
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CODEX_CHATS_LIMIT,
  DEFAULT_CODEX_SESSION_SCAN_LIMIT,
  MAX_LOCAL_SESSIONS_LIMIT,
  MAX_REALPATH_CACHE_SIZE,
} = require('./constants');
const {
  encodeClaudeProjectDir,
  isReadableDirectory,
  readJsonFile,
  safeMtimeMs,
  safeReadDir,
  safeReadFilesRecursive,
} = require('../project');
const {
  isCodexSubagentSource,
  normalizeCodexTitle,
  readClaudeSessionSummary,
  readCodexSessionIndex,
  readCodexSessionMeta,
} = require('./readers');
const {
  compareLocalSessions,
  parseTimeMs,
  sqliteTimeMs,
  stringOrEmpty,
} = require('./utils');

let BetterSqlite3 = null;
let betterSqlite3Loaded = false;
const realpathCache = new Map();

function resolveClaudeTranscriptPath(workspace, sessionId, homeDir) {
  const projectDir = encodeClaudeProjectDir(workspace || process.cwd());
  return path.join(homeDir, '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

function findClaudeTranscriptPath(workspace, sessionId, homeDir) {
  const expected = resolveClaudeTranscriptPath(workspace, sessionId, homeDir);
  if (fs.existsSync(expected)) return { transcriptPath: expected, expectedPath: expected };

  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const fileName = `${sessionId}.jsonl`;
  for (const entry of safeReadFilesRecursive(projectsDir, { extension: '.jsonl', limit: 10000 })) {
    if (path.basename(entry.fullPath) === fileName) {
      return { transcriptPath: entry.fullPath, expectedPath: expected };
    }
  }
  return { transcriptPath: '', expectedPath: expected };
}

function collectLocalProjectSessions({ agentType, workspace, homeDir, limit, projectId }) {
  const sessions = agentType === 'codex'
    ? collectCodexProjectSessions(homeDir, workspace, { limit, projectId })
    : collectClaudeProjectSessions(homeDir, workspace, { limit });
  return sessions.sort(compareLocalSessions).slice(0, limit);
}

function findLocalProjectSessionById({ agentType, workspace, homeDir, sessionId }) {
  const targetId = String(sessionId || '').trim();
  if (!targetId) return null;
  if (agentType === 'codex') {
    return findCodexProjectSessionById(homeDir, workspace, targetId) ||
      collectCodexProjectSessions(homeDir, workspace, { scanLimit: 5000 })
        .find(item => item.id === targetId) ||
      null;
  }
  const sessions = collectClaudeProjectSessions(homeDir, workspace);
  return sessions.find(item => item.id === targetId) || null;
}

function resolveCurrentHistoryTranscript({ agentType, workspace, homeDir, sessionId }) {
  if (agentType === 'claude') {
    if (sessionId.includes('/') || sessionId.includes('\\')) {
      return { ok: false, message: '当前 Claude session ID 不合法，无法读取历史。' };
    }
    const { transcriptPath, expectedPath } = findClaudeTranscriptPath(workspace, sessionId, homeDir);
    if (!fs.existsSync(transcriptPath)) {
      return { ok: false, message: `未找到当前 Claude session 的历史文件。\nAgent session: ${sessionId}\n工作目录: ${workspace}\n预期历史文件: ${expectedPath}` };
    }
    return { ok: true, transcriptPath };
  }

  const matched = findLocalProjectSessionById({ agentType, workspace, homeDir, sessionId });
  if (!matched?.transcriptPath) {
    return { ok: false, message: `未找到当前 Codex session 的历史文件。\nAgent session: ${sessionId}` };
  }
  return { ok: true, transcriptPath: matched.transcriptPath };
}

function collectClaudeProjectSessions(homeDir, workspace, options = {}) {
  const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(workspace));
  if (!isReadableDirectory(projectDir)) return [];

  let files = safeReadDir(projectDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => {
      const fullPath = path.join(projectDir, entry.name);
      return { entry, fullPath, updatedAt: safeMtimeMs(fullPath) };
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (options.limit) files = files.slice(0, options.limit);

  return files
    .map(entry => {
      const sessionId = entry.entry.name.replace(/\.jsonl$/u, '');
      const fullPath = entry.fullPath;
      const summary = readClaudeSessionSummary(fullPath);
      return {
        id: sessionId,
        title: summary.title || sessionId,
        firstMessage: summary.firstMessage || '',
        lastMessage: summary.lastMessage || '',
        updatedAt: entry.updatedAt,
        transcriptPath: fullPath,
      };
    });
}

function collectCodexProjectSessions(homeDir, workspace, options = {}) {
  const codexDir = path.join(homeDir, '.codex');
  const index = readCodexSessionIndex(path.join(codexDir, 'session_index.jsonl'));
  const assignment = readCodexProjectAssignment(codexDir, options.projectId);

  const stateResult = collectCodexProjectSessionsFromState(
    codexDir,
    workspace,
    index,
    assignment,
    options,
  );
  if (stateResult) {
    if (!assignment) return stateResult.sessions;
    const missingIds = assignment.threadIds.filter(id => !stateResult.foundIds.has(id));
    if (missingIds.length === 0) return stateResult.sessions;
    const missingSessions = collectCodexProjectSessionsFromJsonl(
      codexDir,
      workspace,
      index,
      {
        ...assignment,
        threadIds: missingIds,
        includeUnassignedByWorkspace: false,
      },
      options,
    );
    return mergeCodexWorkspaceSessions(
      [...stateResult.sessions, ...missingSessions],
      normalizedSessionsLimit(options.limit),
    );
  }

  return collectCodexProjectSessionsFromJsonl(
    codexDir,
    workspace,
    index,
    assignment,
    options,
  );
}

function collectCodexProjectSessionsFromJsonl(codexDir, workspace, index, assignment, options = {}) {
  const resultLimit = Number.isInteger(options.limit)
    ? normalizedSessionsLimit(options.limit)
    : 0;
  const wantedIds = assignment ? new Set(assignment.threadIds) : null;
  const includeUnassignedByWorkspace = !assignment || assignment.includeUnassignedByWorkspace !== false;
  const sessionsDir = path.join(codexDir, 'sessions');
  const filesByPath = new Map();
  if (wantedIds && wantedIds.size > 0) {
    for (const file of findCodexTranscriptFilesByIds(sessionsDir, wantedIds)) {
      filesByPath.set(file.fullPath, file);
    }
  }
  if (includeUnassignedByWorkspace) {
    for (const file of safeReadFilesRecursive(sessionsDir, {
      extension: '.jsonl',
      limit: options.scanLimit || DEFAULT_CODEX_SESSION_SCAN_LIMIT,
    })) {
      filesByPath.set(file.fullPath, file);
    }
  }
  const files = Array.from(filesByPath.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const workspaceKeys = workspaceMatchKeys(workspace);
  const matchedSessions = [];

  for (const file of files) {
    const meta = readCodexSessionMeta(file.fullPath);
    if (isCodexSubagentSource('', meta.source)) continue;
    if (!meta.id) continue;
    if (assignment) {
      const assignedProjectId = assignment.projectIdsByThreadId.get(meta.id);
      if (assignedProjectId) {
        if (assignedProjectId !== assignment.projectId || !wantedIds.has(meta.id)) continue;
      } else if (!includeUnassignedByWorkspace || !codexWorkspaceMatchesListingPath(meta.cwd, workspaceKeys)) {
        continue;
      }
    } else if (!codexWorkspaceMatchesListingPath(meta.cwd, workspaceKeys)) {
      continue;
    }
    const indexed = index.get(meta.id) || {};
    const item = {
      id: meta.id,
      title: normalizeCodexTitle(indexed.threadName) || meta.firstMessage || meta.id,
      firstMessage: meta.firstMessage || '',
      updatedAt: parseTimeMs(indexed.updatedAt) || file.updatedAt,
      transcriptPath: file.fullPath,
      workspace: meta.cwd || '',
    };
    matchedSessions.push(item);
    if (!assignment && resultLimit && matchedSessions.length >= resultLimit) break;
  }

  return mergeCodexWorkspaceSessions(matchedSessions, resultLimit);
}

function normalizedSessionsLimit(value) {
  return Math.max(1, Math.min(value || DEFAULT_LOCAL_SESSIONS_LIMIT, MAX_LOCAL_SESSIONS_LIMIT));
}

function mergeCodexWorkspaceSessions(sessions, limit = 0) {
  const sessionsById = new Map();
  for (const item of sessions) {
    const id = stringOrEmpty(item?.id);
    if (!id) continue;
    const existing = sessionsById.get(id);
    if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
      sessionsById.set(id, item);
    }
  }

  const merged = Array.from(sessionsById.values()).sort(compareLocalSessions);
  return limit > 0 ? merged.slice(0, limit) : merged;
}

function collectCodexProjectSessionsFromState(codexDir, workspace, index, assignment, options = {}) {
  const Database = loadBetterSqlite3();
  if (!Database) return null;

  const stateDbPath = findLatestCodexStateDb(codexDir);
  if (!stateDbPath) return null;

  let db;
  try {
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    if (!hasSqliteTable(db, 'threads')) return null;

    const limit = normalizedSessionsLimit(options.limit);
    const columns = sqliteTableColumns(db, 'threads');
    if (assignment) {
      const assignedResult = collectAssignedCodexSessionsFromState(
        db,
        assignment.threadIds,
        columns,
        index,
        limit,
      );
      const unassignedSessions = collectUnassignedCodexCwdSessionsFromState(
        db,
        workspace,
        columns,
        index,
        assignment,
        limit,
      );
      return {
        sessions: mergeCodexWorkspaceSessions(
          [...assignedResult.sessions, ...unassignedSessions],
          limit,
        ),
        foundIds: assignedResult.foundIds,
      };
    }

    const cwdCandidates = sqliteCwdCandidates(workspace);
    const queryLimit = limit * Math.max(1, cwdCandidates.length);
    const visibilityPredicates = [];
    if (columns.has('thread_source')) {
      visibilityPredicates.push("COALESCE(thread_source, '') <> 'subagent'");
    }
    if (columns.has('source')) {
      visibilityPredicates.push("COALESCE(source, '') NOT LIKE '%\"subagent\"%'");
    }
    const visibilitySql = visibilityPredicates.length > 0
      ? ` AND ${visibilityPredicates.join(' AND ')}`
      : '';
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, title, first_user_message, preview,
             recency_at_ms, updated_at_ms, updated_at
      FROM threads
      WHERE archived = 0 AND cwd IN (${cwdCandidates.map(() => '?').join(', ')})${visibilitySql}
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(...cwdCandidates, queryLimit);
    const workspaceKeys = workspaceMatchKeys(workspace);
    const matchedSessions = [];

    for (const row of rows) {
      const matchTier = codexWorkspaceMatchTier(row.cwd, workspaceKeys);
      if (!matchTier) continue;
      const indexed = index.get(stringOrEmpty(row.id)) || {};
      const item = {
        id: stringOrEmpty(row.id),
        title: normalizeCodexTitle(indexed.threadName) || normalizeCodexTitle(row.title) || normalizeCodexTitle(row.preview) || stringOrEmpty(row.id),
        firstMessage: normalizeCodexTitle(row.first_user_message) || normalizeCodexTitle(row.preview) || '',
        updatedAt: sqliteTimeMs(row.recency_at_ms) || sqliteTimeMs(row.updated_at_ms) || sqliteTimeMs(row.updated_at),
        transcriptPath: stringOrEmpty(row.rollout_path),
        workspace: stringOrEmpty(row.cwd),
      };
      matchedSessions.push(item);
    }

    const validSessions = mergeCodexWorkspaceSessions(matchedSessions, limit);
    return { sessions: validSessions, foundIds: new Set(rows.map(row => stringOrEmpty(row.id)).filter(Boolean)) };
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close failures; the JSONL fallback remains available.
      }
    }
  }
}

function collectAssignedCodexSessionsFromState(db, threadIds, columns, index, limit) {
  const rows = [];
  const foundIds = new Set();
  const optionalColumns = [
    columns.has('thread_source') ? 'thread_source' : "'' AS thread_source",
    columns.has('source') ? 'source' : "'' AS source",
  ];

  for (let offset = 0; offset < threadIds.length; offset += 500) {
    const batch = threadIds.slice(offset, offset + 500);
    const batchRows = db.prepare(`
      SELECT id, rollout_path, cwd, title, first_user_message, preview, archived,
             recency_at_ms, updated_at_ms, updated_at, ${optionalColumns.join(', ')}
      FROM threads
      WHERE id IN (${batch.map(() => '?').join(', ')})
    `).all(...batch);
    rows.push(...batchRows);
  }

  const sessions = [];
  for (const row of rows) {
    const id = stringOrEmpty(row.id);
    if (!id) continue;
    foundIds.add(id);
    if (Number(row.archived) !== 0 || isCodexSubagentSource(row.thread_source, row.source)) continue;
    const indexed = index.get(id) || {};
    sessions.push({
      id,
      title: normalizeCodexTitle(indexed.threadName) || normalizeCodexTitle(row.title) || normalizeCodexTitle(row.preview) || id,
      firstMessage: normalizeCodexTitle(row.first_user_message) || normalizeCodexTitle(row.preview) || '',
      updatedAt: sqliteTimeMs(row.recency_at_ms) || sqliteTimeMs(row.updated_at_ms) || sqliteTimeMs(row.updated_at),
      transcriptPath: stringOrEmpty(row.rollout_path),
      workspace: stringOrEmpty(row.cwd),
    });
  }
  return { sessions: mergeCodexWorkspaceSessions(sessions, limit), foundIds };
}

function collectUnassignedCodexCwdSessionsFromState(
  db,
  workspace,
  columns,
  index,
  assignment,
  limit,
) {
  const cwdCandidates = sqliteCwdCandidates(workspace);
  const visibilityPredicates = [];
  if (columns.has('thread_source')) {
    visibilityPredicates.push("COALESCE(thread_source, '') <> 'subagent'");
  }
  if (columns.has('source')) {
    visibilityPredicates.push("COALESCE(source, '') NOT LIKE '%\"subagent\"%'");
  }
  const visibilitySql = visibilityPredicates.length > 0
    ? ` AND ${visibilityPredicates.join(' AND ')}`
    : '';
  const rows = db.prepare(`
    SELECT id, rollout_path, cwd, title, first_user_message, preview,
           recency_at_ms, updated_at_ms, updated_at
    FROM threads
    WHERE archived = 0 AND cwd IN (${cwdCandidates.map(() => '?').join(', ')})${visibilitySql}
    ORDER BY recency_at_ms DESC, updated_at_ms DESC, updated_at DESC, id DESC
  `).all(...cwdCandidates);
  const workspaceKeys = workspaceMatchKeys(workspace);
  const sessions = [];

  for (const row of rows) {
    const id = stringOrEmpty(row.id);
    if (!id || assignment.projectIdsByThreadId.has(id)) continue;
    if (!codexWorkspaceMatchTier(row.cwd, workspaceKeys)) continue;
    const indexed = index.get(id) || {};
    sessions.push({
      id,
      title: normalizeCodexTitle(indexed.threadName) || normalizeCodexTitle(row.title) || normalizeCodexTitle(row.preview) || id,
      firstMessage: normalizeCodexTitle(row.first_user_message) || normalizeCodexTitle(row.preview) || '',
      updatedAt: sqliteTimeMs(row.recency_at_ms) || sqliteTimeMs(row.updated_at_ms) || sqliteTimeMs(row.updated_at),
      transcriptPath: stringOrEmpty(row.rollout_path),
      workspace: stringOrEmpty(row.cwd),
    });
  }
  return mergeCodexWorkspaceSessions(sessions, limit);
}

function readCodexProjectAssignment(codexDir, projectId) {
  const targetProjectId = stringOrEmpty(projectId);
  if (!targetProjectId) return null;
  const state = readJsonFile(path.join(codexDir, '.codex-global-state.json'));
  if (!state) return null;

  const knownProject = collectObjectsAtKey(state, 'local-projects').some(projects =>
    Object.entries(projects).some(([fallbackId, project]) =>
      stringOrEmpty(project?.id) === targetProjectId || stringOrEmpty(fallbackId) === targetProjectId
    )
  );
  if (!knownProject) return null;

  const assignmentMaps = collectObjectsAtKey(state, 'thread-project-assignments');
  if (assignmentMaps.length === 0) return null;
  const threadIds = [];
  const seen = new Set();
  const projectIdsByThreadId = new Map();
  for (const assignments of assignmentMaps) {
    for (const [threadId, assignment] of Object.entries(assignments)) {
      const id = stringOrEmpty(threadId);
      const assignedProjectId = stringOrEmpty(assignment?.projectId);
      if (!id || !assignedProjectId) continue;
      if (!projectIdsByThreadId.has(id)) projectIdsByThreadId.set(id, assignedProjectId);
      if (seen.has(id) || assignedProjectId !== targetProjectId) continue;
      const projectKind = stringOrEmpty(assignment?.projectKind);
      if (projectKind && projectKind !== 'local') continue;
      seen.add(id);
      threadIds.push(id);
    }
  }
  return {
    projectId: targetProjectId,
    threadIds,
    projectIdsByThreadId,
    includeUnassignedByWorkspace: true,
  };
}

function collectObjectsAtKey(value, targetKey, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectsAtKey(item, targetKey, result);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === targetKey && item && typeof item === 'object' && !Array.isArray(item)) {
      result.push(item);
      continue;
    }
    collectObjectsAtKey(item, targetKey, result);
  }
  return result;
}

