const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isDangerousCommand } = require('../../core/danger');
const { buildCodexEnv } = require('../../runtime/agentEnv');
const { send, sendAgentSession, sendError, sendSystem, sendTurnEnd } = require('../../core/protocol');
const { persistAgentSessionId, stopAgentProcess: stopSessionProcess, updateAgentSessionHistory } = require('../../core/session');
const {
  appendProgressiveAnswerText,
  promotePendingProgress,
  resetProgressiveAnswer,
} = require('../../core/progressiveAnswer');
const { createTextStreamBuffer, appendTextStream, flushTextStream, resetTextStream } = require('../../core/streamBuffer');
const { captureAssistantReplyText, startAssistantReplyLog } = require('../../core/conversationLog');
const { GET_MODELS_AND_REASONS_COMMAND } = require('../../command/settings');
const {
  createCodexHostDirectiveStreamState,
  filterCodexHostDirectiveChunk,
  flushCodexHostDirectiveStream,
  resetCodexHostDirectiveStream,
} = require('./hostDirectives');
const {
  clearPendingPermissions,
  getPendingPermission,
  pendingPermissionIds,
  removePendingPermission,
  setPendingPermission,
} = require('../../core/permissionState');
const {
  codexDefaultReasoningEffort,
  codexFallbackModels,
  codexFallbackReasoningEfforts,
  codexModelInputNeedsLookup,
  codexReasoningInputNeedsLookup,
  codexTurnModelOverride,
  codexTurnReasoningOverride,
  currentCodexReasoningEffort,
  findCodexModelEntry,
  formatCodexModelList,
  formatCodexReasoningEffortLabel,
  formatCodexReasoningList,
  normalizeCodexModelEntries,
  normalizeCodexModelList,
  normalizeCodexReasoningEffort,
  resolveModelNameFromList,
  uniqueReasoningEfforts,
  withCodexFallbackModels,
} = require('./options');
const {
  buildCodexDeliveryInput,
  buildCodexInput,
  stringifyInput,
} = require('./input');
const {
  buildCodexBridgeInstructions,
  extractCodexDeveloperInstructions,
  mergeCodexDeveloperInstructions,
} = require('./instructions');

const CODEX_TURN_COMPLETION_FALLBACK_MS = 1000;
const CODEX_COMPACTION_STALE_MS = 90_000;
const DEFAULT_CODEX_COMPACTION_TIMEOUT_MS = 300_000;

function execute(input, ws, session, config) {
  const textForCheck = stringifyInput(input);
  if (isDangerousCommand(textForCheck) && session.autoApprove !== true) {
    const preview = textForCheck.slice(0, 200);
    session.pendingDanger = { input };
    send(ws, 'danger_warning', {
      text: `⚠️ 检测到可能的危险操作，请确认是否继续执行：

"${preview}${textForCheck.length > 200 ? '...' : ''}"`,
    });
    return;
  }

  if (session.isTurnActive) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, '消息队列已满，请稍后再试');
      return;
    }
    session.messageQueue.push({ input, ws });
    sendSystem(ws, `Codex 正在处理上一条消息，已加入队列（${session.messageQueue.length}）`);
    return;
  }

  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') {
    runExecTurn(input, ws, session, config);
  } else {
    runAppServerTurn(input, ws, session, config);
  }
}

// ─── app-server persistent mode ────────────────────────────────────────

function runAppServerTurn(input, ws, session, config) {
  session.isTurnActive = true;
  session.currentInputForNoOutput = input;
  session.sawPartialAssistantText = false;
  session.codexAssistantEnded = false;
  session.codexUseProgressiveAnswer = true;
  session.codexAgentMessageDeclaredPhases = new Map();
  session.codexAgentMessageEmissionPhases = new Map();
  session.codexToolStates = new Map();
  resetCodexAssistantText(session);
  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;
  startAssistantReplyLog(session, config, { agentType: 'codex' });

  const agentConfig = config.agents?.codex || {};
  const log = config.logger;
  log?.info('codex turn start', { mode: 'app-server', bin: agentConfig.bin, agentSessionId: session.agentSessionId });

  ensureAppServer(session, config)
    .then(() => {
      session._log?.info('codex app-server ready, ensuring thread');
      return ensureThread(session);
    })
    .then(threadId => {
      session._log?.info('codex thread ensured', { threadId });
      const modelOverride = codexTurnModelOverride(session);
      const reasoningOverride = codexTurnReasoningOverride(session, agentConfig, {
        includeDefault: Object.prototype.hasOwnProperty.call(modelOverride, 'model'),
      });
      sendJsonRpc(session.codexAppServer, {
        jsonrpc: '2.0',
        id: nextRpcId(session),
        method: 'turn/start',
        params: {
          threadId,
          input: buildCodexInput(buildCodexDeliveryInput(input, session, {
            config,
            includeBridgeContextHint: session.codexDeveloperInstructionsMode !== 'developer',
          }), session.workspace),
          cwd: session.workspace,
          ...modelOverride,
          ...reasoningOverride,
        },
      });
    })
    .catch(err => {
      session._log?.error('codex turn error', { message: err.message });
      if (session.isTurnActive) {
        sendError(ws, `Codex app-server 错误: ${err.message}`);
        finishCodexTurn(ws, session, config, 'error', { error: err.message });
      }
    });
}

async function warmup(ws, session, config) {
  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') return { supported: false };

  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;
  await ensureAppServer(session, config);
  const threadId = await ensureThread(session);
  return { supported: true, process: 'codex app-server', threadId };
}

function compactCodexContext(ws, session, config, options = {}) {
  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') return false;

  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;

  const trigger = options.trigger || 'manual';
  if (session.isTurnActive || session.codexCompaction || session.pendingCodexManualCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({ input: '/compact', ws, config, compact: true, trigger });
    sendSystem(ws, `Codex is busy. Queued native /compact (${session.messageQueue.length}).`);
    return true;
  }

  sendCodexCompactCommand(ws, session, config, { trigger });
  return true;
}

function applySettingsCodexContext(ws, session, config, options = {}) {
  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') {
    sendError(ws, 'Codex exec mode does not support runtime /settings apply. Use app-server mode.');
    sendTurnEnd(ws, session, 'error', { error: 'runtime_settings_unsupported_in_exec_mode' });
    return true;
  }

  if (session.isTurnActive || session.codexCompaction || session.pendingCodexManualCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({
      input: options.nativeCommand || '/settings apply',
      ws,
      config,
      settingsApplyCommand: true,
      settingsApplyOptions: options,
    });
    sendSystem(ws, `Codex is busy. Queued /settings apply (${session.messageQueue.length}).`);
    return true;
  }

  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;

  applyCodexRuntimeSettings(ws, session, config, options).catch(err => {
    sendError(ws, `Codex settings apply failed: ${err.message}`);
    sendTurnEnd(ws, session, 'error', { error: err.message });
  });
  return true;
}

async function applyCodexRuntimeSettings(ws, session, config, options = {}) {
  const effortInput = String(options.reasoningEffort || options.effort || '').trim();
  const modelInput = String(options.modelId || options.model || '').trim();
  if (!effortInput && !modelInput) {
    sendError(ws, 'Please specify at least one of --reasoning or --model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_settings' });
    return;
  }

  const entries = await loadCodexActualModelEntries(session, config);
  const modelNames = withCodexFallbackModels(entries.map(entry => entry.name));
  const requestedModel = modelInput && codexModelInputNeedsLookup(modelInput)
    ? resolveModelNameFromList(modelInput, modelNames)
    : modelInput;
  const configuredTargetModel = requestedModel
    || session.codexModelOverride
    || config?.agents?.codex?.model
    || '';
  const runtimeTargetEntry = configuredTargetModel
    ? findCodexModelEntry(entries, configuredTargetModel)
    : entries.find(entry => entry.isDefault) || entries[0] || null;
  const targetModel = configuredTargetModel || runtimeTargetEntry?.name || '';
  const targetEntry = findCodexModelEntry(entries, targetModel);
  const availableEfforts = targetEntry
    ? reasoningIdsForEntry(targetEntry)
    : codexFallbackReasoningEfforts();
  const requestedEffort = effortInput && codexReasoningInputNeedsLookup(effortInput)
    ? resolveModelNameFromList(effortInput, availableEfforts)
    : effortInput;
  const validated = validateCodexSettingsCombination({
    entries,
    model: targetModel,
    effort: requestedEffort,
  });
  const model = requestedModel ? validated.model : '';
  const effort = requestedEffort ? validated.effort : '';

  const previousModel = session.codexModelOverride || config?.agents?.codex?.model || '(default)';
  const previousEffort = session.codexReasoningEffortOverride || '(model default)';
  const notes = [];

  if (model) {
    session.codexModelOverride = model;
    session.codexModelOverrideDirty = true;
    notes.push(`model: ${previousModel} -> ${model}`);
  }
  if (effort) {
    session.codexReasoningEffortOverride = effort;
    session.codexReasoningEffortDirty = true;
    notes.push(`effort: ${formatCodexReasoningEffortLabel(previousEffort)} -> ${formatCodexReasoningEffortLabel(effort)}`);
  }

  sendCodexSettingsApplyResult(ws, session, config, {
    status: 'set',
    previousModel,
    previousEffort,
    modelId: model || session.codexModelOverride || config?.agents?.codex?.model || '',
    reasoningEffort: effort || currentCodexReasoningEffort(session),
  });
  sendSystem(ws, [
    'Codex settings updated for the next turn.',
    ...notes,
  ].join('\n'));
  sendTurnEnd(ws, session);
}

function sendCodexSettingsApplyResult(ws, session, config, options = {}) {
  send(ws, 'slash_command_result', {
    command: GET_MODELS_AND_REASONS_COMMAND,
    version: 1,
    data: {
      agentType: 'codex',
      status: options.status || 'set',
      reasoning: {
        current: String(options.reasoningEffort || currentCodexReasoningEffort(session) || '').trim(),
        previous: String(options.previousEffort || '').trim(),
      },
      model: {
        current: String(options.modelId || session.codexModelOverride || config?.agents?.codex?.model || '').trim(),
        previous: String(options.previousModel || '').trim(),
      },
    },
  });
}

