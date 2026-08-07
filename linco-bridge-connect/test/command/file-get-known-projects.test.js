const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleGet } = require('../../src/command/fileGet');
const { knownProjectCandidates } = require('../../src/command/project');

function createCaptureWs() {
  const sent = [];
  return {
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

function createFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-get-known-projects-'));
  const currentProject = path.join(homeDir, 'work', 'current-project');
  const otherProject = path.join(homeDir, 'work', 'other-project');
  const unlistedDir = path.join(homeDir, 'private', 'unlisted');
  const runtimeDir = path.join(homeDir, '.linco', 'codex', 'sessions', 'test');
  const attachmentsDir = path.join(runtimeDir, 'attachments');
  for (const dir of [currentProject, otherProject, unlistedDir, attachmentsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, '.codex-global-state.json'), JSON.stringify({
    'project-order': ['current-id', 'other-id'],
    'local-projects': {
      'current-id': {
        id: 'current-id',
        name: 'current-project',
        rootPaths: [currentProject],
      },
      'other-id': {
        id: 'other-id',
        name: 'other-project',
        rootPaths: [otherProject],
      },
    },
  }));

  return {
    homeDir,
    currentProject,
    otherProject,
    unlistedDir,
    session: {
      id: 'known-project-get-session',
      agentType: 'codex',
      workspace: currentProject,
      runtimeDir,
      attachmentsDir,
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

function outboundFile(ws) {
  return ws.sent.find(item => item.type === 'outbound_message' && item.mediaBase64);
}

function createManyProjectsFixture(count = 21) {
  const fixture = createFixture();
  const projectOrder = [];
  const localProjects = {};
  const projects = [];
  for (let index = 1; index <= count; index++) {
    const id = `project-${String(index).padStart(2, '0')}`;
    const projectPath = path.join(fixture.homeDir, 'many-projects', id);
    fs.mkdirSync(projectPath, { recursive: true });
    projectOrder.push(id);
    localProjects[id] = {
      id,
      name: id,
      rootPaths: [projectPath],
    };
    projects.push(projectPath);
  }
  fs.writeFileSync(
    path.join(fixture.homeDir, '.codex', '.codex-global-state.json'),
    JSON.stringify({ 'project-order': projectOrder, 'local-projects': localProjects }),
  );
  fixture.session.workspace = projects[0];
  return { ...fixture, projects };
}

test('project candidates return every normalized Codex state project', t => {
  const fixture = createManyProjectsFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));

  const projects = knownProjectCandidates(fixture.session, { homeDir: fixture.homeDir });

  assert.equal(projects.length, 21);
  assert.deepEqual(projects.map(project => project.path), fixture.projects);
});

test('get reads files beyond the legacy 20 known-project root limit', t => {
  const fixture = createManyProjectsFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));
  const allowedTarget = path.join(fixture.projects[19], 'allowed.txt');
  const excludedTarget = path.join(fixture.projects[20], 'excluded.txt');
  fs.writeFileSync(allowedTarget, 'allowed project');
  fs.writeFileSync(excludedTarget, 'excluded project');

  const allowedWs = createCaptureWs();
  handleGet(allowedTarget, allowedWs, fixture.session, fixture.config);
  assert.equal(
    outboundFile(allowedWs)?.mediaBase64,
    Buffer.from('allowed project').toString('base64'),
  );

  const excludedWs = createCaptureWs();
  handleGet(excludedTarget, excludedWs, fixture.session, fixture.config);
  assert.equal(
    outboundFile(excludedWs)?.mediaBase64,
    Buffer.from('excluded project').toString('base64'),
  );
});

test('get allows an absolute file from another project shown by /project', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));
  const target = path.join(fixture.otherProject, 'report.txt');
  fs.writeFileSync(target, 'other project report');
  const ws = createCaptureWs();

  handleGet(target, ws, fixture.session, fixture.config);

  const message = outboundFile(ws);
  assert.ok(message);
  assert.equal(message.mediaName, 'report.txt');
  assert.equal(
    message.mediaBase64,
    Buffer.from('other project report').toString('base64'),
  );
  assert.equal(message.references[0].path, target);
  assert.equal(message.references[0].command, `/get ${target}`);
});

test('get reads an absolute file outside every /project root', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));
  const target = path.join(fixture.unlistedDir, 'private.txt');
  fs.writeFileSync(target, 'private');
  const ws = createCaptureWs();

  handleGet(target, ws, fixture.session, fixture.config);

  assert.equal(
    outboundFile(ws)?.mediaBase64,
    Buffer.from('private').toString('base64'),
  );
});

test('get reads through a known-project symlink into an unlisted directory', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));
  const outsideFile = path.join(fixture.unlistedDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside');
  const linkDir = path.join(fixture.otherProject, 'linked-outside');
  try {
    fs.symlinkSync(
      fixture.unlistedDir,
      linkDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (err) {
    t.skip(`当前平台无法创建测试软链接: ${err.message}`);
    return;
  }
  const ws = createCaptureWs();

  handleGet(path.join(linkDir, 'outside.txt'), ws, fixture.session, fixture.config);

  assert.equal(
    outboundFile(ws)?.mediaBase64,
    Buffer.from('outside').toString('base64'),
  );
});

test('relative get paths remain scoped to the current workspace', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.homeDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.currentProject, 'same-name.txt'), 'current');
  fs.writeFileSync(path.join(fixture.otherProject, 'same-name.txt'), 'other');
  const ws = createCaptureWs();

  handleGet('same-name.txt', ws, fixture.session, fixture.config);

  assert.equal(
    outboundFile(ws)?.mediaBase64,
    Buffer.from('current').toString('base64'),
  );
});
