const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractFileReferences,
  validateGetFile,
} = require('../../src/core/fileReferences');

function baseConfig(overrides = {}) {
  return {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowHiddenGetFiles: false,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
    ...overrides,
  };
}

function writeFile(filePath, content = 'content') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-file-references-hidden-'));
const session = {
  workspace: path.join(tempDir, 'workspace'),
  runtimeDir: path.join(tempDir, '.linco', 'sessions', 'session-1'),
  attachmentsDir: path.join(tempDir, '.linco', 'sessions', 'session-1', 'attachments'),
};

try {
  fs.mkdirSync(session.workspace, { recursive: true });
  fs.mkdirSync(session.runtimeDir, { recursive: true });
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  {
    const target = path.join(session.workspace, '.env');
    writeFile(target, 'TOKEN=secret');

    const result = validateGetFile(target, session, baseConfig());

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, path.resolve(target));
  }

  {
    const target = path.join(session.workspace, '.git', 'config');
    writeFile(target, '[core]');

    const result = validateGetFile(target, session, baseConfig());

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, path.resolve(target));
  }

  {
    const target = path.join(session.workspace, 'reports', 'report.v1.txt');
    writeFile(target, 'normal');

    const result = validateGetFile(target, session, baseConfig());

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, path.resolve(target));
  }

  {
    const target = path.join(session.runtimeDir, 'result.txt');
    writeFile(target, 'runtime output');

    const result = validateGetFile(target, session, baseConfig());

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, path.resolve(target));
  }

  {
    const target = path.join(session.workspace, '.env');

    const result = validateGetFile(target, session, baseConfig({ allowHiddenGetFiles: true }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, path.resolve(target));
  }

  {
    const hidden = path.join(session.workspace, '.secret', 'token.txt');
    const visible = path.join(session.workspace, 'public', 'report.txt');
    writeFile(hidden, 'secret');
    writeFile(visible, 'visible');

    const text = `[hidden](${hidden}) and [visible](${visible})`;
    const references = extractFileReferences(text, session, baseConfig());

    assert.strictEqual(references.length, 2);
    assert.deepStrictEqual(
      references.map(reference => reference.path),
      [path.resolve(hidden), path.resolve(visible)],
    );
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