function modelCodexContext(ws, session, config, options = {}) {
  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') {
    sendError(ws, 'Codex exec mode does not support runtime /model switching. Use app-server mode for persistent model changes.');
    sendTurnEnd(ws, session, 'error', { error: 'runtime_model_unsupported_in_exec_mode' });
    return true;
  }

  if (session.isTurnActive || session.codexCompaction || session.pendingCodexManualCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({
      input: options.nativeCommand || '/model',
      ws,
      config,
      modelCommand: true,
      modelOptions: options,
    });
    sendSystem(ws, `Codex is busy. Queued native /model (${session.messageQueue.length}).`);
    return true;
  }

  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;

  const command = options.command || 'show';
  if (command === 'list') {
    listCodexModels(ws, session, config);
    return true;
  }

  if (command === 'show') {
    sendCodexModelResult(ws, session, config, { status: 'status' });
    const lines = [`Codex model override: ${session.codexModelOverride || '(none)'}`];
    if (agentConfig.model) lines.push(`Configured default: ${agentConfig.model}`);
    lines.push('Use /model <name> to apply a model to the next Codex turn and subsequent turns.');
    sendSystem(ws, lines.join('\n'));
    sendTurnEnd(ws, session);
    return true;
  }

  if (command === 'clear') {
    const previous = session.codexModelOverride || '(none)';
    session.codexModelOverride = null;
    session.codexModelOverrideDirty = true;
    sendCodexModelResult(ws, session, config, { status: 'cleared', previous });
    sendSystem(ws, `Codex model override cleared (was ${previous}). Next turn will use ${session.codexModelOverride || 'the provider default model'}.`);
    sendTurnEnd(ws, session);
    return true;
  }

  const modelInput = String(options.model || '').trim();
  if (modelInput && codexModelInputNeedsLookup(modelInput)) {
    resolveCodexModelInput(session, config, modelInput)
      .then(model => setCodexModelOverride(ws, session, config, model))
      .catch(err => {
        sendError(ws, `Codex model selection failed: ${err.message}`);
        sendTurnEnd(ws, session, 'error', { error: err.message });
      });
    return true;
  }

  setCodexModelOverride(ws, session, config, modelInput);
  return true;
}

function reasoningCodexContext(ws, session, config, options = {}) {
  const agentConfig = config.agents?.codex || {};
  const mode = agentConfig.mode === 'exec' ? 'exec' : 'app-server';
  if (mode === 'exec') {
    sendError(ws, 'Codex exec mode does not support runtime /reasoning switching. Use app-server mode for persistent reasoning changes.');
    sendTurnEnd(ws, session, 'error', { error: 'runtime_reasoning_unsupported_in_exec_mode' });
    return true;
  }

  if (session.isTurnActive || session.codexCompaction || session.pendingCodexManualCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({
      input: options.nativeCommand || '/reasoning',
      ws,
      config,
      reasoningCommand: true,
      reasoningOptions: options,
    });
    sendSystem(ws, `Codex is busy. Queued native /reasoning (${session.messageQueue.length}).`);
    return true;
  }

  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;

  const command = options.command || 'show';
  if (command === 'list') {
    listCodexReasoningEfforts(ws, session, config);
    return true;
  }

  if (command === 'show') {
    sendCodexReasoningStatus(ws, session, config);
    return true;
  }

  if (command === 'clear') {
    const previous = session.codexReasoningEffortOverride || '(none)';
    session.codexReasoningEffortOverride = null;
    session.codexReasoningEffortDirty = true;
    sendCodexReasoningResult(ws, session, config, {
      status: 'cleared',
      previous,
    });
    sendSystem(ws, `Codex reasoning effort override cleared (was ${formatCodexReasoningEffortLabel(previous)}). Next turn will use the model default reasoning effort.`);
    sendTurnEnd(ws, session);
    return true;
  }

  const effortInput = String(options.effort || '').trim();
  applyCodexReasoningEffort(ws, session, config, effortInput).catch(err => {
    sendError(ws, `Codex reasoning selection failed: ${err.message}`);
    sendTurnEnd(ws, session, 'error', { error: err.message });
  });
  return true;
}

function setCodexModelOverride(ws, session, config, model) {
  const agentConfig = config.agents?.codex || {};
  if (!model) {
    sendError(ws, 'Please specify a model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_model' });
    return;
  }

  const previous = session.codexModelOverride || agentConfig.model || '(default)';
  session.codexModelOverride = model;
  session.codexModelOverrideDirty = true;
  sendCodexModelResult(ws, session, config, { status: 'set', previous });
  sendSystem(ws, `Codex model set for the next turn: ${previous} -> ${model}`);
  sendTurnEnd(ws, session);
}

function sendCodexModelResult(ws, session, config, options = {}) {
  const defaultModel = String(config?.agents?.codex?.model || '').trim();
  const current = String(session.codexModelOverride || defaultModel || '').trim();
  const models = withCodexFallbackModels([current, defaultModel]);
  send(ws, 'slash_command_result', {
    command: 'model',
    version: 1,
    data: {
      agentType: 'codex',
      status: options.status || 'status',
      current,
      previous: ['(none)', '(default)'].includes(options.previous) ? '' : String(options.previous || '').trim(),
      defaultModel,
      items: models.map(model => ({
        id: model,
        label: model,
        command: `/model ${model}`,
      })),
    },
  });
}

async function applyCodexReasoningEffort(ws, session, config, effortInput) {
  const choices = await loadCodexReasoningChoicesWithListFallback(session, config);
  const supportedEfforts = choices.hasAuthoritativeModelCapabilities
    ? choices.efforts
    : codexFallbackReasoningEfforts();
  const resolved = codexReasoningInputNeedsLookup(effortInput)
    ? resolveModelNameFromList(effortInput, supportedEfforts)
    : effortInput;
  const normalized = normalizeCodexReasoningEffort(resolved);
  if (!normalized) {
    throw new Error('Please specify a reasoning effort.');
  }

  if (!supportedEfforts.includes(normalized)) {
    throw unsupportedCodexReasoningEffortError(resolved, supportedEfforts);
  }

  const previous = session.codexReasoningEffortOverride || '(model default)';
  session.codexReasoningEffortOverride = normalized;
  session.codexReasoningEffortDirty = true;
  sendCodexReasoningResult(ws, session, config, {
    status: 'set',
    previous,
  });
  sendSystem(ws, `Codex reasoning effort set for the next turn: ${formatCodexReasoningEffortLabel(previous)} -> ${formatCodexReasoningEffortLabel(normalized)}`);
  sendTurnEnd(ws, session);
}

function listCodexModels(ws, session, config) {
  ensureAppServer(session, config)
    .then(() => rpcRequest(session, nextRpcId(session), 'model/list', { includeHidden: true, limit: 100 }))
    .then(result => {
      const models = withCodexFallbackModels(normalizeCodexModelList(result));
      const current = session.codexModelOverride || config.agents?.codex?.model || '';
      const actions = models.map(model => ({
        label: model === current ? `✓ ${model}` : model,
        text: `/model switch ${models.indexOf(model) + 1}`,
        command: `/model switch ${models.indexOf(model) + 1}`,
        type: 'command',
        action: 'select',
        model,
      }));
      send(ws, 'system', {
        text: formatCodexModelList(models, current),
        actions,
        quickActions: actions,
        quickReplies: actions,
      });
      sendTurnEnd(ws, session);
    })
    .catch(err => {
      const models = codexFallbackModels();
      const current = session.codexModelOverride || config.agents?.codex?.model || '';
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
          `Current model: ${current || '(default)'}`,
          `Codex model/list failed; showing fallback models. ${err.message}`,
          '',
          ...models.map((model, index) => `${index + 1}. ${model}${model === current ? ' (current)' : ''}`),
        ].join('\n'),
        actions,
        quickActions: actions,
        quickReplies: actions,
      });
      sendTurnEnd(ws, session);
    });
}

function listCodexReasoningEfforts(ws, session, config) {
  loadCodexReasoningChoicesWithListFallback(session, config)
    .then(({ efforts, defaultEffort, model, listError }) => {
      const current = currentCodexReasoningEffort(session);
      const actions = efforts.map((effort, index) => ({
        label: effort === current ? `* ${formatCodexReasoningEffortLabel(effort)}` : formatCodexReasoningEffortLabel(effort),
        text: `/reasoning switch ${index + 1}`,
        command: `/reasoning switch ${index + 1}`,
        type: 'command',
        action: 'select',
        effort,
      }));
      sendCodexReasoningResult(ws, session, config, {
        status: 'list',
        efforts,
        defaultEffort,
        model,
        listError,
      });
      send(ws, 'system', {
        text: listError
          ? [
            `Current reasoning effort: ${current ? formatCodexReasoningEffortLabel(current) : '(model default)'}`,
            `Codex model/list failed; showing fallback reasoning efforts. ${listError}`,
            '',
            ...efforts.map((effort, index) => `${index + 1}. ${formatCodexReasoningEffortLabel(effort)}${effort === current ? ' (current)' : ''}`),
          ].join('\n')
          : formatCodexReasoningList(efforts, current, { defaultEffort, model }),
        actions,
        quickActions: actions,
        quickReplies: actions,
      });
      sendTurnEnd(ws, session);
    })
    .catch(err => {
      sendError(ws, `Codex reasoning list failed: ${err.message}`);
      sendTurnEnd(ws, session, 'error', { error: err.message });
    });
}

function sendCodexReasoningStatus(ws, session, config) {
  loadCodexReasoningChoicesWithListFallback(session, config)
    .then(({ efforts, defaultEffort, model, listError }) => {
      sendCodexReasoningResult(ws, session, config, {
        status: 'status',
        efforts,
        defaultEffort,
        model,
        listError,
      });
      const lines = [`Codex reasoning effort override: ${session.codexReasoningEffortOverride ? formatCodexReasoningEffortLabel(session.codexReasoningEffortOverride) : '(none)'}`];
      if (listError) lines.push(`Codex model/list failed; showing fallback reasoning efforts. ${listError}`);
      if (defaultEffort) lines.push(`Model default: ${formatCodexReasoningEffortLabel(defaultEffort)}${model ? ` (${model})` : ''}`);
      if (efforts.length) {
        lines.push(`Use /reasoning <${efforts.join('|')}> to apply an effort to the next Codex turn and subsequent turns.`);
      } else {
        lines.push('The selected model does not support reasoning effort overrides.');
      }
      sendSystem(ws, lines.join('\n'));
      sendTurnEnd(ws, session);
    })
    .catch(err => {
      sendError(ws, `Codex reasoning status failed: ${err.message}`);
      sendTurnEnd(ws, session, 'error', { error: err.message });
    });
}

function sendCodexReasoningResult(ws, session, config, options = {}) {
  const current = currentCodexReasoningEffort(session);
  const defaultEffort = normalizeCodexReasoningEffort(
    Object.prototype.hasOwnProperty.call(options, 'defaultEffort')
      ? options.defaultEffort
      : codexDefaultReasoningEffort(config?.agents?.codex)
  );
  const efforts = Object.prototype.hasOwnProperty.call(options, 'efforts')
    ? uniqueCapabilityReasoningEfforts(options.efforts)
    : codexFallbackReasoningEfforts();
  send(ws, 'slash_command_result', {
    command: 'reasoning',
    version: 1,
    data: {
      agentType: 'codex',
      status: options.status || 'status',
      current,
      previous: normalizeCodexReasoningEffort(options.previous === '(model default)' ? '' : options.previous || ''),
      defaultEffort,
      model: options.model || session.codexModelOverride || config?.agents?.codex?.model || '',
      options: efforts.map(effort => ({
        id: effort,
        label: formatCodexReasoningEffortLabel(effort),
        command: `/reasoning ${effort}`,
        isCurrent: effort === current,
        isDefault: !current && defaultEffort ? effort === defaultEffort : effort === defaultEffort,
      })),
      ...(options.listError ? { error: options.listError } : {}),
    },
  });
}

