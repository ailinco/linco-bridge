const path = require('node:path');

const HISTORY_FILE_AUTHORIZATION = Symbol('historyFileAuthorization');
const MAX_AUTHORIZED_HISTORY_FILES = 200;
const MAX_HISTORY_FILE_PATH_LENGTH = 4096;

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function historyIdentity(agentType, agentSessionId, workspace) {
  const type = String(agentType || '').trim().toLowerCase();
  const sessionId = String(agentSessionId || '').trim();
  const projectPath = String(workspace || '').trim();
  if (!type || !sessionId || !projectPath) return '';
  return JSON.stringify([type, sessionId, normalizedPath(projectPath)]);
}

function currentHistoryIdentity(session = {}) {
  return historyIdentity(session.agentType, session.agentSessionId, session.workspace);
}

function payloadHistoryIdentity(payload = {}) {
  return historyIdentity(payload.agentType, payload.agentSessionId, payload.workspace);
}

function payloadFilePaths(payload) {
  const result = [];
  for (const round of Array.isArray(payload?.rounds) ? payload.rounds : []) {
    for (const message of [round?.user, round?.assistant]) {
      for (const file of Array.isArray(message?.files) ? message.files : []) {
        const localPath = typeof file?.localPath === 'string' ? file.localPath.trim() : '';
        if (!localPath || localPath.length > MAX_HISTORY_FILE_PATH_LENGTH ||
            localPath.includes('\0') || !path.isAbsolute(localPath)) {
          continue;
        }
        result.push(path.resolve(localPath));
      }
    }
  }
  return result;
}

function registerHistoryPayloadFiles(session, payload) {
  const identity = currentHistoryIdentity(session);
  if (!identity || payloadHistoryIdentity(payload) !== identity) return 0;

  let authorization = session[HISTORY_FILE_AUTHORIZATION];
  if (!authorization || authorization.identity !== identity) {
    authorization = { identity, files: new Map() };
    session[HISTORY_FILE_AUTHORIZATION] = authorization;
  }

  for (const filePath of payloadFilePaths(payload)) {
    const key = normalizedPath(filePath);
    authorization.files.delete(key);
    authorization.files.set(key, filePath);
    while (authorization.files.size > MAX_AUTHORIZED_HISTORY_FILES) {
      authorization.files.delete(authorization.files.keys().next().value);
    }
  }
  return authorization.files.size;
}

function authorizedHistoryFiles(session) {
  const authorization = session?.[HISTORY_FILE_AUTHORIZATION];
  if (!authorization) return [];
  if (authorization.identity !== currentHistoryIdentity(session)) {
    clearHistoryFileAuthorization(session);
    return [];
  }
  return [...authorization.files.values()];
}

function clearHistoryFileAuthorization(session) {
  if (session) delete session[HISTORY_FILE_AUTHORIZATION];
}

module.exports = {
  authorizedHistoryFiles,
  clearHistoryFileAuthorization,
  registerHistoryPayloadFiles,
};
