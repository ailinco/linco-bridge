const crypto = require('crypto');
const path = require('path');
const { isDangerousCommand } = require('../../core/danger');
const { send, sendError, sendSystem, sendTurnEnd } = require('../../core/protocol');
const {
  createAgentSessionEntry,
  persistAgentSessionId,
  saveSessionMetadata,
  stopAgentProcess: stopSessionProcess,
  updateAgentSessionHistory,
} = require('../../core/session');
const { appendBridgeContextHint } = require('../../core/agentPrompt');
const { buildFileReferenceHint } = require('../../core/fileReferences');
const { createTextStreamBuffer, appendTextStream, flushTextStream, resetTextStream } = require('../../core/streamBuffer');
const { captureAssistantReplyText, startAssistantReplyLog } = require('../../core/conversationLog');
const {
  appendProgressiveAnswerText,
  promotePendingProgress,
  resetProgressiveAnswer,
} = require('../../core/progressiveAnswer');
const {
  DEFAULT_GATEWAY_URL,
  REQUIRED_METHODS,
  OpenClawGatewayClient,
  ensureOpenClawGateway,
  normalizeGatewayUrl,
} = require('../../gateway/openclawGateway');
const {
  clearPendingPermissions,
  getPendingPermission,
  pendingPermissionIds,
  removePendingPermission,
  setPendingPermission,
} = require('../../core/permissionState');
const {
  buildOpenClawSessionKey,
  buildOpenClawSessionLabel,
  firstText,
  isSessionKeyForAgent,
  resolveOpenClawAgentId,
  sanitizeOpenClawErrorMessage,
  stripInternalOutboxHint,
} = require('./identity');

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const OPENCLAW_COMPACTION_STALE_MS = 90_000;
const DEFAULT_OPENCLAW_COMPACTION_TIMEOUT_MS = 300_000;

function execute(input, ws, session, config) {
  const textForCheck = stringifyInput(input);
  if (isDangerousCommand(textForCheck) && session.autoApprove !== true) {
    const preview = textForCheck.slice(0, 200);
    session.pendingDanger = { input };
    send(ws, 'danger_warning', {
      text: `Possible dangerous operation detected. Confirm to continue:\n\n"${preview}${textForCheck.length > 200 ? '...' : ''}"`,
    });
    return;
  }

  if (session.isTurnActive) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return;
    }
    session.messageQueue.push({ input, ws });
    sendSystem(ws, `OpenClaw is handling the previous message. Queued (${session.messageQueue.length}).`);
    return;
  }

  runOpenClawTurn(input, ws, session, config);
}

async function runOpenClawTurn(input, ws, session, config) {
  session.isTurnActive = true;
  session.currentInputForNoOutput = input;
  session.sawPartialAssistantText = false;
  session._lastWs = ws;
  session._lastConfig = config;
  bindOpenClawOutputContext(session, ws, config);
  startAssistantReplyLog(session, config, { agentType: 'openclaw' });
  resetOpenClawAssistantText(session);

  const agentConfig = config.agents?.openclaw || {};
  const agentId = resolveOpenClawAgentId(input, session, agentConfig);
  const inputWithOutbox = maybeAddOutboxHint(input, session, config);

  try {
    const gatewayUrl = await ensureOpenClawGateway(agentConfig, config.logger);
    const client = await ensureOpenClawClient(session, agentConfig, gatewayUrl, config);
    client.requireMethods(REQUIRED_METHODS.filter(method => method !== 'chat.abort'));

    const sessionKey = await ensureOpenClawSession(client, session, agentId, input, agentConfig);
    await subscribeSession(client, sessionKey, config);

    const runId = crypto.randomUUID();
    session.openclawRunId = runId;
    session.openclawLastText = '';
    session.openclawFinished = false;

    const done = new Promise(resolve => {
      session._openclawFinish = resolve;
    });
    armOpenClawTurnTimeout(ws, session, config, agentConfig);

    const sendStarted = client.request('chat.send', {
      sessionKey,
      message: stringifyInput(inputWithOutbox),
      deliver: false,
      idempotencyKey: runId,
      attachments: buildOpenClawAttachments(inputWithOutbox),
    }, { timeoutMs: null }).catch(err => {
      if (session.isTurnActive) throw err;
      return null;
    });

    const result = await Promise.race([
      sendStarted,
      done.then(() => null),
    ]);
    if (!session.isTurnActive) return;
    if (result?.runId) session.openclawRunId = result.runId;
    config.logger?.info('openclaw run started', {
      runId: session.openclawRunId,
      sessionKey,
      agentId,
    });

    await done;
  } catch (err) {
    if (session.isTurnActive) {
      if (!isClosedAbort(err)) {
        const message = `OpenClaw error: ${sanitizeOpenClawErrorMessage(err.message)}`;
        failActiveOpenClawCompaction(ws, session, config, 'process_unavailable', message);
        sendError(ws, message);
        sendTurnEnd(ws, session, 'error', { error: message });
      }
      finishTurn(ws, session, config, { drain: !isClosedAbort(err) });
    }
  }
}

async function ensureOpenClawClient(session, agentConfig, gatewayUrl, config) {
  const current = session.openclawClient;
  if (current?.connected) return current;
  if (current) current.close();

  const client = new OpenClawGatewayClient({
    url: gatewayUrl,
    agentConfig,
    logger: config.logger,
    requestTimeoutMs: agentConfig.requestTimeoutMs || 30000,
  });
  session.openclawClient = client;
  session.openclawGatewayUrl = gatewayUrl;
  session.openclawUnsubscribeEvents = client.onEvent((event, payload, frame) => {
    routeOpenClawGatewayEvent(event, payload, frame, session, config);
  });
  session.openclawUnsubscribeClose = client.onClose(err => {
    routeOpenClawGatewayClose(err, session, config);
  });
  session.agentProcess = createOpenClawProcessHandle(session, client);
  await client.connect();
  return client;
}

function bindOpenClawOutputContext(session, ws, config) {
  session.openclawOutputContext = { ws, config };
}

function openClawOutputContext(session, fallbackConfig) {
  const active = session?.openclawOutputContext;
  return {
    ws: active?.ws || session?._lastWs || session?.ws,
    config: active?.config || session?._lastConfig || fallbackConfig || {},
  };
}

