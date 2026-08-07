# History Default Three Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change every history command's omitted-limit default from 10 rounds to 3 rounds while preserving explicit limits.

**Architecture:** Keep all history parsers on the existing shared `DEFAULT_HISTORY_ROUNDS_LIMIT` constant and change that constant once. Protect the shared behavior with parser tests, then align help text and bilingual documentation.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, `assert`, Markdown documentation.

---

### Task 1: Change the shared history default

**Files:**
- Modify: `test/command/history-payload-files.test.js:84`
- Modify: `test/command/linco-local-command-turn-end.test.js:1826`
- Modify: `src/command/history/constants.js:7`
- Modify: `src/command/help.js:23`
- Modify: `README.zh-CN.md:280`
- Modify: `README.en-US.md:282`
- Modify: `docs/slash-commands.md:42`
- Modify: `docs/slash-commands.en-US.md:42`

- [ ] **Step 1: Write the failing parser expectations**

Extend the existing `history thinking flag is opt-in` test so omitted limits use 3 for plain, thinking, chat, and project/session forms while an explicit `10` remains 10:

```js
assert.deepEqual(parseHistoryArgs(''), {
  ok: true,
  limit: 3,
  includeThinking: false,
});
assert.deepEqual(parseHistoryArgs('--with-thinking'), {
  ok: true,
  limit: 3,
  includeThinking: true,
});
assert.deepEqual(parseHistoryArgs('--chat chat-1'), {
  ok: true,
  chatId: 'chat-1',
  limit: 3,
  includeThinking: false,
});
assert.deepEqual(parseHistoryArgs('--project "/tmp/demo" --session session-1'), {
  ok: true,
  limit: 3,
  projectPath: '/tmp/demo',
  sessionId: 'session-1',
  includeThinking: false,
});
assert.equal(parseHistoryArgs('10').limit, 10);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/command/history-payload-files.test.js
```

Expected: FAIL because omitted limits currently resolve to 10.

- [ ] **Step 3: Change the shared constant**

In `src/command/history/constants.js`, change:

```js
const DEFAULT_HISTORY_ROUNDS_LIMIT = 10;
```

to:

```js
const DEFAULT_HISTORY_ROUNDS_LIMIT = 3;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test test/command/history-payload-files.test.js`.

Expected: all tests in the file PASS, including explicit limit 10.

- [ ] **Step 5: Update help and documentation**

Replace the five user-facing `默认 10 轮` / `defaults to 10 rounds` descriptions with 3 rounds in `src/command/help.js`, both READMEs, and both slash-command documents.

- [ ] **Step 6: Update the command integration expectation**

Update the no-argument `/history` integration test to expect the latest three rounds and verify the first returned timestamp belongs to the second of four fixture rounds.

- [ ] **Step 7: Run full verification and commit**

```powershell
rg -n -S "默认 10 轮|defaults to 10 rounds|Default is 10 rounds" README.zh-CN.md README.en-US.md docs src -g '!docs/superpowers/**'
npm test
git diff --check
git add -- test/command/history-payload-files.test.js test/command/linco-local-command-turn-end.test.js src/command/history/constants.js src/command/help.js README.zh-CN.md README.en-US.md docs/slash-commands.md docs/slash-commands.en-US.md docs/superpowers/plans/2026-08-07-history-default-three-rounds.md
git commit -m "feat: default history retrieval to three rounds"
```

Expected: no stale 10-round descriptions, full test exit code 0, and a clean committed change.
