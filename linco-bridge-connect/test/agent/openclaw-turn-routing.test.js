const assert = require('node:assert/strict');
const test = require('node:test');

const openclaw = require('../../src/agent/openclaw');

test('OpenClaw 排队控制命令不会提前改写当前轮路由', () => {
  const config = createConfig();

  for (const [name, enqueue] of [
    ['compact', (ws, session) => openclaw._internal.compactOpenClawContext(ws, session, config)],
    ['model', (ws, session) => openclaw.model(ws, session, config, { command: 'show' })],
  ]) {
    const activeWs = createWs(`active-${name}`);
    const queuedWs = createWs(`queued-${name}`);
    const session = createActiveSession(activeWs, config);

    enqueue(queuedWs, session);

    assert.equal(session._lastWs, activeWs, `${name} must preserve the active turn route`);
    assert.equal(session.messageQueue.length, 1);
  }
});

test('OpenClaw Gateway 事件使用当前轮不可变输出上下文', () => {
  const config = createConfig();
  const activeWs = createWs('active-turn');
  const newerWs = createWs('newer-request');
  const session = createActiveSession(activeWs, config);

  openclaw._internal.bindOpenClawOutputContext(session, activeWs, config);
  session._lastWs = newerWs;
  openclaw._internal.routeOpenClawGatewayEvent(
    'chat',
    { state: 'delta', runId: session.openclawRunId, deltaText: '当前轮回答' },
    null,
    session,
    config,
  );

  assert(activeWs.events.some(event => event.type === 'assistant_start'));
  assert.equal(newerWs.events.length, 0);
});

function createConfig() {
  return {
    maxMessageQueue: 10,
    agents: { openclaw: {} },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function createActiveSession(ws, config) {
  return {
    id: 'openclaw-routing-session',
    agentSessionId: 'openclaw-routing-agent-session',
    openclawRunId: 'openclaw-routing-run',
    openclawLastText: '',
    isTurnActive: true,
    messageQueue: [],
    _lastWs: ws,
    _lastConfig: config,
  };
}

function createWs(requestId) {
  return {
    requestId,
    events: [],
    linco: {
      messageId: requestId,
      streamId: `ddchat-stream-${requestId}`,
    },
    send(raw) {
      this.events.push(JSON.parse(raw));
    },
  };
}