async function resolveCodexModelInput(session, config, input) {
  const raw = String(input || '').trim();
  const models = await loadCodexModelNames(session, config);
  return resolveModelNameFromList(raw, models);
}

async function loadCodexModelNames(session, config) {
  try {
    const models = await loadCodexActualModelNames(session, config);
    return withCodexFallbackModels(models);
  } catch {
    return codexFallbackModels();
  }
}

async function loadCodexActualModelNames(session, config) {
  const entries = await loadCodexActualModelEntries(session, config);
  return entries.map(entry => entry.name);
}

async function loadCodexActualModelEntries(session, config) {
  await ensureAppServer(session, config);
  const result = await requestCodexModelList(session);
  return normalizeCodexModelEntries(result);
}

function requestCodexModelList(session) {
  return rpcRequest(session, nextRpcId(session), 'model/list', { includeHidden: true, limit: 100 });
}

async function loadCodexReasoningChoicesWithListFallback(session, config) {
  await ensureAppServer(session, config);
  let result;
  try {
    result = await requestCodexModelList(session);
  } catch (err) {
    return {
      efforts: codexFallbackReasoningEfforts(),
      defaultEffort: codexDefaultReasoningEffort(config?.agents?.codex),
      model: session.codexModelOverride || config?.agents?.codex?.model || '',
      hasAuthoritativeModelCapabilities: false,
      listError: err.message,
    };
  }
  return codexReasoningChoicesFromEntries(normalizeCodexModelEntries(result), session, config);
}

function codexReasoningChoicesFromEntries(entries, session, config) {
  const currentModel = String(session.codexModelOverride || config?.agents?.codex?.model || '').trim();
  const currentEntry = findCodexModelEntry(entries, currentModel);
  const selected = currentEntry || entries.find(entry => entry.isDefault) || entries[0] || null;
  const efforts = selected ? reasoningIdsForEntry(selected) : codexFallbackReasoningEfforts();
  const connectorDefault = codexDefaultReasoningEffort(config?.agents?.codex);
  const defaultEffort = selected
    ? [selected.defaultReasoningEffort, connectorDefault].find(effort => efforts.includes(effort)) || efforts[0] || ''
    : connectorDefault;
  return {
    efforts,
    defaultEffort,
    modelDefaultEffort: selected?.defaultReasoningEffort || '',
    model: selected?.name || currentModel || '',
    hasAuthoritativeModelCapabilities: Boolean(selected && (currentEntry || !currentModel)),
  };
}

function reasoningIdsForEntry(entry) {
  if (!entry?.hasReasoningEffortMetadata) return codexFallbackReasoningEfforts();
  return uniqueCapabilityReasoningEfforts(entry.supportedReasoningEfforts);
}

function uniqueCapabilityReasoningEfforts(efforts) {
  const result = [];
  const seen = new Set();
  for (const effort of efforts || []) {
    const raw = effort && typeof effort === 'object' ? effort.id : effort;
    const normalized = normalizeCodexReasoningEffort(raw);
    if (!normalized || normalized.length > 120 || /[\x00-\x1f\x7f]/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function validateCodexSettingsCombination({ entries = [], model = '', effort = '' } = {}) {
  const entry = findCodexModelEntry(entries, model);
  const normalizedEffort = normalizeCodexReasoningEffort(effort);
  const supportedEfforts = entry ? reasoningIdsForEntry(entry) : codexFallbackReasoningEfforts();
  if (normalizedEffort && !supportedEfforts.includes(normalizedEffort)) {
    throw unsupportedCodexReasoningEffortError(effort, supportedEfforts, entry?.name || 'custom model');
  }
  return {
    model: entry?.name || String(model || '').trim(),
    effort: normalizedEffort,
  };
}

function unsupportedCodexReasoningEffortError(effort, supportedEfforts, model = '') {
  const suffix = supportedEfforts.length
    ? ` Use one of: ${supportedEfforts.join(', ')}.`
    : ' This model does not support reasoning efforts.';
  return new Error(`Unsupported Codex reasoning effort${model ? ` for ${model}` : ''}: ${effort}.${suffix}`);
}

function sendCodexCompactCommand(ws, session, config, options = {}) {
  session.isTurnActive = true;
  session.currentInputForNoOutput = '/compact';
  session.sawPartialAssistantText = false;
  session.codexAssistantEnded = false;
  session.codexUseProgressiveAnswer = false;
  session.codexAgentMessageDeclaredPhases = new Map();
  session.codexAgentMessageEmissionPhases = new Map();
  session.codexToolStates = new Map();
  resetCodexAssistantText(session);
  session._lastWs = ws;
  session._lastConfig = config;
  session._log = config.logger;

  const trigger = options.trigger || 'manual';
  const startedAt = Date.now();
  const pending = {
    id: `codex-compact-${startedAt}`,
    trigger,
    startedAt,
    manualTurn: true,
    timeoutTimerId: null,
  };
  session.pendingCodexManualCompaction = pending;
  pending.timeoutTimerId = setTimeout(() => {
    if (session.pendingCodexManualCompaction !== pending) return;
    failPendingCodexManualCompaction(session, 'timeout', 'Codex context compaction did not start before timeout.');
  }, codexCompactionTimeoutMs(session));
  pending.timeoutTimerId.unref?.();

  ensureAppServer(session, config)
    .then(() => ensureThread(session))
    .then(threadId => {
      session._log?.info('codex manual context compaction requested', {
        sessionId: session.id,
        threadId,
        trigger,
      });
      const rpcId = nextRpcId(session);
      return rpcRequest(session, rpcId, 'thread/compact/start', { threadId });
    })
    .catch(err => {
      session._log?.error('codex manual context compaction request failed', {
        sessionId: session.id,
        error: err.message,
      });
      failPendingCodexManualCompaction(session, 'app_server_error', err.message);
    });
}

function ensureAppServer(session, config) {
  if (session.codexAppServer && session.codexAppServer.stdin && !session.codexAppServer.stdin.destroyed) {
    session._log?.info('codex reusing existing app-server');
    return Promise.resolve();
  }

  session._log?.info('codex spawning new app-server');

  return new Promise((resolve, reject) => {
    const agentConfig = config.agents?.codex || {};
    const bin = agentConfig.bin || 'codex';
    const spawnTarget = resolveCodexSpawnTarget(bin);
    const child = spawn(spawnTarget.command, [...spawnTarget.argsPrefix, 'app-server', '--listen', 'stdio://'], {
      cwd: session.workspace,
      env: buildCodexAppServerEnv(),
      shell: spawnTarget.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    session.codexAppServer = child;
    session.agentProcess = child;
    session.codexRpcId = 0;
    session.codexPendingRequests = new Map();
    session.codexInheritedDeveloperInstructions = '';
    session.codexDeveloperInstructionsApplied = false;
    session.codexDeveloperInstructionsMode = null;
    session.codexDeveloperInstructionsPromise = null;
    session.codexDeveloperInstructionsResolved = false;
    session.stdoutBuffer = '';
    session.stderrBuffer = '';
    session.turnCompletedTimerId = null;

    let initialized = false;
    let initResolve;
    let initReject;
    const initPromise = new Promise((res, rej) => {
      initResolve = res;
      initReject = rej;
    });

    const timeout = setTimeout(() => {
      if (!initialized) {
        initReject(new Error('Codex app-server 初始化超时'));
        child.kill();
      }
    }, 15000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      session.stdoutBuffer += chunk;
      const lines = session.stdoutBuffer.split(/\r?\n/);
      session.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          handleAppServerMessage(msg, session);
        } catch {
          // ignore unparseable lines
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      session.stderrBuffer += chunk;
    });

    child.on('error', err => {
      if (!initialized) {
        clearTimeout(timeout);
        initReject(err);
      } else {
        const errWs = session._lastWs;
        failPendingCodexManualCompaction(session, 'app_server_error', err.message);
        failActiveCodexCompaction(session, 'app_server_error', err.message);
        if (errWs) {
          sendError(errWs, `Codex app-server 错误: ${err.message}`);
        }
      }
    });

    child.on('close', (code, signal) => {
      const isCurrentChild = session.codexAppServer === child;
      const hadActiveTurn = session.isTurnActive;
      const cfg = session._lastConfig;
      const errWs = session._lastWs;
      const errorMessage = `Codex app-server exited, code=${code}, signal=${signal || 'null'}`;
      if (isCurrentChild) {
        session.codexAppServer = null;
        failPendingCodexManualCompaction(session, 'app_server_closed', errorMessage);
        failActiveCodexCompaction(session, 'app_server_closed', errorMessage);
        if (hadActiveTurn && errWs) {
          finishCodexTurn(errWs, session, cfg, 'error', { error: errorMessage });
        } else {
          clearTurnState(session);
        }
        clearPendingPermissions(session, 'codex');
        // drain pending requests
        for (const [, pending] of session.codexPendingRequests) {
          pending.reject(new Error(`app-server 已退出，code=${code}, signal=${signal || 'null'}`));
        }
        session.codexPendingRequests.clear();
      }
      if (!initialized) {
        clearTimeout(timeout);
        initReject(new Error(`Codex app-server 启动失败，退出码: ${code}, signal=${signal || 'null'}`));
      } else if (isCurrentChild) {
        // app-server exited mid-session — drain queue
        if (!hadActiveTurn && cfg && errWs) drainQueue(errWs, session, cfg);
      }
    });

    // send initialize
    const initId = ++session.codexRpcId;
    sendJsonRpc(child, {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        clientInfo: { name: 'linco', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });

    session.codexPendingRequests.set(initId, {
      resolve: (result) => {
        initialized = true;
        clearTimeout(timeout);
        initResolve(result);
      },
      reject: (err) => {
        clearTimeout(timeout);
        initReject(err);
      },
    });

    initPromise.then(resolve, reject);
  });
}

function buildCodexAppServerEnv() {
  const env = buildCodexEnv();
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
  }
  return env;
}

async function ensureThread(session) {
  const agentConfig = session._lastConfig?.agents?.codex || {};
  const resolvedDeveloperInstructions = await resolveCodexDeveloperInstructions(session);
  const developerInstructions = session.codexDeveloperInstructionsMode === 'developer'
    && session.codexDeveloperInstructionsApplied !== true
    ? resolvedDeveloperInstructions
    : '';

  if (session.agentSessionId) {
    // Resume existing thread after app-server restart
    return resumeCodexThread(session, developerInstructions).then(result => {
      recordCodexThreadReasoning(session, result);
      if (developerInstructions && session.codexDeveloperInstructionsMode === 'developer') {
        session.codexDeveloperInstructionsApplied = true;
      }
      emitCodexAgentSession(session, session.agentSessionId);
      return session.agentSessionId;
    }).catch(err => {
      // If resume fails, start a new thread
      session._log?.warn('codex thread resume failed, starting new', { message: err.message });
      return startNewThread(
        session,
        agentConfig,
        session.codexDeveloperInstructionsMode === 'developer' ? developerInstructions : '',
      );
    });
  }

  return startNewThread(session, agentConfig, developerInstructions);
}

function resumeCodexThread(session, developerInstructions = '') {
  const rpcId = nextRpcId(session);
  return rpcRequest(session, rpcId, 'thread/resume', buildCodexThreadResumeParams(
    session,
    developerInstructions,
  )).catch(err => {
    if (!developerInstructions) throw err;
    switchCodexDeveloperInstructionsToInputFallback(session, err);
    const fallbackRpcId = nextRpcId(session);
    return rpcRequest(session, fallbackRpcId, 'thread/resume', buildCodexThreadResumeParams(session));
  });
}

function startNewThread(session, agentConfig, developerInstructions = '') {
  return requestStartCodexThread(session, agentConfig, developerInstructions).then(result => {
    recordCodexThreadReasoning(session, result);
    if (developerInstructions && session.codexDeveloperInstructionsMode === 'developer') {
      session.codexDeveloperInstructionsApplied = true;
    }
    const threadId = result?.thread?.id || result?.id || result?.threadId;
    if (threadId) {
      persistAgentSessionId(session, threadId);
      emitCodexAgentSession(session, threadId);
      return threadId;
    }
    // Fallback: wait for thread/started notification
    return new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('创建线程超时')), 15000);
      session._threadStartResolve = (id) => {
        clearTimeout(fallback);
        resolve(id);
      };
      session._threadStartReject = (err) => {
        clearTimeout(fallback);
        reject(err);
      };
    });
  });
}

