const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isDangerousCommand } = require('../../core/danger');
const { buildClaudeEnv } = require('../../runtime/agentEnv');
const { buildAgentSystemPrompt } = require('../../core/agentPrompt');
const { send, sendAgentSession, sendError, sendSystem, sendTurnEnd } = require('../../core/protocol');
const {
  markClaudeResumeEntrypointFixPending,
  scheduleClaudeResumeEntrypointRepair,
} = require('../../runtime/claudeTranscript');
const {
  appendProgressiveAnswerText,
  promotePendingProgress,
  resetProgressiveAnswer,
} = require('../../core/progressiveAnswer');
const { appendTextStream, flushTextStream, resetTextStream } = require('../../core/streamBuffer');
const { captureAssistantReplyText, startAssistantReplyLog } = require('../../core/conversationLog');
const { GET_MODELS_AND_REASONS_COMMAND } = require('../../command/settings');
const { persistAgentSessionId, saveSessionMetadata, stopAgentProcess, updateAgentSessionHistory } = require('../../core/session');
const {
  getPendingPermission,
  hasPendingPermissions,
  pendingPermissionIds,
  removePendingPermission,
  setPendingPermission,
} = require('../../core/permissionState');
const {
  DEFAULT_CLAUDE_EFFORT,
  availableClaudeEfforts,
  availableClaudeModels,
  configuredClaudeEffort,
  currentClaudeEffort,
  currentClaudeModel,
  isSupportedClaudeEffort,
  resolveClaudeEffortInput,
  resolveClaudeModelInput,
} = require('./options');
const {
  buildClaudePayload,
  buildClaudeSlashPayload,
  extractText,
  stripMetaBlocks,
} = require('./input');

const CLAUDE_COMPACTION_STALE_MS = 90_000;
const DEFAULT_CLAUDE_COMPACTION_TIMEOUT_MS = 300_000;
const MAX_COMPACTION_RESULT_PREVIEW = 500;

function executeClaudeQuery(input, ws, session, config) {
  session._lastWs = ws;
  session._lastConfig = config;
  const textForCheck = typeof input === 'string' ? input : extractText(input);

  if (isDangerousCommand(textForCheck)) {
    config.logger?.warn('dangerous command detected', {
      sessionId: session.id,
      chars: textForCheck.length,
      autoApprove: session.autoApprove === true,
    });
    if (session.autoApprove === true) {
      enqueueClaudeQuery(input, ws, session, config);
      return;
    }

    const preview = textForCheck.slice(0, 200);
    send(ws, 'danger_warning', {
      text: `⚠️ 检测到可能的危险操作，请确认是否继续执行：\n\n"${preview}${textForCheck.length > 200 ? '...' : ''}"`
    });

    session.pendingDanger = {
      kind: 'message',
      resolve: () => enqueueClaudeQuery(input, ws, session, config),
    };
    return;
  }

  enqueueClaudeQuery(input, ws, session, config);
}

function enqueueClaudeQuery(input, ws, session, config) {
  if (session.isTurnActive) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      config.logger?.warn('message queue full', {
        sessionId: session.id,
        queueLength: session.messageQueue.length,
        maxQueue: config.maxMessageQueue,
      });
      sendError(ws, '❌ 消息队列已满，请稍后再发送。');
      return;
    }
    session.messageQueue.push({ input, ws, config });
    config.logger?.info('message queued', {
      sessionId: session.id,
      queueLength: session.messageQueue.length,
      maxQueue: config.maxMessageQueue,
    });
    sendSystem(ws, `⏳ Claude 正在回复，已加入队列（${session.messageQueue.length}）`);
    return;
  }

  sendClaudeQuery(input, ws, session, config);
}

function compactClaudeContext(ws, session, config, options = {}) {
  session._lastWs = ws;
  session._lastConfig = config;
  const trigger = options.trigger || 'manual';
  if (session.isTurnActive || session.claudeCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      config.logger?.warn('message queue full during claude compact', {
        sessionId: session.id,
        queueLength: session.messageQueue.length,
        maxQueue: config.maxMessageQueue,
      });
      sendError(ws, 'Message queue is full. Please try again later.');
      return true;
    }
    session.messageQueue.push({ input: '/compact', ws, config, compact: true, trigger });
    sendSystem(ws, `Claude is busy. Queued native /compact (${session.messageQueue.length}).`);
    return true;
  }

  return sendClaudeCompactCommand(ws, session, config, { trigger });
}

function applySettingsClaudeContext(ws, session, config, options = {}) {
  session._lastWs = ws;
  session._lastConfig = config;

  if (session.isTurnActive || session.claudeCompaction) {
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
    sendSystem(ws, `Claude is busy. Queued /settings apply (${session.messageQueue.length}).`);
    return true;
  }

  const effortInput = String(options.reasoningEffort || options.effort || '').trim();
  const modelInput = String(options.modelId || options.model || '').trim();
  const updates = {
    effort: effortInput ? resolveClaudeEffortInput(effortInput) : '',
    model: modelInput ? resolveClaudeModelInput(modelInput) : '',
  };

  if (updates.effort && !isSupportedClaudeEffort(updates.effort)) {
    sendError(ws, `Unsupported Claude effort: ${effortInput}. Use one of: ${availableClaudeEfforts().map(item => item.name).join(', ')}.`);
    sendTurnEnd(ws, session, 'error', { error: 'unsupported_effort' });
    return true;
  }
  if (updates.model && !updates.model.trim()) {
    sendError(ws, 'Please specify a valid model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_model' });
    return true;
  }
  if (!updates.effort && !updates.model) {
    sendError(ws, 'Please specify at least one of --reasoning or --model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_settings' });
    return true;
  }

  const previousEffort = currentClaudeEffort(session, config) || '(default)';
  const previousModel = currentClaudeModel(session, config) || '(default)';
  let changed = false;

  if (updates.effort) {
    session.claudeEffortOverride = updates.effort;
    changed = true;
  }
  if (updates.model) {
    session.claudeModelOverride = updates.model;
    changed = true;
  }
  if (changed) {
    restartClaudeProcessForRuntimeOptionChange(session);
  }

  sendClaudeSettingsApplyResult(ws, session, config, {
    status: 'set',
    previousReasoning: previousEffort,
    previousModel,
    reasoningEffort: updates.effort || currentClaudeEffort(session, config),
    modelId: updates.model || currentClaudeModel(session, config),
  });

  const notes = [];
  if (updates.effort) notes.push(`effort: ${previousEffort} -> ${updates.effort}`);
  if (updates.model) notes.push(`model: ${previousModel} -> ${updates.model}`);
  sendSystem(ws, [
    'Claude settings updated.',
    ...notes,
    'Next message will resume the same Claude session with the new settings.',
  ].join('\n'));
  sendTurnEnd(ws, session);
  return true;
}

