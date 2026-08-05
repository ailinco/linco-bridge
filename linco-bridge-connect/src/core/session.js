const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureDir } = require('../config');
const { clearHistoryFileAuthorization } = require('./historyFileAccess');
const { createTextStreamBuffer, resetTextStream } = require('./streamBuffer');

const MAX_EXTERNAL_SESSION_ID_LENGTH = 256;
const SESSION_METADATA_FILE = 'session.json';

function createStreamState() {
  return createTextStreamBuffer();
}

function createSession(config, { externalSessionId, externalSessionScope, agentType = 'claude' } = {}) {
  const normalizedAgentType = normalizeAgentType(agentType);
  const normalizedExternalId = normalizeExternalSessionId(externalSessionId);
  const normalizedScope = normalizeExternalSessionScope(externalSessionScope);
  const id = normalizedExternalId || createFallbackSessionId();
  const idSource = normalizedExternalId ? 'im' : 'generated';
  const storageId = deriveStorageId(normalizedScope ? `${normalizedScope}:${id}` : id);
  const runtimeDir = resolveSessionRuntimeDir(config, normalizedAgentType, storageId);
  const defaultWorkspace = path.join(runtimeDir, 'workspace');
  const attachmentsDir = resolveRuntimeSubdir(runtimeDir, config.attachmentsDirName || 'attachments');

  ensureDir(runtimeDir);
  ensureDir(defaultWorkspace);
  ensureDir(attachmentsDir);

  const metadata = loadSessionMetadata(runtimeDir);
  const workspace = resolveSavedWorkspace(metadata.workspace, defaultWorkspace);
  const agentSessionId = metadata.agentSessionId || null;
  const agentSessionHistory = metadata.agentSessionHistory || [];
  const approveMode = normalizeApproveMode(metadata.approveMode);
  const autoApprove = approveMode !== 'manual';
  const openclawAgentId = normalizeOptionalSessionSelector(metadata.openclawAgentId);
  const hermesProfile = normalizeOptionalSessionSelector(metadata.hermesProfile);
  const openclawModelOverride = normalizeOptionalSessionSelector(metadata.openclawModelOverride);
  const hermesModelOverride = normalizeOptionalSessionSelector(metadata.hermesModelOverride);
  const hermesModelPreviousDefault = normalizeOptionalSessionSelector(metadata.hermesModelPreviousDefault);
  const claudeResumeEntrypointFixPending = metadata.claudeResumeEntrypointFixPending === true;
  const claudeResumeEntrypointFixedSessionId = normalizeOptionalSessionSelector(metadata.claudeResumeEntrypointFixedSessionId);

  const activeEntry = agentSessionHistory.find(e => e.id === agentSessionId);
  const messageCount = activeEntry?.messageCount ?? 0;
  const usage = activeEntry ? { ...activeEntry.usage } : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  return {
    id,
    idSource,
    agentType: normalizedAgentType,
    activeScope: normalizedScope,
    activeKey: activeSessionKey(normalizedAgentType, id, normalizedScope),
    storageId,
    runtimeDir,
    workspace,
    attachmentsDir,
    agentSessionId,
    agentSessionHistory,
    messageCount,
    usage,
    agentProcess: null,
    claudeProcess: null,
    stdoutBuffer: '',
    isTurnActive: false,
    currentInputForNoOutput: null,
    messageQueue: [],
    pendingDanger: null,
    approveMode,
    autoApprove,
    pendingPermission: null,
    pendingPermissions: new Map(),
    openclawAgentId,
    hermesProfile,
    openclawModelOverride,
    hermesModelOverride,
    hermesModelPreviousDefault,
    claudeResumeEntrypointFixPending,
    claudeResumeEntrypointFixedSessionId,
    streamState: createStreamState(),
    sawPartialAssistantText: false,
  };
}

function normalizeExternalSessionId(value) {
  if (value == null) return '';
  const id = String(value).trim();
  if (!id) return '';
  if (id.length > MAX_EXTERNAL_SESSION_ID_LENGTH) {
    throw new Error(`session_id 长度不能超过 ${MAX_EXTERNAL_SESSION_ID_LENGTH}`);
  }
  if (/[\x00-\x1F\x7F]/.test(id)) {
    throw new Error('session_id 不能包含控制字符');
  }
  return id;
}

function normalizeExternalSessionScope(value) {
  if (value == null) return '';
  const scope = String(value).trim();
  if (!scope) return '';
  if (scope.length > MAX_EXTERNAL_SESSION_ID_LENGTH) {
    throw new Error(`session scope 闀垮害涓嶈兘瓒呰繃 ${MAX_EXTERNAL_SESSION_ID_LENGTH}`);
  }
  if (/[\x00-\x1F\x7F]/.test(scope)) {
    throw new Error('session scope 涓嶈兘鍖呭惈鎺у埗瀛楃');
  }
  return scope;
}

