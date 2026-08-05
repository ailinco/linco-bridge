const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleGet } = require('../../src/command/fileGet');
const { handleHistory } = require('../../src/command/history/handlers');
const { authorizedHistoryFiles } = require('../../src/core/historyFileAccess');

function createCaptureWs() {
  const sent = [];
  return {
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

function outboundFile(ws) {
  return ws.sent.find(item => item.type === 'outbound_message' && item.mediaBase64);
}

function createFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-get-home-'));
  const clipboardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-get-clipboard-'));
  const workspace = path.join(homeDir, 'projects', 'current-project');
  const otherWorkspace = path.join(homeDir, 'projects', 'other-project');
  const runtimeDir = path.join(homeDir, '.linco', 'codex', 'sessions', 'bridge-session');
  const attachmentsDir = path.join(runtimeDir, 'attachments');
  const imagePath = path.join(clipboardDir, 'codex-clipboard-history.png');
  const siblingPath = path.join(clipboardDir, 'not-in-history.png');
  for (const directory of [workspace, otherWorkspace, attachmentsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(imagePath, Buffer.from('history-image'));
  fs.writeFileSync(siblingPath, Buffer.from('sibling-image'));

  const agentSessionId = 'codex-history-file-session';
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '08', '05');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const userMessage = [
    '# Files mentioned by the user:',
    '',
    `## ${path.basename(imagePath)}: ${imagePath}`,
    '',
    '## My request for Codex:',
    'what is in this image?',
  ].join('\n');
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-${agentSessionId}.jsonl`),
    [
      { type: 'session_meta', payload: { id: agentSessionId, cwd: workspace } },
      { type: 'event_msg', timestamp: '2026-08-05T01:00:00.000Z', payload: { type: 'user_message', message: userMessage } },
      { type: 'event_msg', timestamp: '2026-08-05T01:00:01.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'image answer' } },
    ].map(JSON.stringify).join('\n'),
  );

  return {
    homeDir,
    clipboardDir,
    workspace,
    otherWorkspace,
    imagePath,
    siblingPath,
    session: {
      id: 'bridge-session',
      agentType: 'codex',
      agentSessionId,
      workspace,
      runtimeDir,
      attachmentsDir,
      agentSessionHistory: [],
      messageQueue: [],
    },
    config: {
      homeDir,
      maxOutgoingAttachmentBytes: 1024 * 1024,
      allowHiddenGetFiles: false,
      allowUnsafeAttachments: false,
      unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
    },
  };
}

test('history authorizes only its current project and Agent Session temporary image', t => {
  const fixture = createFixture();
  t.after(() => {
    fs.rmSync(fixture.homeDir, { recursive: true, force: true });
    fs.rmSync(fixture.clipboardDir, { recursive: true, force: true });
  });

  const beforeHistoryWs = createCaptureWs();
  handleGet(fixture.imagePath, beforeHistoryWs, fixture.session, fixture.config);
  assert.equal(outboundFile(beforeHistoryWs), undefined);

  const historyWs = createCaptureWs();
  handleHistory('1', historyWs, fixture.session, { homeDir: fixture.homeDir });
  assert.equal(historyWs.sent[0]?.type, 'slash_command_result');
  assert.equal(historyWs.sent[0]?.data.rounds[0].user.files[0].localPath, fixture.imagePath);
  assert.deepEqual(authorizedHistoryFiles(fixture.session), [fixture.imagePath]);

  const imageWs = createCaptureWs();
  handleGet(fixture.imagePath, imageWs, fixture.session, fixture.config);
  assert.equal(
    outboundFile(imageWs)?.mediaBase64,
    Buffer.from('history-image').toString('base64'),
  );

  const siblingWs = createCaptureWs();
  handleGet(fixture.siblingPath, siblingWs, fixture.session, fixture.config);
  assert.equal(outboundFile(siblingWs), undefined);

  fixture.session.workspace = fixture.otherWorkspace;
  const otherProjectWs = createCaptureWs();
  handleGet(fixture.imagePath, otherProjectWs, fixture.session, fixture.config);
  assert.equal(outboundFile(otherProjectWs), undefined);

  fixture.session.workspace = fixture.workspace;
  handleHistory('1', createCaptureWs(), fixture.session, { homeDir: fixture.homeDir });
  fixture.session.agentSessionId = 'another-agent-session';
  const otherSessionWs = createCaptureWs();
  handleGet(fixture.imagePath, otherSessionWs, fixture.session, fixture.config);
  assert.equal(outboundFile(otherSessionWs), undefined);
});