function sendClaudeSettingsApplyResult(ws, session, config, options = {}) {
  send(ws, 'slash_command_result', {
    command: GET_MODELS_AND_REASONS_COMMAND,
    version: 1,
    data: {
      agentType: 'claude',
      status: options.status || 'set',
      reasoning: {
        current: String(options.reasoningEffort || currentClaudeEffort(session, config) || '').trim(),
        previous: String(options.previousReasoning || '').trim(),
      },
      model: {
        current: String(options.modelId || currentClaudeModel(session, config) || '').trim(),
        previous: String(options.previousModel || '').trim(),
      },
    },
  });
}

function modelClaudeContext(ws, session, config, options = {}) {
  session._lastWs = ws;
  session._lastConfig = config;
  const command = options.command || 'show';

  if (session.isTurnActive || session.claudeCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      config.logger?.warn('message queue full during claude model command', {
        sessionId: session.id,
        queueLength: session.messageQueue.length,
        maxQueue: config.maxMessageQueue,
      });
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
    sendSystem(ws, `Claude is busy. Queued /model (${session.messageQueue.length}).`);
    return true;
  }

  if (command === 'list') {
    sendClaudeResolvedModelList(ws, session, config);
    return true;
  }

  if (command === 'show') {
    sendClaudeModelStatus(ws, session, config);
    return true;
  }

  if (command === 'clear') {
    const previous = session.claudeModelOverride || '(none)';
    session.claudeModelOverride = null;
    restartClaudeProcessForModelChange(session);
    sendClaudeModelResult(ws, session, config, { status: 'cleared', previous });
    sendSystem(ws, `Claude model override cleared (was ${previous}). The next message will resume the same Claude session with ${config.agents?.claude?.model || 'the provider default model'}.`);
    sendTurnEnd(ws, session);
    return true;
  }

  const model = resolveClaudeModelInput(options.model);
  if (!model) {
    sendError(ws, 'Please specify a model.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_model' });
    return true;
  }

  const previous = currentClaudeModel(session, config) || '(default)';
  session.claudeModelOverride = model;
  restartClaudeProcessForModelChange(session);
  sendClaudeModelResult(ws, session, config, { status: 'set', previous });
  sendSystem(ws, `Claude model set: ${previous} -> ${model}\nNext message will resume the same Claude session with this model.`);
  sendTurnEnd(ws, session);
  return true;
}

