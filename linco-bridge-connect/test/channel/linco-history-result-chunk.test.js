const assert = require('node:assert');
const test = require('node:test');

const {
  createLincoAdapter,
  mapLocalEventToLinco,
} = require('../../src/channel/linco/protocol');

test('large history slash results are split into ordered base64 chunks', () => {
  const historyData = {
    version: 3,
    rounds: [{
      user: {
        text: '同步带大附件的 PC 历史',
        files: [{
          name: 'large.png',
          mimeType: 'image/png',
          base64: Buffer.alloc(400 * 1024, 7).toString('base64'),
        }],
      },
      assistant: { text: '完成' },
    }],
  };
  const payload = mapLocalEventToLinco({
    type: 'slash_command_result',
    command: 'history',
    version: 1,
    data: historyData,
  }, {
    id: 'session-large-history-result',
    workspace: process.cwd(),
  }, {}, {
    messageId: 'm-large-history-result',
    streamId: 'linco-stream-large-history-result',
  });

  assert(Array.isArray(payload));
  assert(payload.length > 1);
  assert(payload.every(item => item.type === 'slash_command_result_chunk'));
  assert(payload.every(item => item.command === 'history'));
  assert(payload.every(item => item.requestId === 'm-large-history-result'));
  assert(payload.every(item => item.streamId === 'linco-stream-large-history-result'));
  assert(payload.every(item => item.chunkCount === payload.length));
  assert.deepStrictEqual(
    payload.map(item => item.chunkIndex),
    payload.map((_, index) => index),
  );
  const restored = JSON.parse(Buffer.from(
    payload.map(item => item.chunkData).join(''),
    'base64',
  ).toString('utf8'));
  assert.deepStrictEqual(restored, historyData);
});

test('small history slash results keep the legacy single-frame shape', () => {
  const payload = mapLocalEventToLinco({
    type: 'slash_command_result',
    command: 'history',
    version: 1,
    data: { version: 3, rounds: [] },
  }, {
    id: 'session-small-history-result',
    workspace: process.cwd(),
  }, {}, {
    messageId: 'm-small-history-result',
    streamId: 'linco-stream-small-history-result',
  });

  assert.strictEqual(Array.isArray(payload), false);
  assert.strictEqual(payload.type, 'slash_command_result');
  assert.deepStrictEqual(payload.data, { version: 3, rounds: [] });
});

test('linco adapter sends every large history chunk as its own envelope', () => {
  const sent = [];
  const session = {
    id: 'session-large-history-send',
    workspace: process.cwd(),
    linco: {
      messageId: 'm-large-history-send',
      streamId: 'linco-stream-large-history-send',
    },
  };
  const adapter = createLincoAdapter({
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  }, session, {
    serverUserId: 'user-large-history-send',
  });

  const historyData = {
    version: 3,
    rounds: [{
      user: {
        text: '同步带大附件的 PC 历史',
        files: [{
          name: 'large.png',
          mimeType: 'image/png',
          base64: Buffer.alloc(400 * 1024, 9).toString('base64'),
        }],
      },
      assistant: { text: '完成' },
    }],
  };
  adapter.send(JSON.stringify({
    type: 'slash_command_result',
    command: 'history',
    version: 1,
    data: historyData,
  }));

  assert(sent.length > 1);
  assert(sent.every(item => item.type === 'slash_command_result_chunk'));
  assert(sent.every(item => item.data === undefined));
  assert.deepStrictEqual(
    JSON.parse(Buffer.from(
      sent.map(item => item.chunkData).join(''),
      'base64',
    ).toString('utf8')),
    historyData,
  );
});