function findCodexTranscriptFilesByIds(sessionsDir, wantedIds) {
  if (!isReadableDirectory(sessionsDir) || wantedIds.size === 0) return [];
  const files = [];
  const stack = [sessionsDir];
  const wantedIdList = Array.from(wantedIds);
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReadDir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stem = entry.name.slice(0, -'.jsonl'.length);
      const matches = wantedIds.has(stem) || wantedIdList.some(id => stem.endsWith(`-${id}`));
      if (matches) files.push({ fullPath, updatedAt: safeMtimeMs(fullPath) });
    }
  }
  return files.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function loadBetterSqlite3() {
  if (betterSqlite3Loaded) return BetterSqlite3;
  betterSqlite3Loaded = true;
  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch {
    BetterSqlite3 = null;
  }
  return BetterSqlite3;
}

function findLatestCodexStateDb(codexDir) {
  if (!isReadableDirectory(codexDir)) return '';
  return safeReadDir(codexDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^state_\d+\.sqlite$/u.test(entry.name))
    .map(entry => {
      const fullPath = path.join(codexDir, entry.name);
      return { fullPath, updatedAt: safeMtimeMs(fullPath) };
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]?.fullPath || '';
}

function hasSqliteTable(db, tableName) {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return !!row;
  } catch {
    return false;
  }
}

function sqliteTableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map(row => stringOrEmpty(row.name))
    .filter(Boolean));
}

function sqliteCwdCandidates(workspace) {
  const resolved = path.resolve(workspace || process.cwd());
  const realpath = safeRealpath(resolved);
  const values = [resolved, realpath];
  if (process.platform === 'win32') {
    values.push(`\\\\?\\${resolved}`);
    if (realpath) values.push(`\\\\?\\${realpath}`);
  }
  return Array.from(new Set(values.filter(Boolean)));
}

function findCodexProjectSessionById(homeDir, workspace, sessionId) {
  const targetId = stringOrEmpty(sessionId);
  if (!targetId) return null;

  const codexDir = path.join(homeDir, '.codex');
  const workspaceKeys = workspaceMatchKeys(workspace);
  const index = readCodexSessionIndex(path.join(codexDir, 'session_index.jsonl'));
  const candidates = findCodexTranscriptCandidates(path.join(codexDir, 'sessions'), targetId);
  let aliasMatch = null;

  for (const file of candidates) {
    const meta = readCodexSessionMeta(file.fullPath);
    const matchTier = codexWorkspaceMatchTier(meta.cwd, workspaceKeys);
    if (meta.id !== targetId || !matchTier) continue;
    const indexed = index.get(meta.id) || {};
    const matched = {
      id: meta.id,
      title: normalizeCodexTitle(indexed.threadName) || meta.firstMessage || meta.id,
      firstMessage: meta.firstMessage || '',
      updatedAt: parseTimeMs(indexed.updatedAt) || file.updatedAt,
      transcriptPath: file.fullPath,
    };
    if (matchTier === 'exact') return matched;
    if (!aliasMatch) aliasMatch = matched;
  }

  return aliasMatch;
}