function reasoningClaudeContext(ws, session, config, options = {}) {
  session._lastWs = ws;
  session._lastConfig = config;
  const command = options.command || 'show';

  if (session.isTurnActive || session.claudeCompaction) {
    if (session.messageQueue.length >= config.maxMessageQueue) {
      config.logger?.warn('message queue full during claude reasoning command', {
        sessionId: session.id,
        queueLength: session.messageQueue.length,
        maxQueue: config.maxMessageQueue,
      });
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
    sendSystem(ws, `Claude is busy. Queued /reasoning (${session.messageQueue.length}).`);
    return true;
  }

  if (command === 'list') {
    sendClaudeEffortList(ws, session, config);
    return true;
  }

  if (command === 'show') {
    sendClaudeEffortStatus(ws, session, config);
    return true;
  }

  if (command === 'clear') {
    const previous = session.claudeEffortOverride || '(none)';
    session.claudeEffortOverride = null;
    restartClaudeProcessForRuntimeOptionChange(session);
    sendSystem(ws, `Claude effort override cleared (was ${previous}). The next message will resume the same Claude session with the provider default effort.`);
    sendClaudeReasoningResult(ws, session, config, {
      status: 'cleared',
      previous,
    });
    sendTurnEnd(ws, session);
    return true;
  }

  const effort = resolveClaudeEffortInput(options.effort);
  if (!effort) {
    sendError(ws, 'Please specify an effort, for example /reasoning high.');
    sendTurnEnd(ws, session, 'error', { error: 'missing_effort' });
    return true;
  }

  if (!isSupportedClaudeEffort(effort)) {
    sendError(ws, `Unsupported Claude effort: ${options.effort}. Use one of: ${availableClaudeEfforts().map(item => item.name).join(', ')}.`);
    sendTurnEnd(ws, session, 'error', { error: 'unsupported_effort' });
    return true;
  }

  const previous = currentClaudeEffort(session, config) || '(default)';
  session.claudeEffortOverride = effort;
  restartClaudeProcessForRuntimeOptionChange(session);
  sendSystem(ws, `Claude effort set: ${previous} -> ${effort}\nNext message will resume the same Claude session with this effort.`);
  sendClaudeReasoningResult(ws, session, config, {
    status: 'set',
    previous,
  });
  sendTurnEnd(ws, session);
  return true;
}

function sendClaudeModelStatus(ws, session, config) {
  sendClaudeModelResult(ws, session, config, { status: 'status' });
  const agentConfig = config.agents?.claude || {};
  const lines = [`Claude model override: ${session.claudeModelOverride || '(none)'}`];
  if (agentConfig.model) lines.push(`Configured default: ${agentConfig.model}`);
  lines.push('Use /model <name> to resume the same Claude session with a different model.');
  lines.push('Common aliases: sonnet, opus');
  sendSystem(ws, lines.join('\n'));
  sendTurnEnd(ws, session);
}

function sendClaudeModelResult(ws, session, config, options = {}) {
  const defaultModel = String(config?.agents?.claude?.model || '').trim();
  const current = currentClaudeModel(session, config);
  send(ws, 'slash_command_result', {
    command: 'model',
    version: 1,
    data: {
      agentType: 'claude',
      status: options.status || 'status',
      current,
      previous: ['(none)', '(default)'].includes(options.previous) ? '' : String(options.previous || '').trim(),
      defaultModel,
      items: availableClaudeModels().map(model => ({
        id: model.name,
        label: model.name,
        description: model.desc,
        command: `/model ${model.name}`,
      })),
    },
  });
}

function sendClaudeEffortStatus(ws, session, config) {
  const agentConfig = config.agents?.claude || {};
  const defaultEffort = configuredClaudeEffort(config) || DEFAULT_CLAUDE_EFFORT;
  sendClaudeReasoningResult(ws, session, config, {
    status: 'status',
    defaultEffort,
  });
  const lines = [`Claude effort override: ${session.claudeEffortOverride || '(none)'}`];
  lines.push(`Configured default: ${defaultEffort}`);
  lines.push('Use /reasoning <low|medium|high|xhigh|max> to resume the same Claude session with a different effort.');
  sendSystem(ws, lines.join('\n'));
  sendTurnEnd(ws, session);
}

function sendClaudeModelList(ws, session, config) {
  const current = currentClaudeModel(session, config);
  const models = ['sonnet', 'opus'];
  const actions = models.map(model => ({
    label: model === current ? `✓ ${model}` : model,
    text: `/model ${model}`,
    command: `/model ${model}`,
    type: 'command',
    action: 'select',
    model,
  }));
  send(ws, 'system', {
    text: [
      `Current Claude model: ${current || '(default)'}`,
      '',
      ...models.map((model, index) => `${index + 1}. ${model}${model === current ? ' (current)' : ''}`),
    ].join('\n'),
    actions,
    quickActions: actions,
    quickReplies: actions,
  });
  sendTurnEnd(ws, session);
}

function sendClaudeEffortList(ws, session, config) {
  const current = currentClaudeEffort(session, config);
  const efforts = availableClaudeEfforts();
  const actions = efforts.map((effort, index) => ({
    label: effort.name === current ? `* ${effort.name}` : effort.name,
    text: `/reasoning switch ${index + 1}`,
    command: `/reasoning switch ${index + 1}`,
    type: 'command',
    action: 'select',
    effort: effort.name,
  }));
  sendClaudeReasoningResult(ws, session, config, {
    status: 'list',
    defaultEffort: configuredClaudeEffort(config) || DEFAULT_CLAUDE_EFFORT,
  });
  send(ws, 'system', {
    text: [
      `Current Claude effort: ${current || '(default)'}`,
      '',
      ...efforts.map((effort, index) => `${index + 1}. ${effort.name}${effort.name === current ? ' (current)' : ''} - ${effort.desc}`),
      '',
      'Use /reasoning <number>, /reasoning switch <number>, or /reasoning <low|medium|high|xhigh|max>.',
    ].join('\n'),
    actions,
    quickActions: actions,
    quickReplies: actions,
  });
  sendTurnEnd(ws, session);
}

function sendClaudeReasoningResult(ws, session, config, options = {}) {
  const current = String(session.claudeEffortOverride || '').trim();
  const defaultEffort = String(options.defaultEffort || configuredClaudeEffort(config) || DEFAULT_CLAUDE_EFFORT).trim();
  send(ws, 'slash_command_result', {
    command: 'reasoning',
    version: 1,
    data: {
      agentType: 'claude',
      status: options.status || 'status',
      current,
      previous: ['(none)', '(default)'].includes(options.previous) ? '' : String(options.previous || '').trim(),
      defaultEffort,
      options: availableClaudeEfforts().map(effort => ({
        id: effort.name,
        label: effort.name === 'xhigh' ? 'Extra High' : effort.name === 'max' ? 'Max' : effort.name[0].toUpperCase() + effort.name.slice(1),
        description: effort.desc,
        command: `/reasoning ${effort.name}`,
        isCurrent: effort.name === current,
        isDefault: defaultEffort ? effort.name === defaultEffort : false,
      })),
    },
  });
}

function sendClaudeResolvedModelList(ws, session, config) {
  const current = currentClaudeModel(session, config);
  const models = availableClaudeModels();
  const actions = models.map((model, index) => ({
    label: model.name === current ? `* ${model.name}` : model.name,
    text: `/model switch ${index + 1}`,
    command: `/model switch ${index + 1}`,
    type: 'command',
    action: 'select',
    model: model.name,
  }));
  send(ws, 'system', {
    text: [
      `Current Claude model: ${current || '(default)'}`,
      '',
      ...models.map((model, index) => `${index + 1}. ${model.name}${model.name === current ? ' (current)' : ''} - ${model.desc}`),
      '',
      'Use /model <number>, /model switch <number>, or /model <name>.',
    ].join('\n'),
    actions,
    quickActions: actions,
    quickReplies: actions,
  });
  sendTurnEnd(ws, session);
}

function restartClaudeProcessForModelChange(session) {
  restartClaudeProcessForRuntimeOptionChange(session);
}

function restartClaudeProcessForRuntimeOptionChange(session) {
  stopAgentProcess(session, { clearAgentSession: false });
}

function sendClaudeCompactCommand(ws, session, config, options = {}) {
  const child = ensureClaudeProcess(ws, session, config);
  if (!child) {
    sendClaudeCompactionEvent(ws, session, 'failed', {
      compactionId: `claude-compact-${Date.now()}`,
      trigger: options.trigger || 'manual',
      error: { code: 'process_unavailable', message: 'Claude process could not be started.' },
      text: 'Claude context compaction failed: process unavailable.',
    });
    sendTurnEnd(ws, session, 'error', { error: 'Claude process could not be started.' });
    return true;
  }

  if (session.claudeCompaction) {
    failActiveClaudeCompaction(ws, session, config, 'superseded', 'Another Claude compaction started before the previous one completed.');
  }

  session._lastWs = ws;
  session._lastConfig = config;
  bindClaudeOutputContext(child, ws, config);

  const compactionId = `claude-compact-${Date.now()}`;
  const compaction = {
    id: compactionId,
    trigger: options.trigger || 'manual',
    startedAt: Date.now(),
    staleTimerId: null,
    timeoutTimerId: null,
    staleNotified: false,
    completed: false,
    resultPreview: '',
  };
  session.claudeCompaction = compaction;
  session.isTurnActive = true;
  session.currentInputForNoOutput = '/compact';
  resetStreamForTurn(session);

  config.logger?.info('claude context compaction started', {
    sessionId: session.id,
    compactionId,
    trigger: compaction.trigger,
    agentSessionId: session.agentSessionId || '',
  });

  sendClaudeCompactionEvent(ws, session, 'started', {
    compactionId,
    trigger: compaction.trigger,
    text: 'Compacting Claude context...',
  });

  compaction.staleTimerId = setTimeout(() => {
    if (session.claudeCompaction !== compaction || compaction.completed) return;
    compaction.staleNotified = true;
    sendClaudeCompactionEvent(ws, session, 'stale', {
      compactionId,
      trigger: compaction.trigger,
      durationMs: Date.now() - compaction.startedAt,
      text: 'Claude context compaction is still running.',
    });
  }, CLAUDE_COMPACTION_STALE_MS);
  compaction.staleTimerId.unref?.();

  compaction.timeoutTimerId = setTimeout(() => {
    if (session.claudeCompaction !== compaction || compaction.completed) return;
    failActiveClaudeCompaction(ws, session, config, 'timeout', 'Claude context compaction timed out.');
  }, claudeCompactionTimeoutMs(session, config));
  compaction.timeoutTimerId.unref?.();

  try {
    writeClaudeJson(session, buildClaudeSlashPayload('/compact'));
  } catch (err) {
    config.logger?.error('claude compact stdin write failed', { sessionId: session.id, error: err.message });
    failActiveClaudeCompaction(ws, session, config, 'stdin_write_failed', err.message);
  }

  return true;
}

function sendClaudeQuery(input, ws, session, config) {
  const child = ensureClaudeProcess(ws, session, config);
  if (!child) return;

  session._lastWs = ws;
  session._lastConfig = config;
  bindClaudeOutputContext(child, ws, config);

  const payload = buildClaudePayload(input, session, config);
  const resumeId = session.agentSessionId;
  const isFirstNewClaudeTurn = !resumeId && (session.messageCount || 0) === 0;
  if (isFirstNewClaudeTurn && config?.agents?.claude?.fixResumeEntrypoint !== false) {
    markClaudeResumeEntrypointFixPending(session, persistSessionMetadata);
  }
  config.logger?.info('claude turn started', {
    sessionId: session.id,
    chars: extractText(input).length,
    resumeId: resumeId || '(new session)',
    workspace: session.workspace,
  });
  session.isTurnActive = true;
  session.currentInputForNoOutput = input;
  startAssistantReplyLog(session, config, { agentType: 'claude' });
  resetStreamForTurn(session);
  sendSystem(ws, `🤔 Claude 正在思考... (resume: ${resumeId || 'new'})`);

  try {
    writeClaudeJson(session, payload);
  } catch (err) {
    config.logger?.error('claude stdin write failed', { sessionId: session.id, error: err.message });
    session.isTurnActive = false;
    session.currentInputForNoOutput = null;
    clearClaudeOutputContext(child, ws);
    sendError(ws, `❌ 发送消息到 Claude 失败: ${err.message}`);
  }
}

function bindClaudeOutputContext(child, ws, config) {
  if (!child) return;
  child.lincoOutputContext = { ws, config };
}

function claudeOutputContext(child, session, fallbackWs, fallbackConfig) {
  const active = child?.lincoOutputContext;
  return {
    ws: active?.ws || session?._lastWs || fallbackWs,
    config: active?.config || session?._lastConfig || fallbackConfig,
  };
}

function clearClaudeOutputContext(child, ws) {
  if (!child?.lincoOutputContext) return;
  if (ws && child.lincoOutputContext.ws !== ws) return;
  child.lincoOutputContext = null;
}

function ensureClaudeProcess(ws, session, config) {
  if (session.claudeProcess && session.claudeProcess.exitCode === null && !session.claudeProcess.killed) {
    return session.claudeProcess;
  }

  const agentConfig = config.agents?.claude || {};
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--append-system-prompt', buildAgentSystemPrompt(session, config),
  ];
  if (session.approveMode === 'yolo') {
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push('--permission-prompt-tool', 'stdio');
  }

  const model = currentClaudeModel(session, config);
  if (model) {
    args.push('--model', model);
  }

  const effort = currentClaudeEffort(session, config);
  if (effort) {
    args.push('--effort', effort);
  }

  if (agentConfig.addRuntimeDir !== false && session.runtimeDir) {
    args.push('--add-dir', session.runtimeDir);
  }

  const resumeSessionId = session.agentSessionId;
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  const env = buildClaudeEnv();
  if (config.gitBashEnv) {
    env.CLAUDE_CODE_GIT_BASH_PATH = config.gitBashEnv;
  }

  const claudeBin = agentConfig.bin || 'claude';
  const spawnTarget = resolveClaudeSpawnTarget(claudeBin);
  config.logger?.info('claude process starting', {
    sessionId: session.id,
    cwd: session.workspace,
    command: claudeBin,
    spawnCommand: spawnTarget.command,
    model: model || '(default)',
    effort: effort || '(default)',
    resume: !!resumeSessionId,
    resumeSessionId: resumeSessionId || '(none)',
    fullCommand: `${spawnTarget.command} ${args.join(' ')}`,
  });

  const child = spawn(spawnTarget.command, args, {
    cwd: session.workspace,
    env,
    shell: spawnTarget.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  session.claudeProcess = child;
  session.agentProcess = child;
  session.stdoutBuffer = '';
  child.lincoAgentSessionIdAtSpawn = resumeSessionId || null;
  child.lincoLastStderr = '';

  child.stdout.on('data', (chunk) => {
    if (session.claudeProcess !== child) return;

    // Check first line for session_id to verify resume worked
    if (session._checkingResume) {
      session._checkingResume = false;
    } else {
      const raw = chunk.toString();
      const firstLine = raw.split('\n').find(l => l.trim());
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine);
          if (parsed.type === 'system' && parsed.subtype === 'init') {
            session._checkingResume = true;
            const actualId = parsed.session_id;
            const expectedId = resumeSessionId;
            const output = claudeOutputContext(child, session, ws, config);
            output.config?.logger?.info('claude session initialized', {
              sessionId: session.id,
              expectedResumeId: expectedId || '(none)',
              actualSessionId: actualId,
              resumed: actualId === expectedId,
            });
          }
        } catch (e) {}
      }
    }

    handleClaudeStdoutData(chunk, child, session, ws, config);
  });

  child.stderr.on('data', (data) => {
    if (session.claudeProcess !== child) return;
    const errText = data.toString().trim();
    if (errText) {
      child.lincoLastStderr = `${child.lincoLastStderr}\n${errText}`.trim().slice(-2000);
      config.logger?.warn('claude stderr', { sessionId: session.id, stderr: errText });
    }
  });

  child.on('close', (code) => {
    if (session.claudeProcess !== child) return;
    const output = claudeOutputContext(child, session, ws, config);
    const outputWs = output.ws;
    const outputConfig = output.config || config;
    outputConfig.logger?.info('claude process closed', { sessionId: session.id, code });
    clearClaudeOutputContext(child, outputWs);
    session.claudeProcess = null;
    if (session.claudeCompaction) {
      failActiveClaudeCompaction(outputWs, session, outputConfig, 'process_closed', `Claude process exited during context compaction. Exit code: ${code}`);
      return;
    }
    flushAssistantText(outputWs, session);
    if (session.isTurnActive) {
      session.isTurnActive = false;
      session.currentInputForNoOutput = null;
      const message = code === 0 || code === null ? '⚠️ Claude 会话已结束。' : `❌ Claude 进程退出，退出码: ${code}`;
      sendError(outputWs, message);
      sendTurnEnd(outputWs, session, 'error', { error: message });
      drainMessageQueue(outputWs, session, outputConfig);
    }
  });

  child.on('error', (err) => {
    if (session.claudeProcess !== child) return;
    const output = claudeOutputContext(child, session, ws, config);
    const outputWs = output.ws;
    const outputConfig = output.config || config;
    outputConfig.logger?.error('claude process spawn error', { sessionId: session.id, error: err.message });
    clearClaudeOutputContext(child, outputWs);
    session.claudeProcess = null;
    if (session.claudeCompaction) {
      failActiveClaudeCompaction(outputWs, session, outputConfig, 'process_unavailable', err.message);
      return;
    }
    session.isTurnActive = false;
    session.currentInputForNoOutput = null;
    flushAssistantText(outputWs, session);
    const message = `❌ 无法启动 Claude: ${err.message}\n请确认已安装 Claude Code 并设置好 API 密钥。`;
    sendError(outputWs, message);
    sendTurnEnd(outputWs, session, 'error', { error: message });
  });

  return child;
}

