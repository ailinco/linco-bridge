# Unrestricted `/get` File Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `/get` to send every ordinary local file that the connector Node.js process can read, without path, hidden-file, extension, empty-file, or configured-size restrictions.

**Architecture:** Keep the existing command and outbound protocol, but reduce `validateGetFile()` to filesystem existence, ordinary-file, real-path, and readability checks. Remove command-level project/history allowlisting, catch final read failures at the command boundary, and update tests and documentation to describe the unrestricted behavior.

**Tech Stack:** Node.js CommonJS, `node:fs`, `node:path`, built-in `node:test`, `assert`.

---

### Task 1: Define the unrestricted file contract with failing tests

**Files:**
- Create: `test/core/file-references-unrestricted-get.test.js`
- Modify: `test/core/file-references-hidden.test.js`
- Modify: `test/command/file-get-known-projects.test.js`
- Modify: `test/core/history-file-access.test.js`

- [ ] **Step 1: Add a focused unrestricted validation test**

Create `test/core/file-references-unrestricted-get.test.js` with real temporary files. Assert that `validateGetFile()` accepts an ordinary file outside all session roots, a hidden file, an empty file, a file larger than `maxOutgoingAttachmentBytes`, and a configured unsafe `.exe` file. Assert that a missing path and a directory still fail.

```js
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
```

- [ ] **Step 2: Update existing assertions to the new contract**

In `file-references-hidden.test.js`, change `.env` and `.git/config` assertions to `ok === true`, and change Markdown extraction to expect both hidden and visible references. In `file-get-known-projects.test.js`, rename the legacy-limit and unlisted/symlink tests and assert that all those files produce outbound messages. In `history-file-access.test.js`, keep history authorization identity tests but change file validation expectations so sibling, hidden, oversized, unsafe, and symlink targets are accepted while directories remain rejected.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```powershell
node --test test/core/file-references-unrestricted-get.test.js test/core/file-references-hidden.test.js test/command/file-get-known-projects.test.js test/core/history-file-access.test.js
```

Expected: FAIL because current validation returns `outside_allowed_roots`, `hidden_path`, `too_large`, `empty`, or `unsafe` for the newly allowed cases.

- [ ] **Step 4: Commit the failing contract tests**

```powershell
git add -- test/core/file-references-unrestricted-get.test.js test/core/file-references-hidden.test.js test/command/file-get-known-projects.test.js test/core/history-file-access.test.js
git commit -m "test: define unrestricted get file access"
```

### Task 2: Remove `/get` file access restrictions

**Files:**
- Modify: `src/core/fileReferences.js:123`
- Modify: `src/command/fileGet.js:1`

- [ ] **Step 1: Reduce validation to filesystem checks**

Replace the body of `validateGetFile()` with logic equivalent to:

```js
function validateGetFile(filePath) {
  const resolved = path.resolve(filePath);
  const readPath = safeRealpath(resolved) || resolved;
  let stat;
  try {
    stat = fs.statSync(readPath);
  } catch (err) {
    const code = err?.code === 'ENOENT' ? 'missing' : 'unreadable';
    const message = code === 'missing'
      ? `文件不存在：${resolved}`
      : `无法读取文件：${resolved}`;
    return { ok: false, code, message };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'not_file', message: `不是普通文件：${resolved}` };
  }
  try {
    fs.accessSync(readPath, fs.constants.R_OK);
  } catch {
    return { ok: false, code: 'unreadable', message: `无法读取文件：${resolved}` };
  }
  return { ok: true, path: resolved, readPath, size: stat.size };
}
```

Keep the public function signature compatible with existing callers even though session, config, and allowlist options no longer affect the result.

- [ ] **Step 2: Remove command-level allowlist construction and catch final reads**

Remove `authorizedHistoryFiles` and `knownProjectCandidates` imports from `src/command/fileGet.js`. Call `validateGetFile(resolved, session, config)` without allowlist options. Wrap `buildOutboundFileMessage()` and `send()` in `try/catch`; on failure call `sendError(ws, `读取文件失败：${resolved}`)` so a permission change or read error between validation and base64 encoding does not escape command handling.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/core/file-references-unrestricted-get.test.js test/core/file-references-hidden.test.js test/core/file-references-resolve-get.test.js test/core/history-file-access.test.js test/command/file-get-known-projects.test.js test/command/history-file-get.test.js
```

Expected: all focused tests PASS.

- [ ] **Step 4: Commit the implementation**

```powershell
git add -- src/core/fileReferences.js src/command/fileGet.js
git commit -m "feat: allow get to read any accessible file"
```

### Task 3: Align public documentation and run full verification

**Files:**
- Modify: `README.zh-CN.md`
- Modify: `README.en-US.md`
- Modify: `docs/security.md`
- Modify: `docs/security.en-US.md`
- Modify: `docs/protocol.md`
- Modify: `docs/protocol.en-US.md`
- Modify: `docs/slash-commands.md`
- Modify: `docs/slash-commands.en-US.md`

- [ ] **Step 1: Replace obsolete restriction descriptions**

Document that `/get` accepts any ordinary local file readable by the connector process, including hidden, empty, large, and executable files. State that connector OS permissions and transport limits still apply. Remove claims about allowed roots, the 20-project limit, hidden paths, dangerous extensions, and `maxOutgoingAttachmentBytes` enforcement for `/get`.

- [ ] **Step 2: Run documentation consistency searches**

Run:

```powershell
rg -n -S "\/get.*(允许|限制|hidden|dangerous|20|50 MB)|ALLOW_HIDDEN_GET_FILES|MAX_OUTGOING_ATTACHMENT_BYTES" README.zh-CN.md README.en-US.md docs
```

Expected: no remaining text claims that `/get` enforces the removed restrictions; configuration references unrelated to `/get` may remain.

- [ ] **Step 3: Run the full test suite**

Run:

```powershell
npm test
```

Expected: exit code 0 with zero failed tests.

- [ ] **Step 4: Check the final diff and commit documentation**

```powershell
git diff --check
git status --short
git add -- README.zh-CN.md README.en-US.md docs/security.md docs/security.en-US.md docs/protocol.md docs/protocol.en-US.md docs/slash-commands.md docs/slash-commands.en-US.md docs/superpowers/plans/2026-08-07-unrestricted-get-file-access.md
git commit -m "docs: document unrestricted get file access"
```
