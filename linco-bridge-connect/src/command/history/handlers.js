
const os = require('os');
const path = require('path');
const { createAgentSessionEntry, saveSessionMetadata } = require('../../core/session');
const { send, sendError, sendSystem } = require('../../core/protocol');
const { rejectLockedIdentityChange, sessionIdentityLocked } = require('../agentSelection');
const { isReadableDirectory } = require('../project');
const {
  parseBindArgs,
  parseChatsArgs,
  parseHistoryArgs,
  parseSessionsArgs,
  resolveSlashProjectWorkspace,
} = require('./args');
const {
  buildBindActions,
  buildChatBindActions,
  buildChatsPayload,
  buildHistoryPayload,
  buildSessionsPayload,
} = require('./payloads');
const {
  parseRecentHistoryRounds,
} = require('./readers');
const {
  collectCodexProjectlessChats,
  collectLocalProjectSessions,
  findCodexProjectlessChatById,
  findLocalProjectSessionById,
  resolveCurrentHistoryTranscript,
} = require('./sessions');
const { stringOrEmpty } = require('./utils');

function sendSlashCommandResult(ws, command, data = {}) {
  send(ws, 'slash_command_result', {
    command,
    version: 1,
    data,
  });
}

function handleSessions(rawArg, ws, session, options = {}) {
  const agentType = session.agentType || 'claude';
  if (!['claude', 'codex'].includes(agentType)) {
    sendError(ws, `/sessions 目前只支持 Claude 和 Codex 模式，当前是 ${agentType}。`);
    return;
  }

  const parsed = parseSessionsArgs(rawArg);
  if (!parsed.ok) {
    sendError(ws, parsed.message);
    return;
  }

  const workspace = resolveSlashProjectWorkspace(parsed.projectPath, session.workspace);
  if (!isReadableDirectory(workspace)) {
    sendError(ws, `当前工作目录不可访问: ${workspace}`);
    return;
  }

  const sessions = collectLocalProjectSessions({
    agentType,
    workspace,
    homeDir: options.homeDir || os.homedir(),
    limit: parsed.limit,
  });

  if (sessions.length === 0) {
    sendSlashCommandResult(ws, 'sessions', buildSessionsPayload(agentType, workspace, [], [], parsed.limit));
    return;
  }

  const actions = buildBindActions(sessions, parsed.projectPath ? workspace : '');
  sendSlashCommandResult(ws, 'sessions', buildSessionsPayload(agentType, workspace, sessions, actions, parsed.limit));
}

function handleChats(rawArg, ws, session, options = {}) {
  const agentType = session.agentType || 'claude';
  if (agentType !== 'codex') {
    sendError(ws, `/chats only supports Codex mode. Current mode is ${agentType}.`);
    return;
  }

  const parsed = parseChatsArgs(rawArg);
  if (!parsed.ok) {
    sendError(ws, parsed.message);
    return;
  }

  const chats = collectCodexProjectlessChats(options.homeDir || os.homedir(), { limit: parsed.limit });
  const actions = buildChatBindActions(chats);
  sendSlashCommandResult(ws, 'chats', buildChatsPayload(chats, actions, parsed.limit));
}