function resolveClaudeSpawnTarget(command) {
  if (process.platform !== 'win32') {
    return { command, shell: false };
  }

  const normalized = path.normalize(command || '');
  if (normalized.toLowerCase().endsWith('.cmd')) {
    const exe = path.join(path.dirname(normalized), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) {
      return { command: exe, shell: false };
    }
  }

  return { command, shell: true };
}

function writeClaudeJson(session, payload) {
  const child = session.claudeProcess;
  if (!child || child.killed || child.exitCode !== null || child.stdin.destroyed) {
    throw new Error('Claude 进程未运行');
  }
  child.stdin.write(JSON.stringify(payload) + '\n');
}

function handleClaudeStdoutData(chunk, child, session, fallbackWs, fallbackConfig) {
  session.stdoutBuffer += chunk.toString();
  const lines = session.stdoutBuffer.split('\n');
  session.stdoutBuffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const output = claudeOutputContext(child, session, fallbackWs, fallbackConfig);
    try {
      handleClaudeMessage(JSON.parse(line), output.ws, session, output.config || fallbackConfig, child);
    } catch (err) {
      (output.config || fallbackConfig).logger?.warn('claude stream-json parse failed', { sessionId: session.id, error: err.message });
    }
  }
}

async function warmup(ws, session, config) {
  session._lastWs = ws;
  session._lastConfig = config;
  const child = ensureClaudeProcess(ws, session, config);
  if (!child) throw new Error('Claude process did not start');
  return { supported: true, process: 'claude' };
}

