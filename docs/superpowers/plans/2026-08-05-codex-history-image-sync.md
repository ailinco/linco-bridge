# Codex History Image Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve safe desktop image references through history sync and resolve them through the existing bridge preview flow so App history displays Codex user images.

**Architecture:** The connector adds an optional, metadata-only `files` array to each history message. The service normalizes that array with strict count, type, length, path, and forbidden-content checks. The App converts valid image references to its existing attachment marker and extends the existing bridge-image repair pass to user messages, so the current `/get` and OSS upload path remains the only file transport.

**Tech Stack:** Node.js built-in test runner, NestJS/TypeScript/Jest, Flutter/Dart/Drift.

---

### Task 1: Connector history file references

**Files:**
- Modify: `linco-bridge-connect/src/command/history/payloads.js`
- Modify: `linco-bridge-connect/test/command/history-payload-files.test.js`
- Modify: `linco-bridge-connect/docs/protocol.md`

- [ ] **Step 1: Write failing connector tests**

Replace the exclusion-only assertion with tests that require `buildHistoryPayload()` to retain only `name`, `mimeType`, `size`, and `localPath`, preserve multiple references, omit malformed paths and `data:` values, and keep `files` absent for text-only rounds.

- [ ] **Step 2: Run the focused connector test and verify RED**

Run: `node --test test/command/history-payload-files.test.js`

Expected: FAIL because `buildHistoryPayload()` currently removes `user.files` and `assistant.files`.

- [ ] **Step 3: Implement metadata-only normalization**

Add a small helper in `payloads.js` that accepts at most 10 file objects, validates bounded string fields and a non-negative finite size, rejects `data:`/Base64-bearing values, and returns only the four allowed keys. Attach the resulting optional array when constructing user and assistant history messages; do not change message IDs, text, timestamps, pagination, or history version.

- [ ] **Step 4: Document the optional protocol field**

Add the `files` object shape, limits, and no-Base64 rule to `docs/protocol.md`.

- [ ] **Step 5: Verify connector GREEN**

Run: `node --test test/command/history-payload-files.test.js`

Expected: PASS, including text-only and malformed-file compatibility cases.

### Task 2: Service validation and forwarding

**Files:**
- Modify: `aichat-service/src/modules/im/utils/bridge-history-identity.ts`
- Modify: `aichat-service/src/modules/im/utils/bridge-history-identity.spec.ts`

- [ ] **Step 1: Write failing service tests**

Add cases proving valid file references survive history normalization, extra keys and forbidden inline content are stripped, invalid entries are dropped without rejecting the round, the output is capped at 10 entries, and payloads without `files` remain byte-for-byte compatible at the message-field level.

- [ ] **Step 2: Run the focused Jest test and verify RED**

Run the repository's Jest command against the selected bridge-history spec.

Expected: FAIL because the current normalizer does not retain `files`.

- [ ] **Step 3: Implement service-side normalization**

Define the optional history-file-reference type beside the existing history identity utilities and normalize only `name`, `mimeType`, `size`, and `localPath`. Enforce the same count and length limits as the connector, reject `data:` and Base64 fields, and preserve valid references in `round.user` or `round.assistant` before the gateway forwards the payload. `im.gateway.ts` already calls this normalizer before forwarding, so it requires no behavioral change.

- [ ] **Step 4: Verify service GREEN**

Run the focused Jest test, then the existing bridge-history test group.

Expected: PASS with no changes to history identity, pagination, or text behavior.

### Task 3: App import of structured image references

**Files:**
- Modify: `aichat/lib/chat/services/bridge_history_importer.dart`
- Modify: `aichat/test/chat/bridge_history_import_test.dart`

- [ ] **Step 1: Write failing importer tests**

Add a desktop-originated user round containing two valid image references plus malformed/non-image entries. Assert that the saved user content contains the original question followed by the two existing-form markers `【图片：name】(url:localPath)`, invalid entries are ignored, a repeated import does not duplicate messages or markers, and a legacy round without `files` is unchanged.

- [ ] **Step 2: Run the focused Flutter test and verify RED**

Run: `flutter test test/chat/bridge_history_import_test.dart --plain-name "imports desktop image references as attachment markers"`

Expected: FAIL because the importer currently persists only the `text` field.

- [ ] **Step 3: Implement marker conversion at the import boundary**

Parse only list/map values with bounded `name`, image `mimeType`, finite non-negative `size`, and non-empty non-`data:` `localPath`. Append escaped attachment markers to the user text before the existing stable-ID merge. Keep assistant and text-only behavior unchanged and reuse the existing marker format rather than creating a new message-part type.

- [ ] **Step 4: Verify importer GREEN**

Run the focused test and the complete `bridge_history_import_test.dart` file.

Expected: PASS with stable message count and old payload compatibility.

### Task 4: Resolve imported user image markers

**Files:**
- Modify: `aichat/lib/chat/services/bridge_local_image_links.dart`
- Modify: `aichat/lib/chat/services/agent_link_service.dart`
- Modify: `aichat/test/chat/bridge_local_image_repair_test.dart`

- [ ] **Step 1: Write failing repair tests**

Add cases showing attachment markers with Windows local paths are extracted, user-message markers are fetched and replaced with the returned CDN URL, assistant Markdown-image repair still works, duplicate paths are fetched once, the global `maxImages` cap remains enforced, and one fetch failure leaves that marker untouched while later references continue.

- [ ] **Step 2: Run the focused Flutter tests and verify RED**

Run the selected bridge-image link and service tests.

Expected: FAIL because marker extraction is unsupported and `repairBridgeLocalImages()` currently skips `message.isMe`.

- [ ] **Step 3: Extend parsing and repair minimally**

Teach `extractBridgeLocalImageReferences()` and `replaceBridgeLocalImagePath()` to recognize the existing image attachment marker in addition to Markdown images. Remove only the user-message exclusion from the repair loop; keep deleted-message handling, bridge-mode checks, caching, attempt limits, preview validation, persistence, and per-file failure isolation intact. Allow `persistBridgeImageResolution()` to update a user attachment marker when invoked for one.

- [ ] **Step 4: Verify repair GREEN**

Run the focused tests and the existing App bridge-history/image-related tests.

Expected: PASS; imported local paths become CDN marker URLs while unrelated messages are unchanged.

### Task 5: Cross-repository compatibility verification

**Files:**
- Verify only: all files changed in Tasks 1-4

- [ ] **Step 1: Run connector regression tests**

Run the focused history tests plus the repository's relevant history test suite.

- [ ] **Step 2: Run service regression tests and build/typecheck**

Run the bridge-history Jest group and the repository's configured TypeScript build or typecheck command.

- [ ] **Step 3: Run App regression tests and analysis**

Run the complete bridge-history import test, focused repair tests, and `flutter analyze` for the modified files.

- [ ] **Step 4: Check diffs and forbidden payload content**

Run `git diff --check` in all three modified repositories and inspect the connector/service diffs to confirm no Base64 or `data:` payload is emitted.

- [ ] **Step 5: Record the compatibility result**

Confirm old plugin + new App, new plugin + old App, and text-only history remain supported because `files` is optional and ignored by consumers that do not know it. Confirm `AIChat-Admin` is unchanged because it is outside this data flow.