function clearOpenClawOutputContext(session, ws) {
  if (!session?.openclawOutputContext) return;
  if (ws && session.openclawOutputContext.ws !== ws) return;
  session.openclawOutputContext = null;
}

function routeOpenClawGatewayEvent(event, payload, frame, session, fallbackConfig) {
  const output = openClawOutputContext(session, fallbackConfig);
  handleOpenClawEvent(event, payload, frame, output.ws, session, output.config);
}

function routeOpenClawGatewayClose(err, session, fallbackConfig) {
  const output = openClawOutputContext(session, fallbackConfig);
  handleOpenClawGatewayClose(err, output.ws, session, output.config);
}

async function ensureOpenClawSession(client, session, agentId, input, agentConfig) {
  if (session.agentSessionId && isSessionKeyForAgent(session.agentSessionId, agentId)) {
    session.openclawAgentId = agentId;
    return session.agentSessionId;
  }

  const requestedKey = buildOpenClawSessionKey(agentId, session);
  const params = {
    key: requestedKey,
    agentId,
    label: buildOpenClawSessionLabel(input, session),
  };
  const model = String(session.openclawModelOverride || agentConfig.model || '').trim();
  if (model) params.model = model;

  const created = await client.request('sessions.create', params);
  const sessionKey = created?.key || requestedKey;
  session.openclawAgentId = agentId;
  persistAgentSessionId(session, sessionKey);
  ensureHistoryEntry(session, sessionKey, input);
  return sessionKey;
}

async function subscribeSession(client, sessionKey, config) {
  if (!client.supports('sessions.messages.subscribe')) return;
  try {
    await client.request('sessions.messages.subscribe', { key: sessionKey });
  } catch (err) {
    config.logger?.warn?.('openclaw session message subscribe failed', { sessionKey, error: err.message });
  }
}

function handleOpenClawEvent(event, payload, frame, ws, session, config) {
  if (!ws || !session) return;

  if (isOpenClawCompactionEvent(event, payload || {})) {
    handleOpenClawCompactionEvent(event, payload || {}, ws, session, config);
    return;
  }

  if (isOpenClawCompactionStatusEvent(event, payload || {})) {
    return;
  }

  if (event === 'chat') {
    handleChatEvent(payload || {}, ws, session, config);
    return;
  }
  if (event === 'chat.side_result') {
    handleToolEvent(event, payload || {}, ws, session);
    return;
  }
  if (isOpenClawGatewayToolEvent(event, payload || {})) {
    handleToolEvent(event, payload || {}, ws, session);
    return;
  }
  if (event === 'agent' || event === 'session.tool') return;
  if (event === 'exec.approval.requested') {
    handleApprovalRequest('exec', payload || {}, ws, session, config);
    return;
  }
  if (event === 'plugin.approval.requested') {
    handleApprovalRequest('plugin', payload || {}, ws, session, config);
    return;
  }
  if (event === 'exec.approval.resolved' || event === 'plugin.approval.resolved') {
    return;
  }
  if (isOpenClawActionEvent(event, payload || {})) {
    handleToolEvent(event, payload || {}, ws, session);
  }
}

function handleChatEvent(payload, ws, session, config) {
  if (!matchesCurrentRun(payload, session)) return;
  if (payload.runId && !session.openclawRunId) session.openclawRunId = payload.runId;

  if (payload.state === 'delta') {
    const reasoning = extractReasoningText(payload);
    if (reasoning && shouldEmitOpenClawReasoning(session)) send(ws, 'thinking', { text: reasoning, mode: 'summary' });

    if (session.openclawCompaction && (session.openclawCompaction.trigger === 'manual' || isOpenClawCompactionStatusPayload(payload))) {
      extractDeltaText(payload, session);
      return;
    }

    const delta = extractDeltaText(payload, session);
    if (delta) appendOpenClawAssistantText(delta, ws, session);
    return;
  }

  if (payload.state === 'final') {
    const finalText = extractMessageText(payload.message);
    if (finalText && finalText.startsWith(session.openclawLastText || '')) {
      const delta = finalText.slice((session.openclawLastText || '').length);
      if (delta) appendOpenClawAssistantText(delta, ws, session);
    } else if (finalText && !session.openclawLastText) {
      appendOpenClawAssistantText(finalText, ws, session);
    }
    completeRun(payload, ws, session, config);
    return;
  }

  if (payload.state === 'aborted') {
    flushOpenClawAssistantText(ws, session);
    if (session.streamState?.assistantStarted) send(ws, 'assistant_end', {});
    sendSystem(ws, 'OpenClaw run stopped.');
    sendTurnEnd(ws, session, 'cancelled');
    finishTurn(ws, session, config, { drain: false });
    return;
  }

  if (payload.state === 'error') {
    sendError(ws, payload.errorMessage || 'OpenClaw run failed.');
    sendTurnEnd(ws, session, 'error', { error: payload.errorMessage || 'OpenClaw run failed.' });
    finishTurn(ws, session, config);
  }
}

function completeRun(payload, ws, session, config) {
  if (completeManualOpenClawCompaction(ws, session)) {
    sendTurnEnd(ws, session);
    finishTurn(ws, session, config);
    return;
  }
  const hadOutput = session.streamState?.assistantStarted || Boolean(extractMessageText(payload.message));
  flushOpenClawAssistantText(ws, session);
  if (hadOutput) send(ws, 'assistant_end', {});
  else sendSystem(ws, 'OpenClaw returned no output.');
  updateOpenClawSessionStats(session, payload.usage);
  sendTurnEnd(ws, session);
  finishTurn(ws, session, config);
}

function finishTurn(ws, session, config, options = {}) {
  const { drain = true } = options;
  clearOpenClawTurnTimeout(session);
  session.openclawRunId = null;
  session.openclawLastText = '';
  session.openclawFinished = true;
  const resolve = session._openclawFinish;
  session._openclawFinish = null;
  session.isTurnActive = false;
  session.currentInputForNoOutput = null;
  clearPendingPermissions(session, 'openclaw');
  flushOpenClawAssistantText(ws, session);
  resetOpenClawAssistantText(session);
  clearOpenClawOutputContext(session, ws);
  if (typeof resolve === 'function') resolve();
  if (drain) drainQueue(ws, session, config);
}