function handleClaudeMessage(parsed, ws, session, config, child = session.claudeProcess) {
  updateClaudeSessionId(parsed, session, child, config);

  if (session.claudeCompaction) {
    handleClaudeCompactionMessage(parsed, ws, session, config);
    return;
  }

  switch (parsed.type) {
    case 'stream_event':
      handleStreamEvent(parsed, ws, session);
      break;
    case 'assistant':
      handleAssistantMessage(parsed, ws, session, config);
      break;
    case 'user':
      handleUserMessage(parsed, ws, session, config);
      break;
    case 'result':
      flushAssistantText(ws, session);
      if (session.streamState.assistantStarted) {
        send(ws, 'assistant_end');
      }
      const resultError = claudeResultErrorMessage(parsed, child);
      if (resultError) {
        config.logger?.warn('claude turn failed', {
          sessionId: session.id,
          subtype: parsed.subtype || '(none)',
          error: resultError,
        });
        sendError(ws, resultError);
        sendTurnEnd(ws, session, 'error', { error: resultError });
        session.isTurnActive = false;
        session.currentInputForNoOutput = null;
        clearClaudeOutputContext(child, ws);
        drainMessageQueue(ws, session, config);
        break;
      }
      if (!session.streamState.assistantStarted) {
        sendSystem(ws, noOutputMessage(session));
      }
      if (parsed.usage) {
        const u = parsed.usage;
        if (!session.usage) {
          session.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        }
        if (u.input_tokens) session.usage.inputTokens += u.input_tokens;
        if (u.output_tokens) session.usage.outputTokens += u.output_tokens;
        if (u.cache_read_input_tokens) session.usage.cacheReadTokens += u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) session.usage.cacheCreationTokens += u.cache_creation_input_tokens;
      }
      session.messageCount = (session.messageCount || 0) + 1;
      updateAgentSessionHistory(session);
      scheduleClaudeResumeEntrypointRepair(session, config, { saveSessionMetadata: persistSessionMetadata, homeDir: config?.homeDir });
      config.logger?.info('claude turn completed', {
        sessionId: session.id,
        queueLength: session.messageQueue.length,
        usage: session.usage,
        messageCount: session.messageCount,
      });
      sendTurnEnd(ws, session);
      session.isTurnActive = false;
      session.currentInputForNoOutput = null;
      clearClaudeOutputContext(child, ws);
      drainMessageQueue(ws, session, config);
      break;
    case 'control_request':
      handleControlRequest(parsed, ws, session, config);
      break;
    case 'control_cancel_request':
      removePendingPermission(session, parsed.request_id);
      break;
  }
}

