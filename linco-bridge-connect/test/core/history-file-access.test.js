const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateGetFile } = require('../../src/core/fileReferences');
const {
  clearPersistedAgentSession,
  persistAgentSessionId,
} = require('../../src/core/session');
const {
  authorizedHistoryFiles,
  clearHistoryFileAuthorization,
  registerHistoryPayloadFiles,
} = require('../../src/core/historyFileAccess');

function createSession(overrides = {}) {
  return {
    agentType: 'codex',
    agentSessionId: 'agent-session-a',
    workspace: path.join(os.tmpdir(), 'linco-history-access', 'project-a'),
    ...overrides,
  };
}

function createPayload(session, filePaths) {
  const midpoint = Math.ceil(filePaths.length / 2);
  const mapFile = localPath => ({
    name: path.basename(localPath),
    mimeType: 'image/png',
    size: 10,
    localPath,
  });
  return {
    agentType: session.agentType,
    agentSessionId: session.agentSessionId,
    workspace: session.workspace,
    rounds: [{
      user: { files: filePaths.slice(0, midpoint).map(mapFile) },
      assistant: { files: filePaths.slice(midpoint).map(mapFile) },
    }],
  };
}

function fileConfig(overrides = {}) {
  return {
    maxOutgoingAttachmentBytes: 1024,
    allowHiddenGetFiles: false,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
    ...overrides,
  };
}

test('history payload registers only exact absolute file paths for the current identity', () => {
  const session = createSession();
  const firstPath = path.join(os.tmpdir(), 'codex-clipboard-first.png');
  const secondPath = path.join(os.tmpdir(), 'codex-clipboard-second.png');
  const payload = createPayload(session, [firstPath, secondPath]);
  payload.rounds[0].user.files.push({
    name: 'relative.png',
    mimeType: 'image/png',
    size: 10,
    localPath: 'relative.png',
  });
  payload.rounds[0].assistant.files.push({
    name: 'invalid.png',
    mimeType: 'image/png',
    size: 10,
    localPath: `${path.join(os.tmpdir(), 'invalid.png')}\0suffix`,
  });

  assert.equal(registerHistoryPayloadFiles(session, payload), 2);
  assert.deepEqual(authorizedHistoryFiles(session), [
    path.resolve(firstPath),
    path.resolve(secondPath),
  ]);

  clearHistoryFileAuthorization(session);
  assert.deepEqual(authorizedHistoryFiles(session), []);
});

test('history pagination merges files and evicts oldest paths at the bound', () => {
  const session = createSession();
  const paths = Array.from({ length: 205 }, (_, index) =>
    path.join(os.tmpdir(), `codex-history-page-${String(index).padStart(3, '0')}.png`));

  registerHistoryPayloadFiles(session, createPayload(session, paths.slice(0, 100)));
  registerHistoryPayloadFiles(session, createPayload(session, paths.slice(100)));

  const authorized = authorizedHistoryFiles(session);
  assert.equal(authorized.length, 200);
  assert.deepEqual(authorized, paths.slice(5).map(filePath => path.resolve(filePath)));
});

test('history file authorization rejects payloads for another identity', () => {
  const session = createSession();
  const filePath = path.join(os.tmpdir(), 'codex-clipboard-other.png');
  const payload = createPayload(session, [filePath]);

  payload.agentSessionId = 'agent-session-b';
  assert.equal(registerHistoryPayloadFiles(session, payload), 0);
  assert.deepEqual(authorizedHistoryFiles(session), []);
});

for (const [label, mutate] of [
  ['agent type', session => { session.agentType = 'claude'; }],
  ['Agent Session ID', session => { session.agentSessionId = 'agent-session-b'; }],
  ['project workspace', session => { session.workspace = path.join(os.tmpdir(), 'linco-history-access', 'project-b'); }],
]) {
  test(`changing ${label} invalidates previous history file authorization`, () => {
    const session = createSession();
    const originalIdentity = { ...session };
    const filePath = path.join(os.tmpdir(), `codex-clipboard-${label.replaceAll(' ', '-')}.png`);
    registerHistoryPayloadFiles(session, createPayload(session, [filePath]));

    mutate(session);
    assert.deepEqual(authorizedHistoryFiles(session), []);

    Object.assign(session, originalIdentity);
    assert.deepEqual(authorizedHistoryFiles(session), []);
  });
}