function requestStartCodexThread(session, agentConfig, developerInstructions = '') {
  const rpcId = nextRpcId(session);
  return rpcRequest(session, rpcId, 'thread/start', buildCodexThreadStartParams(
    session,
    agentConfig,
    developerInstructions,
  )).catch(err => {
    if (!developerInstructions) throw err;
    switchCodexDeveloperInstructionsToInputFallback(session, err);
    const fallbackRpcId = nextRpcId(session);
    return rpcRequest(session, fallbackRpcId, 'thread/start', buildCodexThreadStartParams(
      session,
      agentConfig,
    ));
  });
}

function switchCodexDeveloperInstructionsToInputFallback(session, err) {
  session._log?.warn('codex developer instructions rejected, using input fallback', {
    message: err.message,
  });
  session.codexDeveloperInstructionsMode = 'input';
  session.codexDeveloperInstructionsApplied = false;
}

function buildCodexThreadStartParams(session, agentConfig = {}, developerInstructions = '') {
  return {
    cwd: session.workspace,
    model: agentConfig.model || null,
    effort: codexDefaultReasoningEffort(agentConfig),
    approvalPolicy: codexApprovalPolicy(session),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...buildCodexThreadSandbox(session),
  };
}

function buildCodexThreadResumeParams(session, developerInstructions = '') {
  return {
    threadId: session.agentSessionId,
    cwd: session.workspace,
    approvalPolicy: codexApprovalPolicy(session),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...buildCodexThreadSandbox(session),
  };
}

function resolveCodexDeveloperInstructions(session) {
  if (session.codexDeveloperInstructionsResolved) {
    return Promise.resolve(buildResolvedCodexDeveloperInstructions(session));
  }
  if (session.codexDeveloperInstructionsPromise) {
    return session.codexDeveloperInstructionsPromise;
  }

  session.codexDeveloperInstructionsPromise = (async () => {
    try {
      const rpcId = nextRpcId(session);
      const result = await rpcRequest(session, rpcId, 'config/read', {
        cwd: session.workspace,
        includeLayers: false,
      });
      session.codexInheritedDeveloperInstructions = extractCodexDeveloperInstructions(result);
      session.codexDeveloperInstructionsMode = 'developer';
      return buildResolvedCodexDeveloperInstructions(session);
    } catch (err) {
      session._log?.warn('codex developer instructions unavailable, using input fallback', {
        message: err.message,
      });
      session.codexInheritedDeveloperInstructions = '';
      session.codexDeveloperInstructionsMode = 'input';
      return '';
    } finally {
      session.codexDeveloperInstructionsResolved = true;
      session.codexDeveloperInstructionsPromise = null;
    }
  })();

  return session.codexDeveloperInstructionsPromise;
}

function buildResolvedCodexDeveloperInstructions(session) {
  const bridge = buildCodexBridgeInstructions(session, session._lastConfig || {});
  return mergeCodexDeveloperInstructions(
    session.codexInheritedDeveloperInstructions,
    bridge,
  );
}

function codexApprovalPolicy(session) {
  return session?.approveMode === 'yolo' ? 'never' : 'untrusted';
}

function recordCodexThreadReasoning(session, payload) {
  const effort = normalizeCodexReasoningEffort(
    payload?.reasoningEffort
      || payload?.reasoning_effort
      || payload?.thread?.reasoningEffort
      || payload?.thread?.reasoning_effort
      || payload?.params?.reasoningEffort
      || payload?.params?.reasoning_effort
      || payload?.params?.thread?.reasoningEffort
      || payload?.params?.thread?.reasoning_effort
      || ''
  );
  if (effort) session.codexActiveReasoningEffort = effort;
}

function sendCodexAssistantEnd(ws, session) {
  if (session.codexAssistantEnded) return;
  session.codexAssistantEnded = true;
  flushCodexAssistantText(ws, session);
  send(ws, 'assistant_end', {});
}

function clearTurnState(session) {
  flushCodexAssistantText(session._lastWs, session);
  resetProgressiveAnswer(session);
  session.isTurnActive = false;
  session.currentInputForNoOutput = null;
  if (session.turnCompletedTimerId) {
    clearTimeout(session.turnCompletedTimerId);
    session.turnCompletedTimerId = null;
  }
}

function finishCodexTurn(ws, session, config, reason = 'completed', payload = {}) {
  if (!session.isTurnActive) return;

  if (reason !== 'completed') {
    failActiveCodexCompaction(session, 'turn_failed', payload.error || reason);
  }

  if (reason === 'completed') {
    updateCodexSessionStats(session, payload);
  }

  clearTurnState(session);
  if (session.sawPartialAssistantText) {
    sendCodexAssistantEnd(ws, session);
  }
  sendTurnEnd(ws, session, reason, payload);
  if (config) drainQueue(ws, session, config);
}

function isFinalCodexAssistantItem(params) {
  const item = params.item || {};
  return isCodexAssistantMessageType(item.type) && item.phase === 'final_answer';
}

function armCodexTurnCompletionFallback(ws, session, config) {
  if (session.turnCompletedTimerId) clearTimeout(session.turnCompletedTimerId);
  session.turnCompletedTimerId = setTimeout(() => {
    finishCodexTurn(ws, session, config, 'completed');
  }, CODEX_TURN_COMPLETION_FALLBACK_MS);
}

function ensureCodexStreamState(session) {
  if (!session.codexStreamState) {
    session.codexStreamState = createTextStreamBuffer();
  }
  return session.codexStreamState;
}

function appendCodexAssistantText(text, ws, session, ensureAssistantStarted, phase = '') {
  if (session.codexAssistantEnded) return;
  const meta = codexAssistantChunkMeta(session, phase);
  if (meta.ephemeral) {
    appendProgressiveAnswerText(text, ws, session);
  }
  maybeAppendCodexAssistantBreak(ws, session, ensureAssistantStarted, meta);
  appendCodexAssistantTextNow(text, ws, session, ensureAssistantStarted, meta);
}

function appendCodexAssistantTextNow(text, ws, session, ensureAssistantStarted, meta = codexAssistantChunkMeta(session, 'final_answer')) {
  if (session.codexAssistantEnded) return;
  const state = ensureCodexStreamState(session);
  state.onStart = ensureAssistantStarted;
  const output = meta.ephemeral
    ? text
    : filterCodexHostDirectiveChunk(ensureCodexHostDirectiveStreamState(session), text);
  if (!output) return;
  appendCodexAssistantTextOutput(output, ws, session, state, meta);
}

function appendCodexAssistantTextOutput(text, ws, session, state, meta) {
  appendTextStream(text, ws, state, meta);
  rememberCodexAssistantText(session, text);
  if (!meta.ephemeral) session.codexSawFinalAssistantText = true;
  session.sawPartialAssistantText = true;
}

function flushCodexAssistantText(ws, session) {
  const streamState = session.codexStreamState;
  const directiveTail = flushCodexHostDirectiveStream(session.codexHostDirectiveStreamState);
  if (directiveTail) {
    const state = ensureCodexStreamState(session);
    appendCodexAssistantTextOutput(
      directiveTail,
      ws,
      session,
      state,
      codexAssistantChunkMeta(session, 'final_answer'),
    );
  }
  flushTextStream(ws, streamState);
}

function resetCodexAssistantText(session) {
  resetTextStream(ensureCodexStreamState(session));
  resetCodexHostDirectiveStream(ensureCodexHostDirectiveStreamState(session));
  resetProgressiveAnswer(session);
  session.codexNeedsAssistantBreak = false;
  session.codexSawFinalAssistantText = false;
  session.codexAssistantTextTail = '';
}

function ensureCodexHostDirectiveStreamState(session) {
  if (!session.codexHostDirectiveStreamState) {
    session.codexHostDirectiveStreamState = createCodexHostDirectiveStreamState();
  }
  return session.codexHostDirectiveStreamState;
}

function appendCodexProgressAssistantText(text, ws, session) {
  if (!text || session.codexAssistantEnded) return;
  const meta = codexAssistantChunkMeta(session, 'progress');
  maybeAppendCodexAssistantBreak(ws, session, () => send(ws, 'assistant_start', {}), meta);
  appendCodexAssistantTextNow(text, ws, session, () => send(ws, 'assistant_start', {}), meta);
}

function maybeAppendCodexAssistantBreak(ws, session, ensureAssistantStarted, meta = codexAssistantChunkMeta(session, 'final_answer')) {
  if (!session?.codexNeedsAssistantBreak || !session.sawPartialAssistantText) {
    if (session) session.codexNeedsAssistantBreak = false;
    return;
  }
  session.codexNeedsAssistantBreak = false;
  if (!meta.ephemeral && !session.codexSawFinalAssistantText) return;
  const state = ensureCodexStreamState(session);
  const tail = `${session.codexAssistantTextTail || ''}${state.pendingText || ''}`;
  if (tail.endsWith('\n\n')) return;
  appendCodexAssistantTextNow(tail.endsWith('\n') ? '\n' : '\n\n', ws, session, ensureAssistantStarted, meta);
}

function codexAssistantChunkMeta(session, phase) {
  const normalized = String(phase || '').trim();
  if (session?.codexUseProgressiveAnswer && normalized !== 'final_answer') {
    return { phase: 'progress', ephemeral: true };
  }
  return { phase: 'final_answer', ephemeral: false };
}