function findCodexTranscriptCandidates(sessionsDir, sessionId) {
  if (!isReadableDirectory(sessionsDir)) return [];
  const wantedSuffix = `-${sessionId}.jsonl`;
  const wantedExact = `${sessionId}.jsonl`;
  const result = [];
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReadDir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === wantedExact || entry.name.endsWith(wantedSuffix)) {
        result.push({ fullPath, updatedAt: safeMtimeMs(fullPath) });
      }
    }
  }

  return result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function collectCodexProjectlessChats(homeDir, options = {}) {
  const codexDir = path.join(homeDir, '.codex');
  const stateFile = path.join(codexDir, '.codex-global-state.json');
  const state = readJsonFile(stateFile);
  const chatIds = collectCodexProjectlessThreadIds(state);
  if (chatIds.length === 0) return [];

  const wanted = new Set(chatIds);
  const index = readCodexSessionIndex(path.join(codexDir, 'session_index.jsonl'));
  const scanLimit = options.scanLimit || 5000;
  const chats = [];

  for (const file of safeReadFilesRecursive(path.join(codexDir, 'sessions'), { extension: '.jsonl', limit: scanLimit })) {
    const meta = readCodexSessionMeta(file.fullPath);
    if (!meta.id || !wanted.has(meta.id)) continue;
    const indexed = index.get(meta.id) || {};
    chats.push({
      id: meta.id,
      title: normalizeCodexTitle(indexed.threadName) || meta.firstMessage || meta.id,
      firstMessage: meta.firstMessage || '',
      workspace: meta.cwd || '',
      updatedAt: parseTimeMs(indexed.updatedAt) || file.updatedAt,
      transcriptPath: file.fullPath,
      source: 'codex-chats',
    });
  }

  const byId = new Map(chats.map(chat => [chat.id, chat]));
  for (const id of chatIds) {
    if (byId.has(id)) continue;
    const indexed = index.get(id) || {};
    if (!indexed.threadName && !indexed.updatedAt) continue;
    byId.set(id, {
      id,
      title: normalizeCodexTitle(indexed.threadName) || id,
      firstMessage: '',
      workspace: '',
      updatedAt: parseTimeMs(indexed.updatedAt) || 0,
      transcriptPath: '',
      source: 'codex-chats',
    });
  }

  const limit = options.limit || DEFAULT_CODEX_CHATS_LIMIT;
  return Array.from(byId.values()).sort(compareLocalSessions).slice(0, limit);
}

