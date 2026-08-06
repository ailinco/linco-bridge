const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSlashCommand } = require('../../src/command/index');
const { buildBridgeSettingsPayload } = require('../../src/command/settingsCommand');
const {
  GET_MODELS_AND_REASONS_COMMAND,
  parseSettingsArgs,
} = require('../../src/command/settings');

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

test('Claude bridge settings expose versioned model reasoning capabilities', async () => {
  const payload = await buildBridgeSettingsPayload(
    { agentType: 'claude' },
    { agents: { claude: { model: 'OPUS', effort: 'unsupported' } } },
  );

  assert.equal(payload.capabilitiesVersion, 2);
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
  assert.deepEqual(
    payload.model.items.map(item => item.supportedReasoningEfforts),
    payload.model.items.map(() => payload.model.items[0].supportedReasoningEfforts),
  );
  assert.equal(payload.model.items[0].supportedReasoningEfforts[4].label, 'Max');
  assert.equal(payload.model.items[0].supportedReasoningEfforts[4].description, 'Maximum reasoning effort');
  assert.deepEqual(payload.model.items.map(item => item.defaultReasoningEffort), [
    'low',
    'low',
    'low',
    'low',
    'low',
  ]);
});