function markCodexAssistantBreak(session) {
  if (!session?.sawPartialAssistantText) return;
  session.codexNeedsAssistantBreak = true;
}

function rememberCodexAssistantText(session, text) {
  captureAssistantReplyText(session, text);
  const next = `${session.codexAssistantTextTail || ''}${text || ''}`;
  session.codexAssistantTextTail = next.slice(-4000);
}

function codexAgentMessageId(params) {
  return String(params.item?.id || params.itemId || params.id || '').trim();
}

function ensureCodexAgentMessageDeclaredPhases(session) {
  if (!(session.codexAgentMessageDeclaredPhases instanceof Map)) {
    session.codexAgentMessageDeclaredPhases = new Map();
  }
  return session.codexAgentMessageDeclaredPhases;
}

function rememberCodexAgentMessageDeclaredPhase(session, params) {
  const itemId = codexAgentMessageId(params);
  const phase = String(params.item?.phase || params.phase || '').trim();
  if (!itemId || !phase) return;
  ensureCodexAgentMessageDeclaredPhases(session).set(itemId, phase);
}

function codexAgentMessagePhase(session, params) {
  const explicit = String(params.item?.phase || params.phase || '').trim();
  if (explicit) return explicit;
  const itemId = codexAgentMessageId(params);
  if (!itemId) return '';
  return ensureCodexAgentMessageDeclaredPhases(session).get(itemId) || '';
}

function ensureCodexAgentMessageEmissionPhases(session) {
  if (session.codexAgentMessageEmissionPhases instanceof Map) {
    return session.codexAgentMessageEmissionPhases;
  }
  const phases = new Map();
  if (session.codexEmittedAgentMessageIds instanceof Set) {
    for (const itemId of session.codexEmittedAgentMessageIds) {
      phases.set(itemId, 'unknown');
    }
  }
  session.codexAgentMessageEmissionPhases = phases;
  return phases;
}

function codexAgentMessageEmissionPhase(session, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return '';
  return ensureCodexAgentMessageEmissionPhases(session).get(id) || '';
}

function markCodexAgentMessageEmitted(session, itemId, phase = '') {
  const id = String(itemId || '').trim();
  if (!id) return;
  const phases = ensureCodexAgentMessageEmissionPhases(session);
  const nextPhase = String(phase || '').trim() === 'final_answer'
    ? 'final_answer'
    : 'progress';
  if (phases.get(id) === 'final_answer') return;
  phases.set(id, nextPhase);
}

function hasCodexAgentMessageEmitted(session, itemId) {
  return Boolean(codexAgentMessageEmissionPhase(session, itemId));
}

function ensureCodexToolStates(session) {
  if (!(session.codexToolStates instanceof Map)) {
    session.codexToolStates = new Map();
  }
  return session.codexToolStates;
}

function codexToolStateFor(session, id) {
  const toolId = String(id || '').trim();
  if (!toolId) return null;
  const states = ensureCodexToolStates(session);
  return states.get(toolId) || null;
}

function setCodexToolState(session, id, next) {
  const toolId = String(id || '').trim();
  if (!toolId) return;
  const states = ensureCodexToolStates(session);
  const previous = states.get(toolId) || {};
  states.set(toolId, {
    ...previous,
    ...next,
  });
}

function emitCodexToolCall(ws, session, tool) {
  if (!ws) return false;
  const id = String(tool.id || '').trim();
  const existing = codexToolStateFor(session, id);
  if (existing?.phase === 'completed' || existing?.phase === 'started') {
    return false;
  }
  promotePendingProgress(ws, session);
  flushTextStream(ws, session.codexStreamState);
  const name = String(tool.name || existing?.name || 'tool').trim() || 'tool';
  const input = tool.input ?? existing?.input ?? '';
  send(ws, 'tool_call', { id, name, input });
  setCodexToolState(session, id, { phase: 'started', name, input });
  markCodexAssistantBreak(session);
  return true;
}

function emitCodexToolResult(ws, session, tool) {
  if (!ws) return false;
  const id = String(tool.id || '').trim();
  const existing = codexToolStateFor(session, id);
  if (existing?.phase === 'completed') return false;

  const name = String(tool.name || existing?.name || 'tool').trim() || 'tool';
  const input = tool.input ?? existing?.input ?? '';
  if (id && existing?.phase !== 'started') {
    emitCodexToolCall(ws, session, { id, name, input });
  }

  const output = tool.output ?? '';
  send(ws, 'tool_result', { id, output });
  setCodexToolState(session, id, {
    phase: 'completed',
    name,
    input,
    output,
  });
  markCodexAssistantBreak(session);
  return true;
}

function codexToolOutputFromParams(params = {}) {
  const item = params.item || {};
  const candidates = [
    item.output,
    item.result,
    item.results,
    item.stdout,
    item.stderr,
    item.data?.output,
    item.data?.result,
    item.data?.stdout,
    item.data?.stderr,
    params.output,
    params.result,
    params.stdout,
    params.stderr,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value !== 'string') return JSON.stringify(value).slice(0, 1000);
  }
  return '';
}

function shouldAppendCompletedAgentMessage(session, params) {
  const itemId = codexAgentMessageId(params);
  if (itemId) {
    const emittedPhase = codexAgentMessageEmissionPhase(session, itemId);
    if (!emittedPhase) return true;
    const completedPhase = String(params.item?.phase || params.phase || '').trim();
    return completedPhase === 'final_answer' && emittedPhase === 'progress';
  }
  if (!session.sawPartialAssistantText) return true;
  return params.item?.phase === 'final_answer';
}

function nextRpcId(session) {
  session.codexRpcId = (session.codexRpcId || 0) + 1;
  return session.codexRpcId;
}

function rpcRequest(session, id, method, params) {
  return new Promise((resolve, reject) => {
    session.codexPendingRequests.set(id, { resolve, reject });
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
  });
}

function sendJsonRpc(child, message) {
  if (child.stdin && !child.stdin.destroyed) {
    child.stdin.write(JSON.stringify(message) + '\n');
  }
}

function codexAgentConfig(session) {
  return session?._lastConfig?.agents?.codex || {};
}

function isRemoteCodexSession(session, ws = session?._lastWs) {
  return Boolean(ws?.linco || session?.linco);
}

function numberFromProcessEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shouldEmitCodexProgress(session, ws = session?._lastWs) {
  return !session?.codexCompaction;
}

function shouldEmitCodexReasoning(session, ws = session?._lastWs) {
  return !session?.codexCompaction;
}

