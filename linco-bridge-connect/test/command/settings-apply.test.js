const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSlashCommand } = require('../../src/command/index');
const { buildBridgeSettingsPayload } = require('../../src/command/settingsCommand');
const {
  GET_MODELS_AND_REASONS_COMMAND,
  parseSettingsArgs,
} = require('../../src/command/settings');
const codex = require('../../src/agent/codex');

function makeWs() {
  const sent = [];
  return {
    sent,
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

function fakeChild() {
  return {
    stdin: {
      destroyed: false,
      written: [],
      write(chunk) {
        this.written.push(chunk);
      },
    },
  };
}

function makeCodexApplyHarness(overrides = {}) {
  const child = fakeChild();
  const ws = makeWs();
  const session = {
    id: 'session-codex-settings-apply',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-settings-apply', streamId: 'linco-stream-codex-settings-apply' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexAppServer: child,
    codexPendingRequests: new Map(),
    codexRpcId: 0,
    codexModelOverride: 'gpt-5.5',
    codexReasoningEffortOverride: 'high',
    codexModelOverrideDirty: false,
    codexReasoningEffortDirty: false,
    messageQueue: [],
    agentSessionHistory: [],
    ...overrides,
  };
  const config = {
    agents: { codex: { mode: 'app-server', model: 'gpt-5.5', reasoningEffort: 'high' } },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { child, config, session, ws };
}

async function resolveNextModelList(session, child, result, options = {}) {
  await new Promise(resolve => setImmediate(resolve));
  const request = child.stdin.written
    .map(line => JSON.parse(line))
    .find(message => message.method === 'model/list' && session.codexPendingRequests.has(message.id));
  assert.ok(request, 'expected a pending model/list request');
  const pending = session.codexPendingRequests.get(request.id);
  if (options.reject) pending.reject(result);
  else pending.resolve(result);
  await new Promise(resolve => setImmediate(resolve));
}

async function resolveNextRpc(session, child, method, result) {
  let request;
  for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    request = child.stdin.written
      .map(line => JSON.parse(line))
      .find(message => message.method === method && session.codexPendingRequests.has(message.id));
  }
  assert.ok(request, `expected a pending ${method} request; wrote ${child.stdin.written.join(' | ')}`);
  session.codexPendingRequests.get(request.id).resolve(result);
  await new Promise(resolve => setImmediate(resolve));
}

test('parseSettingsArgs parses composite apply command', () => {
  assert.deepEqual(
    parseSettingsArgs('apply --reasoning high --model gpt-5.5'),
    {
      mode: 'apply',
      reasoningEffort: 'high',
      modelId: 'gpt-5.5',
    },
  );
});

test('claude /settings apply updates model and effort with one restart', () => {
  const ws = makeWs();
  const session = {
    id: 'session-settings-apply',
    storageId: 'sid_settings_apply',
    workspace: process.cwd(),
    runtimeDir: process.cwd(),
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
    claudeProcess: {
      stdin: null,
      killed: false,
      exitCode: null,
      kill() {
        this.killed = true;
      },
    },
  };

  assert.strictEqual(
    handleSlashCommand(
      '/settings apply --reasoning high --model opus',
      ws,
      session,
      { agents: { claude: { model: 'sonnet', effort: 'medium' } } },
    ),
    true,
  );

  assert.strictEqual(session.claudeEffortOverride, 'high');
  assert.strictEqual(session.claudeModelOverride, 'opus');
  assert.strictEqual(session.claudeProcess, null);

  const result = ws.sent.find(item => item.type === 'slash_command_result');
  assert.equal(result?.command, GET_MODELS_AND_REASONS_COMMAND);
  assert.equal(result?.data?.reasoning?.current, 'high');
  assert.equal(result?.data?.model?.current, 'opus');
});

test('codex /settings apply validates the complete model-effort combination before mutating state', async () => {
  const { child, config, session, ws } = makeCodexApplyHarness();

  assert.equal(handleSlashCommand('/settings apply --reasoning ultra --model gpt-5.6-luna', ws, session, config), true);
  await resolveNextModelList(session, child, {
    models: [{
      id: 'gpt-5.6-luna',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'max' },
      ],
    }],
  });

  assert.equal(session.codexModelOverride, 'gpt-5.5');
  assert.equal(session.codexReasoningEffortOverride, 'high');
  assert.equal(session.codexModelOverrideDirty, false);
  assert.equal(session.codexReasoningEffortDirty, false);
  assert.match(ws.sent.find(item => item.type === 'error')?.text || '', /ultra/i);
  assert.equal(ws.sent.at(-1).type, 'turn_end');
  assert.equal(ws.sent.at(-1).reason, 'error');
});