function createFallbackSessionId() {
  return crypto.randomUUID().slice(0, 8);
}

function deriveStorageId(sessionId) {
  return `sid_${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

function normalizeAgentType(value) {
  const type = String(value || 'claude').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(type)) {
    throw new Error('agentType 只能包含字母、数字、下划线或中划线');
  }
  return type;
}

function normalizeOptionalSessionSelector(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeApproveMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'manual') return 'manual';
  if (raw === 'auto') return 'auto';
  if (raw === 'yolo') return 'yolo';
  return 'auto';
}

function activeSessionKey(agentType, sessionId, scope = '') {
  const normalizedScope = normalizeExternalSessionScope(scope);
  return normalizedScope
    ? `${normalizeAgentType(agentType)}:${normalizedScope}:${sessionId}`
    : `${normalizeAgentType(agentType)}:${sessionId}`;
}

function resolveSessionRuntimeDir(config, agentType, storageId) {
  return path.join(config.lincoHome, normalizeAgentType(agentType), 'sessions', storageId);
}

function resolveRuntimeSubdir(runtimeDir, dirName) {
  const name = String(dirName || '').trim();
  if (!name || path.isAbsolute(name)) {
    throw new Error('运行目录子路径必须是相对路径');
  }

  const resolved = path.resolve(runtimeDir, name);
  if (!isInsideOrSame(resolved, runtimeDir)) {
    throw new Error('运行目录子路径不能跳出当前会话目录');
  }
  return resolved;
}

function isInsideOrSame(filePath, dir) {
  const relative = path.relative(dir, filePath);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveSavedWorkspace(savedWorkspace, defaultWorkspace) {
  if (!savedWorkspace || typeof savedWorkspace !== 'string') return defaultWorkspace;
  if (!path.isAbsolute(savedWorkspace)) return defaultWorkspace;
  if (!fs.existsSync(savedWorkspace)) return defaultWorkspace;

  try {
    return fs.statSync(savedWorkspace).isDirectory() ? savedWorkspace : defaultWorkspace;
  } catch {
    return defaultWorkspace;
  }
}

function clearStreamState(session) {
  resetTextStream(session.streamState);
  session.streamState = createStreamState();
}

function sessionMetadataPath(sessionOrRuntimeDir) {
  const runtimeDir = typeof sessionOrRuntimeDir === 'string'
    ? sessionOrRuntimeDir
    : sessionOrRuntimeDir?.runtimeDir;
  return path.join(runtimeDir, SESSION_METADATA_FILE);
}

function loadSessionMetadata(runtimeDir) {
  const file = sessionMetadataPath(runtimeDir);
  if (!fs.existsSync(file)) return {};

  try {
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    return metadata && typeof metadata === 'object' ? metadata : {};
  } catch {
    return {};
  }
}

function saveSessionMetadata(session) {
  const approveMode = normalizeApproveMode(session.approveMode);
  const metadata = {
    sessionId: session.id,
    storageId: session.storageId,
    workspace: session.workspace,
    agentType: session.agentType || 'claude',
    agentSessionId: session.agentSessionId || null,
    agentSessionHistory: session.agentSessionHistory || [],
    approveMode,
    autoApprove: approveMode !== 'manual',
    openclawAgentId: (session.agentType || 'claude') === 'openclaw' ? (session.openclawAgentId || null) : null,
    hermesProfile: (session.agentType || 'claude') === 'hermes' ? (session.hermesProfile || null) : null,
    openclawModelOverride: (session.agentType || 'claude') === 'openclaw' ? (session.openclawModelOverride || null) : null,
    hermesModelOverride: (session.agentType || 'claude') === 'hermes' ? (session.hermesModelOverride || null) : null,
    hermesModelPreviousDefault: (session.agentType || 'claude') === 'hermes' ? (session.hermesModelPreviousDefault || null) : null,
    claudeResumeEntrypointFixPending: (session.agentType || 'claude') === 'claude' ? session.claudeResumeEntrypointFixPending === true : false,
    claudeResumeEntrypointFixedSessionId: (session.agentType || 'claude') === 'claude' ? (session.claudeResumeEntrypointFixedSessionId || null) : null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sessionMetadataPath(session), `${JSON.stringify(metadata, null, 2)}\n`);
}

function createAgentSessionEntry(session, id, firstMessage = '') {
  return {
    id,
    agentType: session.agentType || 'claude',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    workspace: session.workspace,
    firstMessage: String(firstMessage || '').slice(0, 200),
    messageCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

function recordAgentSession(session, firstMessage = '') {
  if (!session.agentSessionHistory) session.agentSessionHistory = [];

  const existing = session.agentSessionHistory.find(e => e.id === session.agentSessionId);
  if (existing) {
    existing.lastActiveAt = new Date().toISOString();
    existing.isActive = true;
    saveSessionMetadata(session);
    return;
  }

  if (session.agentSessionId) {
    for (const entry of session.agentSessionHistory) {
      entry.isActive = false;
    }

    const entry = createAgentSessionEntry(session, session.agentSessionId, firstMessage);
    entry.isActive = true;
    session.agentSessionHistory.push(entry);
    saveSessionMetadata(session);
  }
}

function updateAgentSessionHistory(session) {
  if (!session.agentSessionHistory || !session.agentSessionId) return;

  const entry = session.agentSessionHistory.find(e => e.id === session.agentSessionId);
  if (entry) {
    entry.lastActiveAt = new Date().toISOString();
    if (session.messageCount != null) entry.messageCount = session.messageCount;
    if (session.usage) {
      entry.usage = { ...entry.usage, ...session.usage };
    }
  }
  saveSessionMetadata(session);
}

function extractText(input) {
  if (!Array.isArray(input)) return String(input || '');
  return input
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}

function persistAgentSessionId(session, agentSessionId) {
  const nextId = String(agentSessionId || '').trim();
  if (!nextId || session.agentSessionId === nextId) return;
  const isNew = !session.agentSessionId;
  clearHistoryFileAuthorization(session);
  session.agentSessionId = nextId;
  if (isNew) {
    recordAgentSession(session, extractText(session.currentInputForNoOutput));
  } else {
    saveSessionMetadata(session);
  }
}

function clearPersistedAgentSession(session) {
  clearHistoryFileAuthorization(session);
  session.agentSessionId = null;
  saveSessionMetadata(session);
}

function resetConversationState(session, { clearAgentSession = true, clearClaudeSession } = {}) {
  const shouldClearAgentSession = clearClaudeSession == null ? clearAgentSession : clearClaudeSession;
  if (shouldClearAgentSession) {
    clearPersistedAgentSession(session);
  }
  session.stdoutBuffer = '';
  session.isTurnActive = false;
  session.currentInputForNoOutput = null;
  session.messageQueue = [];
  session.pendingDanger = null;
  session.pendingPermission = null;
  if (session.pendingPermissions?.clear) session.pendingPermissions.clear();
  else session.pendingPermissions = new Map();
  session.sawPartialAssistantText = false;
  clearStreamState(session);
}

function stopAgentProcess(session, { clearAgentSession = false, clearClaudeSession } = {}) {
  const shouldClearAgentSession = clearClaudeSession == null ? clearAgentSession : clearClaudeSession;
  const children = collectSessionChildren(session);
  session.agentProcess = null;
  session.claudeProcess = null;
  session.codexAppServer = null;

  for (const child of children) {
    stopChildProcess(child);
  }

  resetConversationState(session, { clearAgentSession: shouldClearAgentSession });
}

function collectSessionChildren(session) {
  const children = [];
  const seen = new Set();
  for (const child of [session.agentProcess, session.claudeProcess, session.codexAppServer]) {
    if (!child || seen.has(child)) continue;
    seen.add(child);
    children.push(child);
  }
  return children;
}

function stopChildProcess(child, graceMs = 3000) {
  try {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  } catch {}

  if (isChildRunning(child)) {
    setTimeout(() => {
      forceKillChildProcess(child);
    }, graceMs).unref?.();
  }
}

function isChildRunning(child) {
  return !!child && !child.killed && child.exitCode === null;
}

function forceKillChildProcess(child) {
  if (!isChildRunning(child)) return;

  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }

    child.kill('SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

function killCurrentProcess(session) {
  stopAgentProcess(session, { clearAgentSession: false });
}

function cleanupSession(session) {
  stopAgentProcess(session, { clearAgentSession: false });
}

module.exports = {
  activeSessionKey,
  cleanupSession,
  clearPersistedAgentSession,
  clearStreamState,
  createAgentSessionEntry,
  createSession,
  deriveStorageId,
  killCurrentProcess,
  loadSessionMetadata,
  normalizeAgentType,
  normalizeApproveMode,
  normalizeExternalSessionId,
  persistAgentSessionId,
  recordAgentSession,
  resetConversationState,
  saveSessionMetadata,
  stopAgentProcess,
  updateAgentSessionHistory,
};