function codexCompactionTimeoutMs(session) {
  const configured = Number(codexAgentConfig(session).compactionTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return numberFromProcessEnv('LINCO_CODEX_COMPACTION_TIMEOUT_MS', DEFAULT_CODEX_COMPACTION_TIMEOUT_MS);
}

function isCodexContextCompactionItem(itemType) {
  return String(itemType || '') === 'contextCompaction';
}

function codexCompactionId(params = {}) {
  return String(params.item?.id || params.itemId || params.id || '').trim();
}

function clearCodexCompactionTimers(compaction) {
  if (!compaction) return;
  if (compaction.staleTimerId) clearTimeout(compaction.staleTimerId);
  if (compaction.timeoutTimerId) clearTimeout(compaction.timeoutTimerId);
  compaction.staleTimerId = null;
  compaction.timeoutTimerId = null;
}

function clearPendingCodexManualCompaction(session) {
  const pending = session?.pendingCodexManualCompaction;
  if (pending?.timeoutTimerId) clearTimeout(pending.timeoutTimerId);
  if (session) session.pendingCodexManualCompaction = null;
  return pending || null;
}

function sendCodexCompactionEvent(session, phase, fields = {}) {
  const ws = session?._lastWs;
  if (!ws) return false;
  const linco = ws.linco || session.linco || {};
  send(ws, 'context_compaction', {
    phase,
    compactionId: fields.compactionId,
    agentType: 'codex',
    trigger: fields.trigger,
    sessionKey: session.id,
    agentSessionId: session.agentSessionId,
    streamId: linco.streamId,
    requestId: linco.messageId,
    durationMs: fields.durationMs,
    error: fields.error,
    text: fields.text,
    ts: fields.ts || Date.now(),
  });
  return true;
}

function handleCodexCompactionStarted(params, session) {
  const id = codexCompactionId(params);
  if (!id) {
    session._log?.warn?.('codex context compaction without id', {
      item: summarizeCodexItemForLog(params.item),
    });
  }

  if (session.codexCompaction && !session.codexCompaction.completed) {
    failActiveCodexCompaction(session, 'superseded', 'Another context compaction started before the previous one completed.');
  }

  const compactionId = id || `codex-compaction-${Date.now()}`;
  const startedAt = Date.now();
  const pendingManual = clearPendingCodexManualCompaction(session);
  const compaction = {
    id: compactionId,
    trigger: pendingManual?.trigger || 'auto',
    manualTurn: pendingManual?.manualTurn === true,
    startedAt,
    staleTimerId: null,
    timeoutTimerId: null,
    staleNotified: false,
    completed: false,
  };
  session.codexCompaction = compaction;

  sendCodexCompactionEvent(session, 'started', {
    compactionId,
    trigger: compaction.trigger,
    text: '正在整理上下文...',
    ts: startedAt,
  });

  compaction.staleTimerId = setTimeout(() => {
    if (session.codexCompaction !== compaction || compaction.completed) return;
    compaction.staleNotified = true;
    sendCodexCompactionEvent(session, 'stale', {
      compactionId,
      trigger: compaction.trigger,
      durationMs: Date.now() - startedAt,
      text: '上下文仍在整理，请稍候。',
    });
  }, CODEX_COMPACTION_STALE_MS);
  compaction.staleTimerId.unref?.();

  compaction.timeoutTimerId = setTimeout(() => {
    if (session.codexCompaction !== compaction || compaction.completed) return;
    failActiveCodexCompaction(session, 'timeout', '上下文整理超时');
  }, codexCompactionTimeoutMs(session));
  compaction.timeoutTimerId.unref?.();
}

function handleCodexCompactionCompleted(params, session) {
  const id = codexCompactionId(params);
  const active = session.codexCompaction;
  if (!active) {
    session._log?.warn?.('codex context compaction completed without active state', { id });
    return;
  }
  if (id && active.id !== id) {
    session._log?.warn?.('codex context compaction completed with mismatched id', {
      activeId: active.id,
      completedId: id,
    });
    return;
  }

  active.completed = true;
  clearCodexCompactionTimers(active);
  sendCodexCompactionEvent(session, 'completed', {
    compactionId: active.id,
    trigger: active.trigger,
    durationMs: Date.now() - active.startedAt,
    text: '上下文整理完成，继续处理当前问题。',
  });
  session.codexCompaction = null;
  if (active.manualTurn && session.isTurnActive) {
    finishCodexTurn(session._lastWs, session, session._lastConfig, 'completed');
  }
}

function failActiveCodexCompaction(session, code, message) {
  const active = session?.codexCompaction;
  if (!active || active.completed) return false;

  clearCodexCompactionTimers(active);
  sendCodexCompactionEvent(session, 'failed', {
    compactionId: active.id,
    trigger: active.trigger,
    durationMs: Date.now() - active.startedAt,
    error: { code, message: String(message || code) },
    text: '上下文整理失败，已继续尝试处理当前问题。',
  });
  session.codexCompaction = null;
  if (active.manualTurn && session.isTurnActive) {
    finishCodexTurn(session._lastWs, session, session._lastConfig, 'error', { error: String(message || code) });
  }
  return true;
}

function failPendingCodexManualCompaction(session, code, message) {
  const pending = clearPendingCodexManualCompaction(session);
  if (!pending) return false;

  sendCodexCompactionEvent(session, 'failed', {
    compactionId: pending.id,
    trigger: pending.trigger,
    durationMs: Date.now() - pending.startedAt,
    error: { code, message: String(message || code) },
    text: 'Codex context compaction failed before it started.',
  });
  if (session.isTurnActive) {
    finishCodexTurn(session._lastWs, session, session._lastConfig, 'error', { error: String(message || code) });
  }
  return true;
}

function buildCodexThreadSandbox(session) {
  const writableRoots = [session.workspace].filter(Boolean);
  const agentConfig = session._lastConfig?.agents?.codex || {};
  if (session?.approveMode === 'yolo') {
    return {
      sandbox: 'danger-full-access',
      config: {
        sandbox_mode: 'danger-full-access',
      },
    };
  }
  return {
    sandbox: 'workspace-write',
    config: {
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: {
        writable_roots: [...new Set(writableRoots)],
        network_access: agentConfig.networkAccess !== false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
    },
  };
}

function buildCodexPermissionGrant(session) {
  const readableRoots = [session.attachmentsDir].filter(Boolean);
  const writableRoots = [session.workspace].filter(Boolean);
  const entries = [
    ...readableRoots.map(root => ({
      path: { type: 'path', path: root },
      access: 'read',
    })),
    ...writableRoots.map(root => ({
      path: { type: 'path', path: root },
      access: 'write',
    })),
  ];

  return {
    fileSystem: {
      read: readableRoots,
      write: writableRoots,
      entries,
    },
    network: { enabled: false },
  };
}

function handleServerRequest(message, session) {
  const method = message.method || '';
  const params = message.params || {};
  const ws = session._lastWs;

  // File change approval — auto-approve silently
  if (method === 'item/fileChange/requestApproval') {
    session._log?.info('codex auto-approving file change');
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { decision: 'accept' },
    });
    return;
  }

  // Command execution approval — auto-approve by default, or ask the user when disabled.
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const cmd = params.command || params.tool || '';
    session._log?.info('codex command execution approval requested', { method, command: cmd, autoApprove: session.autoApprove === true });

    if (getPendingPermission(session, String(message.id), 'codex')) return;

    if (session.autoApprove === true) {
      sendJsonRpc(session.codexAppServer, {
        jsonrpc: '2.0',
        id: message.id,
        result: { decision: 'accept' },
      });
      return;
    }

    setPendingPermission(session, {
      provider: 'codex',
      requestId: String(message.id),
      toolName: 'exec',
      input: cmd,
      _codexMethod: method,
      _rpcId: message.id,
    });

    if (ws) {
      send(ws, 'permission_request', {
        requestId: String(message.id),
        toolName: 'exec',
        input: cmd,
      });
    }
    return;
  }

  // Permissions approval — auto-grant
  if (method === 'item/permissions/requestApproval') {
    session._log?.info('codex auto-granting permissions');
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { permissions: buildCodexPermissionGrant(session), scope: 'session' },
    });
    return;
  }

  // Apply patch approval — auto-approve silently
  if (method === 'applyPatchApproval') {
    session._log?.info('codex auto-approving patch');
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { decision: 'approved' },
    });
    return;
  }

  // Generic approval fallback
  if (method.includes('requestApproval') || method.includes('approval')) {
    session._log?.info('codex auto-approving', { method });
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { decision: 'accept' },
    });
    return;
  }

  // Tool call from server request
  if (method === 'item/tool/call') {
    const toolName = params.name || params.tool || '';
    emitCodexToolCall(ws, session, {
      id: String(message.id),
      name: toolName,
      input: JSON.stringify(params.input || {}).slice(0, 300),
    });
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { ok: true },
    });
    return;
  }

  // Tool user input
  if (method === 'item/tool/requestUserInput') {
    session._log?.info('codex tool requesting user input');
    sendJsonRpc(session.codexAppServer, {
      jsonrpc: '2.0',
      id: message.id,
      result: { continue: true },
    });
    return;
  }

  // Unknown server request — reject
  session._log?.warn('codex unknown server request', { method, params: JSON.stringify(params).slice(0, 200) });
  sendJsonRpc(session.codexAppServer, {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'method not supported' },
  });
}

function handleAppServerMessage(message, session) {
  const ws = session._lastWs;

  // thread.started notification — resolve ensureThread promise
  if (message.method === 'thread.started' || message.method === 'thread/start') {
    recordCodexThreadReasoning(session, message);
    const threadId = message.params?.thread?.id || message.params?.id || message.result?.thread?.id;
    if (threadId) {
      persistAgentSessionId(session, threadId);
      emitCodexAgentSession(session, threadId);
      if (session._threadStartResolve) {
        session._threadStartResolve(threadId);
        session._threadStartResolve = null;
        session._threadStartReject = null;
      }
    }
    return;
  }

  // RPC response (has id field matching our pending request)
  if (message.id != null && session.codexPendingRequests?.has(message.id)) {
    const pending = session.codexPendingRequests.get(message.id);
    session.codexPendingRequests.delete(message.id);
    if (message.error) {
      session._log?.error('codex RPC error', { id: message.id, error: JSON.stringify(message.error) });
      pending.reject(new Error(JSON.stringify(message.error)));
    } else {
      session._log?.info('codex RPC response', { id: message.id, keys: Object.keys(message.result || {}) });
      pending.resolve(message.result || message);
    }
    return;
  }

  // Server request (has id but not our pending) — auto-approve
  if (message.id != null && message.method) {
    handleServerRequest(message, session);
    return;
  }

  // notification
  const method = message.method || '';
  const params = message.params || {};

  if (isCodexReasoningMethod(method)) {
    const text = extractReasoningText(params);
    if (text && shouldEmitCodexReasoning(session, ws)) send(ws, 'thinking', { text, mode: 'summary' });
    return;
  }

  if (method === 'item/agentMessage/delta' || method.includes('delta')) {
    const delta = params.delta || '';
    if (delta) {
      const itemType = params.item?.type || params.type || '';
      const phase = codexAgentMessagePhase(session, params);
      if (isRemoteCodexSession(session, ws) && isCodexAssistantMessageType(itemType) && phase !== 'final_answer') {
        if (shouldEmitCodexProgress(session, ws)) {
          appendCodexProgressAssistantText(delta, ws, session);
          send(ws, 'thinking', { text: delta, mode: 'progress' });
        }
        markCodexAgentMessageEmitted(session, codexAgentMessageId(params), phase);
        return;
      }
      if (isCodexProgressAssistantItem(params)) {
        if (shouldEmitCodexProgress(session, ws)) {
          appendCodexProgressAssistantText(delta, ws, session);
          send(ws, 'thinking', { text: delta, mode: 'progress' });
        }
        markCodexAgentMessageEmitted(session, codexAgentMessageId(params), phase);
        return;
      }
      appendCodexAssistantText(delta, ws, session, () => send(ws, 'assistant_start', {}), phase);
      markCodexAgentMessageEmitted(session, codexAgentMessageId(params), phase);
    }
    return;
  }

  if (method === 'item/completed') {
    const itemType = params.item?.type || '';
    session._log?.info('codex item completed', { itemType, item: summarizeCodexItemForLog(params.item) });
    if (isCodexContextCompactionItem(itemType)) {
      handleCodexCompactionCompleted(params, session);
      return;
    }
    if (isCodexReasoningItem(itemType)) {
      const text = extractReasoningText(params);
      if (text && shouldEmitCodexReasoning(session, ws)) send(ws, 'thinking', { text, mode: 'summary' });
      return;
    }
    if (itemType === 'imageGeneration') {
      emitCodexImageGeneration(ws, session, params.item || {});
      return;
    }
    if (isCodexProgressAssistantItem(params)) {
      const text = extractFinalText(params);
      const agentMessageId = codexAgentMessageId(params);
      if (text && !hasCodexAgentMessageEmitted(session, agentMessageId)) {
        if (shouldEmitCodexProgress(session, ws)) {
          appendCodexProgressAssistantText(text, ws, session);
          send(ws, 'thinking', { text, mode: 'progress' });
        }
        markCodexAgentMessageEmitted(session, agentMessageId, params.item?.phase || params.phase || '');
      }
      return;
    }
    if (itemType === 'toolCall' || itemType === 'commandExecution' || itemType === 'webSearch') {
      const itemId = params.item?.id || params.itemId || '';
      const isCommand = itemType === 'commandExecution';
      const isWebSearch = itemType === 'webSearch';
      const toolName = isCommand ? 'exec' : isWebSearch ? 'webSearch' : (params.item?.name || params.item?.tool || '');
      const toolInput = isCommand
        ? (params.item?.command || '')
        : isWebSearch
          ? (params.item?.query || params.item?.input || params.item?.arguments || {})
          : (params.item?.input || params.item?.arguments || {});
      const output = codexToolOutputFromParams(params);
      const generatedImages = isCommand ? extractSelfDefinedImageGeneration(params) : [];
      if (generatedImages.length > 0) {
        emitCodexToolResult(ws, session, {
          id: itemId,
          name: toolName,
          input: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput).slice(0, 300),
          output: summarizeSelfDefinedImageGeneration(generatedImages),
        });
        for (const image of generatedImages) {
          emitCodexImageGeneration(ws, session, image);
        }
        return;
      }
      emitCodexToolResult(ws, session, {
        id: itemId,
        name: toolName,
        input: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput).slice(0, 300),
        output,
      });
      return;
    }

    // final content fallback if this item did not emit deltas
    const text = extractFinalText(params);
    const agentMessageId = codexAgentMessageId(params);
    if (text && shouldAppendCompletedAgentMessage(session, params)) {
      const phase = params.item?.phase || params.phase || '';
      if (session.sawPartialAssistantText && (phase !== 'final_answer' || session.codexSawFinalAssistantText)) {
        appendCodexAssistantText('\n\n', ws, session, () => send(ws, 'assistant_start', {}), phase);
      }
      appendCodexAssistantText(text, ws, session, () => send(ws, 'assistant_start', {}), phase);
      markCodexAgentMessageEmitted(session, agentMessageId, phase);
    }
    // Safety fallback: some app-server builds emit task completion without a turn/completed notification.
    // Arm it only after the final assistant message, not after user/tool/reasoning items.
    if (isFinalCodexAssistantItem(params)) {
      armCodexTurnCompletionFallback(ws, session, session._lastConfig);
    }
    return;
  }

  if (method === 'turn/completed' || method === 'turn.completed') {
    finishCodexTurn(ws, session, session._lastConfig, 'completed', params);
    return;
  }

  if (method === 'error' || method.includes('error')) {
    const message = params.message || JSON.stringify(params);
    failActiveCodexCompaction(session, 'app_server_error', message);
    sendError(ws, message);
    finishCodexTurn(ws, session, session._lastConfig, 'error', { error: message });
    return;
  }

  // tool call notifications
  if (method === 'tool/start' || method === 'tool_call') {
    const toolName = params.name || params.tool || '';
    if (toolName) {
      emitCodexToolCall(ws, session, {
        id: params.id || params.toolId || '',
        name: toolName,
        input: params.input || params.arguments || {},
      });
    }
    return;
  }

  if (method === 'tool/completed' || method === 'tool_result') {
    emitCodexToolResult(ws, session, {
      id: params.id || params.toolId || '',
      output: codexToolOutputFromParams(params),
    });
    return;
  }

  if (method === 'item/started') {
    const itemType = params.item?.type || '';
    session._log?.info('codex item started', { itemType, item: summarizeCodexItemForLog(params.item) });
    if (isCodexAssistantMessageType(itemType)) {
      rememberCodexAgentMessageDeclaredPhase(session, params);
    }
    if (isCodexContextCompactionItem(itemType)) {
      handleCodexCompactionStarted(params, session);
      return;
    }
    if (itemType === 'toolCall' || itemType === 'commandExecution' || itemType === 'webSearch') {
      const isCommand = itemType === 'commandExecution';
      const isWebSearch = itemType === 'webSearch';
      const toolName = isCommand ? 'exec' : isWebSearch ? 'webSearch' : (params.item?.name || params.item?.tool || '');
      const toolInput = isCommand
        ? (params.item?.command || '')
        : isWebSearch
          ? (params.item?.query || params.item?.input || params.item?.arguments || {})
          : (params.item?.input || params.item?.arguments || {});
      const itemId = params.item?.id || params.itemId || '';
      if (toolName) {
        emitCodexToolCall(ws, session, {
          id: itemId,
          name: toolName,
          input: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput).slice(0, 300),
        });
      }
    }
    return;
  }
}

