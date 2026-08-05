const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { mapLocalEventToLinco } = require('../../src/channel/linco/protocol');

function loadCodexHandler() {
  const filename = path.resolve(__dirname, '../../src/agent/codex/index.js');
  const source = fs.readFileSync(filename, 'utf8');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(
    `${source}\nmodule.exports._test = { handleAppServerMessage };\n`,
    filename,
  );
  return mod.exports._test.handleAppServerMessage;
}

function createRemoteSession(workspace = process.cwd()) {
  const sent = [];
  const ws = {
    linco: {
      messageId: 'message-final-phase-correction',
      streamId: 'stream-final-phase-correction',
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
  const session = {
    id: 'session-final-phase-correction',
    workspace,
    isTurnActive: true,
    currentInputForNoOutput: '这是什么东西',
    messageQueue: [],
    sawPartialAssistantText: false,
    codexAssistantEnded: false,
    codexUseProgressiveAnswer: true,
    codexAgentMessageEmissionPhases: new Map(),
    agentSessionId: 'thread-final-phase-correction',
    linco: ws.linco,
    _lastWs: ws,
    _lastConfig: {},
    _log: { info() {} },
  };
  return { session, sent };
}

const handleAppServerMessage = loadCodexHandler();

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-final-phase-correction-'));
  const imagePath = path.join(workspace, 'scaled_beidouxing.png');
  fs.writeFileSync(imagePath, 'fake image');

  try {
    const { session, sent } = createRemoteSession(workspace);
    const progressText = '我先查看图片内容和可见细节，再判断它是什么。';
    const finalText =
      `这是一张“北斗星”品牌或功能入口图，右侧图标表现的是“文档检索/信息查询”。` +
      `仅凭图片无法确定它具体属于哪个软件或系统。\n\n` +
      `[scaled_beidouxing.png](${imagePath})`;

    handleAppServerMessage({
      method: 'item/agentMessage/delta',
      params: {
        item: {
          type: 'agentMessage',
          id: 'agent-image-progress',
          phase: 'commentary',
        },
        delta: progressText,
      },
    }, session);
    handleAppServerMessage({
      method: 'item/agentMessage/delta',
      params: {
        itemId: 'agent-image-final',
        delta: finalText,
      },
    }, session);
    handleAppServerMessage({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'agent-image-final',
          text: finalText,
          phase: 'final_answer',
        },
      },
    }, session);
    handleAppServerMessage({ method: 'turn/completed', params: {} }, session);

    const linco = { streamId: 'linco-stream-image-final-correction' };
    const mapped = sent
      .map(event => mapLocalEventToLinco(event, session, {}, linco))
      .filter(Boolean);
    const chunks = mapped.filter(event => event.type === 'stream_chunk');
    const finalChunk = chunks.find(
      event => event.done === false && event.phase === 'final_answer',
    );
    const done = chunks.find(event => event.done === true);

    assert(finalChunk);
    assert.strictEqual(finalChunk.replacePrevious, true);
    assert.strictEqual(finalChunk.fullText, finalText);
    assert(done);
    assert.strictEqual(
      done.fullText,
      '这是一张“北斗星”品牌或功能入口图，右侧图标表现的是“文档检索/信息查询”。仅凭图片无法确定它具体属于哪个软件或系统。',
    );
    assert.strictEqual(done.text, finalText);
    assert(!done.fullText.includes(progressText));
    assert.strictEqual(done.references.length, 0);
    assert.strictEqual(done.mediaName, 'scaled_beidouxing.png');
    assert.strictEqual(done.mediaType, 'image/png');
    assert.strictEqual(
      done.mediaBase64,
      Buffer.from('fake image').toString('base64'),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const { session, sent } = createRemoteSession();
  const finalText = 'This explicit final answer must only be emitted once.';

  handleAppServerMessage({
    method: 'item/agentMessage/delta',
    params: {
      item: {
        type: 'agentMessage',
        id: 'agent-explicit-final-on-delta',
        phase: 'final_answer',
      },
      phase: 'final_answer',
      delta: finalText,
    },
  }, session);
  handleAppServerMessage({
    method: 'item/completed',
    params: {
      item: {
        type: 'agentMessage',
        id: 'agent-explicit-final-on-delta',
        phase: 'final_answer',
        text: finalText,
      },
    },
  }, session);

  assert.strictEqual(
    sent.filter(
      message => message.type === 'assistant_chunk' && message.text === finalText,
    ).length,
    1,
  );
}

{
  const { session, sent } = createRemoteSession();
  const prefix =
    '明白，我刚才把本机排查记录和用户现场混在了一起。' +
    '不能据此断定该用户是插件休眠后尚未 OPEN。\n\n' +
    '对于该用户，只能确认页面在线不代表本次同步链路完整可用。';
  const suffix = '\n\n不能简单归因于“插件还没 open”。';
  const finalText = `${prefix}${suffix}`;
  const itemId = 'agent-final-phase-arrives-on-last-delta';

  handleAppServerMessage({
    method: 'item/started',
    params: {
      item: {
        type: 'agentMessage',
        id: itemId,
        phase: 'final_answer',
        text: '',
      },
    },
  }, session);
  handleAppServerMessage({
    method: 'item/agentMessage/delta',
    params: {
      itemId,
      delta: prefix,
    },
  }, session);
  handleAppServerMessage({
    method: 'item/agentMessage/delta',
    params: {
      itemId,
      phase: 'final_answer',
      delta: suffix,
    },
  }, session);
  handleAppServerMessage({
    method: 'item/completed',
    params: {
      item: {
        type: 'agentMessage',
        id: itemId,
        phase: 'final_answer',
        text: finalText,
      },
    },
  }, session);
  handleAppServerMessage({ method: 'turn/completed', params: {} }, session);

  const streamedText = sent
    .filter(event => event.type === 'assistant_chunk')
    .map(event => event.text)
    .join('');
  const linco = { streamId: 'linco-stream-late-final-phase' };
  const chunks = sent
    .map(event => mapLocalEventToLinco(event, session, {}, linco))
    .filter(event => event?.type === 'stream_chunk');
  const finalChunk = chunks.filter(event => event.done === false).at(-1);
  const done = chunks.find(event => event.done === true);

  assert.strictEqual(streamedText, finalText);
  assert(finalChunk);
  assert.strictEqual(finalChunk.fullText, finalText);
  assert(done);
  assert.strictEqual(done.fullText, finalText);
}

console.log('codex final phase correction ok');