test('exact history files still pass every existing file safety check', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-file-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const session = createSession({ workspace });

  const safePath = path.join(outside, 'codex-clipboard-safe.png');
  const siblingPath = path.join(outside, 'codex-clipboard-sibling.png');
  const hiddenPath = path.join(outside, '.codex-clipboard-hidden.png');
  const oversizedPath = path.join(outside, 'codex-clipboard-large.png');
  const unsafePath = path.join(outside, 'codex-clipboard-danger.exe');
  const directoryPath = path.join(outside, 'not-a-file.png');
  fs.writeFileSync(safePath, 'safe');
  fs.writeFileSync(siblingPath, 'sibling');
  fs.writeFileSync(hiddenPath, 'hidden');
  fs.writeFileSync(oversizedPath, '12345');
  fs.writeFileSync(unsafePath, 'unsafe');
  fs.mkdirSync(directoryPath);

  assert.equal(validateGetFile(safePath, session, fileConfig(), {
    allowedFiles: [safePath],
  }).ok, true);
  assert.equal(validateGetFile(siblingPath, session, fileConfig(), {
    allowedFiles: [safePath],
  }).code, 'outside_allowed_roots');
  assert.equal(validateGetFile(hiddenPath, session, fileConfig(), {
    allowedFiles: [hiddenPath],
  }).code, 'hidden_path');
  assert.equal(validateGetFile(oversizedPath, session, fileConfig({
    maxOutgoingAttachmentBytes: 4,
  }), {
    allowedFiles: [oversizedPath],
  }).code, 'too_large');
  assert.equal(validateGetFile(unsafePath, session, fileConfig(), {
    allowedFiles: [unsafePath],
  }).code, 'unsafe');
  assert.equal(validateGetFile(directoryPath, session, fileConfig(), {
    allowedFiles: [directoryPath],
  }).code, 'not_file');

  const aliasDirectory = path.join(root, 'outside-alias');
  const aliasPath = path.join(aliasDirectory, path.basename(safePath));
  try {
    fs.symlinkSync(outside, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(validateGetFile(aliasPath, session, fileConfig(), {
      allowedFiles: [safePath],
    }).code, 'outside_allowed_roots');
    assert.equal(validateGetFile(aliasPath, session, fileConfig(), {
      allowedFiles: [aliasPath],
    }).code, 'outside_allowed_roots');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
  }
});

test('switching Agent Sessions away and back cannot restore old authorization', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-session-switch-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const session = createSession({
    id: 'bridge-session',
    storageId: 'bridge-session',
    runtimeDir,
    agentSessionHistory: [],
  });
  const filePath = path.join(os.tmpdir(), 'codex-clipboard-old-session.png');
  registerHistoryPayloadFiles(session, createPayload(session, [filePath]));

  persistAgentSessionId(session, 'agent-session-b');
  persistAgentSessionId(session, 'agent-session-a');

  assert.deepEqual(authorizedHistoryFiles(session), []);
});

test('clearing and recreating an Agent Session cannot restore old authorization', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-session-clear-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const session = createSession({
    id: 'bridge-session',
    storageId: 'bridge-session',
    runtimeDir,
    agentSessionHistory: [],
  });
  const filePath = path.join(os.tmpdir(), 'codex-clipboard-cleared-session.png');
  registerHistoryPayloadFiles(session, createPayload(session, [filePath]));

  clearPersistedAgentSession(session);
  persistAgentSessionId(session, 'agent-session-a');

  assert.deepEqual(authorizedHistoryFiles(session), []);
});