test('codex /settings apply atomically applies model-specific max and ultra capabilities', async () => {
  const { child, config, session, ws } = makeCodexApplyHarness();

  assert.equal(handleSlashCommand('/settings apply --reasoning ULTRA --model gpt-5.6-sol', ws, session, config), true);
  await resolveNextModelList(session, child, {
    models: [{
      id: 'gpt-5.6-sol',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'ultra' },
      ],
    }],
  });

  assert.equal(session.codexModelOverride, 'gpt-5.6-sol');
  assert.equal(session.codexReasoningEffortOverride, 'ultra');
  assert.equal(session.codexModelOverrideDirty, true);
  assert.equal(session.codexReasoningEffortDirty, true);
  const result = ws.sent.find(item => item.type === 'slash_command_result');
  assert.equal(result.data.model.current, 'gpt-5.6-sol');
  assert.equal(result.data.reasoning.current, 'ultra');
  assert.equal(child.stdin.written.filter(line => JSON.parse(line).method === 'model/list').length, 1);
});

test('codex /settings apply keeps legacy reasoning validation for unknown custom models', async () => {
  const { child, config, session, ws } = makeCodexApplyHarness();

  assert.equal(handleSlashCommand('/settings apply --reasoning high --model provider/custom', ws, session, config), true);
  await resolveNextModelList(session, child, {
    models: [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }],
  });

  assert.equal(session.codexModelOverride, 'provider/custom');
  assert.equal(session.codexReasoningEffortOverride, 'high');
  assert.equal(session.codexModelOverrideDirty, true);
  assert.equal(session.codexReasoningEffortDirty, true);
  assert.equal(ws.sent.at(-1).type, 'turn_end');
  assert.notEqual(ws.sent.at(-1).reason, 'error');
});

test('codex /settings apply respects explicit empty reasoning capabilities', async () => {
  const entries = [{
    id: 'gpt-no-reasoning',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [],
  }];

  const modelOnly = makeCodexApplyHarness();
  assert.equal(handleSlashCommand('/settings apply --model gpt-no-reasoning', modelOnly.ws, modelOnly.session, modelOnly.config), true);
  await resolveNextModelList(modelOnly.session, modelOnly.child, { models: entries });
  assert.equal(modelOnly.session.codexModelOverride, 'gpt-no-reasoning');
  assert.equal(modelOnly.session.codexReasoningEffortOverride, null);
  assert.equal(modelOnly.session.codexModelOverrideDirty, true);
  assert.equal(modelOnly.session.codexReasoningEffortDirty, true);

  const withReasoning = makeCodexApplyHarness();
  assert.equal(handleSlashCommand('/settings apply --reasoning high --model gpt-no-reasoning', withReasoning.ws, withReasoning.session, withReasoning.config), true);
  await resolveNextModelList(withReasoning.session, withReasoning.child, { models: entries });
  assert.equal(withReasoning.session.codexModelOverride, 'gpt-5.5');
  assert.equal(withReasoning.session.codexReasoningEffortOverride, 'high');
  assert.equal(withReasoning.session.codexModelOverrideDirty, false);
  assert.equal(withReasoning.session.codexReasoningEffortDirty, false);
  assert.equal(withReasoning.ws.sent.at(-1).reason, 'error');
});