function handleBind(rawArg, ws, session, options = {}) {
  const agentType = session.agentType || 'claude';
  if (!['claude', 'codex'].includes(agentType)) {
    sendError(ws, `/bind 目前只支持 Claude 和 Codex 模式，当前是 ${agentType}。`);
    return;
  }

  if (sessionIdentityLocked(session)) {
    rejectLockedIdentityChange(ws);
    return;
  }

  const parsed = parseBindArgs(rawArg);
  if (!parsed.ok) {
    sendError(ws, parsed.message);
    return;
  }

  if (parsed.chatId) {
    if (agentType !== 'codex') {
      sendError(ws, '/bind --chat only supports Codex mode.');
      return;
    }
    const matched = findCodexProjectlessChatById(options.homeDir || os.homedir(), parsed.chatId);
    if (!matched) {
      sendError(ws, `Codex chat not found: ${parsed.chatId}`);
      return;
    }
    const workspace = matched.workspace;
    if (!workspace || !isReadableDirectory(workspace)) {
      sendError(ws, `Codex chat workspace is not accessible: ${workspace || '(empty)'}`);
      return;
    }
    bindMatchedSession(ws, session, matched, workspace, 'Codex chat');
    return;
  }

  const targetId = parsed.sessionId;
  if (!targetId) {
    sendError(ws, '用法：/bind <session-id>。请先使用 /sessions 查看可接入的 PC 会话。');
    return;
  }

  const workspace = resolveSlashProjectWorkspace(parsed.projectPath, session.workspace);
  if (!isReadableDirectory(workspace)) {
    sendError(ws, `当前工作目录不可访问: ${workspace}`);
    return;
  }

  const matched = findLocalProjectSessionById({
    agentType,
    workspace,
    homeDir: options.homeDir || os.homedir(),
    sessionId: targetId,
  });
  if (!matched) {
    sendError(ws, `未找到当前项目下可接入的 ${agentType} session: ${targetId}`);
    return;
  }

  if (!session.agentSessionHistory) session.agentSessionHistory = [];
  for (const entry of session.agentSessionHistory) entry.isActive = false;
  session.workspace = workspace;
  session.agentSessionId = matched.id;
  const existing = session.agentSessionHistory.find(entry => entry.id === matched.id);
  if (existing) {
    existing.isActive = true;
    existing.lastActiveAt = new Date().toISOString();
  } else {
    const entry = createAgentSessionEntry(session, matched.id, matched.firstMessage || matched.title || '');
    entry.isActive = true;
    session.agentSessionHistory.push(entry);
  }
  saveSessionMetadata(session);

  sendSystem(ws, `已接入 PC 会话。\nAgent session: ${matched.id}\n工作目录: ${workspace}`);
}

function bindMatchedSession(ws, session, matched, workspace, label = 'PC session') {
  activateMatchedSession(session, matched, workspace);
  sendSystem(ws, `Bound ${label}.\nAgent session: ${matched.id}\nWorkspace: ${workspace}`);
}

function activateMatchedSession(session, matched, workspace) {
  if (!session.agentSessionHistory) session.agentSessionHistory = [];
  for (const entry of session.agentSessionHistory) entry.isActive = false;
  session.workspace = workspace;
  session.agentSessionId = matched.id;
  const existing = session.agentSessionHistory.find(entry => entry.id === matched.id);
  if (existing) {
    existing.isActive = true;
    existing.lastActiveAt = new Date().toISOString();
  } else {
    const entry = createAgentSessionEntry(session, matched.id, matched.firstMessage || matched.title || '');
    entry.isActive = true;
    session.agentSessionHistory.push(entry);
  }
  saveSessionMetadata(session);
}

function bindExplicitHistorySession(ws, session, input) {
  const agentSessionId = stringOrEmpty(input.agentSessionId);
  if (!agentSessionId) return { ok: true, switched: false };
  const currentAgentSessionId = stringOrEmpty(session.agentSessionId);
  if (currentAgentSessionId && currentAgentSessionId !== agentSessionId && !input.allowSwitch) {
    sendError(
      ws,
      `Cannot reload desktop history into this IM session because it is already bound to Agent session ${currentAgentSessionId}. Create a new IM session for ${agentSessionId}.`
    );
    return { ok: false, switched: false };
  }

  let matched = null;
  if (input.agentType === 'codex') {
    matched = findLocalProjectSessionById({
      agentType: input.agentType,
      workspace: input.workspace,
      homeDir: input.homeDir,
      sessionId: agentSessionId,
    });
  }
  if (!matched) {
    matched = {
      id: agentSessionId,
      title: path.basename(input.transcriptPath || agentSessionId),
      firstMessage: '',
    };
  }
  activateMatchedSession(session, matched, input.workspace);
  return { ok: true, switched: Boolean(currentAgentSessionId && currentAgentSessionId !== agentSessionId) };
}

function readRecentHistory(ws, transcriptPath, options) {
  try {
    return parseRecentHistoryRounds(transcriptPath, options);
  } catch (error) {
    sendError(
      ws,
      `读取本地历史失败: ${error?.message || 'unknown error'}`,
      error?.code,
    );
    return null;
  }
}