function findCodexProjectlessChatById(homeDir, chatId) {
  const targetId = stringOrEmpty(chatId);
  if (!targetId) return null;
  return collectCodexProjectlessChats(homeDir, { limit: 5000, scanLimit: 10000 })
    .find(item => item.id === targetId) || null;
}

function collectCodexProjectlessThreadIds(state) {
  const result = [];
  const seen = new Set();
  const push = value => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };
  const direct = state?.['projectless-thread-ids'];
  if (Array.isArray(direct)) direct.forEach(push);
  const nested = state?.['electron-persisted-atom-state']?.['projectless-thread-ids'];
  if (Array.isArray(nested)) nested.forEach(push);
  return result;
}

function normalizePathKey(value) {
  if (!value || typeof value !== 'string') return '';
  const resolved = path.resolve(stripWindowsLongPathPrefix(value));
  return (safeRealpath(resolved) || resolved).toLowerCase();
}

function rawPathKey(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(stripWindowsLongPathPrefix(value)).toLowerCase();
}

function workspaceMatchKeys(workspace) {
  return {
    raw: rawPathKey(workspace),
    canonical: normalizePathKey(workspace),
  };
}

function codexWorkspaceMatchesListingPath(candidateWorkspace, workspaceKeys) {
  const candidateKey = rawPathKey(candidateWorkspace);
  return !!candidateKey &&
    (candidateKey === workspaceKeys.raw || candidateKey === workspaceKeys.canonical);
}