test('codex model-only apply sends an atomic compatible combination on the next turn', async () => {
  const narrow = makeCodexApplyHarness();
  assert.equal(handleSlashCommand('/settings apply --model gpt-narrow', narrow.ws, narrow.session, narrow.config), true);
  await resolveNextModelList(narrow.session, narrow.child, {
    models: [{
      id: 'gpt-narrow',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low'],
    }],
  });
  assert.equal(narrow.session.codexModelOverride, 'gpt-narrow');
  assert.equal(narrow.session.codexReasoningEffortOverride, 'low');
  assert.equal(narrow.session.codexModelOverrideDirty, true);
  assert.equal(narrow.session.codexReasoningEffortDirty, true);

  const narrowTurnWs = makeWs();
  codex.execute('next turn', narrowTurnWs, narrow.session, narrow.config);
  await resolveNextRpc(narrow.session, narrow.child, 'config/read', {});
  await resolveNextRpc(narrow.session, narrow.child, 'thread/resume', { thread: { id: 'codex-thread-1' } });
  const narrowTurn = narrow.child.stdin.written.map(line => JSON.parse(line)).find(message => message.method === 'turn/start');
  assert.equal(narrowTurn.params.model, 'gpt-narrow');
  assert.equal(narrowTurn.params.effort, 'low');

  const empty = makeCodexApplyHarness();
  assert.equal(handleSlashCommand('/settings apply --model gpt-no-reasoning', empty.ws, empty.session, empty.config), true);
  await resolveNextModelList(empty.session, empty.child, {
    models: [{ id: 'gpt-no-reasoning', supportedReasoningEfforts: [] }],
  });
  assert.equal(empty.session.codexModelOverride, 'gpt-no-reasoning');
  assert.equal(empty.session.codexReasoningEffortOverride, null);
  assert.equal(empty.session.codexModelOverrideDirty, true);
  assert.equal(empty.session.codexReasoningEffortDirty, true);

  const emptyTurnWs = makeWs();
  codex.execute('next turn', emptyTurnWs, empty.session, empty.config);
  await resolveNextRpc(empty.session, empty.child, 'config/read', {});
  await resolveNextRpc(empty.session, empty.child, 'thread/resume', { thread: { id: 'codex-thread-1' } });
  const emptyTurn = empty.child.stdin.written.map(line => JSON.parse(line)).find(message => message.method === 'turn/start');
  assert.equal(emptyTurn.params.model, 'gpt-no-reasoning');
  assert.equal(Object.prototype.hasOwnProperty.call(emptyTurn.params, 'effort'), false);
});

test('codex /settings apply does not mutate state when model capabilities cannot be loaded', async () => {
  const { child, config, session, ws } = makeCodexApplyHarness();

  assert.equal(handleSlashCommand('/settings apply --reasoning high --model gpt-5.6-sol', ws, session, config), true);
  await resolveNextModelList(session, child, new Error('model list unavailable'), { reject: true });

  assert.equal(session.codexModelOverride, 'gpt-5.5');
  assert.equal(session.codexReasoningEffortOverride, 'high');
  assert.equal(session.codexModelOverrideDirty, false);
  assert.equal(session.codexReasoningEffortDirty, false);
  assert.match(ws.sent.find(item => item.type === 'error')?.text || '', /model list unavailable/);
  assert.equal(ws.sent.at(-1).reason, 'error');
});

test('codex /settings apply rejects reasoning for an implicit runtime model with explicit empty capabilities', async () => {
  const modelLists = [
    {
      models: [
        { id: 'capable-first', supportedReasoningEfforts: ['high'] },
        { id: 'runtime-default-empty', isDefault: true, supportedReasoningEfforts: [] },
      ],
    },
    {
      models: [
        { id: 'runtime-first-empty', supportedReasoningEfforts: [] },
        { id: 'capable-second', supportedReasoningEfforts: ['high'] },
      ],
    },
  ];

  for (const modelList of modelLists) {
    const { child, config, session, ws } = makeCodexApplyHarness({
      codexModelOverride: '',
      codexReasoningEffortOverride: 'low',
    });
    config.agents.codex.model = '';
    config.agents.codex.reasoningEffort = 'low';

    assert.equal(handleSlashCommand('/settings apply --reasoning high', ws, session, config), true);
    await resolveNextModelList(session, child, modelList);

    assert.equal(session.codexModelOverride, '');
    assert.equal(session.codexReasoningEffortOverride, 'low');
    assert.equal(session.codexModelOverrideDirty, false);
    assert.equal(session.codexReasoningEffortDirty, false);
    assert.equal(ws.sent.at(-1).reason, 'error');
  }
});

