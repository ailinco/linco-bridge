const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const spawnedChildren = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = (_command, args) => {
  const child = createFakeChild();
  child.spawnArgs = [...args];
  spawnedChildren.push(child);
  return child;
};
const claude = require('../../src/agent/claude');
childProcess.spawn = originalSpawn;

test('Claude 预热后首轮输出使用当前聊天路由', async (t) => {
  const fixture = createFixture(t);
  const warmupWs = createWs('bridge-workspace-history');
  const chatWs = createWs('req-chat-after-warmup');

  await claude.warmup(warmupWs, fixture.session, fixture.config);
  claude.execute('当前是什么项目', chatWs, fixture.session, fixture.config);
  emitClaudeTurn(spawnedChildren.at(-1), '当前项目是 aichat。');

  assert.deepEqual(streamedTexts(chatWs), ['当前项目是 aichat。']);
  assert.equal(streamedTexts(warmupWs).length, 0);
  assert.equal(lastEvent(chatWs, 'turn_end')?.type, 'turn_end');
});

test('Claude 复用进程时第二轮输出使用第二轮路由', (t) => {
  const fixture = createFixture(t);
  const firstWs = createWs('req-first-turn');
  const secondWs = createWs('req-second-turn');

  claude.execute('第一轮', firstWs, fixture.session, fixture.config);
  const child = spawnedChildren.at(-1);
  emitClaudeTurn(child, '第一轮回答');

  claude.execute('第二轮', secondWs, fixture.session, fixture.config);
  emitClaudeTurn(child, '第二轮回答');

  assert.deepEqual(streamedTexts(firstWs), ['第一轮回答']);
  assert.deepEqual(streamedTexts(secondWs), ['第二轮回答']);
  assert.equal(lastEvent(secondWs, 'turn_end')?.type, 'turn_end');
});

test('Claude 排队消息不会提前接管当前轮次输出', (t) => {
  const fixture = createFixture(t);
  const firstWs = createWs('req-active-turn');
  const queuedWs = createWs('req-queued-turn');

  claude.execute('当前轮', firstWs, fixture.session, fixture.config);
  const child = spawnedChildren.at(-1);
  claude.execute('排队轮', queuedWs, fixture.session, fixture.config);

  emitClaudeTurn(child, '当前轮回答');
  assert.deepEqual(streamedTexts(firstWs), ['当前轮回答']);
  assert.deepEqual(streamedTexts(queuedWs), []);

  emitClaudeTurn(child, '排队轮回答');
  assert.deepEqual(streamedTexts(firstWs), ['当前轮回答']);
  assert.deepEqual(streamedTexts(queuedWs), ['排队轮回答']);
  assert.equal(lastEvent(queuedWs, 'turn_end')?.type, 'turn_end');
});

test('Claude 旧预热进程不能覆盖刚绑定的项目会话 ID', async (t) => {
  const fixture = createFixture(t);
  const warmupWs = createWs('bridge-workspace-stale-resume');
  fixture.session.agentSessionId = 'temporary-session-id';

  await claude.warmup(warmupWs, fixture.session, fixture.config);
  const child = spawnedChildren.at(-1);
  fixture.session.agentSessionId = 'project-session-id';

  emitClaudeFrames(child, [{
    type: 'system',
    subtype: 'init',
    session_id: 'temporary-session-id',
  }]);

  assert.equal(fixture.session.agentSessionId, 'project-session-id');
});

test('Claude 错误结果返回错误而不是无输出完成提示', (t) => {
  const fixture = createFixture(t);
  const ws = createWs('req-invalid-resume');

  claude.execute('当前是什么项目', ws, fixture.session, fixture.config);
  const child = spawnedChildren.at(-1);
  emitClaudeFrames(child, [{
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'No conversation found with session ID: invalid-session-id',
    usage: {},
  }]);

  assert.equal(ws.events.some((event) => event.type === 'system' && /无输出/.test(event.text || '')), false);
  assert.match(lastEvent(ws, 'error')?.text || '', /No conversation found/);
  assert.equal(lastEvent(ws, 'turn_end')?.reason, 'error');
  assert.equal(fixture.session.messageCount, 0);
});

function createFixture(t) {
  const lincoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-claude-routing-'));
  t.after(() => fs.rmSync(lincoHome, { recursive: true, force: true }));
  const config = {
    lincoHome,
    homeDir: lincoHome,
    attachmentsDirName: 'attachments',
    maxMessageQueue: 10,
    agents: {
      claude: {
        bin: 'claude',
        fixResumeEntrypoint: false,
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
  const { createSession } = require('../../src/core/session');
  const session = createSession(config, {
    externalSessionId: `session-${Date.now()}-${Math.random()}`,
    externalSessionScope: 'test',
    agentType: 'claude',
  });
  return { config, session };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = {
    destroyed: false,
    writes: [],
    write(value) {
      this.writes.push(value);
      return true;
    },
    end() {
      this.destroyed = true;
    },
  };
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
  };
  return child;
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

function emitClaudeTurn(child, text) {
  const frames = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    },
    { type: 'result', subtype: 'success', usage: {} },
  ];
  emitClaudeFrames(child, frames);
}

function emitClaudeFrames(child, frames) {
  child.stdout.emit(
    'data',
    Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`),
  );
}

function streamedTexts(ws) {
  return ws.events
    .filter((event) => event.type === 'assistant_chunk')
    .map((event) => event.text);
}

function lastEvent(ws, type) {
  return ws.events.filter((event) => event.type === type).at(-1);
}