function codexWorkspaceMatchTier(candidateWorkspace, workspaceKeys) {
  if (!candidateWorkspace || typeof candidateWorkspace !== 'string') return '';
  if (rawPathKey(candidateWorkspace) === workspaceKeys.raw) return 'exact';
  if (normalizePathKey(candidateWorkspace) === workspaceKeys.canonical) return 'alias';
  return '';
}

function safeRealpath(value) {
  const cacheKey = path.resolve(value);
  if (realpathCache.has(cacheKey)) return realpathCache.get(cacheKey);
  try {
    const realpath = fs.realpathSync.native(value);
    if (realpathCache.size >= MAX_REALPATH_CACHE_SIZE) realpathCache.clear();
    realpathCache.set(cacheKey, realpath);
    return realpath;
  } catch {
    return '';
  }
}

function stripWindowsLongPathPrefix(value) {
  const text = String(value || '');
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice('\\\\?\\UNC\\'.length)}`;
  if (text.startsWith('\\\\?\\')) return text.slice('\\\\?\\'.length);
  return text;
}

module.exports = {
  collectClaudeProjectSessions,
  collectCodexProjectSessions,
  collectCodexProjectlessChats,
  collectLocalProjectSessions,
  findClaudeTranscriptPath,
  findCodexProjectSessionById,
  findCodexProjectlessChatById,
  findLocalProjectSessionById,
  resolveCurrentHistoryTranscript,
  resolveClaudeTranscriptPath,
};