test('codex /settings apply validates reasoning against the implicit first runtime model', async () => {
  const { child, config, session, ws } = makeCodexApplyHarness({
    codexModelOverride: '',
    codexReasoningEffortOverride: 'low',
  });
  config.agents.codex.model = '';
  config.agents.codex.reasoningEffort = 'low';

  assert.equal(handleSlashCommand('/settings apply --reasoning ultra', ws, session, config), true);
  await resolveNextModelList(session, child, {
    models: [{ id: 'runtime-first-ultra', supportedReasoningEfforts: ['low', 'ultra'] }],
  });

  assert.equal(session.codexModelOverride, '');
  assert.equal(session.codexReasoningEffortOverride, 'ultra');
  assert.equal(session.codexModelOverrideDirty, false);
  assert.equal(session.codexReasoningEffortDirty, true);
  assert.equal(ws.sent.at(-1).reason, 'completed');
});

test('validateCodexSettingsCombination uses normalized model capabilities', () => {
  const entries = codex._internal.normalizeCodexModelEntries({
    models: [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'ULTRA' }] }],
  });

  assert.deepEqual(
    codex._internal.validateCodexSettingsCombination({ entries, model: 'GPT-5.6-SOL', effort: 'ULTRA' }),
    { model: 'gpt-5.6-sol', effort: 'ultra' },
  );
});

test('Claude bridge settings expose versioned model reasoning capabilities', async () => {
  const payload = await buildBridgeSettingsPayload(
    { agentType: 'claude' },
    { agents: { claude: { model: 'OPUS', effort: 'unsupported' } } },
  );

  assert.equal(payload.capabilitiesVersion, 2);
  assert.equal(payload.reasoning.defaultEffort, 'high');
  assert.equal(payload.reasoning.options[0].command, '/reasoning low');
  assert.equal(payload.model.runtimeDefaultModelId, 'opus');
  assert.deepEqual(payload.model.items.map(item => item.id), [
    'sonnet',
    'opus',
    'opus[1m]',
    'haiku',
    'fable',
  ]);
  assert.deepEqual(payload.model.items[0].supportedReasoningEfforts.map(item => item.id), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  const topLevelCapabilities = payload.reasoning.options.map(({ command, ...option }) => option);
  for (const model of payload.model.items) {
    assert.deepEqual(model.supportedReasoningEfforts, topLevelCapabilities);
  }
  assert.equal(payload.model.items[0].supportedReasoningEfforts[4].label, 'Max');
  assert.equal(payload.model.items[0].supportedReasoningEfforts[4].description, 'Maximum reasoning effort');
  assert.deepEqual(payload.model.items.map(item => item.defaultReasoningEffort), [
    'high',
    'high',
    'high',
    'high',
    'high',
  ]);

  const emptyConfig = { agents: { claude: {} } };
  const fallbackPayload = await buildBridgeSettingsPayload(
    { agentType: 'claude' },
    emptyConfig,
  );
  const reasoningWs = makeWs();
  assert.equal(handleSlashCommand('/reasoning status', reasoningWs, { agentType: 'claude' }, emptyConfig), true);
  const reasoningStatus = reasoningWs.sent.find(item => item.type === 'slash_command_result' && item.command === 'reasoning');
  assert.equal(fallbackPayload.reasoning.defaultEffort, reasoningStatus.data.defaultEffort);
  assert.equal(fallbackPayload.reasoning.defaultEffort, 'high');
  assert.equal(fallbackPayload.model.runtimeDefaultModelId, 'sonnet');
  assert.deepEqual(fallbackPayload.model.items.map(item => item.defaultReasoningEffort), [
    'high',
    'high',
    'high',
    'high',
    'high',
  ]);

  const configuredPayload = await buildBridgeSettingsPayload(
    { agentType: 'claude' },
    { agents: { claude: { effort: 'max', model: 'not-a-claude-model' } } },
  );
  assert.equal(configuredPayload.reasoning.defaultEffort, 'max');
  assert.equal(configuredPayload.model.runtimeDefaultModelId, 'sonnet');
  assert.deepEqual(configuredPayload.model.items.map(item => item.defaultReasoningEffort), [
    'max',
    'max',
    'max',
    'max',
    'max',
  ]);
});