function handleHistory(rawArg, ws, session, options = {}) {
  const agentType = session.agentType || 'claude';
  if (!['claude', 'codex'].includes(agentType)) {
    sendError(ws, `/history 目前只支持 Claude 和 Codex 模式，当前是 ${agentType}。`);
    return;
  }

  const parsed = parseHistoryArgs(rawArg);
  if (!parsed.ok) {
    sendError(ws, parsed.message);
    return;
  }

  if (parsed.chatId) {
    if (agentType !== 'codex') {
      sendError(ws, '/history --chat only supports Codex mode.');
      return;
    }
    const matched = findCodexProjectlessChatById(options.homeDir || os.homedir(), parsed.chatId);
    if (!matched?.transcriptPath) {
      sendError(ws, `Codex chat history not found: ${parsed.chatId}`);
      return;
    }
    const history = readRecentHistory(ws, matched.transcriptPath, {
      agentType,
      sessionId: matched.id,
      limit: parsed.limit,
      includeThinking: parsed.includeThinking === true,
      beforeCursor: parsed.beforeCursor,
    });
    if (!history) return;
    const recent = history.rounds;
    let bindResult = { ok: true, switched: false };
    if (options.bindExplicitHistorySession) {
      bindResult = bindExplicitHistorySession(ws, session, {
        agentType,
        agentSessionId: matched.id,
        workspace: matched.workspace,
        transcriptPath: matched.transcriptPath,
        homeDir: options.homeDir || os.homedir(),
        allowSwitch: options.allowExplicitHistorySessionSwitch === true,
      });
      if (!bindResult.ok) {
        return;
      }
    }
    sendSlashCommandResult(ws, 'history', buildHistoryPayload(agentType, matched.id, parsed.limit, recent, {
      workspace: matched.workspace,
      replaceConversation: options.historyReload === true,
      switchedSession: bindResult.switched,
      syncMeta: history.syncMeta,
      pageInfo: history.pageInfo,
    }));
    return;
  }

  const agentSessionId = stringOrEmpty(parsed.sessionId || session.agentSessionId);
  if (!agentSessionId) {
    sendError(ws, '当前 IM 会话还没有绑定 Agent Session。请先发送一条普通消息，或使用 /sessions 后 /bind 接入已有 PC 会话。');
    return;
  }

  const workspace = resolveSlashProjectWorkspace(parsed.projectPath, session.workspace);
  if (!isReadableDirectory(workspace)) {
    sendError(ws, `当前工作目录不可访问: ${workspace}`);
    return;
  }

  const resolved = resolveCurrentHistoryTranscript({
    agentType,
    workspace,
    homeDir: options.homeDir || os.homedir(),
    sessionId: agentSessionId,
  });
  if (!resolved.ok) {
    sendError(ws, resolved.message);
    return;
  }

  let bindResult = { ok: true, switched: false };
  if (options.bindExplicitHistorySession && parsed.sessionId) {
    bindResult = bindExplicitHistorySession(ws, session, {
      agentType,
      agentSessionId,
      workspace,
      transcriptPath: resolved.transcriptPath,
      homeDir: options.homeDir || os.homedir(),
      allowSwitch: options.allowExplicitHistorySessionSwitch === true,
    });
    if (!bindResult.ok) {
      return;
    }
  }

  const history = readRecentHistory(ws, resolved.transcriptPath, {
    agentType,
    sessionId: agentSessionId,
    limit: parsed.limit,
    includeThinking: parsed.includeThinking === true,
    beforeCursor: parsed.beforeCursor,
  });
  if (!history) return;
  const recent = history.rounds;

  if (recent.length === 0) {
    sendSlashCommandResult(ws, 'history', buildHistoryPayload(agentType, agentSessionId, parsed.limit, [], {
      workspace,
      replaceConversation: options.historyReload === true,
      switchedSession: bindResult.switched,
      syncMeta: history.syncMeta,
      pageInfo: history.pageInfo,
    }));
    return;
  }

  sendSlashCommandResult(ws, 'history', buildHistoryPayload(agentType, agentSessionId, parsed.limit, recent, {
    workspace,
    replaceConversation: options.historyReload === true,
    switchedSession: bindResult.switched,
    syncMeta: history.syncMeta,
    pageInfo: history.pageInfo,
  }));
}

module.exports = {
  handleBind,
  handleChats,
  handleHistory,
  handleSessions,
  sendSlashCommandResult,
};
