const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mimeFromFilename,
  resolveGetTarget,
  validateGetFile,
} = require('../../src/core/fileReferences');

function baseConfig() {
  return {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowHiddenGetFiles: false,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe'],
  };
}

function writeFile(filePath, content = 'content') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-resolve-get-'));
const session = {
  workspace: path.join(tempDir, 'workspace'),
  runtimeDir: path.join(tempDir, 'sid_test'),
  attachmentsDir: path.join(tempDir, 'sid_test', 'attachments'),
};

try {
  assert.strictEqual(mimeFromFilename('contract.vue'), 'text/plain; charset=utf-8');

  fs.mkdirSync(session.workspace, { recursive: true });
  fs.mkdirSync(session.runtimeDir, { recursive: true });
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  {
    const target = path.join(session.workspace, 'report.txt');
    writeFile(target, 'workspace file');

    const resolved = resolveGetTarget('report.txt', session);
    assert.strictEqual(resolved, path.resolve(target));
    assert.strictEqual(validateGetFile(resolved, session, baseConfig()).ok, true);
  }

  {
    const target = path.join(session.runtimeDir, '卤肉饭制作过程.txt');
    writeFile(target, 'runtime file');

    const resolved = resolveGetTarget('卤肉饭制作过程.txt', session);
    assert.strictEqual(resolved, path.resolve(target));
    assert.strictEqual(validateGetFile(resolved, session, baseConfig()).ok, true);
  }

  {
    const target = path.join(session.attachmentsDir, 'upload.pdf');
    writeFile(target, 'attachment file');

    const resolved = resolveGetTarget('upload.pdf', session);
    assert.strictEqual(resolved, path.resolve(target));
    assert.strictEqual(validateGetFile(resolved, session, baseConfig()).ok, true);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