function emitCodexAgentSession(session, threadId = session?.agentSessionId) {
  const agentSessionId = String(threadId || '').trim();
  if (!agentSessionId) return false;
  return sendAgentSession(session?._lastWs, session, {
    agentType: 'codex',
    agentSessionId,
  });
}

function updateCodexSessionStats(session, params = {}) {
  session.messageCount = (session.messageCount || 0) + 1;

  const usage = params.usage || params.turn?.usage || params.response?.usage;
  if (usage) {
    if (!session.usage) {
      session.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }
    session.usage.inputTokens += usage.input_tokens || usage.inputTokens || 0;
    session.usage.outputTokens += usage.output_tokens || usage.outputTokens || 0;
    session.usage.cacheReadTokens += usage.cache_read_input_tokens || usage.cacheReadTokens || 0;
    session.usage.cacheCreationTokens += usage.cache_creation_input_tokens || usage.cacheCreationTokens || 0;
  }

  updateAgentSessionHistory(session);
}

function isCodexAssistantMessageType(type) {
  return ['agentMessage', 'agent_message', 'message'].includes(type);
}

function emitCodexImageGeneration(ws, session, item = {}) {
  if (!ws) return false;

  const imageBase64 = extractCodexImageBase64(item);
  const savedPath = typeof item.savedPath === 'string' ? item.savedPath : '';
  let mediaBase64 = imageBase64;
  let mediaName = 'generated-image.png';
  let size = 0;
  let referencePath = savedPath;

  if (savedPath) {
    mediaName = path.basename(savedPath);
    try {
      const stat = fs.statSync(savedPath);
      if (stat.isFile()) size = stat.size;
      if (!mediaBase64) mediaBase64 = fs.readFileSync(savedPath).toString('base64');
    } catch {
      // Fall back to the inline image result when the saved path is unavailable.
    }
  }

  if (!mediaBase64) return false;
  referencePath = ensureCodexImageReferencePath(session, savedPath, mediaName, mediaBase64) || savedPath;
  if (referencePath) mediaName = path.basename(referencePath);
  if (!size) {
    try {
      size = Buffer.from(mediaBase64, 'base64').length;
    } catch {
      size = 0;
    }
  }

  promotePendingProgress(ws, session);
  flushTextStream(ws, session.codexStreamState);
  send(ws, 'outbound_message', {
    messageId: `codex-image-${Date.now()}`,
    text: '图片已生成',
    mediaName,
    mediaType: mediaTypeFromImageName(mediaName),
    mediaBase64,
    size,
  });
  markCodexAssistantBreak(session);
  return true;
}

function ensureCodexImageReferencePath(session, savedPath, mediaName, mediaBase64) {
  const workspace = session?.workspace ? path.resolve(session.workspace) : '';
  if (!workspace) return savedPath || '';

  if (savedPath) {
    const resolvedSavedPath = path.resolve(savedPath);
    if (isInsideOrSamePath(resolvedSavedPath, workspace)) return resolvedSavedPath;
  }

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const target = nextAvailableCodexImagePath(workspace, mediaName);
    if (savedPath && fs.existsSync(savedPath)) {
      fs.copyFileSync(savedPath, target);
    } else {
      fs.writeFileSync(target, Buffer.from(mediaBase64, 'base64'));
    }
    return target;
  } catch {
    return savedPath || '';
  }
}

