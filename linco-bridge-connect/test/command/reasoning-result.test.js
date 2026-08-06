const assert = require('assert');

const { handleSlashCommand } = require('../../src/command');
const codex = require('../../src/agent/codex');

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
    stdin: {
      destroyed: false,
      written: [],
      write(chunk) {
        this.written.push(chunk);
      },
    },
  };
}

const codexReasoningResultTest = (async () => {
  const ws = createCaptureWs();
  const child = fakeChild();
  const session = {
    id: 'session-codex-reasoning-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning', streamId: 'linco-stream-codex-reasoning' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexAppServer: child,
    codexPendingRequests: new Map(),
    codexRpcId: 0,
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = { agents: { codex: { mode: 'app-server', model: 'gpt-5.5' } }, logger: { info() {}, warn() {}, error() {} } };

  assert.strictEqual(handleSlashCommand('/reasoning extra-high', ws, session, config), true);
  await new Promise(resolve => setImmediate(resolve));
  const rpc = JSON.parse(child.stdin.written[0]);
  assert.strictEqual(rpc.method, 'model/list');
  session.codexPendingRequests.get(rpc.id).resolve({
    models: [{
      id: 'gpt-5.5',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    }],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(session.codexReasoningEffortOverride, 'xhigh');
  assert.deepStrictEqual(codex._internal.codexTurnReasoningOverride(session), { effort: 'xhigh' });

  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Codex reasoning slash_command_result');
  assert.strictEqual(result.command, 'reasoning');
  assert.strictEqual(result.data.agentType, 'codex');
  assert.strictEqual(result.data.current, 'xhigh');
  assert.strictEqual(result.data.previous, '');
  assert.strictEqual(result.data.status, 'set');
  assert.strictEqual(result.data.defaultEffort, 'high');
  assert.deepStrictEqual(result.data.options.map(option => option.id), ['low', 'medium', 'high', 'xhigh']);
  assert.strictEqual(result.data.options[2].isDefault, true);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
})();

{
  const params = codex._internal.buildCodexThreadStartParams({
    workspace: 'D:\\code\\sample',
  }, {});

  assert.strictEqual(params.effort, 'high');
}

{
  const params = codex._internal.buildCodexThreadStartParams({
    workspace: 'D:\\code\\sample',
  }, {
    effort: 'medium',
  });

  assert.strictEqual(params.effort, 'medium');
}

{
  const session = {};
  codex._internal.recordCodexThreadReasoning(session, { reasoningEffort: 'medium' });
  assert.strictEqual(codex._internal.currentCodexReasoningEffort(session), 'medium');
}

{
  const session = {};
  assert.deepStrictEqual(codex._internal.codexTurnReasoningOverride(session, {}, { includeDefault: true }), { effort: 'high' });
  assert.strictEqual(session.codexActiveReasoningEffort, 'high');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-reasoning-active-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning-active', streamId: 'linco-stream-codex-reasoning-active' },
    agentType: 'codex',
    codexActiveReasoningEffort: 'high',
    messageQueue: [],
    agentSessionHistory: [],
  };

  codex._internal.sendCodexReasoningResult(ws, session, { agents: { codex: {} } }, { status: 'status' });
  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Codex active reasoning slash_command_result');
  assert.strictEqual(result.data.current, 'high');
  assert.strictEqual(result.data.defaultEffort, 'high');
  assert.strictEqual(result.data.options[2].isCurrent, true);
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-reasoning-clear-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-codex-reasoning-clear', streamId: 'linco-stream-codex-reasoning-clear' },
    agentType: 'codex',
    agentSessionId: 'codex-thread-1',
    codexReasoningEffortOverride: 'high',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning --clear', ws, session, { agents: { codex: { mode: 'app-server' } } }), true);
  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Codex clear slash_command_result');
  assert.strictEqual(result.command, 'reasoning');
  assert.strictEqual(result.data.current, '');
  assert.strictEqual(result.data.previous, 'high');
  assert.strictEqual(result.data.status, 'cleared');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning', streamId: 'linco-stream-claude-reasoning' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning high', ws, session, { agents: { claude: {} } }), true);
  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Claude reasoning slash_command_result');
  assert.strictEqual(result.command, 'reasoning');
  assert.strictEqual(result.data.agentType, 'claude');
  assert.strictEqual(result.data.current, 'high');
  assert.strictEqual(result.data.previous, '');
  assert.strictEqual(result.data.status, 'set');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-list-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning-list', streamId: 'linco-stream-claude-reasoning-list' },
    agentType: 'claude',
    claudeEffortOverride: 'medium',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning', ws, session, { agents: { claude: { effort: 'low' } } }), true);
  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Claude reasoning list slash_command_result');
  assert.strictEqual(result.command, 'reasoning');
  assert.strictEqual(result.data.agentType, 'claude');
  assert.strictEqual(result.data.current, 'medium');
  assert.strictEqual(result.data.defaultEffort, 'low');
  assert.deepStrictEqual(result.data.options.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(result.data.options[1].isCurrent, true);
  assert.strictEqual(result.data.options[0].isDefault, true);
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-reasoning-list-default-result',
    workspace: process.cwd(),
    linco: { messageId: 'm-claude-reasoning-list-default', streamId: 'linco-stream-claude-reasoning-list-default' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/reasoning', ws, session, { agents: { claude: {} } }), true);
  const result = ws.sent.find(event => event.type === 'slash_command_result');
  assert(result, 'expected Claude reasoning list slash_command_result');
  assert.strictEqual(result.command, 'reasoning');
  assert.strictEqual(result.data.agentType, 'claude');
  assert.strictEqual(result.data.current, '');
  assert.strictEqual(result.data.defaultEffort, 'high');
  assert.deepStrictEqual(result.data.options.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(result.data.options[2].isDefault, true);
}

codexReasoningResultTest.then(() => {
  console.log('reasoning result ok');
});
