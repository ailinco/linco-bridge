# Project List and History Image Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return every discovered project from `/project` while allowing mobile history repair to read only exact files exposed by the current project and Agent Session history payload.

**Architecture:** Make the existing project candidate limit optional, leaving `/project` unlimited and making `/get` explicitly retain the legacy 20-root limit. Add an in-memory, bounded history-file authorization registry to each bridge session; history handlers register metadata-only payload paths, and `/get` supplies only the current identity's exact paths to the existing file validator.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, filesystem/path APIs.

---

### Task 1: Separate Project Display and File-Access Limits

**Files:**
- Modify: `linco-bridge-connect/test/command/file-get-known-projects.test.js`
- Modify: `linco-bridge-connect/src/command/project.js`
- Modify: `linco-bridge-connect/src/command/fileGet.js`

- [ ] **Step 1: Write failing tests for more than 20 project results and a 20-root `/get` boundary**

Create 21 readable projects in Codex global state. Assert `knownProjectCandidates(session, { homeDir })` returns 21, while `/get` can read project 20 and rejects project 21.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/command/file-get-known-projects.test.js`

Expected: the project count assertion reports 20 instead of 21.

- [ ] **Step 3: Implement an optional candidate limit**

Use one helper in `project.js` so all agent branches share the same behavior:

```js
function limitKnownProjects(projects, limit) {
  return Number.isInteger(limit) && limit >= 0 ? projects.slice(0, limit) : projects;
}

function knownProjectCandidates(session, options = {}) {
  // collect and normalize as today
  return limitKnownProjects(projects, options.limit);
}
```

Keep `sendKnownProjects()` unlimited. In `fileGet.js`, call:

```js
knownProjectCandidates(session, { homeDir: config?.homeDir, limit: 20 })
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/command/file-get-known-projects.test.js`

Expected: all tests pass.

### Task 2: Add Bounded Current-Identity History File Authorization

**Files:**
- Create: `linco-bridge-connect/src/core/historyFileAccess.js`
- Create: `linco-bridge-connect/test/core/history-file-access.test.js`

- [ ] **Step 1: Write failing authorization registry tests**

Test a payload containing user and assistant `files` and assert:

```js
registerHistoryPayloadFiles(session, payload);
assert.deepEqual(authorizedHistoryFiles(session), [firstPath, secondPath]);
```

Also assert unregistered paths are absent, pagination merges paths, the set evicts oldest entries at its bound, and changing agent type, Agent Session ID, or normalized workspace invalidates the stored paths.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/core/history-file-access.test.js`

Expected: module-not-found failure for `historyFileAccess`.

- [ ] **Step 3: Implement the session-local registry**

Implement and export:

```js
registerHistoryPayloadFiles(session, payload)
authorizedHistoryFiles(session)
clearHistoryFileAuthorization(session)
```

Build identity from normalized `agentType`, trimmed `agentSessionId`, and resolved/case-normalized workspace. Register only absolute, non-NUL paths from a payload whose identity exactly matches the current session. Store no file contents, keep the registry off persisted metadata, merge pages for one identity, and cap it at 200 paths by evicting oldest entries.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/core/history-file-access.test.js`

Expected: all tests pass.

### Task 3: Register History Payload Files and Clear on Identity Changes

**Files:**
- Modify: `linco-bridge-connect/src/command/history/handlers.js`
- Modify: `linco-bridge-connect/src/command/project.js`
- Modify: `linco-bridge-connect/src/core/session.js`
- Modify: `linco-bridge-connect/src/agent/hermes/index.js`
- Create: `linco-bridge-connect/test/command/history-file-get.test.js`

- [ ] **Step 1: Write failing history-to-get integration tests**

Create a Codex transcript whose user message references a temporary clipboard PNG outside all normal roots. Run `/history`, then `/get` and assert an outbound image is sent. Assert the same path is rejected before history registration, for a different project, for a different Agent Session ID, and after an identity switch.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/command/history-file-get.test.js`

Expected: `/get` rejects the registered temporary image as outside allowed roots.

- [ ] **Step 3: Register every emitted history payload before sending it**

Add a helper in `handlers.js`:

```js
function sendHistoryResult(ws, session, payload) {
  registerHistoryPayloadFiles(session, payload);
  sendSlashCommandResult(ws, 'history', payload);
}
```

Use it for chat history, empty history, and ordinary/paginated history. A payload queried for a non-current project/session is sent normally but is not registered by the identity checks.

- [ ] **Step 4: Clear authorization in central identity mutation paths**

Call `clearHistoryFileAuthorization(session)` when `selectWorkspace`, `activateMatchedSession`, `persistAgentSessionId`, `clearPersistedAgentSession`, or Hermes session replacement changes the current identity. Avoid clearing when the identity remains unchanged so pagination can merge.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `node --test test/core/history-file-access.test.js test/command/history-file-get.test.js`

Expected: all tests pass.

### Task 4: Extend `/get` With Exact Authorized Files Without Weakening Validation

**Files:**
- Modify: `linco-bridge-connect/src/core/fileReferences.js`
- Modify: `linco-bridge-connect/src/command/fileGet.js`
- Modify: `linco-bridge-connect/test/core/history-file-access.test.js`
- Modify: `linco-bridge-connect/test/command/history-file-get.test.js`

- [ ] **Step 1: Add failing safety tests for exact-file access**

Pass an exact allowed file outside normal roots to `validateGetFile`. Assert the exact file succeeds, a sibling fails, and hidden, oversized, unsafe-extension, non-file, and symlink-alias requests continue to fail under existing rules.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/core/history-file-access.test.js test/command/history-file-get.test.js`

Expected: the safe exact path is still rejected as `outside_allowed_roots`.

- [ ] **Step 3: Add exact-file matching to the validator**

Extend `resolveAllowedFileAccess()` with `options.allowedFiles`. Match the normalized requested path exactly and, for existing files, require its resolved real path to equal the registered file's real path. Return an `exactFile` access descriptor so hidden path checks inspect the full requested/real path rather than treating its containing directory as authorized.

In `fileGet.js`, pass:

```js
allowedFiles: authorizedHistoryFiles(session)
```

Do not change ordinary-file, non-empty, maximum-size, unsafe-extension, or read-path behavior.

- [ ] **Step 4: Run focused and regression tests**

Run:

```text
node --test test/core/history-file-access.test.js test/command/history-file-get.test.js
node --test test/command/file-get-known-projects.test.js test/core/file-references-hidden.test.js test/core/file-references-resolve-get.test.js test/command/history-payload-files.test.js
```

Expected: all tests pass.

### Task 5: Verify the Plugin Change

**Files:**
- Modify if required: `linco-bridge-connect/docs/protocol.md`

- [ ] **Step 1: Document the scoped behavior if the protocol text needs clarification**

State that history `files[].localPath` is metadata only, `/project` has no final 20-item display cap, and `/get` accepts history files only after current-identity registration while its known-project root set remains capped at 20.

- [ ] **Step 2: Run the plugin test suite**

Run: `npm test`

Expected: zero test failures.

- [ ] **Step 3: Check patch integrity**

Run:

```text
git diff --check
git status --short
```

Expected: no whitespace errors; only the approved design/plan and plugin implementation files are changed.

- [ ] **Step 4: Review requirements against the approved design**

Confirm `/project` is unlimited, `/get` retains 20 project roots, exact paths require the current agent/session/project identity, switches invalidate authorization, pagination is bounded and merged, and all original file-safety validations still execute.
