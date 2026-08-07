const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateGetFile } = require('../../src/core/fileReferences');

test('get validation allows every readable ordinary file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-unrestricted-get-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const session = {
    workspace,
    runtimeDir: path.join(root, 'runtime'),
    attachmentsDir: path.join(root, 'runtime', 'attachments'),
  };
  const config = {
    maxOutgoingAttachmentBytes: 4,
    allowHiddenGetFiles: false,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe'],
  };

  const files = [
    [path.join(outside, 'outside.txt'), 'outside'],
    [path.join(outside, '.env'), 'TOKEN=secret'],
    [path.join(outside, 'empty.txt'), ''],
    [path.join(outside, 'large.txt'), '12345'],
    [path.join(outside, 'tool.exe'), 'binary'],
  ];
  for (const [file, content] of files) fs.writeFileSync(file, content);

  for (const [file] of files) {
    const result = validateGetFile(file, session, config);
    assert.equal(result.ok, true, file);
    assert.equal(result.path, path.resolve(file));
    assert.equal(result.readPath, fs.realpathSync.native(file));
  }

  assert.equal(
    validateGetFile(path.join(outside, 'missing.txt'), session, config).code,
    'missing',
  );
  assert.equal(validateGetFile(outside, session, config).code, 'not_file');
});