function handleClaudeCompactionMessage(parsed, ws, session, config) {
  switch (parsed.type) {
    case 'assistant':
      captureClaudeCompactionAssistantText(parsed, session);
      return;
    case 'stream_event':
      captureClaudeCompactionStreamText(parsed, session);
      return;
    case 'result':
      completeClaudeCompaction(parsed, ws, session, config);
      return;
    case 'control_request':
      failActiveClaudeCompaction(ws, session, config, 'unexpected_permission_request', 'Claude requested tool permission during context compaction.');
      return;
    case 'control_cancel_request':
      removePendingPermission(session, parsed.request_id);
      return;
    default:
      return;
  }
}

function captureClaudeCompactionAssistantText(parsed, session) {
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'text' && block.text) appendClaudeCompactionResultPreview(session, block.text);
  }
}

function captureClaudeCompactionStreamText(parsed, session) {
  const event = parsed.event || {};
  if (event.type !== 'content_block_delta') return;
  const delta = event.delta || {};
  if (delta.type === 'text_delta' && delta.text) {
    appendClaudeCompactionResultPreview(session, delta.text);
  }
}

function appendClaudeCompactionResultPreview(session, text) {
  const compaction = session.claudeCompaction;
  if (!compaction || !text) return;
  compaction.resultPreview = `${compaction.resultPreview || ''}${text}`.slice(0, MAX_COMPACTION_RESULT_PREVIEW);
}

function completeClaudeCompaction(parsed, ws, session, config) {
  const compaction = session.claudeCompaction;
  if (!compaction || compaction.completed) {
    config.logger?.warn('claude compaction result without active state', { sessionId: session.id });
    return;
  }

  if (parsed.usage) updateClaudeUsage(session, parsed.usage);

  const resultText = String(parsed.result || compaction.resultPreview || '').trim();
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    failActiveClaudeCompaction(ws, session, config, 'agent_error', resultText || 'Claude returned an error during context compaction.');
    return;
  }

  compaction.completed = true;
  clearClaudeCompactionTimers(compaction);
  session.claudeCompaction = null;
  session.isTurnActive = false;
  session.currentInputForNoOutput = null;
  session.messageCount = (session.messageCount || 0) + 1;
  updateAgentSessionHistory(session);

  const durationMs = Date.now() - compaction.startedAt;
  sendClaudeCompactionEvent(ws, session, 'completed', {
    compactionId: compaction.id,
    trigger: compaction.trigger,
    durationMs,
    result: {
      nativeCommand: '/compact',
      agentResult: resultText.slice(0, MAX_COMPACTION_RESULT_PREVIEW),
    },
    text: 'Claude context compaction completed.',
  });
  config.logger?.info('claude context compaction completed', {
    sessionId: session.id,
    compactionId: compaction.id,
    durationMs,
    result: resultText.slice(0, 160),
  });
  sendTurnEnd(ws, session);
  clearClaudeOutputContext(session.claudeProcess, ws);
  drainMessageQueue(ws, session, config);
}

function failActiveClaudeCompaction(ws, session, config, code, message) {
  const compaction = session.claudeCompaction;
  if (!compaction || compaction.completed) return false;

  compaction.completed = true;
  clearClaudeCompactionTimers(compaction);
  session.claudeCompaction = null;
  session.isTurnActive = false;
  session.currentInputForNoOutput = null;

  const durationMs = Date.now() - compaction.startedAt;
  sendClaudeCompactionEvent(ws, session, 'failed', {
    compactionId: compaction.id,
    trigger: compaction.trigger,
    durationMs,
    error: { code, message },
    text: 'Claude context compaction failed; current session was preserved.',
  });
  config.logger?.warn('claude context compaction failed', {
    sessionId: session.id,
    compactionId: compaction.id,
    code,
    message,
    durationMs,
  });
  sendTurnEnd(ws, session, 'error', { error: message });
  clearClaudeOutputContext(session.claudeProcess, ws);
  drainMessageQueue(ws, session, config);
  return true;
}

function clearClaudeCompactionTimers(compaction) {
  if (!compaction) return;
  if (compaction.staleTimerId) clearTimeout(compaction.staleTimerId);
  if (compaction.timeoutTimerId) clearTimeout(compaction.timeoutTimerId);
  compaction.staleTimerId = null;
  compaction.timeoutTimerId = null;
}

function sendClaudeCompactionEvent(ws, session, phase, fields = {}) {
  send(ws, 'context_compaction', {
    phase,
    compactionId: fields.compactionId,
    agentType: 'claude',
    trigger: fields.trigger || 'manual',
    sessionKey: session.id,
    agentSessionId: session.agentSessionId || undefined,
    streamId: fields.streamId || ws?.linco?.streamId || session.linco?.streamId,
    requestId: fields.requestId || ws?.linco?.messageId || session.linco?.messageId,
    durationMs: fields.durationMs,
    result: fields.result,
    error: fields.error,
    text: fields.text,
    ts: Date.now(),
  });
}

