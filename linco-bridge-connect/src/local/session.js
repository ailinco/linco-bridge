const { send } = require('../core/protocol');

function parseExternalSessionId(request) {
  const rawUrl = request?.url || '/';
  const url = new URL(rawUrl, 'http://localhost');
  if (!url.searchParams.has('session_id') && !url.searchParams.has('sessionId')) return undefined;

  const sessionId = url.searchParams.get('session_id') ?? url.searchParams.get('sessionId');
  if (!String(sessionId || '').trim()) {
    throw new Error('session_id 不能为空');
  }
  return sessionId;
}

function parseAgentType(request, config) {
  const rawUrl = request?.url || '/';
  const url = new URL(rawUrl, 'http://localhost');
  const requested = String(url.searchParams.get('agentType') || '').trim().toLowerCase();
  if (requested && config.agents?.[requested]) return requested;
  return config.defaultLocalAgent || 'claude';
}

function registerActiveSession(activeSessions, session) {
  if (activeSessions.has(session.activeKey)) return false;
  activeSessions.set(session.activeKey, session);
  return true;
}

function sendSessionInfo(ws, session, config) {
  send(ws, 'session_info', {
    sessionId: session.id,
    sessionIdSource: session.idSource,
    storageId: session.storageId,
    agentType: session.agentType,
    agentSessionId: session.agentSessionId,
    workspace: session.workspace,
    runtime: {
      dir: session.runtimeDir,
      attachmentsDir: session.attachmentsDir,
    },
    upload: {
      maxCount: config.maxAttachmentCount,
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
      blockedExtensions: config.allowUnsafeAttachments ? [] : config.unsafeAttachmentExtensions,
    },
    capabilities: {
      incomingAttachments: true,
      multimodalImages: ['claude', 'hermes', 'openclaw'].includes(session.agentType),
      bridgeHistoryCursor: true,
    },
  });
}

module.exports = {
  parseAgentType,
  parseExternalSessionId,
  registerActiveSession,
  sendSessionInfo,
};