function handleOpenClawGatewayClose(err, ws, session, config) {
  failActiveOpenClawCompaction(ws, session, config, 'app_server_closed', `OpenClaw Gateway disconnected: ${err?.message || 'connection closed'}`);
  if (!session?.isTurnActive) return;
  const message = `OpenClaw Gateway disconnected: ${err?.message || 'connection closed'}`;
  config.logger?.warn?.('openclaw gateway disconnected during turn', {
    sessionId: session.id,
    runId: session.openclawRunId,
    error: err?.message,
  });
  sendError(ws, message);
  sendTurnEnd(ws, session, 'error', { error: message });
  finishTurn(ws, session, config);
}

function handleToolEvent(event, payload, ws, session) {
  promotePendingProgress(ws, session);
  flushTextStream(ws, session.streamState);
  const tool = normalizeOpenClawToolEvent(event, payload);
  if (tool.isTerminal) {
    send(ws, 'tool_result', {
      id: tool.id,
      toolUseId: tool.id,
      name: tool.name,
      output: stringifyToolPayload(tool.output),
      isError: tool.isError,
    });
    markOpenClawAssistantBreak(session);
    return;
  }
  send(ws, 'tool_call', {
    id: tool.id,
    name: tool.name,
    input: stringifyToolPayload(tool.input),
  });
  markOpenClawAssistantBreak(session);
}

function isOpenClawGatewayToolEvent(event, payload = {}) {
  if (event !== 'agent' && event !== 'session.tool') return false;
  const phase = String(payload.data?.phase || '').toLowerCase();
  return payload.stream === 'tool' && (phase === 'start' || phase === 'result');
}

function normalizeOpenClawToolEvent(event, payload = {}) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const toolPayload = Object.keys(data).length ? { ...payload, ...data } : payload;
  const phase = String(data.phase || payload.phase || payload.state || payload.status || event || '').toLowerCase();
  return {
    id: openClawActionId(event, toolPayload),
    name: openClawActionName(event, toolPayload),
    input: openClawActionInput(toolPayload),
    output: openClawActionOutput(toolPayload),
    isTerminal: isTerminalOpenClawAction(event, toolPayload, phase),
    isError: isOpenClawActionError(event, toolPayload, phase),
  };
}

function isOpenClawActionEvent(event, payload = {}) {
  const name = String(event || '').toLowerCase();
  if (
    name.includes('tool') ||
    name.includes('node') ||
    name.includes('plugin') ||
    name.includes('exec') ||
    name.includes('command') ||
    name.includes('action') ||
    name.includes('step') ||
    name.includes('task') ||
    name.endsWith('side_result')
  ) {
    return true;
  }
  return Boolean(
    payload.tool ||
    payload.plugin ||
    payload.node ||
    payload.command ||
    payload.rawCommand ||
    payload.action ||
    payload.step ||
    payload.systemRunPlan ||
    payload.data?.phase ||
    payload.data?.toolCallId
  );
}

function openClawActionId(event, payload = {}) {
  return String(
    payload.id ||
    payload.toolCallId ||
    payload.itemId ||
    payload.callId ||
    payload.actionId ||
    payload.action_id ||
    payload.stepId ||
    payload.step_id ||
    payload.commandId ||
    payload.command_id ||
    payload.action?.id ||
    payload.step?.id ||
    `${payload.runId || 'openclaw'}:${event}:${payload.sequence || payload.index || Date.now()}`
  );
}

function openClawActionName(event, payload = {}) {
  return String(
    payload.bridgeTargetToolName ||
    payload.tool ||
    payload.name ||
    payload.plugin ||
    payload.node ||
    payload.command ||
    payload.rawCommand ||
    payload.action?.name ||
    payload.action?.type ||
    payload.step?.name ||
    payload.step?.type ||
    payload.systemRunPlan?.rawCommand ||
    event ||
    'OpenClaw action'
  );
}

function openClawActionInput(payload = {}) {
  return payload.input ??
    payload.args ??
    payload.arguments ??
    payload.params ??
    payload.command ??
    payload.rawCommand ??
    payload.systemRunPlan ??
    payload.action?.input ??
    payload.step?.input ??
    payload;
}

function openClawActionOutput(payload = {}) {
  return payload.output ??
    payload.result ??
    payload.errorMessage ??
    payload.error ??
    payload.action?.output ??
    payload.action?.result ??
    payload.step?.output ??
    payload.step?.result ??
    payload;
}

function isTerminalOpenClawAction(event, payload = {}, phase) {
  const state = String(phase || payload.state || payload.status || payload.phase || event || '').toLowerCase();
  return state.includes('result') ||
    state.includes('complete') ||
    state.includes('completed') ||
    state.includes('done') ||
    state.includes('success') ||
    state.includes('failed') ||
    state.includes('failure') ||
    state.includes('error') ||
    String(event || '').endsWith('side_result');
}

function isOpenClawActionError(event, payload = {}, phase) {
  const state = String(phase || payload.state || payload.status || payload.phase || event || '').toLowerCase();
  return payload.error === true ||
    Boolean(payload.errorMessage) ||
    state.includes('error') ||
    state.includes('fail');
}

