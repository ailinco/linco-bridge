const { logAssistantReply } = require('./conversationLog');

function send(ws, type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

function sendSystem(ws, text) {
  send(ws, 'system', { text });
}

function sendError(ws, text, code) {
  send(ws, 'error', { text, ...(code ? { code } : {}) });
}

function agentSessionIdFrom(session, payload = {}) {
  return (
    payload.agentSessionId ||
    payload.agent_session_id ||
    session?.agentSessionId ||
    ''
  );
}

function buildSessionScopedPayload(session, payload = {}) {
  const linco = payload._linco || session?._turnLinco || session?.linco || {};
  const agentSessionId = agentSessionIdFrom(session, payload);
  return {
    requestId: payload.requestId || payload.request_id || linco.messageId,
    streamId: payload.streamId || payload.stream_id || linco.streamId,
    sessionKey: payload.sessionKey || payload.session_key || session?.id,
    ...(agentSessionId
      ? { agentSessionId, session_id: agentSessionId }
      : {}),
    agentType: payload.agentType || payload.agent_type || session?.agentType,
    ts: payload.ts || Date.now(),
    ...withoutInternalPayload(payload),
  };
}

function buildTurnEndPayload(session, reason = 'completed', payload = {}) {
  return {
    ...buildSessionScopedPayload(session, payload),
    reason,
  };
}

function withoutInternalPayload(payload = {}) {
  const { _linco, ...publicPayload } = payload;
  return publicPayload;
}

function turnEndKey(payload) {
  return [
    payload.requestId || '',
    payload.streamId || '',
    payload.sessionKey || '',
  ].join('|');
}

function sendTurnEnd(ws, session, reason = 'completed', payload = {}) {
  const turnEndPayload = buildTurnEndPayload(
    ws?.linco ? { ...session, _turnLinco: ws.linco } : session,
    reason,
    payload,
  );
  const key = turnEndKey(turnEndPayload);
  if (session && session.lastTurnEndKey === key) return false;
  if (session) session.lastTurnEndKey = key;
  logAssistantReply(session, reason, turnEndPayload);
  send(ws, 'turn_end', turnEndPayload);
  return true;
}

function sendAgentSession(ws, session, payload = {}) {
  if (!ws || typeof ws.send !== 'function') return false;
  const scopedSession = ws?.linco ? { ...session, _turnLinco: ws.linco } : session;
  const agentSessionPayload = buildSessionScopedPayload(scopedSession, {
    established: true,
    ...payload,
  });
  if (!agentSessionPayload.agentSessionId) return false;
  const key = [
    agentSessionPayload.sessionKey || '',
    agentSessionPayload.agentSessionId || '',
  ].join('|');
  if (session && session.lastAgentSessionEventKey === key) return false;
  if (session) session.lastAgentSessionEventKey = key;
  send(ws, 'agent_session', agentSessionPayload);
  return true;
}

module.exports = {
  send,
  sendError,
  sendSystem,
  sendTurnEnd,
  sendAgentSession,
  buildTurnEndPayload,
};