function updateClaudeUsage(session, u) {
  if (!session.usage) {
    session.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  if (u.input_tokens) session.usage.inputTokens += u.input_tokens;
  if (u.output_tokens) session.usage.outputTokens += u.output_tokens;
  if (u.cache_read_input_tokens) session.usage.cacheReadTokens += u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens) session.usage.cacheCreationTokens += u.cache_creation_input_tokens;
}

function claudeCompactionTimeoutMs(session, config) {
  const configured = Number(config.agents?.claude?.compactionTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const sessionConfigured = Number(session.claudeCompactionTimeoutMs);
  if (Number.isFinite(sessionConfigured) && sessionConfigured > 0) return sessionConfigured;
  return DEFAULT_CLAUDE_COMPACTION_TIMEOUT_MS;
}

function noOutputMessage(session) {
  const input = session.currentInputForNoOutput;
  const text = extractText(input).trim();
  if (text.startsWith('/')) {
    return '✅ 操作完成，但 Claude Code 没有返回可展示内容。部分原生斜杠命令在 Linco 的 stream-json 模式下可能只在 CLI/TUI 内部生效。';
  }
  return '✅ 操作完成（无输出）';
}

function updateClaudeSessionId(parsed, session, child, config) {
  const nextId = String(parsed.session_id || '').trim();
  if (!nextId) return false;

  const currentId = String(session.agentSessionId || '').trim();
  const idAtSpawn = String(child?.lincoAgentSessionIdAtSpawn || '').trim();
  const sessionChangedAfterSpawn = currentId !== idAtSpawn;
  if (sessionChangedAfterSpawn && nextId !== currentId) {
    config?.logger?.warn('claude session update ignored from stale process', {
      sessionId: session.id,
      processResumeId: idAtSpawn || '(none)',
      currentAgentSessionId: currentId || '(none)',
      receivedAgentSessionId: nextId,
    });
    return false;
  }

  persistAgentSessionId(session, nextId);
  emitClaudeAgentSession(session, nextId);
  return true;
}

function claudeResultErrorMessage(parsed, child) {
  const subtype = String(parsed?.subtype || '').trim();
  if (parsed?.is_error !== true && (!subtype || subtype === 'success')) return '';

  const detail = [
    parsed?.result,
    parsed?.error?.message,
    typeof parsed?.error === 'string' ? parsed.error : '',
    child?.lincoLastStderr,
  ]
    .map(value => String(value || '').trim())
    .find(Boolean);
  return detail
    ? `❌ Claude 执行失败: ${detail.slice(0, 1200)}`
    : `❌ Claude 执行失败${subtype ? ` (${subtype})` : ''}`;
}

function emitClaudeAgentSession(session, sessionId = session?.agentSessionId) {
  const agentSessionId = String(sessionId || '').trim();
  if (!agentSessionId) return false;
  const output = claudeOutputContext(session?.claudeProcess, session);
  return sendAgentSession(output.ws, session, {
    agentType: 'claude',
    agentSessionId,
  });
}

function persistSessionMetadata(session) {
  saveSessionMetadata(session);
}

function handleStreamEvent(parsed, ws, session) {
  const event = parsed.event || {};
  if (event.type !== 'content_block_delta') return;

  const delta = event.delta || {};
  if (delta.type === 'text_delta' && delta.text) {
    session.sawPartialAssistantText = true;
    appendAssistantText(delta.text, ws, session);
  } else if (isReasoningDelta(delta)) {
    const text = delta.text || delta.thinking || delta.summary || '';
    if (text) send(ws, 'thinking', { text, mode: 'summary' });
  }
}

function handleAssistantMessage(parsed, ws, session, config) {
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      if (!session.sawPartialAssistantText) {
        appendAssistantText(block.text, ws, session);
      }
    } else if (block.type === 'tool_use') {
      config.logger?.info('claude tool use', {
        sessionId: session.id,
        toolName: block.name || 'tool',
        toolUseId: block.id || '',
      });
      promotePendingProgress(ws, session);
      flushTextStream(ws, session.streamState);
      send(ws, 'tool_call', {
        id: block.id || '',
        name: block.name || 'tool',
        input: formatJson(block.input),
      });
      markAssistantBreak(session);
    }
  }
}

function handleUserMessage(parsed, ws, session, config) {
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_result') {
      config.logger?.info('claude tool result', {
        sessionId: session.id,
        toolUseId: block.tool_use_id || '',
        isError: !!block.is_error,
      });
      send(ws, 'tool_result', {
        toolUseId: block.tool_use_id || '',
        isError: !!block.is_error,
        output: formatToolResult(block.content),
      });
      markAssistantBreak(session);
    }
  }
}

function appendAssistantText(text, ws, session) {
  appendProgressiveAnswerText(text, ws, session);
  maybeAppendAssistantBreak(ws, session);
  appendAssistantTextNow(text, ws, session);
}

function appendAssistantTextNow(text, ws, session) {
  appendTextStream(text, ws, session.streamState, { phase: 'progress', ephemeral: true });
  rememberAssistantText(session, text);
}

function isReasoningDelta(delta) {
  const type = String(delta?.type || '').toLowerCase();
  return type.includes('thinking') || type.includes('reasoning');
}

function flushAssistantText(ws, session) {
  flushTextStream(ws, session.streamState);
}

function resetStreamForTurn(session) {
  session.streamState.onStart = (startWs) => {
    send(startWs, 'thinking_clear');
    send(startWs, 'assistant_start');
  };
  resetTextStream(session.streamState);
  resetProgressiveAnswer(session);
  session.sawPartialAssistantText = false;
  session.needsAssistantBreak = false;
  session.assistantTextTail = '';
  session._checkingResume = false;
}

function maybeAppendAssistantBreak(ws, session) {
  if (!session?.needsAssistantBreak || !session.sawPartialAssistantText) {
    if (session) session.needsAssistantBreak = false;
    return;
  }
  session.needsAssistantBreak = false;
  const tail = `${session.assistantTextTail || ''}${session.streamState?.pendingText || ''}`;
  if (tail.endsWith('\n\n')) return;
  appendAssistantTextNow(tail.endsWith('\n') ? '\n' : '\n\n', ws, session);
}