function handleApprovalRequest(kind, payload, ws, session, config) {
  const requestId = String(
    payload.id ||
    payload.requestId ||
    payload.approvalId ||
    `${kind}-${session.openclawRunId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  if (getPendingPermission(session, requestId, 'openclaw')) return;

  const input = formatApprovalInput(kind, payload);
  setPendingPermission(session, {
    provider: 'openclaw',
    requestId,
    approvalKind: kind,
    runId: payload.runId || session.openclawRunId,
    toolName: kind === 'exec' ? 'exec' : (payload.plugin || payload.name || 'plugin'),
    input,
  });

  if (session.autoApprove === true) {
    config.logger?.info('openclaw permission auto-approved', { sessionId: session.id, requestId, kind });
    resolvePendingPermission(true, ws, session, config, requestId, { silent: true }).catch(err => {
      sendError(ws, `OpenClaw auto approval failed: ${err.message}`);
    });
    return;
  }

  send(ws, 'permission_request', {
    requestId,
    toolName: kind === 'exec' ? 'exec' : (payload.plugin || payload.name || 'plugin'),
    input,
  });
}

async function resolvePendingPermission(approved, ws, session, config, requestId, options = {}) {
  const pending = getPendingPermission(session, requestId, 'openclaw');
  if (!pending) {
    config.logger?.warn('openclaw permission response without pending request', {
      sessionId: session.id,
      requestId: requestId || '',
      pendingRequestIds: pendingPermissionIds(session, 'openclaw'),
    });
    return false;
  }

  const client = await getOrCreateClientForResponse(session, config);
  const method = pending.approvalKind === 'plugin'
    ? 'plugin.approval.resolve'
    : 'exec.approval.resolve';
  removePendingPermission(session, pending.requestId);

  try {
    await client.request(method, {
      id: pending.requestId,
      decision: approved ? 'allow-once' : 'deny',
    });
    if (!options.silent) {
      sendSystem(ws, approved ? 'OpenClaw operation approved.' : 'OpenClaw operation denied.');
    }
  } catch (err) {
    sendError(ws, `OpenClaw approval response failed: ${err.message}`);
  }
  return true;
}

async function getOrCreateClientForResponse(session, config) {
  if (session.openclawClient?.connected) return session.openclawClient;
  const agentConfig = config.agents?.openclaw || {};
  const gatewayUrl = session.openclawGatewayUrl || normalizeGatewayUrl(agentConfig.gatewayUrl || DEFAULT_GATEWAY_URL);
  return ensureOpenClawClient(session, agentConfig, gatewayUrl, config);
}

function compactOpenClawContext(ws, session, config, options = {}) {
  const nativeCommand = options.nativeCommand || '/compact';
  const trigger = options.trigger || 'manual';

  if (session.isTurnActive) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({ input: nativeCommand, ws, compact: true, trigger, nativeCommand });
    sendSystem(ws, `OpenClaw is handling the previous message. Queued (${session.messageQueue.length}).`);
    return true;
  }

  session._lastWs = ws;
  session._lastConfig = config;
  if (session.openclawCompaction && !session.openclawCompaction.completed) {
    failActiveOpenClawCompaction(ws, session, config, 'superseded', 'Another OpenClaw context compaction started before the previous one completed.');
  }
  handleOpenClawCompactionStarted('context_compaction.started', {
    compactionId: `openclaw-compact-${Date.now()}`,
    trigger,
    manual: true,
    nativeCommand,
  }, ws, session, config);
  execute(nativeCommand, ws, session, config);
  return true;
}

function modelOpenClawContext(ws, session, config, options = {}) {
  const command = options.command || 'show';

  if (session.isTurnActive || (session.openclawCompaction && !session.openclawCompaction.completed)) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({
      input: options.nativeCommand || '/model',
      ws,
      modelCommand: true,
      modelOptions: options,
    });
    sendSystem(ws, `OpenClaw is handling the previous message. Queued /model (${session.messageQueue.length}).`);
    return true;
  }

  session._lastWs = ws;
  session._lastConfig = config;
  if (command === 'list') {
    sendOpenClawModelList(ws, session, config);
    return true;
  }
  if (command === 'show') {
    sendOpenClawModelStatus(ws, session, config);
    return true;
  }
  if (command === 'clear') {
    session.openclawModelOverride = null;
    saveSessionMetadata(session);
    execute(options.nativeCommand || '/model --clear', ws, session, config);
    return true;
  }

  setOpenClawModel(ws, session, config, options.model);
  return true;
}

function sendOpenClawModelList(ws, session, config) {
  Promise.all([
    loadOpenClawModelNames(session, config),
    currentOpenClawModel(session, config),
  ]).then(([models, current]) => {
    const actions = models.map((model, index) => ({
      label: model === current ? `✓ ${model}` : model,
      text: `/model switch ${index + 1}`,
      command: `/model switch ${index + 1}`,
      type: 'command',
      action: 'select',
      model,
    }));
    send(ws, 'system', {
      text: formatOpenClawModelList(models, current),
      actions,
      quickActions: actions,
      quickReplies: actions,
    });
    sendTurnEnd(ws, session);
  }).catch(err => {
    const models = openClawFallbackModels(session, config);
    const current = String(session.openclawModelOverride || config.agents?.openclaw?.model || '').trim();
    const actions = models.map((model, index) => ({
      label: model === current ? `* ${model}` : model,
      text: `/model switch ${index + 1}`,
      command: `/model switch ${index + 1}`,
      type: 'command',
      action: 'select',
      model,
    }));
    send(ws, 'system', {
      text: [
        `Current OpenClaw model: ${current || '(default)'}`,
        `OpenClaw models.list failed; showing fallback choices. ${err.message}`,
        '',
        ...(models.length
          ? models.map((model, index) => `${index + 1}. ${model}${model === current ? ' (current)' : ''}`)
          : ['No configured fallback models found. You can still send /model <name> manually.']),
      ].join('\n'),
      actions,
      quickActions: actions,
      quickReplies: actions,
    });
    sendTurnEnd(ws, session);
  });
}

function sendOpenClawModelStatus(ws, session, config) {
  currentOpenClawModel(session, config).then(current => {
    const lines = [`OpenClaw model override: ${session.openclawModelOverride || '(none)'}`];
    if (config.agents?.openclaw?.model) lines.push(`Configured default: ${config.agents.openclaw.model}`);
    lines.push(`Current session model: ${current || '(default)'}`);
    lines.push('Use /model <name> to ask OpenClaw to switch the current gateway session model.');
    sendSystem(ws, lines.join('\n'));
    sendTurnEnd(ws, session);
  }).catch(err => {
    sendError(ws, `OpenClaw model status failed: ${err.message}`);
    sendTurnEnd(ws, session, 'error', { error: err.message });
  });
}

function setOpenClawModel(ws, session, config, modelInput) {
  const raw = String(modelInput || '').trim();
  if (!raw) {
    sendError(ws, 'Please specify an OpenClaw model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_model' });
    return;
  }

  if (/^\d+$/.test(raw)) {
    loadOpenClawModelNames(session, config)
      .then(models => setOpenClawModel(ws, session, config, resolveOpenClawModelInput(raw, models)))
      .catch(err => {
        const fallback = openClawFallbackModels(session, config);
        const resolved = resolveOpenClawModelInput(raw, fallback);
        if (resolved !== raw) {
          setOpenClawModel(ws, session, config, resolved);
          return;
        }
        sendError(ws, `OpenClaw model selection failed: ${err.message}`);
        sendTurnEnd(ws, session, 'error', { error: err.message });
      });
    return;
  }

  session.openclawModelOverride = raw;
  saveSessionMetadata(session);
  execute(`/model ${quoteNativeSlashArg(raw)}`, ws, session, config);
}

async function loadOpenClawModelNames(session, config) {
  const client = await getOrCreateClientForResponse(session, config);
  const result = await client.request('models.list', {});
  const models = normalizeOpenClawModelList(result);
  if (models.length > 0) return models;
  throw new Error('models.list returned no models.');
}

async function currentOpenClawModel(session, config) {
  if (session.openclawModelOverride) return String(session.openclawModelOverride).trim();
  if (session.agentSessionId) {
    try {
      const client = await getOrCreateClientForResponse(session, config);
      const result = await client.request('sessions.describe', { key: session.agentSessionId });
      const model = String(result?.session?.model || result?.resolved?.model || '').trim();
      const provider = String(result?.session?.modelProvider || result?.resolved?.modelProvider || '').trim();
      return provider && model && !model.includes('/') ? `${provider}/${model}` : model;
    } catch (err) {
      config.logger?.warn?.('openclaw model status lookup failed', { sessionId: session.id, error: err.message });
    }
  }
  return String(config.agents?.openclaw?.model || '').trim();
}

function normalizeOpenClawModelList(result) {
  const source = Array.isArray(result)
    ? result
    : Array.isArray(result?.models)
      ? result.models
      : Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.items)
          ? result.items
          : [];
  const models = [];
  for (const item of source) {
    const provider = String(item?.provider || '').trim();
    const id = String(item?.key || item?.id || item?.model || item?.name || item || '').trim();
    if (!id) continue;
    models.push(provider && !id.includes('/') ? `${provider}/${id}` : id);
  }
  return uniqueModelNames(models);
}

function openClawFallbackModels(session, config) {
  return uniqueModelNames([
    session?.openclawModelOverride,
    config?.agents?.openclaw?.model,
  ]);
}

function formatOpenClawModelList(models, current) {
  return [
    `Current OpenClaw model: ${current || '(default)'}`,
    '',
    ...models.map((model, index) => `${index + 1}. ${model}${model === current ? ' (current)' : ''}`),
    '',
    'Use /model <number>, /model switch <number>, or /model <name>.',
  ].join('\n');
}

function resolveOpenClawModelInput(input, models) {
  const raw = String(input || '').trim();
  const index = Number.parseInt(raw, 10);
  if (String(index) === raw && index >= 1 && index <= models.length) return models[index - 1];
  const exact = models.find(model => model.toLowerCase() === raw.toLowerCase());
  return exact || raw;
}

function quoteNativeSlashArg(value) {
  const text = String(value || '');
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
}

function uniqueModelNames(models) {
  const seen = new Set();
  const result = [];
  for (const model of models || []) {
    const value = String(model || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function resolvePendingDanger(confirmed, ws, session, config) {
  const pending = session.pendingDanger;
  if (!pending) return false;
  session.pendingDanger = null;
  if (!confirmed) {
    sendSystem(ws, 'Dangerous operation cancelled.');
    return true;
  }
  execute(pending.input, ws, session, config);
  return true;
}

function stop(session, options = {}) {
  const client = session.openclawClient;
  const sessionKey = session.agentSessionId;
  const runId = session.openclawRunId;
  if (client?.connected && sessionKey) {
    const params = runId ? { sessionKey, runId } : { sessionKey };
    client.request('chat.abort', params).catch(() => {});
  }
  finishTurn(session._lastWs || session.ws, session, session._lastConfig || {}, { drain: false });
  stopSessionProcess(session, options);
}

async function warmup(ws, session, config) {
  session._lastWs = ws;
  session._lastConfig = config;
  const agentConfig = config.agents?.openclaw || {};
  const agentId = resolveOpenClawAgentId([], session, agentConfig);
  const gatewayUrl = await ensureOpenClawGateway(agentConfig, config.logger);
  const client = await ensureOpenClawClient(session, agentConfig, gatewayUrl, config);
  client.requireMethods(REQUIRED_METHODS.filter(method => method !== 'chat.abort'));
  const sessionKey = await ensureOpenClawSession(client, session, agentId, [], agentConfig);
  await subscribeSession(client, sessionKey, config);
  return { supported: true, process: 'openclaw gateway', sessionKey };
}

function createOpenClawProcessHandle(session, client) {
  const handle = {
    killed: false,
    exitCode: null,
    stdin: {
      destroyed: false,
      end() {
        this.destroyed = true;
        handle.kill();
      },
    },
    kill() {
      if (this.killed) return;
      this.killed = true;
      this.exitCode = 0;
      if (session.agentSessionId && session.openclawRunId && client.connected) {
        client.request('chat.abort', {
          sessionKey: session.agentSessionId,
          runId: session.openclawRunId,
        }).catch(() => {});
      }
      if (session.openclawUnsubscribeEvents) {
        try { session.openclawUnsubscribeEvents(); } catch {}
        session.openclawUnsubscribeEvents = null;
      }
      if (session.openclawUnsubscribeClose) {
        try { session.openclawUnsubscribeClose(); } catch {}
        session.openclawUnsubscribeClose = null;
      }
      client.close();
      if (session.openclawClient === client) session.openclawClient = null;
    },
  };
  return handle;
}

function ensureHistoryEntry(session, sessionKey, input) {
  if (!session.agentSessionHistory) session.agentSessionHistory = [];
  if (session.agentSessionHistory.some(entry => entry.id === sessionKey)) return;
  for (const entry of session.agentSessionHistory) entry.isActive = false;
  const entry = createAgentSessionEntry(session, sessionKey, firstText(input));
  entry.isActive = true;
  session.agentSessionHistory.push(entry);
  saveSessionMetadata(session);
}

function updateOpenClawSessionStats(session, usage = {}) {
  session.messageCount = (session.messageCount || 0) + 1;
  if (!session.usage) {
    session.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  session.usage.inputTokens += usage.inputTokens || usage.input_tokens || usage.input || 0;
  session.usage.outputTokens += usage.outputTokens || usage.output_tokens || usage.output || 0;
  updateAgentSessionHistory(session);
}

function numberFromProcessEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function openclawCompactionTimeoutMs(session, config) {
  const configured = Number(config?.agents?.openclaw?.compactionTimeoutMs || session?._lastConfig?.agents?.openclaw?.compactionTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return numberFromProcessEnv('LINCO_OPENCLAW_COMPACTION_TIMEOUT_MS', DEFAULT_OPENCLAW_COMPACTION_TIMEOUT_MS);
}

function shouldEmitOpenClawReasoning(session) {
  return !session?.openclawCompaction;
}

function isOpenClawCompactionStatusEvent(event, payload = {}) {
  if (!payload || !payload.sessionKey && !payload.runId && !payload.data) return false;
  const name = String(event || '').toLowerCase();
  const stream = String(payload.stream || '').toLowerCase();
  const dataType = String(payload.data?.type || payload.data?.kind || '').toLowerCase();
  return Boolean(sessionCompactionActiveHint(payload)) && (
    name === 'status' ||
    name === 'progress' ||
    name === 'chat.status' ||
    name === 'chat.progress' ||
    name === 'run.status' ||
    name === 'run.progress' ||
    stream === 'status' ||
    stream === 'progress' ||
    dataType === 'status' ||
    dataType === 'progress'
  );
}

function sessionCompactionActiveHint(payload = {}) {
  return payload.compactionId ||
    payload.compaction_id ||
    payload.data?.compactionId ||
    payload.data?.compaction_id ||
    payload.contextCompaction ||
    payload.context_compaction ||
    payload.data?.contextCompaction ||
    payload.data?.context_compaction;
}

function isOpenClawCompactionStatusPayload(payload = {}) {
  const state = String(payload.state || payload.status || payload.kind || payload.type || payload.message?.type || '').toLowerCase();
  const role = String(payload.role || payload.message?.role || '').toLowerCase();
  return state.includes('status') || state.includes('progress') || role === 'status' || role === 'system';
}

function isOpenClawCompactionEvent(event, payload = {}) {
  if (!matchesOpenClawCompactionTarget(payload, payload.data || {}, null)) return false;
  const name = String(event || '').toLowerCase().replace(/-/g, '_');
  const stream = String(payload.stream || '').toLowerCase().replace(/-/g, '_');
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const type = String(payload.type || payload.kind || data.type || data.kind || '').toLowerCase().replace(/-/g, '_');
  const phase = normalizeCompactionPhase(payload.phase || payload.state || payload.status || data.phase || data.state || data.status || phaseFromCompactionEventName(name));

  if (isExplicitCompactionEventName(name)) return Boolean(phase);
  if ((name === 'context_compaction' || name === 'context.compaction' || name === 'session.compaction' || name === 'session.context_compaction') && phase) return true;
  if ((stream === 'context_compaction' || stream === 'compaction') && phase) return true;
  if ((type === 'contextcompaction' || type === 'context_compaction' || type === 'compaction') && phase) return true;
  return false;
}

function isExplicitCompactionEventName(name) {
  return /(^|[._])(?:context_compaction|context\.compaction|compaction)(?:[._]|$)/.test(name);
}

function phaseFromCompactionEventName(name) {
  const parts = String(name || '').split(/[._]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normalizeCompactionPhase(value) {
  const phase = String(value || '').toLowerCase().replace(/-/g, '_');
  if (['started', 'start', 'begin', 'running', 'in_progress', 'compacting'].includes(phase)) return 'started';
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(phase)) return 'completed';
  if (['failed', 'fail', 'failure', 'error', 'errored', 'timeout', 'cancelled', 'canceled', 'aborted'].includes(phase)) return 'failed';
  return '';
}

function openClawCompactionId(payload = {}) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  return String(
    payload.compactionId ||
    payload.compaction_id ||
    payload.itemId ||
    payload.item_id ||
    data.compactionId ||
    data.compaction_id ||
    data.itemId ||
    data.item_id ||
    payload.id ||
    data.id ||
    ''
  ).trim();
}

function openClawCompactionTrigger(payload = {}) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  return String(payload.trigger || data.trigger || payload.reason || data.reason || payload.source || data.source || 'auto');
}

function matchesOpenClawCompactionTarget(payload = {}, data = payload.data || {}, session) {
  if (!session) return true;
  if (session.agentSessionId && payload.sessionKey && payload.sessionKey !== session.agentSessionId) return false;
  if (session.agentSessionId && data.sessionKey && data.sessionKey !== session.agentSessionId) return false;
  if (session.openclawRunId && payload.runId && payload.runId !== session.openclawRunId) return false;
  if (session.openclawRunId && data.runId && data.runId !== session.openclawRunId) return false;
  return true;
}

function handleOpenClawCompactionEvent(event, payload, ws, session, config) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  if (!matchesOpenClawCompactionTarget(payload, data, session)) return;
  const phase = normalizeCompactionPhase(payload.phase || payload.state || payload.status || data.phase || data.state || data.status || phaseFromCompactionEventName(event));
  if (phase === 'started') {
    handleOpenClawCompactionStarted(event, payload, ws, session, config);
  } else if (phase === 'completed') {
    handleOpenClawCompactionCompleted(event, payload, ws, session, config);
  } else if (phase === 'failed') {
    handleOpenClawCompactionFailed(event, payload, ws, session, config);
  }
}

function clearOpenClawCompactionTimers(compaction) {
  if (!compaction) return;
  if (compaction.staleTimerId) clearTimeout(compaction.staleTimerId);
  if (compaction.timeoutTimerId) clearTimeout(compaction.timeoutTimerId);
  compaction.staleTimerId = null;
  compaction.timeoutTimerId = null;
}

function sendOpenClawCompactionEvent(ws, session, phase, fields = {}) {
  if (!ws) return false;
  const linco = ws.linco || session?.linco || {};
  send(ws, 'context_compaction', {
    phase,
    compactionId: fields.compactionId,
    agentType: 'openclaw',
    trigger: fields.trigger,
    sessionKey: session?.id,
    agentSessionId: session?.agentSessionId,
    streamId: linco.streamId,
    requestId: linco.messageId,
    durationMs: fields.durationMs,
    result: fields.result,
    error: fields.error,
    text: fields.text,
    ts: fields.ts || Date.now(),
  });
  return true;
}

function handleOpenClawCompactionStarted(event, payload, ws, session, config) {
  if (session.openclawCompaction && !session.openclawCompaction.completed) {
    if (session.openclawCompaction.trigger === 'manual') return;
    failActiveOpenClawCompaction(ws, session, config, 'superseded', 'Another OpenClaw context compaction started before the previous one completed.');
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const compactionId = openClawCompactionId(payload) || `openclaw-compact-${Date.now()}`;
  const startedAt = Date.now();
  const compaction = {
    id: compactionId,
    trigger: openClawCompactionTrigger(payload),
    nativeCommand: payload.nativeCommand || data.nativeCommand,
    startedAt,
    staleTimerId: null,
    timeoutTimerId: null,
    staleNotified: false,
    completed: false,
  };
  session.openclawCompaction = compaction;

  sendOpenClawCompactionEvent(ws, session, 'started', {
    compactionId,
    trigger: compaction.trigger,
    text: 'Compacting OpenClaw context...',
    ts: startedAt,
  });

  compaction.staleTimerId = setTimeout(() => {
    if (session.openclawCompaction !== compaction || compaction.completed) return;
    compaction.staleNotified = true;
    sendOpenClawCompactionEvent(ws, session, 'stale', {
      compactionId,
      trigger: compaction.trigger,
      durationMs: Date.now() - startedAt,
      text: 'OpenClaw context compaction is still running.',
    });
  }, OPENCLAW_COMPACTION_STALE_MS);
  compaction.staleTimerId.unref?.();

  compaction.timeoutTimerId = setTimeout(() => {
    if (session.openclawCompaction !== compaction || compaction.completed) return;
    failActiveOpenClawCompaction(ws, session, config, 'timeout', 'OpenClaw context compaction timed out.');
  }, openclawCompactionTimeoutMs(session, config));
  compaction.timeoutTimerId.unref?.();
}

function handleOpenClawCompactionCompleted(event, payload, ws, session, config) {
  const active = session.openclawCompaction;
  const id = openClawCompactionId(payload);
  if (!active) {
    config?.logger?.warn?.('openclaw context compaction completed without active state', { id });
    return;
  }
  if (id && active.id !== id) {
    config?.logger?.warn?.('openclaw context compaction completed with mismatched id', { activeId: active.id, completedId: id });
    return;
  }

  active.completed = true;
  clearOpenClawCompactionTimers(active);
  sendOpenClawCompactionEvent(ws, session, 'completed', {
    compactionId: active.id,
    trigger: active.trigger,
    durationMs: Date.now() - active.startedAt,
    result: compactResultPreview(payload),
    text: 'OpenClaw context compaction completed.',
  });
  session.openclawCompaction = null;
}

function handleOpenClawCompactionFailed(event, payload, ws, session, config) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const code = String(payload.error?.code || data.error?.code || payload.errorCode || data.errorCode || payload.status || data.status || 'agent_error');
  const message = String(payload.error?.message || data.error?.message || payload.errorMessage || data.errorMessage || payload.message || data.message || 'OpenClaw context compaction failed.');
  if (!session.openclawCompaction) {
    handleOpenClawCompactionStarted(event, payload, ws, session, config);
  }
  failActiveOpenClawCompaction(ws, session, config, code, message);
}

function failActiveOpenClawCompaction(ws, session, config, code, message) {
  const active = session?.openclawCompaction;
  if (!active || active.completed) return false;
  clearOpenClawCompactionTimers(active);
  sendOpenClawCompactionEvent(ws || session?._lastWs, session, 'failed', {
    compactionId: active.id,
    trigger: active.trigger,
    durationMs: Date.now() - active.startedAt,
    error: { code, message: String(message || code) },
    text: 'OpenClaw context compaction failed; current session was preserved.',
  });
  session.openclawCompaction = null;
  return true;
}

function completeManualOpenClawCompaction(ws, session) {
  const active = session?.openclawCompaction;
  if (!active || active.completed || active.trigger !== 'manual') return false;
  active.completed = true;
  clearOpenClawCompactionTimers(active);
  sendOpenClawCompactionEvent(ws || session?._lastWs, session, 'completed', {
    compactionId: active.id,
    trigger: active.trigger,
    durationMs: Date.now() - active.startedAt,
    result: { nativeCommand: active.nativeCommand || '/compact' },
    text: 'OpenClaw context compaction completed.',
  });
  session.openclawCompaction = null;
  return true;
}

function compactResultPreview(payload = {}) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const result = payload.result || data.result || payload.summary || data.summary;
  if (!result || typeof result === 'string') return undefined;
  return result;
}

function extractDeltaText(payload, session) {
  if (typeof payload.deltaText === 'string') {
    if (payload.replace) {
      const previous = session.openclawLastText || '';
      session.openclawLastText = payload.deltaText;
      return payload.deltaText.startsWith(previous) ? payload.deltaText.slice(previous.length) : payload.deltaText;
    }
    session.openclawLastText = `${session.openclawLastText || ''}${payload.deltaText}`;
    return payload.deltaText;
  }

  const cumulative = extractMessageText(payload.message);
  if (!cumulative) return '';
  const previous = session.openclawLastText || '';
  session.openclawLastText = cumulative;
  return cumulative.startsWith(previous) ? cumulative.slice(previous.length) : cumulative;
}

function extractReasoningText(payload) {
  if (typeof payload.reasoningDelta === 'string') return payload.reasoningDelta;
  if (typeof payload.thinkingDelta === 'string') return payload.thinkingDelta;
  if (typeof payload.reasoning === 'string') return payload.reasoning;
  if (typeof payload.thinking === 'string') return payload.thinking;
  if (typeof payload.message?.reasoning === 'string') return payload.message.reasoning;
  if (typeof payload.message?.thinking === 'string') return payload.message.thinking;
  return '';
}

function matchesCurrentRun(payload, session) {
  if (!payload) return false;
  if (session.agentSessionId && payload.sessionKey && payload.sessionKey !== session.agentSessionId) return false;
  if (session.openclawRunId && payload.runId && payload.runId !== session.openclawRunId) return false;
  return true;
}

function buildOpenClawAttachments(input) {
  if (!Array.isArray(input)) return undefined;
  const attachments = [];
  for (const block of input) {
    if (block?.type !== 'image') continue;
    const mediaType = block.source?.media_type || 'image/png';
    const data = block.source?.data;
    if (!data) continue;
    attachments.push({
      type: mediaType.startsWith('image/') ? 'image' : 'file',
      mimeType: mediaType,
      fileName: path.basename(block.path || `image.${extensionForMime(mediaType)}`),
      content: data,
    });
  }
  return attachments.length ? attachments : undefined;
}

function stringifyInput(input) {
  if (!Array.isArray(input)) return String(input || '');
  return input.map(block => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'meta') return '';
    if (block?.type === 'image') {
      const name = block.path ? path.basename(block.path) : 'image';
      return `[image attachment: ${name}]`;
    }
    return JSON.stringify(block);
  }).filter(Boolean).join('\n');
}

function maybeAddOutboxHint(input, session, config) {
  return appendBridgeContextHint(buildFileReferenceHint(input, session));
}

function armOpenClawTurnTimeout(ws, session, config, agentConfig = {}) {
  clearOpenClawTurnTimeout(session);
  const timeoutMs = Number(agentConfig.turnTimeoutMs) > 0
    ? Number(agentConfig.turnTimeoutMs)
    : DEFAULT_TURN_TIMEOUT_MS;
  session.openclawTurnTimer = setTimeout(() => {
    if (!session.isTurnActive) return;
    const message = `OpenClaw turn timed out after ${Math.round(timeoutMs / 1000)}s.`;
    config.logger?.warn?.('openclaw turn timeout', {
      sessionId: session.id,
      runId: session.openclawRunId,
      timeoutMs,
    });
    if (session.openclawClient?.connected && session.agentSessionId) {
      const params = session.openclawRunId
        ? { sessionKey: session.agentSessionId, runId: session.openclawRunId }
        : { sessionKey: session.agentSessionId };
      session.openclawClient.request('chat.abort', params).catch(() => {});
    }
    sendError(ws, message);
    sendTurnEnd(ws, session, 'timeout', { error: message });
    finishTurn(ws, session, config);
  }, timeoutMs);
  session.openclawTurnTimer.unref?.();
}

function clearOpenClawTurnTimeout(session) {
  if (!session.openclawTurnTimer) return;
  clearTimeout(session.openclawTurnTimer);
  session.openclawTurnTimer = null;
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (typeof message.content === 'string') return message.content;
  return '';
}

function appendOpenClawAssistantText(text, ws, session) {
  appendProgressiveAnswerText(text, ws, session);
  maybeAppendOpenClawAssistantBreak(ws, session);
  appendOpenClawAssistantTextNow(text, ws, session);
}

function appendOpenClawAssistantTextNow(text, ws, session) {
  ensureOpenClawStreamState(session);
  appendTextStream(text, ws, session.streamState, { phase: 'progress', ephemeral: true });
  rememberOpenClawAssistantText(session, text);
}

function flushOpenClawAssistantText(ws, session) {
  if (!session.streamState) return;
  flushTextStream(ws, session.streamState);
}

function resetOpenClawAssistantText(session) {
  ensureOpenClawStreamState(session);
  resetTextStream(session.streamState);
  resetProgressiveAnswer(session);
  session.openclawNeedsAssistantBreak = false;
  session.openclawAssistantTextTail = '';
}

function maybeAppendOpenClawAssistantBreak(ws, session) {
  if (!session?.openclawNeedsAssistantBreak || !session.streamState?.assistantStarted) {
    if (session) session.openclawNeedsAssistantBreak = false;
    return;
  }
  session.openclawNeedsAssistantBreak = false;
  const tail = `${session.openclawAssistantTextTail || ''}${session.streamState?.pendingText || ''}`;
  if (tail.endsWith('\n\n')) return;
  appendOpenClawAssistantTextNow(tail.endsWith('\n') ? '\n' : '\n\n', ws, session);
}

function markOpenClawAssistantBreak(session) {
  if (!session?.streamState?.assistantStarted) return;
  session.openclawNeedsAssistantBreak = true;
}

function rememberOpenClawAssistantText(session, text) {
  captureAssistantReplyText(session, text);
  const next = `${session.openclawAssistantTextTail || ''}${text || ''}`;
  session.openclawAssistantTextTail = next.slice(-4000);
}

function ensureOpenClawStreamState(session) {
  if (!session.streamState) {
    session.streamState = createTextStreamBuffer({ onStart: ws => send(ws, 'assistant_start', {}) });
  }
  session.streamState.onStart = ws => send(ws, 'assistant_start', {});
}

function formatApprovalInput(kind, payload) {
  if (kind === 'exec') {
    const command = payload.command || payload.rawCommand || payload.systemRunPlan?.rawCommand || '';
    const cwd = payload.cwd || payload.systemRunPlan?.cwd || '';
    return [command, cwd ? `cwd: ${cwd}` : ''].filter(Boolean).join('\n') || stringifyToolPayload(payload);
  }
  return payload.description || payload.prompt || payload.reason || stringifyToolPayload(payload);
}

function stringifyToolPayload(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function extensionForMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'png';
  }
}

function isClosedAbort(err) {
  const text = String(err?.message || '');
  return err?.name === 'AbortError' || text.includes('client closed') || text.includes('Gateway closed');
}

function drainQueue(ws, session, config) {
  const next = session.messageQueue.shift();
  if (!next) return;
  const nextInput = next && typeof next === 'object' && Object.prototype.hasOwnProperty.call(next, 'input')
    ? next.input
    : next;
  const nextWs = next && typeof next === 'object' && next.ws ? next.ws : ws;
  if (next && typeof next === 'object' && next.compact) {
    setImmediate(() => compactOpenClawContext(nextWs, session, config, {
      trigger: next.trigger || 'manual',
      nativeCommand: next.nativeCommand || '/compact',
    }));
    return;
  }
  if (next && typeof next === 'object' && next.modelCommand) {
    setImmediate(() => modelOpenClawContext(nextWs, session, config, next.modelOptions || { command: 'show', nativeCommand: next.input }));
    return;
  }
  setImmediate(() => execute(nextInput, nextWs, session, config));
}

module.exports = {
  compact: compactOpenClawContext,
  execute,
  model: modelOpenClawContext,
  resolvePendingDanger,
  resolvePendingPermission,
  stop,
  warmup,
  _internal: {
    resolveOpenClawAgentId,
    buildOpenClawSessionKey,
    buildOpenClawSessionLabel,
    sanitizeOpenClawErrorMessage,
    stripInternalOutboxHint,
    isSessionKeyForAgent,
    handleOpenClawGatewayClose,
    handleOpenClawEvent,
    bindOpenClawOutputContext,
    routeOpenClawGatewayEvent,
    armOpenClawTurnTimeout,
    clearOpenClawTurnTimeout,
    compactOpenClawContext,
    currentOpenClawModel,
    failActiveOpenClawCompaction,
    isOpenClawCompactionEvent,
    loadOpenClawModelNames,
    openclawCompactionTimeoutMs,
    openClawFallbackModels,
    resolveOpenClawModelInput,
  },
};
