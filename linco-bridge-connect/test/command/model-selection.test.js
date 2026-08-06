const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleSlashCommand, _internal: slashInternals } = require('../../src/command');
const { createSession, saveSessionMetadata } = require('../../src/core/session');
const claude = require('../../src/agent/claude');
const codex = require('../../src/agent/codex');
const {
  formatCodexReasoningEffortLabel,
  normalizeCodexReasoningOptions,
} = require('../../src/agent/codex/options');
const hermes = require('../../src/agent/hermes');
const openclaw = require('../../src/agent/openclaw');
const { createTextStreamBuffer } = require('../../src/core/streamBuffer');

function createCaptureWs() {
  const sent = [];
  return {
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
}

function fakeChild() {
  return {
    killed: false,
    exitCode: null,
    stdin: {
      destroyed: false,
      written: [],
      write(chunk) {
        this.written.push(chunk);
      },
    },
  };
}

{
  const lincoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-model-session-'));
  const config = { lincoHome, sessionsDir: path.join(lincoHome, 'legacy'), attachmentsDirName: 'attachments' };
  const session = createSession(config, { externalSessionId: 'model-session', agentType: 'claude' });
  session.model = 'sonnet';
  saveSessionMetadata(session);

  const metadata = JSON.parse(fs.readFileSync(path.join(session.runtimeDir, 'session.json'), 'utf8'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(metadata, 'model'), false);
  const restored = createSession(config, { externalSessionId: 'model-session', agentType: 'claude' });
  assert.strictEqual(restored.model, undefined);
}

{
  const child = fakeChild();
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-model',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-model', streamId: 'linco-stream-claude-model' },
    agentType: 'claude',
    agentSessionId: 'claude-native-session',
    claudeProcess: child,
    messageQueue: [],
    agentSessionHistory: [],
    streamState: createTextStreamBuffer(),
  };
  const config = { maxMessageQueue: 10, agents: { claude: { model: 'opus' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/model sonnet', ws, session, config), true);
  assert.strictEqual(session.agentSessionId, 'claude-native-session');
  assert.strictEqual(session.claudeModelOverride, 'sonnet');
  assert.strictEqual(session.claudeProcess, null);
  assert.strictEqual(child.stdin.written.length, 0);
  assert.strictEqual(ws.sent.find(item => item.type === 'slash_command_result' && item.command === 'model').data.current, 'sonnet');
  assert.match(ws.sent.find(item => item.type === 'system')?.text, /Claude model set: opus -> sonnet/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-model',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-model', streamId: 'linco-stream-codex-model' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = { agents: { codex: { mode: 'app-server', model: 'gpt-5' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/model gpt-5-codex', ws, session, config), true);
  assert.strictEqual(session.agentSessionId, 'codex-thread-1');
  assert.strictEqual(session.codexModelOverride, 'gpt-5-codex');
  assert.strictEqual(session.codexModelOverrideDirty, true);
  assert.strictEqual(ws.sent.find(item => item.type === 'slash_command_result' && item.command === 'model').data.current, 'gpt-5-codex');
  assert.strictEqual(codex._internal.codexTurnModelOverride(session).model, 'gpt-5-codex');
  assert.deepStrictEqual(codex._internal.codexTurnModelOverride(session), {});
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-model-status',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-model-status', streamId: 'linco-stream-codex-model-status' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-status',
    codexModelOverride: 'gpt-5-codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = { agents: { codex: { mode: 'app-server', model: 'gpt-5' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/model status', ws, session, config), true);
  const result = ws.sent.find(item => item.type === 'slash_command_result' && item.command === 'model');
  assert.strictEqual(result.data.status, 'status');
  assert.strictEqual(result.data.current, 'gpt-5-codex');
  assert.ok(result.data.items.some(item => item.id === 'gpt-5-codex'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

const codexSettingsTest = (async () => {
  const ws = createCaptureWs();
  const child = fakeChild();
  const session = {
    id: 'session-codex-settings',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-settings', streamId: 'linco-stream-codex-settings' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexAppServer: child,
    codexPendingRequests: new Map(),
    codexRpcId: 0,
    codexModelOverride: 'gpt-5.5',
    codexReasoningEffortOverride: 'high',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = { agents: { codex: { mode: 'app-server', model: 'gpt-5.4' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('getModelsAndReasons', ws, session, config), true);
  await new Promise(resolve => setImmediate(resolve));
  const rpc = JSON.parse(child.stdin.written[0]);
  assert.strictEqual(rpc.method, 'model/list');
  session.codexPendingRequests.get(rpc.id).resolve({
    models: [
      { id: 'actual-model-a' },
      { id: 'actual-model-b' },
    ],
  });
  await new Promise(resolve => setImmediate(resolve));
  const result = ws.sent.find(item => item.type === 'slash_command_result');
  assert.strictEqual(result.command, 'getModelsAndReasons');
  assert.strictEqual(result.data.reasoning.current, 'high');
  assert.strictEqual(result.data.model.current, 'gpt-5.5');
  assert.ok(result.data.reasoning.options.some(item => item.id === 'high'));
  assert.deepStrictEqual(result.data.model.items.map(item => item.id), [
    'actual-model-a',
    'actual-model-b',
  ]);
  assert.strictEqual(result.data.model.items.some(item => item.id === 'codex-mini-latest'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.data.reasoning.options[0], 'isCurrent'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.data.reasoning.options[0], 'isDefault'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.data.model.items[0], 'isCurrent'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.data.model.items[0], 'isDefault'), false);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');

  const failedWs = createCaptureWs();
  const failedChild = fakeChild();
  const failedSession = {
    ...session,
    id: 'session-codex-settings-failed-list',
    linco: { messageId: 'm-codex-settings-failed-list', streamId: 'linco-stream-codex-settings-failed-list' },
    codexAppServer: failedChild,
    codexPendingRequests: new Map(),
    codexRpcId: 0,
  };
  assert.strictEqual(handleSlashCommand('/settings', failedWs, failedSession, config), true);
  await new Promise(resolve => setImmediate(resolve));
  const failedRpc = JSON.parse(failedChild.stdin.written[0]);
  failedSession.codexPendingRequests.get(failedRpc.id).reject(new Error('model list unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  const failedResult = failedWs.sent.find(item => item.type === 'slash_command_result');
  assert.deepStrictEqual(failedResult.data.model.items, []);
  assert.strictEqual(failedResult.data.model.listError, 'model list unavailable');
  assert.strictEqual(failedResult.data.model.items.some(item => item.id === 'codex-mini-latest'), false);

  const defaultOnlyWs = createCaptureWs();
  const defaultOnlyChild = fakeChild();
  const defaultOnlySession = {
    ...session,
    id: 'session-codex-settings-default-only',
    linco: { messageId: 'm-codex-settings-default-only', streamId: 'linco-stream-codex-settings-default-only' },
    codexAppServer: defaultOnlyChild,
    codexPendingRequests: new Map(),
    codexRpcId: 0,
    codexModelOverride: '',
  };
  assert.strictEqual(handleSlashCommand('getModelsAndReasons', defaultOnlyWs, defaultOnlySession, config), true);
  await new Promise(resolve => setImmediate(resolve));
  const defaultOnlyRpc = JSON.parse(defaultOnlyChild.stdin.written[0]);
  defaultOnlySession.codexPendingRequests.get(defaultOnlyRpc.id).resolve({
    models: [{ id: 'gpt-5.4' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  const defaultOnlyResult = defaultOnlyWs.sent.find(item => item.type === 'slash_command_result');
  assert.strictEqual(defaultOnlyResult.data.model.current, '');
  assert.strictEqual(defaultOnlyResult.data.model.defaultModel, 'gpt-5.4');
})();

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-model-clear',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-model-clear', streamId: 'linco-stream-codex-model-clear' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexModelOverride: 'gpt-5-codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model --clear', ws, session, { agents: { codex: { mode: 'app-server' } } }), true);
  assert.strictEqual(session.agentSessionId, 'codex-thread-1');
  assert.strictEqual(session.codexModelOverride, null);
  assert.deepStrictEqual(codex._internal.codexTurnModelOverride(session), { model: null });
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-reasoning',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning', streamId: 'linco-stream-codex-reasoning' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = { agents: { codex: { mode: 'app-server', model: 'gpt-5.5' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/reasoning extra-high', ws, session, config), true);
  assert.strictEqual(session.agentSessionId, 'codex-thread-1');
  assert.strictEqual(session.codexReasoningEffortOverride, 'xhigh');
  assert.strictEqual(session.codexReasoningEffortDirty, true);
  assert.deepStrictEqual(codex._internal.codexTurnReasoningOverride(session), { effort: 'xhigh' });
  assert.deepStrictEqual(codex._internal.codexTurnReasoningOverride(session), {});
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-reasoning-clear',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning-clear', streamId: 'linco-stream-codex-reasoning-clear' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexReasoningEffortOverride: 'high',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning --clear', ws, session, { agents: { codex: { mode: 'app-server' } } }), true);
  assert.strictEqual(session.agentSessionId, 'codex-thread-1');
  assert.strictEqual(session.codexReasoningEffortOverride, null);
  assert.deepStrictEqual(codex._internal.codexTurnReasoningOverride(session), { effort: null });
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-reasoning-queued',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning-queued', streamId: 'linco-stream-codex-reasoning-queued' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning high', ws, session, { maxMessageQueue: 10, agents: { codex: { mode: 'app-server' } } }), true);
  assert.strictEqual(session.codexReasoningEffortOverride, undefined);
  assert.strictEqual(session.messageQueue[0].reasoningCommand, true);
  assert.strictEqual(session.messageQueue[0].reasoningOptions.effort, 'high');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-unsupported',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning', streamId: 'linco-stream-claude-reasoning' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning high', ws, session, { agents: { claude: {} } }), true);
  assert.strictEqual(session.claudeEffortOverride, 'high');
  assert.match(ws.sent[0].text, /Claude effort set: \(default\) -> high/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const child = fakeChild();
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning', streamId: 'linco-stream-claude-reasoning' },
    agentType: 'claude',
    agentSessionId: 'claude-native-session',
    claudeProcess: child,
    messageQueue: [],
    agentSessionHistory: [],
    streamState: createTextStreamBuffer(),
  };
  const config = { maxMessageQueue: 10, agents: { claude: { effort: 'medium' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/reasoning extra-high', ws, session, config), true);
  assert.strictEqual(session.agentSessionId, 'claude-native-session');
  assert.strictEqual(session.claudeEffortOverride, 'xhigh');
  assert.strictEqual(session.claudeProcess, null);
  assert.strictEqual(child.stdin.written.length, 0);
  assert.match(ws.sent[0].text, /Claude effort set: medium -> xhigh/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const child = fakeChild();
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-clear',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning-clear', streamId: 'linco-stream-claude-reasoning-clear' },
    agentType: 'claude',
    agentSessionId: 'claude-native-session',
    claudeEffortOverride: 'high',
    claudeProcess: child,
    messageQueue: [],
    agentSessionHistory: [],
    streamState: createTextStreamBuffer(),
  };

  assert.strictEqual(handleSlashCommand('/reasoning --clear', ws, session, { agents: { claude: {} } }), true);
  assert.strictEqual(session.agentSessionId, 'claude-native-session');
  assert.strictEqual(session.claudeEffortOverride, null);
  assert.strictEqual(session.claudeProcess, null);
  assert.match(ws.sent[0].text, /Claude effort override cleared/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-queued',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning-queued', streamId: 'linco-stream-claude-reasoning-queued' },
    agentType: 'claude',
    agentSessionId: 'claude-native-session',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning max', ws, session, { maxMessageQueue: 10, agents: { claude: {} }, logger: { info() {}, warn() {}, error() {} } }), true);
  assert.strictEqual(session.claudeEffortOverride, undefined);
  assert.strictEqual(session.messageQueue[0].reasoningCommand, true);
  assert.strictEqual(session.messageQueue[0].reasoningOptions.effort, 'max');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-model-queued',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-model-queued', streamId: 'linco-stream-codex-model-queued' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model gpt-5-codex', ws, session, { maxMessageQueue: 10, agents: { codex: { mode: 'app-server' } } }), true);
  assert.strictEqual(session.codexModelOverride, undefined);
  assert.strictEqual(session.messageQueue[0].modelCommand, true);
  assert.strictEqual(session.messageQueue[0].modelOptions.model, 'gpt-5-codex');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-hermes-model',
    workspace: process.cwd(),
    linco: { messageId: 'm-hermes-model', streamId: 'linco-stream-hermes-model' },
    agentType: 'hermes',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model qwen', ws, session, { maxMessageQueue: 10, agents: { hermes: {} } }), true);
  assert.strictEqual(session.messageQueue[0].input, '/model qwen');
  assert.strictEqual(session.messageQueue[0].modelCommand, true);
  assert.strictEqual(session.messageQueue[0].modelOptions.model, 'qwen');
}

{
  const ws = createCaptureWs();
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-home-'));
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: qwen3.6-plus\n');
  const session = {
    id: 'session-hermes-model-set',
    workspace: process.cwd(),
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-model-')),
    linco: { messageId: 'm-hermes-model-set', streamId: 'linco-stream-hermes-model-set' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model qwen3.6-flash', ws, session, { maxMessageQueue: 10, agents: { hermes: { hermesHome } } }), true);
  assert.strictEqual(session.hermesModelOverride, 'qwen3.6-flash');
  assert.strictEqual(session.hermesModelPreviousDefault, 'qwen3.6-plus');
  assert.match(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8'), /default: qwen3\.6-flash/);
  assert.strictEqual(hermes._internal.currentHermesModel(session, { hermesHome }), 'qwen3.6-flash');
  assert.match(ws.sent[0].text, /Hermes model set for the next run: qwen3\.6-plus -> qwen3\.6-flash/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-home-clear-'));
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: qwen3.6-flash\n');
  const session = {
    id: 'session-hermes-model-clear',
    workspace: process.cwd(),
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-model-clear-')),
    linco: { messageId: 'm-hermes-model-clear', streamId: 'linco-stream-hermes-model-clear' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
    hermesModelOverride: 'qwen3.6-flash',
    hermesModelPreviousDefault: 'qwen3.6-plus',
  };

  assert.strictEqual(handleSlashCommand('/model --clear', ws, session, { maxMessageQueue: 10, agents: { hermes: { hermesHome } } }), true);
  assert.strictEqual(session.hermesModelOverride, null);
  assert.strictEqual(session.hermesModelPreviousDefault, null);
  assert.match(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8'), /default: qwen3\.6-plus/);
  assert.match(ws.sent[0].text, /Next turn will use qwen3\.6-plus/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-home-no-default-'));
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'platforms:\n  api_server:\n    enabled: true\n');
  const session = {
    id: 'session-hermes-model-no-default',
    workspace: process.cwd(),
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-model-no-default-')),
    linco: { messageId: 'm-hermes-model-no-default', streamId: 'linco-stream-hermes-model-no-default' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model qwen3.6-flash', ws, session, { maxMessageQueue: 10, agents: { hermes: { hermesHome } } }), true);
  assert.match(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8'), /default: qwen3\.6-flash/);
  assert.strictEqual(handleSlashCommand('/model --clear', ws, session, { maxMessageQueue: 10, agents: { hermes: { hermesHome } } }), true);
  const restored = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');
  assert.doesNotMatch(restored, /qwen3\.6-flash/);
  assert.doesNotMatch(restored, /default:/);
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-openclaw-model',
    workspace: process.cwd(),
    linco: { messageId: 'm-openclaw-model', streamId: 'linco-stream-openclaw-model' },
    agentType: 'openclaw',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/model qwen', ws, session, { maxMessageQueue: 10, agents: { openclaw: {} } }), true);
  assert.strictEqual(session.messageQueue[0].input, '/model qwen');
  assert.strictEqual(session.messageQueue[0].modelCommand, true);
  assert.strictEqual(session.messageQueue[0].modelOptions.model, 'qwen');
}

assert.deepStrictEqual(openclaw._internal.resolveOpenClawModelInput('2', ['provider/a', 'provider/b']), 'provider/b');
assert.deepStrictEqual(hermes._internal.resolveHermesModelInput('2', ['provider/a', 'provider/b']), 'provider/b');
assert.deepStrictEqual(openclaw._internal.openClawFallbackModels({
  openclawModelOverride: 'provider/current',
}, { agents: { openclaw: { model: 'provider/default' } } }), ['provider/current', 'provider/default']);
{
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-hermes-candidates-'));
  assert.deepStrictEqual(hermes._internal.configuredHermesModelCandidates({
    model: 'provider/default',
    hermesHome,
  }), ['provider/default']);
}

assert.deepStrictEqual(slashInternals.parseModelArgs('--select "gpt-5-codex"'), {
  mode: 'set',
  model: 'gpt-5-codex',
});
assert.deepStrictEqual(slashInternals.parseModelArgs(''), {
  mode: 'list',
});
assert.deepStrictEqual(slashInternals.parseModelArgs('status'), {
  mode: 'show',
});
assert.deepStrictEqual(slashInternals.parseModelArgs('switch 1'), {
  mode: 'set',
  model: '1',
});
assert.deepStrictEqual(slashInternals.parseModelArgs('default'), {
  mode: 'set',
  model: 'default',
});
assert.deepStrictEqual(slashInternals.parseReasoningArgs(''), {
  mode: 'list',
});
assert.deepStrictEqual(slashInternals.parseReasoningArgs('status'), {
  mode: 'show',
});
assert.deepStrictEqual(slashInternals.parseReasoningArgs('switch 4'), {
  mode: 'set',
  effort: '4',
});
assert.deepStrictEqual(slashInternals.parseReasoningArgs('extra high'), {
  mode: 'set',
  effort: 'xhigh',
});
assert.strictEqual(slashInternals.currentModel({ agentType: 'codex', codexModelOverride: 'gpt-5-codex' }, { agents: { codex: { model: 'gpt-5' } } }), 'gpt-5-codex');
assert.strictEqual(slashInternals.currentModel({ agentType: 'claude', claudeModelOverride: 'sonnet' }, { agents: { claude: { model: 'opus' } } }), 'sonnet');
assert.strictEqual(slashInternals.currentModel({ agentType: 'hermes', hermesModelOverride: 'qwen3.6-flash' }, { agents: { hermes: { model: 'qwen3.6-plus' } } }), 'qwen3.6-flash');
assert.strictEqual(slashInternals.currentModel({ agentType: 'openclaw', openclawModelOverride: 'bailian/qwen3.6-flash' }, { agents: { openclaw: { model: 'bailian/qwen3.6-plus' } } }), 'bailian/qwen3.6-flash');
assert.deepStrictEqual(codex._internal.normalizeCodexModelList({ data: [{ id: 'gpt-5-codex' }, { model: 'gpt-5' }] }), ['gpt-5-codex', 'gpt-5']);
assert.strictEqual(claude._internal.currentClaudeModel({ claudeModelOverride: 'sonnet' }, { agents: { claude: { model: 'opus' } } }), 'sonnet');
assert.strictEqual(claude._internal.currentClaudeEffort({ claudeEffortOverride: 'high' }, { agents: { claude: { effort: 'medium' } } }), 'high');
assert.strictEqual(claude._internal.resolveClaudeModelInput('1'), 'sonnet');
assert.strictEqual(claude._internal.resolveClaudeModelInput('4'), 'haiku');
assert.strictEqual(claude._internal.resolveClaudeEffortInput('4'), 'xhigh');
assert.strictEqual(claude._internal.resolveClaudeEffortInput('extra high'), 'xhigh');
assert.strictEqual(codex._internal.codexModelInputNeedsLookup('1'), true);
assert.strictEqual(codex._internal.codexModelInputNeedsLookup('gpt-5.5'), false);
assert.strictEqual(codex._internal.resolveModelNameFromList('2', ['gpt-5.5', 'gpt-5.4']), 'gpt-5.4');
assert.deepStrictEqual(codex._internal.withCodexFallbackModels(['gpt-5.5', 'custom-model']).slice(0, 3), ['gpt-5.5', 'custom-model', 'gpt-5.4']);
assert.deepStrictEqual(codex._internal.normalizeCodexModelEntries({
  data: [{
    model: 'gpt-5.5',
    displayName: 'GPT-5.5 Codex',
    description: 'Primary coding model',
    defaultReasoningEffort: 'ultra',
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', label: 'Low effort', description: 'Fast responses' },
      { reasoningEffort: 'max', description: 'Maximum reasoning' },
      { reasoningEffort: 'ULTRA', description: 'Deepest reasoning' },
      { reasoningEffort: 'ultra', label: 'Duplicate ultra', description: 'Ignored duplicate' },
    ],
  }],
}), [{
  name: 'gpt-5.5',
  label: 'GPT-5.5 Codex',
  description: 'Primary coding model',
  supportedReasoningEfforts: [
    { id: 'low', label: 'Low effort', description: 'Fast responses' },
    { id: 'max', label: 'Max', description: 'Maximum reasoning' },
    { id: 'ultra', label: 'Ultra', description: 'Deepest reasoning' },
  ],
  defaultReasoningEffort: 'ultra',
  isDefault: true,
}]);
assert.deepStrictEqual(normalizeCodexReasoningOptions([
  { id: 'MAX' },
  { effort: 'ultra' },
]), [
  { id: 'max', label: 'Max', description: '' },
  { id: 'ultra', label: 'Ultra', description: '' },
]);
assert.strictEqual(formatCodexReasoningEffortLabel('max'), 'Max');
assert.strictEqual(formatCodexReasoningEffortLabel('ultra'), 'Ultra');

const longCapabilityId = 'x'.repeat(121);
const boundedModelLabel = 'L'.repeat(201);
const boundedDescription = 'D'.repeat(1001);
assert.deepStrictEqual(codex._internal.normalizeCodexModelEntries({
  data: [
    {
      model: 'bounded-model',
      displayName: boundedModelLabel,
      description: boundedDescription,
      defaultReasoningEffort: 'ultra',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', label: boundedModelLabel, description: boundedDescription },
        { reasoningEffort: 'medium' },
        { reasoningEffort: '' },
        { reasoningEffort: 'bad\u0000id' },
        { reasoningEffort: longCapabilityId },
      ],
    },
    { model: '', displayName: 'Empty ID' },
    { model: 'bad\u001fid', displayName: 'Control ID' },
    { model: longCapabilityId, displayName: 'Long ID' },
    { model: 'fallback-label' },
  ],
}), [
  {
    name: 'bounded-model',
    label: 'L'.repeat(200),
    description: 'D'.repeat(1000),
    supportedReasoningEfforts: [
      { id: 'low', label: 'L'.repeat(200), description: 'D'.repeat(1000) },
      { id: 'medium', label: 'Medium', description: '' },
    ],
    defaultReasoningEffort: 'low',
    isDefault: false,
  },
  {
    name: 'fallback-label',
    label: 'fallback-label',
    description: '',
    supportedReasoningEfforts: [],
    defaultReasoningEffort: '',
    isDefault: false,
  },
]);
assert.deepStrictEqual(codex._internal.uniqueReasoningEfforts(['low', 'low', 'extra-high', 'bad']), ['low', 'xhigh']);
assert.strictEqual(codex._internal.codexReasoningInputNeedsLookup('2'), true);
assert.strictEqual(codex._internal.codexReasoningInputNeedsLookup('high'), false);
assert.match(codex._internal.formatCodexReasoningList(['low', 'medium', 'high', 'xhigh'], '', { defaultEffort: 'medium', model: 'gpt-5.5' }), /2\. Medium \(default\)/);
assert.strictEqual(typeof hermes.model, 'function');
assert.strictEqual(typeof openclaw.model, 'function');

codexSettingsTest.then(() => {
  console.log('model selection ok');
});