function markAssistantBreak(session) {
  if (!session?.sawPartialAssistantText) return;
  session.needsAssistantBreak = true;
}

function rememberAssistantText(session, text) {
  captureAssistantReplyText(session, text);
  const next = `${session.assistantTextTail || ''}${text || ''}`;
  session.assistantTextTail = next.slice(-4000);
}

function handleControlRequest(parsed, ws, session, config) {
  const requestID = parsed.request_id;
  const request = parsed.request || {};
  if (request.subtype !== 'can_use_tool') return;

  const toolName = request.tool_name || 'tool';
  const input = sanitizeToolInput(toolName, request.input || {});
  const inputText = summarizeInput(input);

  if (requestID && getPendingPermission(session, requestID, 'claude')) {
    config.logger?.info('duplicate permission request ignored', {
      sessionId: session.id,
      requestId: requestID,
      toolName,
    });
    return;
  }

  const pending = {
    provider: 'claude',
    requestId: requestID,
    toolName,
    input,
  };
  setPendingPermission(session, pending);

  config.logger?.info('permission request received', {
    sessionId: session.id,
    requestId: requestID,
    toolName,
    autoApprove: session.autoApprove === true,
  });

  if (session.autoApprove === true) {
    try {
      respondPermission(session, true, requestID);
      config.logger?.info('permission auto-approved', {
        sessionId: session.id,
        requestId: requestID,
        toolName,
      });
    } catch (err) {
      sendError(ws, `❌ 自动批准工具权限失败: ${err.message}`);
    }
    return;
  }

  send(ws, 'permission_request', {
    requestId: requestID,
    toolName,
    input: inputText,
  });
}

function respondPermission(session, approved, requestId) {
  const pending = getPendingPermission(session, requestId, 'claude');
  if (!pending) return false;

  const response = approved
    ? { behavior: 'allow', updatedInput: pending.input || {} }
    : { behavior: 'deny', message: 'The user denied this tool use. Stop and wait for the user\'s instructions.' };

  writeClaudeJson(session, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: pending.requestId,
      response,
    },
  });
  removePendingPermission(session, pending.requestId);
  return true;
}

function resolvePendingPermission(approved, ws, session, config, requestId) {
  const pending = getPendingPermission(session, requestId, 'claude');
  if (!pending) {
    config.logger?.warn('permission response without pending request', {
      sessionId: session.id,
      requestId: requestId || '',
      pendingRequestIds: pendingPermissionIds(session, 'claude'),
    });
    return false;
  }

  try {
    respondPermission(session, approved, pending.requestId);
    config.logger?.info('permission response sent', {
      sessionId: session.id,
      requestId: pending?.requestId,
      toolName: pending?.toolName,
      approved,
    });
    sendSystem(ws, approved ? '✅ 已批准工具使用。' : '🚫 已拒绝工具使用。');
  } catch (err) {
    sendError(ws, `❌ 回复权限请求失败: ${err.message}`);
  }
  return true;
}

function resolvePendingDanger(approved, ws, session, config) {
  if (!session.pendingDanger) return false;

  const { resolve } = session.pendingDanger;
  session.pendingDanger = null;

  config.logger?.info('danger confirmation resolved', { sessionId: session.id, approved });

  if (approved) {
    sendSystem(ws, '⚠️ 危险操作已批准，执行中...');
    resolve();
  } else {
    sendSystem(ws, '🚫 已取消危险操作');
  }
  return true;
}

function drainMessageQueue(ws, session, config) {
  if (session.isTurnActive || session.claudeCompaction || hasPendingPermissions(session, 'claude')) return;
  const next = session.messageQueue.shift();
  if (!next) return;
  config.logger?.info('message dequeued', { sessionId: session.id, queueLength: session.messageQueue.length });
  if (next.compact) {
    sendClaudeCompactCommand(next.ws || ws, session, next.config || config, { trigger: next.trigger || 'manual' });
    return;
  }
  if (next.modelCommand) {
    modelClaudeContext(next.ws || ws, session, next.config || config, next.modelOptions || { command: 'show', nativeCommand: next.input });
    return;
  }
  if (next.settingsApplyCommand) {
    applySettingsClaudeContext(
      next.ws || ws,
      session,
      next.config || config,
      next.settingsApplyOptions || { nativeCommand: next.input },
    );
    return;
  }
  if (next.reasoningCommand) {
    reasoningClaudeContext(next.ws || ws, session, next.config || config, next.reasoningOptions || { command: 'show', nativeCommand: next.input });
    return;
  }
  sendClaudeQuery(next.input, next.ws || ws, session, next.config || config);
}

function formatJson(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item?.type === 'text') return item.text || '';
      return formatJson(item);
    }).filter(Boolean).join('\n');
  }
  return formatJson(content);
}

function sanitizeToolInput(toolName, input) {
  if (toolName !== 'Read' || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (input.pages !== '') return input;

  const sanitized = { ...input };
  delete sanitized.pages;
  return sanitized;
}

function summarizeInput(input) {
  try {
    const text = JSON.stringify(input, null, 2);
    return text.length > 1200 ? text.slice(0, 1200) + '\n...' : text;
  } catch {
    return String(input);
  }
}

module.exports = {
  buildClaudePayload,
  compact: compactClaudeContext,
  compactClaudeContext,
  execute: executeClaudeQuery,
  executeClaudeQuery,
  flushAssistantText,
  model: modelClaudeContext,
  applySettings: applySettingsClaudeContext,
  reasoning: reasoningClaudeContext,
  resolvePendingDanger,
  resolvePendingPermission,
  stop: stopAgentProcess,
  warmup,
  _internal: {
    stripMetaBlocks,
    buildClaudeSlashPayload,
    captureClaudeCompactionAssistantText,
    completeClaudeCompaction,
    extractText,
    failActiveClaudeCompaction,
    handleAssistantMessage,
    handleClaudeMessage,
    handleStreamEvent,
    currentClaudeEffort,
    availableClaudeEfforts,
    availableClaudeModels,
    resolveClaudeModelInput,
    resolveClaudeEffortInput,
    currentClaudeModel,
    sendClaudeCompactCommand,
  },
};