function nextAvailableCodexImagePath(dir, name) {
  const safeName = sanitizeCodexImageFilename(name);
  const parsed = path.parse(safeName);
  let candidate = path.join(dir, safeName);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext || '.png'}`);
    index += 1;
  }
  return candidate;
}

function sanitizeCodexImageFilename(name) {
  const base = path.basename(String(name || 'generated-image.png'))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!base) return 'generated-image.png';
  return path.extname(base) ? base : `${base}.png`;
}

function isInsideOrSamePath(filePath, dir) {
  const relative = path.relative(dir, filePath);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function extractCodexImageBase64(item = {}) {
  const result = item.result;
  if (typeof result === 'string') return normalizeMaybeDataUrlBase64(result);
  if (result && typeof result === 'object') {
    return normalizeMaybeDataUrlBase64(result.b64_json || result.base64 || result.data || result.image || '');
  }
  return '';
}

function extractSelfDefinedImageGeneration(params = {}) {
  const command = String(params.item?.command || params.command || '');
  if (!/self-define-imagegen[\\/]+scripts[\\/]+generate_image\.py/i.test(command)) return [];

  const output = codexToolOutputFromParams(params);
  const payload = parseSelfDefinedImageGenerationOutput(output);
  if (!payload) return [];

  const entries = Array.isArray(payload.data) ? payload.data : [];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const savedPath = typeof entry.savedPath === 'string'
      ? entry.savedPath
      : (typeof entry.path === 'string' ? entry.path : '');
    const base64 = normalizeMaybeDataUrlBase64(
      entry.b64_json || entry.base64 || entry.data || entry.image || '',
    );
    if (!savedPath && !base64) return null;
    return {
      type: 'imageGeneration',
      id: `${params.item?.id || params.itemId || 'self-image'}-${index + 1}`,
      status: 'completed',
      savedPath,
      result: base64 ? { b64_json: base64 } : {},
    };
  }).filter(Boolean);
}

function parseSelfDefinedImageGenerationOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;

  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.trim().startsWith('{')) continue;
    try {
      const payload = JSON.parse(candidate);
      if (
        payload?.type === 'imageGeneration'
        && payload?.source === 'self-define-imagegen'
        && payload?.version === 1
      ) {
        return payload;
      }
    } catch {
      // Try the next candidate line when command output contains surrounding text.
    }
  }
  return null;
}

function summarizeSelfDefinedImageGeneration(images) {
  return JSON.stringify({
    type: 'imageGeneration',
    source: 'self-define-imagegen',
    count: images.length,
    savedPaths: images.map(image => image.savedPath).filter(Boolean),
  });
}

function normalizeMaybeDataUrlBase64(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^data:[^;]+;base64,(.+)$/i);
  return match ? match[1] : text;
}

function mediaTypeFromImageName(name) {
  switch (path.extname(String(name || '')).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}

function isCodexProgressAssistantItem(params) {
  const type = params?.item?.type || params?.type || '';
  if (!isCodexAssistantMessageType(type)) return false;
  const phase = String(params?.item?.phase || params?.phase || '').trim();
  return Boolean(phase && phase !== 'final_answer');
}

function isCodexReasoningMethod(method) {
  const normalized = String(method || '').toLowerCase();
  return normalized.includes('reasoning') || normalized.includes('thinking');
}

function isCodexReasoningItem(type) {
  const normalized = String(type || '').toLowerCase();
  return normalized.includes('reasoning') || normalized.includes('thinking');
}

function extractReasoningText(params) {
  if (!params || typeof params !== 'object') return '';
  if (typeof params.text === 'string') return params.text;
  if (typeof params.delta === 'string') return params.delta;
  if (typeof params.summary === 'string') return params.summary;
  if (typeof params.item?.text === 'string') return params.item.text;
  if (typeof params.item?.summary === 'string') return params.item.summary;
  if (Array.isArray(params.item?.summary)) {
    return params.item.summary.map(part => {
      if (typeof part === 'string') return part;
      return part?.text || part?.summary || '';
    }).filter(Boolean).join('\n');
  }
  if (Array.isArray(params.content)) {
    return params.content.map(item => typeof item === 'string' ? item : item?.text || item?.summary || '').filter(Boolean).join('');
  }
  if (Array.isArray(params.item?.content)) {
    return params.item.content.map(item => typeof item === 'string' ? item : item?.text || item?.summary || '').filter(Boolean).join('');
  }
  return '';
}

function extractFinalText(params) {
  if (typeof params.text === 'string') return params.text;
  if (typeof params.delta === 'string') return params.delta;
  if (Array.isArray(params.content)) {
    return params.content.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  }
  if (isCodexAssistantMessageType(params.item?.type) && typeof params.item.text === 'string') {
    return params.item.text;
  }
  return '';
}

function summarizeLogValue(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const textParts = [];
    for (const item of value) {
      if (typeof item === 'string') {
        textParts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') textParts.push(item.text);
      else if (typeof item.input_text === 'string') textParts.push(item.input_text);
      else if (item.type === 'input_text' && typeof item.text === 'string') textParts.push(item.text);
    }
    const joined = textParts.map(part => part.trim()).filter(Boolean).join(' ');
    return joined ? joined.slice(0, 200) : `[array:${value.length}]`;
  }

  if (depth >= 1) return `[object:${Object.keys(value).slice(0, 10).join(',')}]`;

  const summary = {};
  for (const [key, child] of Object.entries(value)) {
    summary[key] = summarizeLogValue(child, depth + 1);
  }
  return summary;
}

function summarizeCodexItemForLog(item) {
  if (!item || typeof item !== 'object') return {};
  return summarizeLogValue(item);
}

function summarizeCodexParams(params) {
  if (!params || typeof params !== 'object') return '';
  const input = params.path || params.file || params.filePath || params.command || params.patch || params.diff || params.input || params;
  return typeof input === 'string' ? input.slice(0, 1000) : JSON.stringify(input).slice(0, 1000);
}

// ─── exec fallback mode ────────────────────────────────────────────────

function runExecTurn(input, ws, session, config) {
  session.isTurnActive = true;
  session.currentInputForNoOutput = input;
  session.sawPartialAssistantText = false;
  session.codexAssistantEnded = false;
  session.codexUseProgressiveAnswer = false;
  resetCodexAssistantText(session);
  startAssistantReplyLog(session, config, { agentType: 'codex' });

  const agentConfig = config.agents?.codex || {};
  const spawnTarget = resolveCodexSpawnTarget(agentConfig.bin || 'codex');
  const child = spawn(spawnTarget.command, [...spawnTarget.argsPrefix, ...buildExecArgs(session, agentConfig)], {
    cwd: session.workspace,
    env: buildCodexEnv(),
    shell: spawnTarget.shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.agentProcess = child;
  session.stdoutBuffer = '';
  let stderr = '';
  let assistantStarted = false;

  const ensureAssistantStarted = () => {
    if (assistantStarted) return;
    assistantStarted = true;
    send(ws, 'assistant_start', {});
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    session.stdoutBuffer += chunk;
    const lines = session.stdoutBuffer.split(/\r?\n/);
    session.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleCodexEvent(JSON.parse(trimmed), ws, session, ensureAssistantStarted);
      } catch {
        appendCodexAssistantText(`${trimmed}\n`, ws, session, ensureAssistantStarted);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  child.on('error', err => {
    sendError(ws, `Codex 启动失败: ${err.message}`);
  });

  child.on('close', code => {
    if (session.agentProcess === child) session.agentProcess = null;
    session.isTurnActive = false;
    session.currentInputForNoOutput = null;

    if (session.stdoutBuffer.trim()) {
      appendCodexAssistantText(`${session.stdoutBuffer.trim()}\n`, ws, session, ensureAssistantStarted);
      session.stdoutBuffer = '';
    }

    if (assistantStarted) {
      flushCodexAssistantText(ws, session);
      send(ws, 'assistant_end', {});
    } else if (code !== 0) {
      sendError(ws, stderr.trim() || `Codex 退出，状态码: ${code}`);
    }

    if (code === 0) {
      updateCodexSessionStats(session);
    }
    sendTurnEnd(ws, session, code === 0 ? 'completed' : 'error', code === 0 ? {} : { error: stderr.trim() || `Codex 退出，状态码: ${code}` });
    drainQueue(ws, session, config);
  });

  child.stdin.end(`${stringifyInput(buildCodexDeliveryInput(input, session, {
    config,
    includeBridgeContextHint: true,
  }))}\n`);
}

function buildExecArgs(session, agentConfig) {
  const args = session.agentSessionId
    ? ['exec', 'resume']
    : ['exec'];
  args.push('--json');
  if (!session.agentSessionId) args.push('--cd', session.workspace);
  if (agentConfig.model) args.push('--model', agentConfig.model);
  if (session.approveMode === 'yolo') args.push('--dangerously-bypass-approvals-and-sandbox');
  if (session.agentSessionId) args.push(session.agentSessionId);
  args.push('-');
  return args;
}

// ─── shared helpers ─────────────────────────────────────────────────────

function resolveCodexSpawnTarget(command) {
  const fallback = command || 'codex';
  if (process.platform !== 'win32') {
    return { command: fallback, argsPrefix: [], shell: false };
  }

  const normalized = path.normalize(fallback);
  const lower = normalized.toLowerCase();

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const shimTarget = resolveNpmShimTarget(normalized);
    if (shimTarget) {
      return { command: process.execPath, argsPrefix: [shimTarget], shell: false };
    }

    return {
      command: process.env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', quoteCmdArg(normalized)],
      shell: false,
    };
  }

  if (lower.endsWith('.exe') || path.isAbsolute(normalized)) {
    return { command: normalized, argsPrefix: [], shell: false };
  }

  return { command: fallback, argsPrefix: [], shell: true };
}

function resolveNpmShimTarget(command) {
  try {
    const source = fs.readFileSync(command, 'utf8');
    const match = source.match(/"?%(?:~dp0|dp0%)\\([^"\r\n]+?\.(?:c?js|mjs))"?/i);
    if (!match) return null;
    const target = path.resolve(path.dirname(command), match[1]);
    return fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[ \t&()^|<>"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function handleCodexEvent(event, ws, session, ensureAssistantStarted) {
  const type = event.type || event.event || event.kind || '';
  const threadId = event.thread_id || event.threadId || event.thread?.id;
  if ((type === 'thread.started' || type === 'thread_started') && threadId) {
    persistAgentSessionId(session, threadId);
    emitCodexAgentSession(session, threadId);
    return;
  }

  if (event.thread_id && !session.agentSessionId) {
    persistAgentSessionId(session, event.thread_id);
    emitCodexAgentSession(session, event.thread_id);
  }

  const text = extractText(event);
  if (text) {
    appendCodexAssistantText(text, ws, session, ensureAssistantStarted);
    return;
  }

  if (type.includes('error') || type === 'turn.failed') {
    sendError(ws, event.message || event.error || JSON.stringify(event));
  }
}

function extractText(event) {
  if (typeof event.text === 'string') return event.text;
  if (typeof event.delta === 'string') return event.delta;
  if (typeof event.message === 'string' && /message|agent/.test(String(event.type || ''))) return event.message;
  if (Array.isArray(event.content)) {
    return event.content.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  }
  if (typeof event.item?.text === 'string' && isCodexAssistantMessageType(event.item.type)) {
    return event.item.text;
  }
  if (event.item?.type === 'message' && Array.isArray(event.item.content)) {
    return event.item.content.map(item => item?.text || '').join('');
  }
  return '';
}

function resolvePendingDanger(confirmed, ws, session, config) {
  const pending = session.pendingDanger;
  if (!pending) return false;
  session.pendingDanger = null;
  if (!confirmed) {
    sendSystem(ws, '已取消危险操作。');
    return true;
  }
  execute(pending.input, ws, session, config);
  return true;
}

function resolvePendingPermission(approved, ws, session, config, requestId) {
  const pending = getPendingPermission(session, requestId, 'codex');
  if (!pending) {
    session._log?.warn('codex permission response without pending request', {
      requestId: requestId || '',
      pendingRequestIds: pendingPermissionIds(session, 'codex'),
    });
    return false;
  }

  removePendingPermission(session, pending.requestId);
  session._log?.info('codex permission response', { approved, toolName: pending.toolName, rpcId: pending._rpcId });

  // Respond to Codex RPC
  if (pending._codexMethod === 'item/commandExecution/requestApproval' || pending._codexMethod === 'execCommandApproval') {
    if (approved) {
      sendJsonRpc(session.codexAppServer, {
        jsonrpc: '2.0',
        id: pending._rpcId,
        result: { decision: 'accept' },
      });
      sendSystem(ws, '✅ 已批准命令执行。');
    } else {
      sendJsonRpc(session.codexAppServer, {
        jsonrpc: '2.0',
        id: pending._rpcId,
        result: { decision: 'reject' },
      });
      sendSystem(ws, '🚫 已拒绝命令执行。');
    }
  }

  return true;
}

function stop(session, options = {}) {
  failActiveCodexCompaction(session, 'turn_cancelled', 'Codex turn was stopped.');
  if (session.codexAppServer) {
    try {
      session.codexAppServer.kill();
    } catch {
      // ignore
    }
    session.codexAppServer = null;
  }
  stopSessionProcess(session, options);
  clearTurnState(session);
  clearPendingPermissions(session, 'codex');
  if (session.codexPendingRequests) {
    for (const [, pending] of session.codexPendingRequests) {
      pending.reject(new Error('用户已停止'));
    }
    session.codexPendingRequests.clear();
  }
  if (session._threadStartResolve) {
    session._threadStartResolve = null;
    session._threadStartReject = null;
  }
}

function drainQueue(ws, session, config) {
  const next = session.messageQueue.shift();
  if (!next) return;
  const nextInput = next && typeof next === 'object' && Object.prototype.hasOwnProperty.call(next, 'input')
    ? next.input
    : next;
  const nextWs = next && typeof next === 'object' && next.ws ? next.ws : ws;
  const nextConfig = next && typeof next === 'object' && next.config ? next.config : config;
  session._lastConfig = nextConfig;
  if (next && typeof next === 'object' && next.compact) {
    setImmediate(() => sendCodexCompactCommand(nextWs, session, nextConfig, { trigger: next.trigger || 'manual' }));
    return;
  }
  if (next && typeof next === 'object' && next.modelCommand) {
    setImmediate(() => modelCodexContext(nextWs, session, nextConfig, next.modelOptions || { command: 'show', nativeCommand: next.input }));
    return;
  }
  if (next && typeof next === 'object' && next.settingsApplyCommand) {
    setImmediate(() => applySettingsCodexContext(
      nextWs,
      session,
      nextConfig,
      next.settingsApplyOptions || { nativeCommand: next.input },
    ));
    return;
  }
  if (next && typeof next === 'object' && next.reasoningCommand) {
    setImmediate(() => reasoningCodexContext(nextWs, session, nextConfig, next.reasoningOptions || { command: 'show', nativeCommand: next.input }));
    return;
  }
  setImmediate(() => execute(nextInput, nextWs, session, nextConfig));
}

module.exports = {
  compact: compactCodexContext,
  execute,
  model: modelCodexContext,
  applySettings: applySettingsCodexContext,
  reasoning: reasoningCodexContext,
  resolvePendingDanger,
  resolvePendingPermission,
  stop,
  warmup,
  _internal: {
    buildCodexThreadStartParams,
    buildCodexThreadResumeParams,
    buildExecArgs,
    codexDefaultReasoningEffort,
    codexTurnModelOverride,
    codexTurnReasoningOverride,
    currentCodexReasoningEffort,
    codexModelInputNeedsLookup,
    codexReasoningInputNeedsLookup,
    formatCodexModelList,
    formatCodexReasoningList,
    loadCodexActualModelEntries,
    loadCodexActualModelNames,
    modelCodexContext,
    normalizeCodexModelEntries,
    normalizeCodexModelList,
    normalizeCodexReasoningEffort,
    reasoningIdsForEntry,
    recordCodexThreadReasoning,
    reasoningCodexContext,
    resolveModelNameFromList,
    sendCodexReasoningResult,
    uniqueCapabilityReasoningEfforts,
    uniqueReasoningEfforts,
    validateCodexSettingsCombination,
    withCodexFallbackModels,
    buildCodexAppServerEnv,
  },
};
