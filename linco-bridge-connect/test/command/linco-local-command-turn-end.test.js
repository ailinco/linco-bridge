const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const test = require('node:test');
const Database = require('better-sqlite3');
const { handleSlashCommand, _internal: slashCommandInternals } = require('../../src/command');
const agentSelection = require('../../src/command/agentSelection');
const { mapLocalEventToLinco } = require('../../src/channel/linco/protocol');
const { buildFileReferenceHint, buildImageGenerationDeliveryHint, _internal: fileReferenceInternals } = require('../../src/core/fileReferences');

function createCaptureWs() {
  const sent = [];
  return {
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
}

function canCreateDirectorySymlink() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-symlink-check-'));
  const realDir = path.join(tempDir, 'real');
  const linkDir = path.join(tempDir, 'link');
  try {
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkDir, 'dir');
    return true;
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') return false;
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const directorySymlinkSupported = canCreateDirectorySymlink();

{
  const session = {
    workspace: 'C:\\work',
    runtimeDir: 'C:\\runtime',
    attachmentsDir: 'C:\\runtime\\attachments',
  };

  assert.strictEqual(buildFileReferenceHint('生成一张小鹿的图片给我', session), '生成一张小鹿的图片给我');
  assert.match(buildImageGenerationDeliveryHint('生成一张小鹿的图片给我', session), /built-in image generation tool/);
  assert.doesNotMatch(buildImageGenerationDeliveryHint('生成一张小鹿的图片给我', session), /\/get/);
  assert.strictEqual(fileReferenceInternals.isImageGenerationRequest('帮我改代码，让页面可以生成图片'), false);
  assert.strictEqual(fileReferenceInternals.isImageGenerationRequest('现在给我生成一张图片'), true);
  assert.match(buildFileReferenceHint('生成一个 report.md 文件发给我', session), /System note: The user is asking to send or deliver a file\/image\./);
  assert.match(buildFileReferenceHint('生成一个 report.md 文件发给我', session), /\[filename\.ext\]\(absolute-local-path\)/);
  assert.doesNotMatch(buildFileReferenceHint('生成一个 report.md 文件发给我', session), /\/get/);
  assert.match(buildFileReferenceHint('download the generated report file', session), /System note: The user is asking to send or deliver a file\/image\./);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-cd-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-cd-runtime-'));
  const selected = path.join(workspace, 'selected project');
  fs.mkdirSync(selected, { recursive: true });
  const ws = createCaptureWs();
  const session = {
    id: 'session-1',
    storageId: 'sid_command_cd',
    workspace,
    runtimeDir,
    linco: {
      messageId: 'm-1',
      streamId: 'linco-stream-m-1',
    },
    agentType: 'claude',
    agentSessionId: 'old-session',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(`/cd "${selected}"`, ws, session, {}), true);

  assert.strictEqual(session.workspace, workspace);
  assert.strictEqual(session.agentSessionId, 'old-session');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(ws.sent.at(-1).sessionKey, 'session-1');
  assert.strictEqual(ws.sent.at(-1).streamId, 'linco-stream-m-1');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-help-claude',
    workspace: process.cwd(),
    linco: { messageId: 'm-help-claude', streamId: 'linco-stream-help-claude' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/help', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'help');
  assert.strictEqual(ws.sent[0].data.agentType, 'claude');
  const commands = ws.sent[0].data.items.map(item => item.command);
  assert.ok(commands.includes('/compact'));
  assert.ok(commands.includes('/cd <路径>'));
  assert.ok(commands.includes('/history [数量]'));
  assert.ok(commands.includes('/pc'));
  assert.ok(commands.includes('/approve manual'));
  assert.ok(commands.includes('/approve auto'));
  assert.ok(commands.includes('/approve yolo'));
  assert.ok(!commands.includes('/approve manual/auto/yolo'));
  assert.ok(!commands.includes('/project'));
  assert.ok(!commands.includes('/get <路径>'));
  assert.ok(!commands.includes('/session'));
  assert.ok(!commands.includes('/sessions [数量]'));
  assert.ok(!commands.includes('/history-reload'));
  assert.ok(!commands.includes('/base'));
  assert.ok(!commands.includes('/agent'));
  assert.ok(!commands.includes('/chats [limit]'));
  assert.ok(ws.sent[0].data.notes.length > 0);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-approve-command-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-approve',
    storageId: 'sid_approve',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-approve', streamId: 'linco-stream-approve' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
    approveMode: 'auto',
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/approve manual', ws, session, {}), true);
  assert.strictEqual(session.approveMode, 'manual');
  assert.strictEqual(session.autoApprove, false);
  assert.strictEqual(session.agentProcess, undefined);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');

  session.agentProcess = { stdin: null, killed: false, exitCode: null, kill() { this.killed = true; } };
  const wsAuto = createCaptureWs();
  assert.strictEqual(handleSlashCommand('/approve auto', wsAuto, session, {}), true);
  assert.strictEqual(session.approveMode, 'auto');
  assert.strictEqual(session.autoApprove, true);
  assert.notStrictEqual(session.agentProcess, null);

  const wsYolo = createCaptureWs();
  assert.strictEqual(handleSlashCommand('/approve yolo', wsYolo, session, {}), true);
  assert.strictEqual(session.approveMode, 'yolo');
  assert.strictEqual(session.autoApprove, true);
  assert.strictEqual(session.agentProcess, null);
  assert.match(wsYolo.sent[0].text, /yolo/);

  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'session.json'), 'utf8'));
  assert.strictEqual(saved.approveMode, 'yolo');
  assert.strictEqual(saved.autoApprove, true);
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-approve-invalid-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-approve-invalid',
    storageId: 'sid_approve_invalid',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-approve-invalid', streamId: 'linco-stream-approve-invalid' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
    approveMode: 'auto',
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/approve on', ws, session, {}), true);
  assert.strictEqual(session.approveMode, 'auto');
  assert.strictEqual(ws.sent[0].type, 'error');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-help-codex',
    workspace: process.cwd(),
    linco: { messageId: 'm-help-codex', streamId: 'linco-stream-help-codex' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/help', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'help');
  assert.strictEqual(ws.sent[0].data.agentType, 'codex');
  const commands = ws.sent[0].data.items.map(item => item.command);
  assert.ok(commands.includes('/pwd'));
  assert.ok(commands.includes('/reasoning'));
  assert.ok(commands.includes('/approve manual'));
  assert.ok(commands.includes('/approve auto'));
  assert.ok(commands.includes('/approve yolo'));
  assert.ok(!commands.includes('/project'));
  assert.ok(!commands.includes('/chats [limit]'));
  assert.ok(!commands.includes('/agent'));
  assert.ok(!commands.includes('/profile'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-remove-account-slash-config-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    defaultAgent: 'claude',
    channels: {
      linco: {
        agents: {
          claude: {
            defaultAccount: 'main',
            accounts: {
              main: { appId: 'app-main', appSecret: 'secret-main', enabled: true },
              backup: { appId: 'app-backup', appSecret: 'secret-backup', enabled: true },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-remove-account',
    workspace: process.cwd(),
    linco: {
      messageId: 'm-remove-account',
      streamId: 'linco-stream-remove-account',
      channel: 'linco',
      accountId: 'main',
    },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = {
    configFile,
    defaultLocalAgent: 'claude',
    im: { channel: 'linco', account: 'main' },
  };

  assert.strictEqual(handleSlashCommand('/remove-account', ws, session, config), true);

  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.claude.accounts.main, undefined);
  assert.strictEqual(saved.channels.linco.agents.claude.accounts.backup.appId, 'app-backup');
  assert.strictEqual(saved.channels.linco.agents.claude.defaultAccount, 'backup');
  assert.strictEqual(config.im.account, 'backup');
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.match(ws.sent[0].text, /已删除账号: linco\/claude\/main/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-id-claude',
    workspace: process.cwd(),
    linco: { messageId: 'm-session-id-claude', streamId: 'linco-stream-session-id-claude' },
    agentType: 'claude',
    agentSessionId: 'claude-session-123',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/session', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'session');
  assert.deepStrictEqual(ws.sent[0].data, {
    agentType: 'claude',
    sessionKey: 'session-id-claude',
    agentSessionId: 'claude-session-123',
    established: true,
  });
  assert.strictEqual(ws.sent[1].type, 'system');
  assert.match(ws.sent[1].text, /claude-session-123/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-id-codex-empty',
    workspace: process.cwd(),
    linco: { messageId: 'm-session-id-codex-empty', streamId: 'linco-stream-session-id-codex-empty' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/session', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'session');
  assert.deepStrictEqual(ws.sent[0].data, {
    agentType: 'codex',
    sessionKey: 'session-id-codex-empty',
    agentSessionId: null,
    established: false,
  });
  assert.strictEqual(ws.sent[1].type, 'system');
  assert.match(ws.sent[1].text, /还没有 Agent Session ID/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-help-openclaw',
    workspace: process.cwd(),
    linco: { messageId: 'm-help-openclaw', streamId: 'linco-stream-help-openclaw' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/help', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'help');
  assert.strictEqual(ws.sent[0].data.agentType, 'openclaw');
  const commands = ws.sent[0].data.items.map(item => item.command);
  assert.ok(commands.includes('/agent'));
  assert.ok(!commands.includes('/history [数量]'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  for (const agentType of ['claude', 'openclaw', 'hermes']) {
    const ws = createCaptureWs();
    const session = {
      id: `session-unknown-slash-pass-through-${agentType}`,
      workspace: process.cwd(),
      linco: { messageId: `m-unknown-slash-${agentType}`, streamId: `linco-stream-unknown-slash-${agentType}` },
      agentType,
      messageQueue: [],
      agentSessionHistory: [],
    };

    assert.strictEqual(handleSlashCommand('/unknown-native-command', ws, session, {}), false);
    assert.deepStrictEqual(ws.sent, []);
  }
}

{
  const ws = createCaptureWs();
  const child = {
    exitCode: null,
    killed: false,
    stdin: {
      destroyed: false,
      written: [],
      write(value) {
        this.written.push(value);
      },
    },
  };
  const session = {
    id: 'session-compact-claude',
    workspace: process.cwd(),
    runtimeDir: process.cwd(),
    attachmentsDir: process.cwd(),
    linco: { messageId: 'm-compact', streamId: 'linco-stream-compact' },
    agentType: 'claude',
    agentSessionId: 'claude-native-session',
    messageQueue: [],
    agentSessionHistory: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    streamState: { reset() {}, pendingText: '', assistantStarted: false },
    claudeProcess: child,
    agentProcess: child,
    autoApprove: true,
  };
  const config = {
    maxMessageQueue: 10,
    agents: { claude: { compactionTimeoutMs: 300000 } },
    logger: { info() {}, warn() {}, error() {} },
  };

  assert.strictEqual(handleSlashCommand('/compact', ws, session, config), true);
  assert.strictEqual(ws.sent[0].type, 'context_compaction');
  assert.strictEqual(ws.sent[0].phase, 'started');
  assert.strictEqual(ws.sent[0].agentType, 'claude');
  assert.strictEqual(ws.sent[0].agentSessionId, 'claude-native-session');
  assert.strictEqual(session.isTurnActive, true);
  assert.strictEqual(session.currentInputForNoOutput, '/compact');
  assert.strictEqual(child.stdin.written.length, 1);
  assert.deepStrictEqual(JSON.parse(child.stdin.written[0]), {
    type: 'user',
    message: {
      role: 'user',
      content: '/compact',
    },
  });
  clearTimeout(session.claudeCompaction.staleTimerId);
  clearTimeout(session.claudeCompaction.timeoutTimerId);
  session.claudeCompaction = null;
}

{
  const slashPath = require.resolve('../../src/command');
  const agentRunnerPath = require.resolve('../../src/runtime/agentRunner');
  const originalAgentRunner = require.cache[agentRunnerPath];
  const originalSlash = require.cache[slashPath];
  let compactCalled = null;

  require.cache[agentRunnerPath] = {
    id: agentRunnerPath,
    filename: agentRunnerPath,
    loaded: true,
    exports: {
      compactAgentContext(ws, session, config, options) {
        compactCalled = { ws, session, config, options };
        return true;
      },
      resolvePendingDanger() { return false; },
      resolvePendingPermission() { return false; },
      stopAgentProcess() {},
      warmupAgentProcess() {},
    },
  };
  delete require.cache[slashPath];
  const { handleSlashCommand: handleSlashCommandWithMock } = require('../../src/command');

  try {
    const ws = createCaptureWs();
    const session = {
      id: 'session-compact-codex',
      workspace: process.cwd(),
      linco: { messageId: 'm-compact-codex', streamId: 'linco-stream-compact-codex' },
      agentType: 'codex',
      messageQueue: [],
      agentSessionHistory: [],
    };
    const config = {
      maxMessageQueue: 10,
      agents: { codex: { compactionTimeoutMs: 300000 } },
    };

    assert.strictEqual(handleSlashCommandWithMock('/compact', ws, session, config), true);
    assert.strictEqual(compactCalled.session, session);
    assert.deepStrictEqual(compactCalled.options, { trigger: 'manual', nativeCommand: '/compact' });
    assert.deepStrictEqual(ws.sent, []);
  } finally {
    if (originalAgentRunner) require.cache[agentRunnerPath] = originalAgentRunner;
    else delete require.cache[agentRunnerPath];
    if (originalSlash) require.cache[slashPath] = originalSlash;
    else delete require.cache[slashPath];
  }
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-help-openclaw',
    workspace: process.cwd(),
    linco: { messageId: 'm-help-openclaw', streamId: 'linco-stream-help-openclaw' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/help', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'help');
  assert.strictEqual(ws.sent[0].data.agentType, 'openclaw');
  const commands = ws.sent[0].data.items.map(item => item.command);
  assert.ok(commands.includes('/agent'));
  assert.ok(commands.includes('/compact'));
  assert.ok(!commands.includes('/project'));
  assert.ok(!commands.includes('/profile'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-help-hermes',
    workspace: process.cwd(),
    linco: { messageId: 'm-help-hermes', streamId: 'linco-stream-help-hermes' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/help', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'help');
  assert.strictEqual(ws.sent[0].data.agentType, 'hermes');
  const commands = ws.sent[0].data.items.map(item => item.command);
  assert.ok(commands.includes('/profile'));
  assert.ok(commands.includes('/compact'));
  assert.ok(!commands.includes('/project'));
  assert.ok(!commands.includes('/agent'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-commands-removed',
    workspace: process.cwd(),
    linco: { messageId: 'm-commands-removed', streamId: 'linco-stream-commands-removed' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/commands', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /\/commands 已移除/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-refresh-removed',
    workspace: process.cwd(),
    linco: { messageId: 'm-refresh-removed', streamId: 'linco-stream-refresh-removed' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/refresh', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /\/refresh 已移除/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-openclaw-workspace-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-openclaw-workspace',
    workspace,
    linco: { messageId: 'm-openclaw-workspace', streamId: 'linco-stream-openclaw-workspace' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/project', ws, session, {}), true);
  assert.match(ws.sent[0].text, /工作空间由 OpenClaw Agent 自身管理/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-openclaw-cd-'));
  const selected = path.join(workspace, 'selected project');
  fs.mkdirSync(selected, { recursive: true });
  const ws = createCaptureWs();
  const session = {
    id: 'session-openclaw-cd',
    workspace,
    linco: { messageId: 'm-openclaw-cd', streamId: 'linco-stream-openclaw-cd' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand(`/cd "${selected}"`, ws, session, {}), true);
  assert.strictEqual(session.workspace, workspace);
  assert.match(ws.sent[0].text, /工作空间由 OpenClaw Agent 自身管理/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-hermes-workspace-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-hermes-workspace',
    workspace,
    linco: { messageId: 'm-hermes-workspace', streamId: 'linco-stream-hermes-workspace' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/pwd', ws, session, {}), true);
  assert.match(ws.sent[0].text, /工作空间由 Hermes Profile\/Gateway 自身管理/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-pc-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-2',
    workspace,
    linco: {
      messageId: 'm-2',
      streamId: 'linco-stream-m-2',
    },
    agentType: 'claude',
    agentSessionId: '75e7c33e-fb18-43f6-ae8f-27b39214d0db',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/pc', ws, session, {}), true);

  assert.strictEqual(ws.sent[0].type, 'system');
  assert(ws.sent[0].text.includes('claude --resume'));
  assert(ws.sent[0].text.includes(session.agentSessionId));
  assert(ws.sent[0].text.includes(workspace));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(ws.sent.at(-1).sessionKey, 'session-2');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-pc-claude-repair-home-'));
  const workspace = path.join(homeDir, 'project');
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-pc-claude-repair-runtime-'));
  fs.mkdirSync(workspace, { recursive: true });
  const agentSessionId = 'pc-claude-repair-session';
  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(workspace));
  fs.mkdirSync(projectStore, { recursive: true });
  const transcript = path.join(projectStore, `${agentSessionId}.jsonl`);
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } }),
    '',
  ].join('\n'));

  const ws = createCaptureWs();
  const session = {
    id: 'session-pc-claude-repair',
    storageId: 'sid_pc_claude_repair',
    workspace,
    runtimeDir,
    linco: {
      messageId: 'm-pc-claude-repair',
      streamId: 'linco-stream-pc-claude-repair',
    },
    agentType: 'claude',
    agentSessionId,
    claudeResumeEntrypointFixPending: true,
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/pc', ws, session, { homeDir, agents: { claude: {} } }), true);
  const firstRecord = JSON.parse(fs.readFileSync(transcript, 'utf8').trim());
  assert.strictEqual(firstRecord.entrypoint, 'cli');
  assert.strictEqual(session.claudeResumeEntrypointFixPending, false);
  assert.strictEqual(session.claudeResumeEntrypointFixedSessionId, agentSessionId);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-pc-codex-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-pc',
    workspace,
    linco: {
      messageId: 'm-codex-pc',
      streamId: 'linco-stream-codex-pc',
    },
    agentType: 'codex',
    agentSessionId: 'codex-session-123',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/pc', ws, session, {}), true);

  assert.strictEqual(ws.sent[0].type, 'system');
  assert(ws.sent[0].text.includes('codex resume --cd'));
  assert(ws.sent[0].text.includes(session.agentSessionId));
  assert(ws.sent[0].text.includes(workspace));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(ws.sent.at(-1).sessionKey, 'session-codex-pc');
}

{
  assert.deepStrictEqual(
    slashCommandInternals.buildPcResumeCommand('claude', '/tmp/project one', 'session-1', 'linux'),
    {
      language: 'text',
      text: "cd '/tmp/project one'; claude --resume 'session-1'",
    },
  );
  assert.deepStrictEqual(
    slashCommandInternals.buildPcResumeCommand('codex', 'D:\\code\\project one', 'session-2', 'win32'),
    {
      language: 'text',
      text: 'codex resume --cd "D:\\code\\project one" "session-2"',
    },
  );
  assert.deepStrictEqual(
    slashCommandInternals.buildPcResumeCommand('claude', 'D:\\code\\project one', 'session-3', 'win32'),
    {
      language: 'text',
      text: 'cd /d "D:\\code\\project one" && claude --resume "session-3"',
    },
  );
  assert.strictEqual(slashCommandInternals.shellQuote('D:\\Bob "The Builder"', 'win32'), '"D:\\Bob ""The Builder"""');
  assert.strictEqual(slashCommandInternals.shellQuote("/tmp/Bob's Project", 'linux'), "'/tmp/Bob'\\''s Project'");
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-'));
  const project = path.join(workspace, 'ddchat-connect');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.mkdirSync(path.join(workspace, '.hidden'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-project-browse',
    workspace,
    runtimeDir: workspace,
    linco: {
      messageId: 'm-project-browse',
      streamId: 'linco-stream-project-browse',
    },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(`/project ${workspace}`, ws, session, {}), true);

  const projectMessage = ws.sent[0];
  assert.strictEqual(projectMessage.type, 'error');
  assert.match(projectMessage.text, /\/project --select/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-select-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-runtime-'));
  const selected = path.join(workspace, 'selected project');
  fs.mkdirSync(selected, { recursive: true });
  const ws = createCaptureWs();
  const session = {
    id: 'session-project-select',
    storageId: 'sid_project_select',
    workspace,
    runtimeDir,
    linco: {
      messageId: 'm-project-select',
      streamId: 'linco-stream-project-select',
    },
    agentType: 'claude',
    agentSessionId: 'old-session',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(`/project --select "${selected}"`, ws, session, {}), true);

  assert.strictEqual(session.workspace, workspace);
  assert.strictEqual(session.agentSessionId, 'old-session');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-select-new-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-runtime-new-'));
  const selected = path.join(workspace, 'selected', 'project');
  fs.mkdirSync(selected, { recursive: true });
  const ws = createCaptureWs();
  const session = {
    id: 'session-project-select-new',
    storageId: 'sid_project_select_new',
    workspace,
    runtimeDir,
    linco: {
      messageId: 'm-project-select-new',
      streamId: 'linco-stream-project-select-new',
    },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(`/project --select "${selected}"`, ws, session, {}), true);

  assert.strictEqual(session.workspace, path.resolve(selected));
  assert.strictEqual(session.agentSessionId, null);
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(ws.sent.at(-1).session_id, undefined);
  assert.strictEqual(ws.sent.at(-1).agentSessionId, undefined);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-select-codex-warm-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-runtime-codex-warm-'));
  const selected = path.join(workspace, 'selected', 'project');
  fs.mkdirSync(selected, { recursive: true });
  const ws = createCaptureWs();
  const killed = [];
  const child = {
    exitCode: null,
    killed: false,
    stdin: {
      destroyed: false,
      end() {
        this.destroyed = true;
      },
    },
    kill(signal) {
      killed.push(signal || 'default');
      this.killed = true;
    },
  };
  const session = {
    id: 'session-project-select-codex-warm',
    storageId: 'sid_project_select_codex_warm',
    workspace,
    runtimeDir,
    linco: {
      messageId: 'm-project-select-codex-warm',
      streamId: 'linco-stream-project-select-codex-warm',
    },
    agentType: 'codex',
    codexAppServer: child,
    agentProcess: child,
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(`/project --select "${selected}"`, ws, session, {}), true);

  assert.strictEqual(session.workspace, path.resolve(selected));
  assert.strictEqual(session.agentSessionId, null);
  assert.strictEqual(session.codexAppServer, null);
  assert.strictEqual(session.agentProcess, null);
  assert.strictEqual(child.stdin.destroyed, true);
  assert.deepStrictEqual(killed, ['default']);
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(ws.sent.at(-1).session_id, undefined);
  assert.strictEqual(ws.sent.at(-1).agentSessionId, undefined);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-claude-home-'));
  const project = path.join(homeDir, 'code', 'known-claude-project');
  const lincoWorkspace = path.join(homeDir, '.linco', 'claude', 'sessions', 'sid_x', 'workspace');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lincoWorkspace, { recursive: true });

  const encoded = slashCommandInternals.encodeClaudeProjectDir(project);
  const projectStore = path.join(homeDir, '.claude', 'projects', encoded);
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'session.jsonl'), [
    JSON.stringify({ cwd: project }),
    JSON.stringify({ cwd: lincoWorkspace }),
  ].join('\n'));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'claude' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => item.path), [project]);
}

{
  const workspace = 'C:\\Users\\lihuanliang\\.linco\\claude\\sessions\\sid_2d7d9539aefbacd273150f809dcbb28a\\workspace';
  const previousResolve = path.resolve;
  path.resolve = path.win32.resolve;
  try {
    assert.strictEqual(
      slashCommandInternals.encodeClaudeProjectDir(workspace),
      'C--Users-lihuanliang--linco-claude-sessions-sid-2d7d9539aefbacd273150f809dcbb28a-workspace',
    );
  } finally {
    path.resolve = previousResolve;
  }
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-list-home-'));
  const project = path.join(homeDir, 'code', 'listed-claude-project');
  fs.mkdirSync(project, { recursive: true });
  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(project));
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'session.jsonl'), JSON.stringify({ cwd: project }) + '\n');

  const originalHome = os.homedir;
  os.homedir = () => homeDir;
  try {
    const ws = createCaptureWs();
    const session = {
      id: 'session-project-list',
      workspace: project,
      linco: { messageId: 'm-project-list', streamId: 'linco-stream-project-list' },
      agentType: 'claude',
      messageQueue: [],
      agentSessionHistory: [],
      autoApprove: true,
    };

    assert.strictEqual(handleSlashCommand('/project', ws, session, {}), true);
    assert.strictEqual(ws.sent[0].type, 'slash_command_result');
    assert.strictEqual(ws.sent[0].command, 'project');
    assert.strictEqual(ws.sent[0].version, 1);
    assert.strictEqual(ws.sent[0].data.items.length, 1);
    assert.deepStrictEqual({
      index: ws.sent[0].data.items[0].index,
      label: ws.sent[0].data.items[0].label,
      path: ws.sent[0].data.items[0].path,
      source: ws.sent[0].data.items[0].source,
      command: ws.sent[0].data.items[0].command,
      sessionsCommand: ws.sent[0].data.items[0].sessionsCommand,
    }, {
      index: 1,
      label: 'listed-claude-project',
      path: project,
      source: 'claude-session',
      command: `/project --select ${project}`,
      sessionsCommand: `/sessions --project ${project}`,
    });
    assert.strictEqual(ws.sent[0].data.items[0].displayPath, project);
    assert.strictEqual(ws.sent[0].data.items[0].basename, path.basename(project));
    assert.strictEqual(ws.sent[0].data.items[0].parentPath, path.dirname(project));
    assert.strictEqual(typeof ws.sent[0].data.items[0].projectId, 'string');
    assert(ws.sent[0].data.items[0].projectId.length > 0);
    assert.strictEqual(ws.sent[0].data.items[0].projectKey, ws.sent[0].data.items[0].projectId);
    assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  } finally {
    os.homedir = originalHome;
  }
}

{
  assert.deepStrictEqual(slashCommandInternals.parseSessionsArgs(''), { ok: true, limit: 5 });
  assert.deepStrictEqual(slashCommandInternals.parseSessionsArgs('10'), { ok: true, limit: 10 });
  assert.deepStrictEqual(
    slashCommandInternals.parseSessionsArgs('--project /code/app --project-id codex-project-app 10'),
    {
      ok: true,
      limit: 10,
      projectPath: '/code/app',
      projectId: 'codex-project-app',
    },
  );
  assert.strictEqual(slashCommandInternals.parseSessionsArgs('--limit 10').ok, false);
  assert.strictEqual(slashCommandInternals.parseSessionsArgs('51').ok, false);
  assert.deepStrictEqual(slashCommandInternals.parseAgentArgs('--bind qa'), { mode: 'bind', agentId: 'qa' });
  assert.deepStrictEqual(slashCommandInternals.parseProfileArgs('--bind work'), { mode: 'bind', profile: 'work' });
  assert.strictEqual(slashCommandInternals.parseAgentArgs('--bind qa --account remote-account').error, 'Account is inferred from the incoming IM message; do not pass --account.');
  assert.strictEqual(slashCommandInternals.parseProfileArgs('--bind work --account remote-account').error, 'Account is inferred from the incoming IM message; do not pass --account.');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-claude-sessions-home-'));
  const project = path.join(homeDir, 'code', 'claude-session-project');
  fs.mkdirSync(project, { recursive: true });
  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(project));
  fs.mkdirSync(projectStore, { recursive: true });

  const oldFile = path.join(projectStore, 'old-session.jsonl');
  const latestFile = path.join(projectStore, 'latest-session.jsonl');
  fs.writeFileSync(oldFile, [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'older claude question' },
      cwd: project,
      sessionId: 'old-session',
    }),
  ].join('\n'));
  fs.writeFileSync(latestFile, [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'latest claude question' },
      cwd: project,
      sessionId: 'latest-session',
    }),
  ].join('\n'));
  const oldTime = new Date('2026-06-01T00:00:00Z');
  const latestTime = new Date('2026-06-02T00:00:00Z');
  fs.utimesSync(oldFile, oldTime, oldTime);
  fs.utimesSync(latestFile, latestTime, latestTime);

  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-local-sessions',
    workspace: project,
    linco: { messageId: 'm-claude-local-sessions', streamId: 'linco-stream-claude-local-sessions' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/sessions 1', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'sessions');
  assert.strictEqual(ws.sent[0].data.agentType, 'claude');
  assert.strictEqual(ws.sent[0].data.requestedLimit, 1);
  assert.strictEqual(ws.sent[0].data.items[0].id, 'latest-session');
  assert.strictEqual(ws.sent[0].data.items[0].bindCommand, '/bind latest-session');
  assert.match(ws.sent[0].data.items[0].resumeCommand.text, /claude --resume/);
  assert.strictEqual(ws.sent[0].data.items.length, 1);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');

  const bindRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-bind-runtime-'));
  const bindWs = createCaptureWs();
  const bindSession = {
    id: 'session-claude-bind',
    storageId: 'sid_claude_bind',
    workspace: project,
    runtimeDir: bindRuntimeDir,
    linco: { messageId: 'm-claude-bind', streamId: 'linco-stream-claude-bind' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand('/bind latest-session', bindWs, bindSession, { homeDir }), true);
  assert.strictEqual(bindSession.agentSessionId, 'latest-session');
  assert.strictEqual(bindSession.agentSessionHistory.length, 1);
  assert.strictEqual(bindSession.agentSessionHistory[0].isActive, true);
  assert.strictEqual(bindWs.sent[0].type, 'system');
  assert.match(bindWs.sent[0].text, /latest-session/);
  assert.strictEqual(bindWs.sent.at(-1).type, 'turn_end');
  const bindMetadata = JSON.parse(fs.readFileSync(path.join(bindRuntimeDir, 'session.json'), 'utf8'));
  assert.strictEqual(bindMetadata.agentSessionId, 'latest-session');

  const lockedWs = createCaptureWs();
  const lockedSession = {
    ...bindSession,
    linco: { messageId: 'm-claude-bind-locked', streamId: 'linco-stream-claude-bind-locked' },
  };
  assert.strictEqual(handleSlashCommand('/bind old-session', lockedWs, lockedSession, { homeDir }), true);
  assert.strictEqual(lockedSession.agentSessionId, 'latest-session');
  assert.strictEqual(lockedWs.sent[0].type, 'error');
  assert.strictEqual(lockedWs.sent.at(-1).type, 'turn_end');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-claude-unicode-path-home-'));
  const project = path.join(homeDir, 'code', '无限进步', '1-个人产出', '1-Coding项目', 'Linco');
  fs.mkdirSync(project, { recursive: true });
  const encoded = slashCommandInternals.encodeClaudeProjectDir(project);
  assert(!encoded.includes('无限进步'));
  assert(!encoded.includes(path.sep));
  assert(/^[A-Za-z0-9._-]+$/.test(encoded));

  const projectStore = path.join(homeDir, '.claude', 'projects', encoded);
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'unicode-session.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-06-11T03:00:00.000Z', message: { role: 'user', content: 'unicode path question' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-11T03:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'unicode path answer' }] } }),
  ].join('\n'));

  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-unicode-path',
    workspace: project,
    linco: { messageId: 'm-claude-unicode-path', streamId: 'linco-stream-claude-unicode-path' },
    agentType: 'claude',
    agentSessionId: 'unicode-session',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/history 1', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'history');
  assert.strictEqual(ws.sent[0].data.agentSessionId, 'unicode-session');
  assert.strictEqual(ws.sent[0].data.rounds[0].user.text, 'unicode path question');
  assert.strictEqual(ws.sent[0].data.rounds[0].assistant.text, 'unicode path answer');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-claude-project-browse-home-'));
  const runtimeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-runtime-workspace-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-bind-runtime-'));
  const project = path.join(homeDir, 'code', 'claude project with spaces');
  fs.mkdirSync(project, { recursive: true });
  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(project));
  fs.mkdirSync(projectStore, { recursive: true });
  const transcript = path.join(projectStore, 'project-session.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-11T01:00:00.000Z',
      message: { role: 'user', content: 'project browse question' },
      cwd: project,
      sessionId: 'project-session',
    }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-11T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'project browse answer' }] } }),
  ].join('\n'));

  const sessionsWs = createCaptureWs();
  const unboundSession = {
    id: 'session-claude-project-browse',
    workspace: runtimeWorkspace,
    linco: { messageId: 'm-project-browse-sessions', streamId: 'linco-stream-project-browse-sessions' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand(`/sessions --project "${project}" 1`, sessionsWs, unboundSession, { homeDir }), true);
  assert.strictEqual(sessionsWs.sent[0].type, 'slash_command_result');
  assert.strictEqual(sessionsWs.sent[0].data.workspace, project);
  assert.strictEqual(sessionsWs.sent[0].data.items[0].id, 'project-session');
  const quotedProject = `"${project.replace(/(["\\])/g, '\\$1')}"`;
  assert.strictEqual(
    sessionsWs.sent[0].data.items[0].bindCommand,
    `/bind --project ${quotedProject} project-session`,
  );
  assert.strictEqual(unboundSession.workspace, runtimeWorkspace);

  const historyWs = createCaptureWs();
  assert.strictEqual(handleSlashCommand(`/history --project "${project}" --session project-session 1`, historyWs, unboundSession, { homeDir }), true);
  assert.strictEqual(historyWs.sent[0].type, 'slash_command_result');
  assert.strictEqual(historyWs.sent[0].command, 'history');
  assert.strictEqual(historyWs.sent[0].data.agentSessionId, 'project-session');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].timestamp, '2026-06-11T01:00:00.000Z');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].timestampMs, Date.parse('2026-06-11T01:00:00.000Z'));
  assert.strictEqual(historyWs.sent[0].data.rounds[0].user.text, 'project browse question');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].user.timestamp, '2026-06-11T01:00:00.000Z');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].assistant.text, 'project browse answer');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].assistant.timestamp, '2026-06-11T01:00:02.000Z');
  assert.strictEqual(unboundSession.agentSessionId, undefined);
  assert.strictEqual(unboundSession.workspace, runtimeWorkspace);

  const bindWs = createCaptureWs();
  const bindSession = {
    id: 'session-claude-project-bind',
    storageId: 'sid_claude_project_bind',
    workspace: runtimeWorkspace,
    runtimeDir,
    linco: { messageId: 'm-project-browse-bind', streamId: 'linco-stream-project-browse-bind' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
    autoApprove: true,
  };

  assert.strictEqual(handleSlashCommand(sessionsWs.sent[0].data.items[0].bindCommand, bindWs, bindSession, { homeDir }), true);
  assert.strictEqual(bindSession.workspace, project);
  assert.strictEqual(bindSession.agentSessionId, 'project-session');
  const bindMetadata = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'session.json'), 'utf8'));
  assert.strictEqual(bindMetadata.workspace, project);
  assert.strictEqual(bindMetadata.agentSessionId, 'project-session');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-sessions-home-'));
  const project = path.join(homeDir, 'code', 'codex-session-project');
  const otherProject = path.join(homeDir, 'code', 'codex-other-project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '06', '08');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.codex', 'session_index.jsonl'), [
    JSON.stringify({ id: 'codex-new', thread_name: 'new codex title', updated_at: '2026-06-08T02:00:00Z' }),
    JSON.stringify({ id: 'codex-old', thread_name: 'old codex title', updated_at: '2026-06-08T01:00:00Z' }),
    JSON.stringify({ id: 'codex-other', thread_name: 'other codex title', updated_at: '2026-06-08T03:00:00Z' }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'new.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-new', cwd: project } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new codex first prompt' }] } }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'old.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-old', cwd: project } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old codex first prompt' }] } }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'other.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-other', cwd: otherProject } }),
  ].join('\n'));

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-local-sessions',
    workspace: project,
    linco: { messageId: 'm-codex-local-sessions', streamId: 'linco-stream-codex-local-sessions' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/sessions', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'sessions');
  assert.strictEqual(ws.sent[0].data.agentType, 'codex');
  assert.strictEqual(ws.sent[0].data.returnedCount, 2);
  assert.deepStrictEqual(ws.sent[0].data.items.map(item => item.id), ['codex-new', 'codex-old']);
  assert.strictEqual(ws.sent[0].data.items[0].bindCommand, '/bind codex-new');
  assert.match(ws.sent[0].data.items[0].resumeCommand.text, /codex resume --cd/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-state-sessions-home-'));
  const project = path.join(homeDir, 'code', 'codex-state-project');
  const otherProject = path.join(homeDir, 'code', 'codex-state-other');
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  const db = new Database(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_threads_archived_cwd_recency_at_ms
      ON threads(archived, cwd, recency_at_ms DESC, id DESC);
  `);
  const insert = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, cwd, title, first_user_message, preview,
      archived, updated_at, updated_at_ms, recency_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('codex-state-old', path.join(codexDir, 'missing-old.jsonl'), project, 'old state title', 'old state prompt', '', 0, 0, 1778040000000, 1778040000000);
  insert.run('codex-state-new', path.join(codexDir, 'missing-new.jsonl'), project, 'new state title', 'new state prompt', '', 0, 0, 1778050000000, 1778050000000);
  insert.run('codex-state-other', path.join(codexDir, 'missing-other.jsonl'), otherProject, 'other state title', 'other state prompt', '', 0, 0, 1778060000000, 1778060000000);
  insert.run('codex-state-archived', path.join(codexDir, 'missing-archived.jsonl'), project, 'archived state title', 'archived state prompt', '', 1, 0, 1778070000000, 1778070000000);
  db.close();

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-state-sessions',
    workspace: project,
    linco: { messageId: 'm-codex-state-sessions', streamId: 'linco-stream-codex-state-sessions' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/sessions 1', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'sessions');
  assert.strictEqual(ws.sent[0].data.returnedCount, 1);
  assert.strictEqual(ws.sent[0].data.items[0].id, 'codex-state-new');
  assert.strictEqual(ws.sent[0].data.items[0].title, 'new state title');
  assert.strictEqual(ws.sent[0].data.items[0].firstMessage, 'new state prompt');
  assert.strictEqual(ws.sent[0].data.items[0].transcriptPath, path.join(codexDir, 'missing-new.jsonl'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

if (directorySymlinkSupported) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-state-realpath-home-'));
  const realProject = path.join(homeDir, 'real', 'codex-state-project');
  const linkProject = path.join(homeDir, 'link', 'codex-state-project');
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(realProject, { recursive: true });
  fs.mkdirSync(path.dirname(linkProject), { recursive: true });
  fs.symlinkSync(realProject, linkProject, 'dir');
  fs.mkdirSync(codexDir, { recursive: true });
  const realProjectCwd = fs.realpathSync.native(realProject);

  const db = new Database(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_threads_archived_cwd_recency_at_ms
      ON threads(archived, cwd, recency_at_ms DESC, id DESC);
  `);
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, cwd, title, first_user_message, preview,
      archived, updated_at, updated_at_ms, recency_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'codex-state-realpath',
    path.join(codexDir, 'realpath.jsonl'),
    realProjectCwd,
    'realpath state title',
    'realpath state prompt',
    '',
    0,
    0,
    1778050000000,
    1778050000000,
  );
  db.close();

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-state-realpath',
    workspace: linkProject,
    linco: { messageId: 'm-codex-state-realpath', streamId: 'linco-stream-codex-state-realpath' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/sessions 1', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'sessions');
  assert.strictEqual(ws.sent[0].data.returnedCount, 1);
  assert.strictEqual(ws.sent[0].data.items[0].id, 'codex-state-realpath');
  assert.strictEqual(ws.sent[0].data.items[0].title, 'realpath state title');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

if (directorySymlinkSupported) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-state-alias-split-home-'));
  const realProject = path.join(homeDir, 'real', 'aichat');
  const linkProject = path.join(homeDir, 'link', 'aichat');
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(realProject, { recursive: true });
  fs.mkdirSync(path.dirname(linkProject), { recursive: true });
  fs.symlinkSync(realProject, linkProject, 'dir');
  fs.mkdirSync(codexDir, { recursive: true });
  const realProjectCwd = fs.realpathSync.native(realProject);

  const db = new Database(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_threads_archived_cwd_recency_at_ms
      ON threads(archived, cwd, recency_at_ms DESC, id DESC);
  `);
  const insert = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, cwd, title, first_user_message, preview,
      archived, updated_at, updated_at_ms, recency_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'codex-state-real-aichat',
    path.join(codexDir, 'real-aichat.jsonl'),
    realProjectCwd,
    'real aichat title',
    'real aichat prompt',
    '',
    0,
    0,
    1778050000000,
    1778050000000,
  );
  insert.run(
    'codex-state-link-aichat',
    path.join(codexDir, 'link-aichat.jsonl'),
    linkProject,
    'link aichat title',
    'link aichat prompt',
    '',
    0,
    0,
    1778060000000,
    1778060000000,
  );
  db.close();

  const linkSessions = slashCommandInternals.collectCodexProjectSessions(homeDir, linkProject, { limit: 10 });
  assert.deepStrictEqual(
    linkSessions.map(item => item.id),
    ['codex-state-link-aichat', 'codex-state-real-aichat'],
  );

  const realSessions = slashCommandInternals.collectCodexProjectSessions(homeDir, realProjectCwd, { limit: 10 });
  assert.deepStrictEqual(realSessions.map(item => item.id), ['codex-state-real-aichat']);
}

if (directorySymlinkSupported) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-realpath-cache-home-'));
  const realProject = path.join(homeDir, 'real', 'codex-jsonl-project');
  const linkProject = path.join(homeDir, 'link', 'codex-jsonl-project');
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '06');
  fs.mkdirSync(realProject, { recursive: true });
  fs.mkdirSync(path.dirname(linkProject), { recursive: true });
  fs.symlinkSync(realProject, linkProject, 'dir');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const realProjectCwd = fs.realpathSync.native(realProject);

  for (let i = 0; i < 3; i++) {
    const id = `codex-jsonl-realpath-${i}`;
    fs.writeFileSync(path.join(sessionsDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: realProjectCwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `realpath prompt ${i}` } }),
    ].join('\n'));
  }

  const originalRealpathNative = fs.realpathSync.native;
  let realpathCalls = 0;
  fs.realpathSync.native = function countedRealpath(...args) {
    realpathCalls += 1;
    return originalRealpathNative.apply(this, args);
  };

  try {
    const sessions = slashCommandInternals.collectCodexProjectSessions(homeDir, linkProject, { scanLimit: 10 });
    assert.strictEqual(sessions.length, 3);
    assert(realpathCalls <= 2, `expected cached realpath calls, got ${realpathCalls}`);
  } finally {
    fs.realpathSync.native = originalRealpathNative;
  }
}

if (directorySymlinkSupported) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-jsonl-alias-split-home-'));
  const realProject = path.join(homeDir, 'real', 'aichat');
  const linkProject = path.join(homeDir, 'link', 'aichat');
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '06');
  fs.mkdirSync(realProject, { recursive: true });
  fs.mkdirSync(path.dirname(linkProject), { recursive: true });
  fs.symlinkSync(realProject, linkProject, 'dir');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const realProjectCwd = fs.realpathSync.native(realProject);

  fs.writeFileSync(path.join(sessionsDir, 'real-aichat.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-jsonl-real-aichat', cwd: realProjectCwd } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'real jsonl prompt' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'link-aichat.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-jsonl-link-aichat', cwd: linkProject } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'link jsonl prompt' } }),
  ].join('\n'));

  const linkSessions = slashCommandInternals.collectCodexProjectSessions(homeDir, linkProject, { scanLimit: 10 });
  assert.deepStrictEqual(
    linkSessions.map(item => item.id),
    ['codex-jsonl-link-aichat', 'codex-jsonl-real-aichat'],
  );

  const realSessions = slashCommandInternals.collectCodexProjectSessions(homeDir, realProjectCwd, { scanLimit: 10 });
  assert.deepStrictEqual(realSessions.map(item => item.id), ['codex-jsonl-real-aichat']);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-jsonl-limit-home-'));
  const project = path.join(homeDir, 'code', 'codex-jsonl-limit-project');
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '06');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    const id = `codex-jsonl-limit-${i}`;
    fs.writeFileSync(path.join(sessionsDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: project } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `limit prompt ${i}` } }),
    ].join('\n'));
  }

  const originalOpenSync = fs.openSync;
  let transcriptOpenCalls = 0;
  fs.openSync = function countedOpen(filePath, ...args) {
    const text = String(filePath);
    if (text.startsWith(sessionsDir) && path.basename(text).startsWith('codex-jsonl-limit-')) {
      transcriptOpenCalls += 1;
    }
    return originalOpenSync.call(this, filePath, ...args);
  };

  try {
    const sessions = slashCommandInternals.collectCodexProjectSessions(homeDir, project, { limit: 2, scanLimit: 10 });
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(transcriptOpenCalls, 2);
  } finally {
    fs.openSync = originalOpenSync;
  }
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-sessions-default-home-'));
  const project = path.join(homeDir, 'code', 'empty-project');
  fs.mkdirSync(project, { recursive: true });

  const ws = createCaptureWs();
  const session = {
    id: 'session-default-home-sessions',
    workspace: project,
    linco: { messageId: 'm-default-home-sessions', streamId: 'linco-stream-default-home-sessions' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/sessions', ws, session, {}), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'sessions');
  assert.strictEqual(ws.sent[0].data.returnedCount, 0);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-session-summary-home-'));
  const project = path.join(homeDir, 'code', 'codex-session-project');
  fs.mkdirSync(project, { recursive: true });
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '06', '08');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.codex', 'session_index.jsonl'), JSON.stringify({
    id: 'codex-context',
    thread_name: `<environment_context>\n  <cwd>${project}</cwd>\n</environment_context>`,
    updated_at: '2026-06-08T02:00:00Z',
  }));
  fs.writeFileSync(path.join(sessionsDir, 'with-context.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-context', cwd: project } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${project}</cwd>\n</environment_context>` }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'real codex prompt' } }),
  ].join('\n'));

  const sessions = slashCommandInternals.collectCodexProjectSessions(homeDir, project);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, 'codex-context');
  assert.strictEqual(sessions[0].firstMessage, 'real codex prompt');
  assert.strictEqual(sessions[0].title, 'real codex prompt');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-fast-history-home-'));
  const project = path.join(homeDir, 'code', 'codex-fast-history-project');
  const otherProject = path.join(homeDir, 'code', 'codex-fast-history-other');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  const codexDir = path.join(homeDir, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions', '2026', '06', '11');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), JSON.stringify({
    id: '019f-fast-history',
    thread_name: 'fast history title',
    updated_at: '2026-06-11T04:00:00Z',
  }));
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(sessionsDir, `noise-${i}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: `noise-${i}`, cwd: otherProject } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `noise ${i}` } }),
    ].join('\n'));
  }
  fs.writeFileSync(path.join(sessionsDir, 'rollout-2026-06-11T12-00-00-019f-fast-history.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: '019f-fast-history', cwd: project } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T04:00:00.000Z', payload: { type: 'user_message', message: 'fast history question' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T04:00:01.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'fast history answer' } }),
  ].join('\n'));

  const matched = slashCommandInternals.findCodexProjectSessionById(homeDir, project, '019f-fast-history');
  assert.strictEqual(matched.id, '019f-fast-history');
  assert.strictEqual(matched.title, 'fast history title');
  assert.match(matched.transcriptPath, /019f-fast-history\.jsonl$/);

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-fast-history',
    workspace: otherProject,
    linco: { messageId: 'm-codex-fast-history', streamId: 'linco-stream-codex-fast-history' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  assert.strictEqual(handleSlashCommand(`/history --project "${project}" --session 019f-fast-history 1`, ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].data.agentSessionId, '019f-fast-history');
  assert.strictEqual(ws.sent[0].data.rounds[0].user.text, 'fast history question');
  assert.strictEqual(ws.sent[0].data.rounds[0].assistant.text, 'fast history answer');
  assert.strictEqual(session.workspace, otherProject);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-chats-home-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-chats-runtime-'));
  const newWorkspace = path.join(homeDir, 'Documents', 'Codex', 'new-chat');
  const oldWorkspace = path.join(homeDir, 'Documents', 'Codex', 'old-chat');
  fs.mkdirSync(newWorkspace, { recursive: true });
  fs.mkdirSync(oldWorkspace, { recursive: true });
  const codexDir = path.join(homeDir, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions', '2026', '06', '11');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, '.codex-global-state.json'), JSON.stringify({
    'projectless-thread-ids': ['chat-new', 'chat-old'],
  }));
  fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), [
    JSON.stringify({ id: 'chat-new', thread_name: 'new chat title', updated_at: '2026-06-11T03:00:00Z' }),
    JSON.stringify({ id: 'chat-old', thread_name: 'old chat title', updated_at: '2026-06-11T02:00:00Z' }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'new-chat.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'chat-new', cwd: newWorkspace } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new chat first prompt' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new chat question' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'new chat answer' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionsDir, 'old-chat.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'chat-old', cwd: oldWorkspace } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old chat first prompt' }] } }),
  ].join('\n'));

  const listWs = createCaptureWs();
  const session = {
    id: 'session-codex-chats',
    storageId: 'sid_codex_chats',
    workspace: homeDir,
    runtimeDir,
    linco: { messageId: 'm-codex-chats', streamId: 'linco-stream-codex-chats' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/chats', listWs, session, { homeDir }), true);
  assert.strictEqual(listWs.sent[0].type, 'slash_command_result');
  assert.strictEqual(listWs.sent[0].command, 'chats');
  assert.strictEqual(listWs.sent[0].data.agentType, 'codex');
  assert.deepStrictEqual(listWs.sent[0].data.items.map(item => item.id), ['chat-new', 'chat-old']);
  assert.strictEqual(listWs.sent[0].data.items[0].historyCommand, '/history --chat chat-new');
  assert.strictEqual(listWs.sent[0].data.items[0].bindCommand, '/bind --chat chat-new');
  assert.strictEqual(listWs.sent[0].data.items[0].workspace, newWorkspace);

  const historyWs = createCaptureWs();
  assert.strictEqual(handleSlashCommand('/history --chat chat-new', historyWs, session, { homeDir }), true);
  assert.strictEqual(historyWs.sent[0].type, 'slash_command_result');
  assert.strictEqual(historyWs.sent[0].command, 'history');
  assert.strictEqual(historyWs.sent[0].data.agentSessionId, 'chat-new');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].user.text, 'new chat question');
  assert.strictEqual(historyWs.sent[0].data.rounds[0].assistant.text, 'new chat answer');

  const historyEqualsWs = createCaptureWs();
  assert.strictEqual(handleSlashCommand('/history --chat=chat-new 1', historyEqualsWs, session, { homeDir }), true);
  assert.strictEqual(historyEqualsWs.sent[0].data.agentSessionId, 'chat-new');
  assert.strictEqual(historyEqualsWs.sent[0].data.returnedRounds, 1);

  const bindWs = createCaptureWs();
  assert.strictEqual(handleSlashCommand('/bind --chat=chat-new', bindWs, session, { homeDir }), true);
  assert.strictEqual(session.workspace, newWorkspace);
  assert.strictEqual(session.agentSessionId, 'chat-new');
  const metadata = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'session.json'), 'utf8'));
  assert.strictEqual(metadata.workspace, newWorkspace);
  assert.strictEqual(metadata.agentSessionId, 'chat-new');

  const chats = slashCommandInternals.collectCodexProjectlessChats(homeDir, { limit: 1 });
  assert.deepStrictEqual(chats.map(chat => chat.id), ['chat-new']);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-nested-chats-home-'));
  const workspace = path.join(homeDir, 'Documents', 'Codex', 'nested-chat');
  fs.mkdirSync(workspace, { recursive: true });
  const codexDir = path.join(homeDir, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions', '2026', '06', '11');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': {
      'projectless-thread-ids': ['chat-nested'],
    },
  }));
  fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), JSON.stringify({
    id: 'chat-nested',
    thread_name: 'nested chat title',
    updated_at: '2026-06-11T04:00:00Z',
  }));
  fs.writeFileSync(path.join(sessionsDir, 'nested-chat.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'chat-nested', cwd: workspace } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'nested question' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'nested answer' } }),
  ].join('\n'));

  const chats = slashCommandInternals.collectCodexProjectlessChats(homeDir);
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].id, 'chat-nested');
  assert.strictEqual(chats[0].workspace, workspace);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-claude-history-home-'));
  const project = path.join(homeDir, 'code', 'claude-history-project');
  const sessionId = 'claude-history-session';
  fs.mkdirSync(project, { recursive: true });
  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(project));
  fs.mkdirSync(projectStore, { recursive: true });
  const transcript = path.join(projectStore, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first real prompt' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden thinking' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'hidden tool result' }] }, toolUseResult: true, sourceToolAssistantUUID: 'tool-1' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate visible text that should be replaced' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'second hidden tool result' }] }, toolUseResult: true, sourceToolAssistantUUID: 'tool-2' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first final answer' }] } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'first real prompt' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'second real prompt' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second final answer' }] } }),
  ].join('\n'));

  const ws = createCaptureWs();
  const session = {
    id: 'session-claude-history',
    workspace: project,
    linco: { messageId: 'm-claude-history', streamId: 'linco-stream-claude-history' },
    agentType: 'claude',
    agentSessionId: sessionId,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/history', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'history');
  assert.strictEqual(ws.sent[0].data.agentType, 'claude');
  assert.strictEqual(ws.sent[0].data.agentSessionId, sessionId);
  assert.strictEqual(ws.sent[0].data.returnedRounds, 2);
  assert.deepStrictEqual(ws.sent[0].data.rounds.map(round => ({
    user: round.user.text,
    assistant: round.assistant.text,
    missing: round.assistant.missing,
  })), [
    { user: 'first real prompt', assistant: 'first final answer', missing: false },
    { user: 'second real prompt', assistant: 'second final answer', missing: false },
  ]);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-history-home-'));
  const project = path.join(homeDir, 'code', 'codex-history-project');
  const sessionId = 'codex-history-session';
  fs.mkdirSync(project, { recursive: true });
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '06', '11');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const transcript = path.join(sessionsDir, 'history.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: project } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden developer context' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first codex prompt' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:00:00.000Z', payload: { type: 'user_message', message: 'first codex prompt' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'hidden commentary' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'hidden response commentary' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:00:03.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'first codex final answer' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'duplicate final answer' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second codex prompt' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:01:00.000Z', payload: { type: 'user_message', message: 'second codex prompt' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:01:04.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: [
      'second codex final answer',
      '::git-stage{cwd="/tmp/project"}',
      '::git-commit{cwd="/tmp/project"}',
      '::git-push{cwd="/tmp/project" branch="dev-2.0"}',
    ].join('\n') } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:02:00.000Z', payload: { type: 'user_message', message: [
      '# Files mentioned by the user:',
      '',
      '## codex-clipboard-7cf6a33a-8263-443e-99aa-17c71df0c0c1.png: /var/folders/cf/14d_8nt10fd1slj8l8dc51gc0000gp/T/codex-clipboard-7cf6a33a-8263-443e-99aa-17c71df0c0c1.png',
      '',
      '## codex-clipboard-c504392c-1e1d-4ed0-ade9-7ecf49a16c13.png: /var/folders/cf/14d_8nt10fd1slj8l8dc51gc0000gp/T/codex-clipboard-c504392c-1e1d-4ed0-ade9-7ecf49a16c13.png',
      '',
      '## My request for Codex:',
      '底部按钮长度/高度目前有多少种规格？',
    ].join('\n') } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:02:06.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'third codex final answer' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:03:00.000Z', payload: { type: 'user_message', message: [
      '生成一张小鹿图片',
      '',
      '系统提示：用户正在要求发送或获取文件/图片。请将最终文件保存到当前工作目录或会话运行目录，并且必须在回复中用 Markdown 文件引用返回，链接目标必须是原始本机绝对路径，例如 [report.md](D:\\path\\report.md)。不要只返回裸文件路径，不要使用相对路径作为链接目标，也不要使用 file://、file:/// 或其他 URL 形式；用户点击引用后会自动触发 /get <路径> 下发文件。',
      `当前工作目录: ${project}`,
      `会话运行目录: ${path.join(homeDir, '.linco', 'codex', 'sessions', 'sid_test')}`,
      `附件目录: ${path.join(homeDir, '.linco', 'codex', 'sessions', 'sid_test', 'attachments')}`,
    ].join('\n') } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-11T02:03:08.000Z', payload: { type: 'agent_message', phase: 'final_answer', message: 'fourth codex final answer' } }),
  ].join('\n'));

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-history',
    workspace: project,
    linco: { messageId: 'm-codex-history', streamId: 'linco-stream-codex-history' },
    agentType: 'codex',
    agentSessionId: sessionId,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/history', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'history');
  assert.strictEqual(ws.sent[0].data.agentType, 'codex');
  assert.strictEqual(ws.sent[0].data.agentSessionId, sessionId);
  assert.strictEqual(ws.sent[0].data.returnedRounds, 3);
  assert.deepStrictEqual(ws.sent[0].data.rounds.map(round => ({
    user: round.user.text,
    userTimestamp: round.user.timestamp,
    assistant: round.assistant.text,
    assistantTimestamp: round.assistant.timestamp,
    missing: round.assistant.missing,
  })), [
    {
      user: 'second codex prompt',
      userTimestamp: '2026-06-11T02:01:00.000Z',
      assistant: 'second codex final answer',
      assistantTimestamp: '2026-06-11T02:01:04.000Z',
      missing: false,
    },
    {
      user: '底部按钮长度/高度目前有多少种规格？',
      userTimestamp: '2026-06-11T02:02:00.000Z',
      assistant: 'third codex final answer',
      assistantTimestamp: '2026-06-11T02:02:06.000Z',
      missing: false,
    },
    {
      user: '生成一张小鹿图片',
      userTimestamp: '2026-06-11T02:03:00.000Z',
      assistant: 'fourth codex final answer',
      assistantTimestamp: '2026-06-11T02:03:08.000Z',
      missing: false,
    },
  ]);
  assert.strictEqual(ws.sent[0].data.rounds[0].timestamp, '2026-06-11T02:01:00.000Z');
  assert.strictEqual(ws.sent[0].data.rounds[0].timestampMs, Date.parse('2026-06-11T02:01:00.000Z'));
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

test('history-reload waits for reload warmup before returning history', async () => {
  const slashPath = require.resolve('../../src/command');
  const agentRunnerPath = require.resolve('../../src/runtime/agentRunner');
  const originalAgentRunner = require.cache[agentRunnerPath];
  const originalSlash = require.cache[slashPath];
  let stopped = false;
  let warmed = 0;
  const warmupResolvers = [];
  const warmupSnapshots = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));

  require.cache[agentRunnerPath] = {
    id: agentRunnerPath,
    filename: agentRunnerPath,
    loaded: true,
    exports: {
      compactAgentContext() { return false; },
      resolvePendingDanger() { return false; },
      resolvePendingPermission() { return false; },
      stopAgentProcess() { stopped = true; },
      warmupAgentProcess(_ws, warmupSession) {
        warmed += 1;
        warmupSnapshots.push({
          workspace: warmupSession.workspace,
          agentSessionId: warmupSession.agentSessionId,
        });
        return new Promise(resolve => warmupResolvers.push(resolve));
      },
    },
  };
  delete require.cache[slashPath];
  const { handleSlashCommand: handleSlashCommandWithMock } = require('../../src/command');

  try {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-reload-home-'));
    const project = path.join(homeDir, 'code', 'history-reload-project');
    const sessionId = 'history-reload-session';
    fs.mkdirSync(project, { recursive: true });
    const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(project));
    fs.mkdirSync(projectStore, { recursive: true });
    fs.writeFileSync(path.join(projectStore, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'sync prompt' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sync answer' }] } }),
    ].join('\n'));

    const ws = createCaptureWs();
    const session = {
      id: 'session-history-reload',
      workspace: project,
      linco: { messageId: 'm-history-reload', streamId: 'linco-stream-history-reload' },
      agentType: 'claude',
      agentSessionId: sessionId,
      messageQueue: [],
      agentSessionHistory: [],
    };

    assert.strictEqual(handleSlashCommandWithMock('/history-reload 1', ws, session, { homeDir }), true);
    assert.strictEqual(stopped, true);
    assert.strictEqual(warmed, 1);
    assert.deepStrictEqual(ws.sent.map(item => item.type), ['system']);
    warmupResolvers.shift()({ supported: false });
    await flush();
    assert.deepStrictEqual(ws.sent.map(item => item.type), ['system', 'system', 'slash_command_result', 'turn_end']);
    assert.strictEqual(ws.sent[2].command, 'history');
    assert.strictEqual(ws.sent[2].data.returnedRounds, 1);
    assert.strictEqual(ws.sent.at(-1).type, 'turn_end');

    const explicitProject = path.join(homeDir, 'code', 'history-reload-explicit-project');
    const explicitRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-reload-explicit-runtime-'));
    const explicitRuntimeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-reload-explicit-workspace-'));
    const explicitSessionId = 'history-reload-explicit-session';
    fs.mkdirSync(explicitProject, { recursive: true });
    const explicitProjectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(explicitProject));
    fs.mkdirSync(explicitProjectStore, { recursive: true });
    fs.writeFileSync(path.join(explicitProjectStore, `${explicitSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'explicit sync prompt' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'explicit sync answer' }] } }),
    ].join('\n'));

    const explicitWs = createCaptureWs();
    const explicitSession = {
      id: 'session-history-reload-explicit',
      storageId: 'sid_history_reload_explicit',
      runtimeDir: explicitRuntimeDir,
      workspace: explicitRuntimeWorkspace,
      linco: { messageId: 'm-history-reload-explicit', streamId: 'linco-stream-history-reload-explicit' },
      agentType: 'claude',
      messageQueue: [],
      agentSessionHistory: [],
    };

    assert.strictEqual(
      handleSlashCommandWithMock(`/history-reload --project "${explicitProject}" --session ${explicitSessionId} 1`, explicitWs, explicitSession, { homeDir }),
      true,
    );
    assert.deepStrictEqual(warmupSnapshots.at(-1), {
      workspace: explicitProject,
      agentSessionId: explicitSessionId,
    });
    assert.strictEqual(explicitWs.sent.some(item => item.type === 'slash_command_result'), false);
    warmupResolvers.shift()({ supported: false });
    await flush();
    const explicitResult = explicitWs.sent.find(item => item.type === 'slash_command_result');
    assert.strictEqual(explicitResult.data.agentSessionId, explicitSessionId);
    assert.strictEqual(explicitSession.workspace, explicitProject);
    assert.strictEqual(explicitSession.agentSessionId, explicitSessionId);
    const explicitMetadata = JSON.parse(fs.readFileSync(path.join(explicitRuntimeDir, 'session.json'), 'utf8'));
    assert.strictEqual(explicitMetadata.workspace, explicitProject);
    assert.strictEqual(explicitMetadata.agentSessionId, explicitSessionId);

    const switchWs = createCaptureWs();
    const switchRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-history-reload-switch-runtime-'));
    const switchSession = {
      id: 'session-history-reload-switch',
      storageId: 'sid_history_reload_switch',
      runtimeDir: switchRuntimeDir,
      workspace: explicitRuntimeWorkspace,
      linco: { messageId: 'm-history-reload-switch', streamId: 'linco-stream-history-reload-switch' },
      agentType: 'claude',
      agentSessionId: 'already-bound-session',
      messageQueue: [],
      agentSessionHistory: [],
    };

    assert.strictEqual(
      handleSlashCommandWithMock(`/history-reload --project "${explicitProject}" --session ${explicitSessionId} 1`, switchWs, switchSession, { homeDir }),
      true,
    );
    assert.deepStrictEqual(warmupSnapshots.at(-1), {
      workspace: explicitProject,
      agentSessionId: explicitSessionId,
    });
    assert.strictEqual(switchWs.sent.some(item => item.type === 'slash_command_result'), false);
    warmupResolvers.shift()({ supported: false });
    await flush();
    const switchResult = switchWs.sent.find(item => item.type === 'slash_command_result');
    assert.strictEqual(switchResult.command, 'history');
    assert.strictEqual(switchResult.data.agentSessionId, explicitSessionId);
    assert.strictEqual(switchResult.data.replaceConversation, true);
    assert.strictEqual(switchResult.data.switchedSession, true);
    assert.strictEqual(switchSession.workspace, explicitProject);
    assert.strictEqual(switchSession.agentSessionId, explicitSessionId);
    const switchMetadata = JSON.parse(fs.readFileSync(path.join(switchRuntimeDir, 'session.json'), 'utf8'));
    assert.strictEqual(switchMetadata.workspace, explicitProject);
    assert.strictEqual(switchMetadata.agentSessionId, explicitSessionId);
    assert.ok(!switchWs.sent.some(item => item.type === 'error' && /already bound/.test(item.text || '')));
  } finally {
    if (originalAgentRunner) require.cache[agentRunnerPath] = originalAgentRunner;
    else delete require.cache[agentRunnerPath];
    if (originalSlash) require.cache[slashPath] = originalSlash;
    else delete require.cache[slashPath];
  }
});

test('history-reload silently ends when the current turn is active', () => {
  const ws = createCaptureWs();
  const session = {
    id: 'session-history-reload-busy',
    workspace: process.cwd(),
    linco: { messageId: 'm-history-reload-busy', streamId: 'linco-stream-history-reload-busy' },
    agentType: 'claude',
    agentSessionId: 'busy-session',
    isTurnActive: true,
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/history-reload', ws, session, {}), true);
  assert.deepStrictEqual(ws.sent.map(item => item.type), ['turn_end']);
  assert.ok(!ws.sent.some(item => item.type === 'slash_command_result' && item.command === 'history'));
});

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-claude-stop-home-'));
  const latestProject = path.join(homeDir, 'code', 'latest-claude-project');
  const oldProject = path.join(homeDir, 'code', 'old-claude-project');
  fs.mkdirSync(latestProject, { recursive: true });
  fs.mkdirSync(oldProject, { recursive: true });

  const projectStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(latestProject));
  fs.mkdirSync(projectStore, { recursive: true });
  const oldFile = path.join(projectStore, 'old.jsonl');
  const latestFile = path.join(projectStore, 'latest.jsonl');
  fs.writeFileSync(oldFile, JSON.stringify({ cwd: oldProject }) + '\n');
  fs.writeFileSync(latestFile, JSON.stringify({ cwd: latestProject }) + '\n');
  const now = new Date();
  fs.utimesSync(oldFile, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));
  fs.utimesSync(latestFile, now, now);

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'claude' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => item.path), [latestProject]);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-claude-mac-home-'));
  const project = path.join(homeDir, 'code', 'mac-encoded-claude-project');
  fs.mkdirSync(project, { recursive: true });

  const projectStore = path.join(homeDir, '.claude', 'projects', '-Users-haohaohuan-Desktop----AI-IM');
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'session.jsonl'), [
    JSON.stringify({ type: 'system', cwd: project }),
  ].join('\n'));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'claude' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => item.path), [project]);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-claude-dir-only-home-'));
  const projectStore = path.join(homeDir, '.claude', 'projects', '-Users-haohaohuan-Desktop----AI-IM');
  fs.mkdirSync(projectStore, { recursive: true });
  fs.writeFileSync(path.join(projectStore, 'session.jsonl'), [
    JSON.stringify({ type: 'system', message: 'no cwd here' }),
  ].join('\n'));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'claude' }, { homeDir });
  assert.deepStrictEqual(candidates, []);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-claude-cwdless-home-'));
  const chatDir = path.join(homeDir, 'AppData', 'Local', 'Temp', 'claude-cwdless-chat-6ae172bbc8e14e34b79a6b0be24a3340');
  const writeDir = path.join(homeDir, 'AppData', 'Local', 'Temp', 'claude-cwdless-write-a7e9f9f56c394c33983b0b6b077cbdea');
  const macDir = path.join(homeDir, 'Library', 'Caches', 'TemporaryItems', 'claude-cwdless-chat-11112222333344445555666677778888');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(writeDir, { recursive: true });
  fs.mkdirSync(macDir, { recursive: true });

  const chatStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(chatDir));
  const writeStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(writeDir));
  const macStore = path.join(homeDir, '.claude', 'projects', slashCommandInternals.encodeClaudeProjectDir(macDir));
  fs.mkdirSync(chatStore, { recursive: true });
  fs.mkdirSync(writeStore, { recursive: true });
  fs.mkdirSync(macStore, { recursive: true });
  fs.writeFileSync(path.join(chatStore, 'session.jsonl'), JSON.stringify({ cwd: chatDir }) + '\n');
  fs.writeFileSync(path.join(writeStore, 'session.jsonl'), JSON.stringify({ cwd: writeDir }) + '\n');
  fs.writeFileSync(path.join(macStore, 'session.jsonl'), JSON.stringify({ cwd: macDir }) + '\n');

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'claude' }, { homeDir });
  assert.deepStrictEqual(candidates, []);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-home-'));
  const project = path.join(homeDir, 'code', 'known-codex-project');
  const activeProject = path.join(homeDir, 'code', 'active-codex-project');
  const sessionOnlyProject = path.join(homeDir, 'code', 'session-only-codex-project');
  const lincoWorkspace = path.join(homeDir, '.linco', 'codex', 'sessions', 'sid_x', 'workspace');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(activeProject, { recursive: true });
  fs.mkdirSync(sessionOnlyProject, { recursive: true });
  fs.mkdirSync(lincoWorkspace, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'sessions', '2026', '06', '02'), { recursive: true });

  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': {
      'project-order': [project],
      'active-workspace-roots': [activeProject],
      'electron-saved-workspace-roots': [lincoWorkspace],
      'electron-workspace-root-labels': {
        [project]: 'Renamed Codex Project',
      },
    },
  }));
  fs.writeFileSync(path.join(homeDir, '.codex', 'sessions', '2026', '06', '02', 'rollout.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: sessionOnlyProject } }),
  ].join('\n'));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => item.path), [project, activeProject]);
  assert.deepStrictEqual(candidates.map(item => item.label), ['Renamed Codex Project', path.basename(activeProject)]);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-same-name-home-'));
  const projectA = path.join(homeDir, 'repo-a', 'aichat');
  const projectB = path.join(homeDir, 'repo-b', 'aichat');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });

  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': {
      'project-order': [projectA, projectB],
      'electron-workspace-root-labels': {
        [projectA]: 'aichat',
        [projectB]: 'aichat',
      },
    },
  }));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => ({ path: item.path, label: item.label })), [
    { path: projectA, label: 'aichat' },
    { path: projectB, label: 'aichat' },
  ]);
  assert.strictEqual(new Set(candidates.map(item => item.projectId)).size, 2);

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-project-same-name',
    workspace: homeDir,
    linco: { messageId: 'm-codex-project-same-name', streamId: 'linco-stream-codex-project-same-name' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  assert.strictEqual(handleSlashCommand('/project', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.deepStrictEqual(ws.sent[0].data.items.map(item => item.path), [projectA, projectB]);
  assert.deepStrictEqual(ws.sent[0].data.items.map(item => item.label), ['aichat', 'aichat']);
  assert.strictEqual(new Set(ws.sent[0].data.items.map(item => item.projectId)).size, 2);
  assert(ws.sent[0].data.items[0].sessionsCommand.includes(projectA));
  assert(ws.sent[0].data.items[1].sessionsCommand.includes(projectB));
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-project-ids-home-'));
  const serviceProject = path.join(homeDir, 'code', 'linkflow-service');
  const adminProject = path.join(homeDir, 'code', 'AIChat-Admin');
  const savedProject = path.join(homeDir, 'legacy', 'aichat');
  const serviceProjectId = 'codex-project-service';
  const adminProjectId = 'codex-project-admin';
  fs.mkdirSync(serviceProject, { recursive: true });
  fs.mkdirSync(adminProject, { recursive: true });
  fs.mkdirSync(savedProject, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });

  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'project-order': [serviceProjectId, adminProjectId],
    'local-projects': {
      [serviceProjectId]: {
        id: serviceProjectId,
        name: 'Linkflow Service',
        rootPaths: [serviceProject],
        updatedAt: 200,
      },
      [adminProjectId]: {
        id: adminProjectId,
        name: 'AIChat Admin',
        rootPaths: [adminProject],
        updatedAt: 100,
      },
    },
    'active-workspace-roots': [serviceProject],
    'electron-saved-workspace-roots': [savedProject],
  }));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => ({ path: item.path, label: item.label })), [
    { path: serviceProject, label: 'Linkflow Service' },
    { path: adminProject, label: 'AIChat Admin' },
    { path: savedProject, label: path.basename(savedProject) },
  ]);
  assert.deepStrictEqual(candidates.slice(0, 2).map(item => item.projectId), [serviceProjectId, adminProjectId]);

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-project-ids',
    workspace: homeDir,
    linco: { messageId: 'm-codex-project-ids', streamId: 'linco-stream-codex-project-ids' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  assert.strictEqual(handleSlashCommand('/project', ws, session, { homeDir }), true);
  assert.strictEqual(
    ws.sent[0].data.items[0].sessionsCommand,
    `/sessions --project ${serviceProject} --project-id ${serviceProjectId} 10`,
  );
}

if (directorySymlinkSupported) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-realpath-home-'));
  const realProject = path.join(homeDir, 'real', 'known-codex-project');
  const linkProject = path.join(homeDir, 'link', 'known-codex-project');
  fs.mkdirSync(realProject, { recursive: true });
  fs.mkdirSync(path.dirname(linkProject), { recursive: true });
  fs.symlinkSync(realProject, linkProject, 'dir');
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  const realProjectCwd = fs.realpathSync.native(realProject);

  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': {
      'project-order': [linkProject],
      'electron-workspace-root-labels': {
        [realProjectCwd]: 'Canonical Codex Project',
      },
    },
  }));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => ({ path: item.path, label: item.label })), [
    { path: linkProject, label: 'Canonical Codex Project' },
  ]);

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-project-realpath',
    storageId: 'sid_codex_project_realpath',
    workspace: homeDir,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'linco-project-realpath-runtime-')),
    linco: { messageId: 'm-codex-project-realpath', streamId: 'linco-stream-codex-project-realpath' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  assert.strictEqual(handleSlashCommand(`/project --select "${linkProject}"`, ws, session, { homeDir }), true);
  assert.strictEqual(session.workspace, path.resolve(linkProject));
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-fallback-home-'));
  const sessionProject = path.join(homeDir, 'code', 'fallback-codex-project');
  fs.mkdirSync(sessionProject, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex', 'sessions', '2026', '06', '02'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'electron-persisted-atom-state': {
      'project-order': [],
      'active-workspace-roots': [],
      'electron-saved-workspace-roots': [],
    },
  }));
  fs.writeFileSync(path.join(homeDir, '.codex', 'sessions', '2026', '06', '02', 'rollout.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: sessionProject } }),
  ].join('\n'));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => item.path), [sessionProject]);
}

{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-known-codex-label-home-'));
  const project = path.join(homeDir, 'Documents', 'New project 4');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'project-order': [project],
    'electron-workspace-root-labels': {
      [project]: 'New project',
    },
  }));

  const candidates = slashCommandInternals.knownProjectCandidates({ agentType: 'codex' }, { homeDir });
  assert.deepStrictEqual(candidates.map(item => ({ path: item.path, label: item.label })), [
    { path: project, label: 'New project' },
  ]);

  const ws = createCaptureWs();
  const session = {
    id: 'session-codex-project-label',
    workspace: homeDir,
    linco: { messageId: 'm-codex-project-label', streamId: 'linco-stream-codex-project-label' },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  assert.strictEqual(handleSlashCommand('/project', ws, session, { homeDir }), true);
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'project');
  assert.strictEqual(ws.sent[0].data.items[0].label, 'New project');
  assert.strictEqual(ws.sent[0].data.items[0].path, project);
  assert.match(ws.sent[0].data.items[0].sessionsCommand, /^\/sessions --project /);
  assert(ws.sent[0].data.items[0].sessionsCommand.includes('New project 4'));
}

{
  const root = path.parse(process.cwd()).root;
  const shallow = path.join(root, 'tmp');
  const concrete = path.join(root, 'tmp', 'real-project');

  assert.strictEqual(slashCommandInternals.isSelectableProjectDirectory(root), false);
  assert.strictEqual(slashCommandInternals.isSelectableProjectDirectory(shallow), false);
  assert.strictEqual(slashCommandInternals.isSelectableProjectDirectory(concrete), true);
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-unsupported',
    workspace: process.cwd(),
    linco: { messageId: 'm-agent-unsupported', streamId: 'linco-stream-agent-unsupported' },
    agentType: 'claude',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/agent', ws, session, {}), true);
  assert.match(ws.sent[0].text, /仅适用于 OpenClaw/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-unsupported',
    workspace: process.cwd(),
    linco: { messageId: 'm-profile-unsupported', streamId: 'linco-stream-profile-unsupported' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/profile', ws, session, {}), true);
  assert.match(ws.sent[0].text, /仅适用于 Hermes/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-list',
    workspace: process.cwd(),
    linco: { messageId: 'm-agent-list', streamId: 'linco-stream-agent-list', accountId: 'remote-account' },
    agentType: 'openclaw',
    openclawAgentId: 'main',
    messageQueue: [],
    agentSessionHistory: [],
  };

  agentSelection.sendOpenClawAgentChoices(
    ws,
    session,
    { agents: { openclaw: { openclawAgentId: 'main' } } },
    [{ id: 'main', model: 'qwen' }, { id: 'qa' }],
    '',
  );
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'agent');
  assert.strictEqual(ws.sent[0].data.items[0].id, 'main');
  assert.strictEqual(ws.sent[0].data.items[1].id, 'qa');
  assert.strictEqual(ws.sent[0].data.account, 'remote-account');
  assert.strictEqual(ws.sent[0].data.actions[0].command, '/agent --bind main');
  assert.strictEqual(ws.sent[0].data.items[0].account, 'remote-account');
  assert.strictEqual(ws.sent[0].data.items[0].command, '/agent --bind main');
  assert.strictEqual(ws.sent[0].data.actions[0].action, 'bind');
}

{
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-list',
    workspace: process.cwd(),
    linco: { messageId: 'm-profile-list', streamId: 'linco-stream-profile-list', accountId: 'remote-account' },
    agentType: 'hermes',
    hermesProfile: 'default',
    messageQueue: [],
    agentSessionHistory: [],
  };

  agentSelection.sendHermesProfileChoices(
    ws,
    session,
    { agents: { hermes: { profile: 'default' } } },
    ['default', 'work'],
    '',
  );
  assert.strictEqual(ws.sent[0].type, 'slash_command_result');
  assert.strictEqual(ws.sent[0].command, 'profile');
  assert.strictEqual(ws.sent[0].data.items[0].name, 'default');
  assert.strictEqual(ws.sent[0].data.items[1].name, 'work');
  assert.strictEqual(ws.sent[0].data.account, 'remote-account');
  assert.strictEqual(ws.sent[0].data.actions[0].command, '/profile --bind default');
  assert.strictEqual(ws.sent[0].data.items[0].account, 'remote-account');
  assert.strictEqual(ws.sent[0].data.items[0].command, '/profile --bind default');
  assert.strictEqual(ws.sent[0].data.actions[0].action, 'bind');
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-select-runtime-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-select',
    storageId: 'sid_agent_select',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-select', streamId: 'linco-stream-agent-select' },
    agentType: 'openclaw',
    agentSessionId: 'agent:main:linco:direct:old',
    openclawAgentId: 'main',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/agent --select backend-engineer', ws, session, { agents: { openclaw: { openclawAgentId: 'main' } } }), true);
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.strictEqual(session.agentSessionId, 'agent:main:linco:direct:old');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /fixed for this IM session/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-select-unlocked-runtime-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-select-unlocked',
    storageId: 'sid_agent_select_unlocked',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-select-unlocked', streamId: 'linco-stream-agent-select-unlocked' },
    agentType: 'openclaw',
    openclawAgentId: 'main',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/agent backend-engineer', ws, session, { agents: { openclaw: { openclawAgentId: 'main' } } }), true);
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /fixed for this IM session/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-select-runtime-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-select',
    storageId: 'sid_profile_select',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-select', streamId: 'linco-stream-profile-select' },
    agentType: 'hermes',
    agentSessionId: 'old-hermes-session',
    hermesProfile: 'default',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/profile --select work', ws, session, { agents: { hermes: { profile: 'default' } } }), true);
  assert.strictEqual(session.hermesProfile, 'default');
  assert.strictEqual(session.agentSessionId, 'old-hermes-session');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /fixed for this IM session/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-select-unlocked-runtime-'));
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-select-unlocked',
    storageId: 'sid_profile_select_unlocked',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-select-unlocked', streamId: 'linco-stream-profile-select-unlocked' },
    agentType: 'hermes',
    hermesProfile: 'default',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/profile work', ws, session, { agents: { hermes: { profile: 'default' } } }), true);
  assert.strictEqual(session.hermesProfile, 'default');
  assert.strictEqual(ws.sent[0].type, 'error');
  assert.match(ws.sent[0].text, /fixed for this IM session/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          openclaw: {
            defaultAccount: 'remote-account',
            accounts: {
              'remote-account': { appId: 'app', appSecret: 'secret', enabled: true, openclawAgentId: 'main' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-bind',
    storageId: 'sid_agent_bind',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-bind', streamId: 'linco-stream-agent-bind', accountId: 'remote-account', channel: 'linco' },
    agentType: 'openclaw',
    agentSessionId: 'agent:main:linco:direct:old',
    openclawAgentId: 'main',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = {
    configFile,
    im: { channel: 'linco', account: 'remote-account' },
    agents: { openclaw: { openclawAgentId: 'main' } },
  };

  assert.strictEqual(handleSlashCommand('/agent --bind backend-engineer', ws, session, config), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.openclaw.accounts['remote-account'].openclawAgentId, 'backend-engineer');
  assert.strictEqual(config.agents.openclaw.openclawAgentId, 'main');
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.strictEqual(session.agentSessionId, 'agent:main:linco:direct:old');
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-explicit-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-explicit-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          openclaw: {
            defaultAccount: 'current-account',
            accounts: {
              'current-account': { appId: 'app', appSecret: 'secret', enabled: true, openclawAgentId: 'main' },
              'target-account': { appId: 'app2', appSecret: 'secret2', enabled: true, openclawAgentId: 'main' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-bind-explicit',
    storageId: 'sid_agent_bind_explicit',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-bind-explicit', streamId: 'linco-stream-agent-bind-explicit', accountId: 'target-account', channel: 'linco' },
    agentType: 'openclaw',
    openclawAgentId: 'main',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = {
    configFile,
    im: { channel: 'linco', account: 'current-account' },
    agents: { openclaw: { openclawAgentId: 'main' } },
  };

  assert.strictEqual(handleSlashCommand('/agent --bind qa', ws, session, config), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.openclaw.accounts['current-account'].openclawAgentId, 'main');
  assert.strictEqual(saved.channels.linco.agents.openclaw.accounts['target-account'].openclawAgentId, 'qa');
  assert.strictEqual(config.agents.openclaw.openclawAgentId, 'main');
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.match(ws.sent[0].text, /target-account/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-create-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-create-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          openclaw: {},
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-bind-create',
    storageId: 'sid_agent_bind_create',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-bind-create', streamId: 'linco-stream-agent-bind-create', accountId: 'main', channel: 'linco' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/agent --bind test', ws, session, {
    configFile,
    im: { channel: 'linco', account: 'default' },
    agents: { openclaw: { openclawAgentId: 'main' } },
  }), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.openclaw.defaultAccount, 'main');
  assert.strictEqual(saved.channels.linco.agents.openclaw.accounts.main.openclawAgentId, 'test');
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          hermes: {
            defaultAccount: 'remote-account',
            accounts: {
              'remote-account': { appId: 'app', appSecret: 'secret', enabled: true, profile: 'default' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-bind',
    storageId: 'sid_profile_bind',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-bind', streamId: 'linco-stream-profile-bind', accountId: 'remote-account', channel: 'linco' },
    agentType: 'hermes',
    agentSessionId: 'old-hermes-session',
    hermesProfile: 'default',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = {
    configFile,
    im: { channel: 'linco', account: 'remote-account' },
    agents: { hermes: { profile: 'default' } },
  };

  assert.strictEqual(handleSlashCommand('/profile --bind work', ws, session, config), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.hermes.accounts['remote-account'].profile, 'work');
  assert.strictEqual(config.agents.hermes.profile, 'default');
  assert.strictEqual(session.hermesProfile, 'default');
  assert.strictEqual(session.agentSessionId, 'old-hermes-session');
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
  assert.strictEqual(fs.existsSync(path.join(runtimeDir, 'session.json')), false);
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-explicit-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-explicit-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          hermes: {
            defaultAccount: 'current-account',
            accounts: {
              'current-account': { appId: 'app', appSecret: 'secret', enabled: true, profile: 'default' },
              'target-account': { appId: 'app2', appSecret: 'secret2', enabled: true, profile: 'default' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-bind-explicit',
    storageId: 'sid_profile_bind_explicit',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-bind-explicit', streamId: 'linco-stream-profile-bind-explicit', accountId: 'target-account', channel: 'linco' },
    agentType: 'hermes',
    hermesProfile: 'default',
    messageQueue: [],
    agentSessionHistory: [],
  };
  const config = {
    configFile,
    im: { channel: 'linco', account: 'current-account' },
    agents: { hermes: { profile: 'default' } },
  };

  assert.strictEqual(handleSlashCommand('/profile --bind work', ws, session, config), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.hermes.accounts['current-account'].profile, 'default');
  assert.strictEqual(saved.channels.linco.agents.hermes.accounts['target-account'].profile, 'work');
  assert.strictEqual(config.agents.hermes.profile, 'default');
  assert.strictEqual(session.hermesProfile, 'default');
  assert.match(ws.sent[0].text, /target-account/);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-create-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-create-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          hermes: {},
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-bind-create',
    storageId: 'sid_profile_bind_create',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-bind-create', streamId: 'linco-stream-profile-bind-create', accountId: 'main', channel: 'linco' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/profile --bind writer', ws, session, {
    configFile,
    im: { channel: 'linco', account: 'default' },
    agents: { hermes: { profile: 'default' } },
  }), true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.channels.linco.agents.hermes.defaultAccount, 'main');
  assert.strictEqual(saved.channels.linco.agents.hermes.accounts.main.profile, 'writer');
  assert.strictEqual(session.hermesProfile, 'default');
  assert.strictEqual(ws.sent[0].type, 'system');
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-unlocked-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-profile-bind-unlocked-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          hermes: {
            defaultAccount: 'default',
            accounts: {
              default: { appId: 'app', appSecret: 'secret', enabled: true, profile: 'default' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-profile-bind-unlocked',
    storageId: 'sid_profile_bind_unlocked',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-profile-bind-unlocked', streamId: 'linco-stream-profile-bind-unlocked', accountId: 'default', channel: 'linco' },
    agentType: 'hermes',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/profile --bind work', ws, session, {
    configFile,
    im: { channel: 'linco', account: 'default' },
    agents: { hermes: { profile: 'default' } },
  }), true);
  assert.strictEqual(session.hermesProfile, 'default');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'session.json'), 'utf8')).hermesProfile, 'default');
}

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-unlocked-config-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-agent-bind-unlocked-runtime-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    defaultChannel: 'linco',
    channels: {
      linco: {
        agents: {
          openclaw: {
            defaultAccount: 'default',
            accounts: {
              default: { appId: 'app', appSecret: 'secret', enabled: true, openclawAgentId: 'main' },
            },
          },
        },
      },
    },
  }, null, 2)}\n`);
  const ws = createCaptureWs();
  const session = {
    id: 'session-agent-bind-unlocked',
    storageId: 'sid_agent_bind_unlocked',
    workspace: process.cwd(),
    runtimeDir,
    linco: { messageId: 'm-agent-bind-unlocked', streamId: 'linco-stream-agent-bind-unlocked', accountId: 'default', channel: 'linco' },
    agentType: 'openclaw',
    messageQueue: [],
    agentSessionHistory: [],
  };

  assert.strictEqual(handleSlashCommand('/agent --bind qa', ws, session, {
    configFile,
    im: { channel: 'linco', account: 'default' },
    agents: { openclaw: { openclawAgentId: 'main' } },
  }), true);
  assert.strictEqual(session.openclawAgentId, 'main');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'session.json'), 'utf8')).openclawAgentId, 'main');
}

{
  const agents = slashCommandInternals.parseOpenClawAgentListOutput(JSON.stringify({
    defaultId: 'main',
    agents: [{ id: 'main', model: { primary: 'qwen' } }, { id: 'qa', workspace: '/tmp/qa' }],
  }));
  assert.deepStrictEqual(agents.map(agent => agent.id), ['main', 'qa']);
  assert.strictEqual(agents[0].isDefault, true);
  assert.strictEqual(agents[0].model, 'qwen');

  const profiles = slashCommandInternals.parseHermesProfileListOutput(' Profile          Model\n ─────────────    ─────\n ◆default         qwen\n  work            claude\n');
  assert.deepStrictEqual(profiles, ['default', 'work']);
  assert.strictEqual(slashCommandInternals.validateHermesProfileName('../bad').ok, false);
  assert(!slashCommandInternals.formatOpenClawAgentChoice({ id: 'test', workspace: '/tmp/openclaw-test', model: 'qwen' }, 'main').includes('workspace'));
  assert.deepStrictEqual(
    slashCommandInternals.resolveWindowsShimCommand('openclaw'),
    process.platform === 'win32'
      ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'openclaw'] }
      : { file: 'openclaw', args: [] },
  );
  const agentPicker = slashCommandInternals.buildAgentPickerPayload(
    [{ id: 'main', model: 'qwen', isDefault: true }, { id: 'qa', workspace: '/tmp/qa' }],
    [],
    { current: 'main', defaultId: 'main', account: 'remote-account', listError: '' },
  );
  assert.strictEqual(agentPicker.items[0].isCurrent, true);
  assert.strictEqual(agentPicker.items[0].isDefault, true);
  assert.strictEqual(agentPicker.account, 'remote-account');
  assert.strictEqual(agentPicker.items[1].account, 'remote-account');
  assert.strictEqual(agentPicker.items[1].command, '/agent --bind qa');
  assert.strictEqual(agentPicker.items[1].bindCommand, '/agent --bind qa');

  const profilePicker = slashCommandInternals.buildProfilePickerPayload(
    ['default', 'work'],
    [],
    { current: 'work', defaultProfile: 'default', account: 'remote-account', listError: 'fallback' },
  );
  assert.strictEqual(profilePicker.listError, 'fallback');
  assert.strictEqual(profilePicker.items[0].isDefault, true);
  assert.strictEqual(profilePicker.items[1].isCurrent, true);
  assert.strictEqual(profilePicker.account, 'remote-account');
  assert.strictEqual(profilePicker.items[1].account, 'remote-account');
  assert.strictEqual(profilePicker.items[1].command, '/profile --bind work');
  assert.strictEqual(profilePicker.items[1].bindCommand, '/profile --bind work');
}

{
  const payload = mapLocalEventToLinco({
    type: 'system',
    text: '请选择项目目录',
    actions: [{ label: '进入 code', command: '/project D:\\code' }],
    quickReplies: [{ label: '取消', command: '/project --cancel' }],
  }, {
    id: 'session-project-actions',
    workspace: process.cwd(),
  }, {}, {
    messageId: 'm-project-actions',
    streamId: 'linco-stream-project-actions',
  });

  assert.strictEqual(payload.type, 'outbound_message');
  assert.deepStrictEqual(payload.actions, [{ label: '进入 code', command: '/project D:\\code' }]);
  assert.deepStrictEqual(payload.quickReplies, [{ label: '取消', command: '/project --cancel' }]);
}

{
  const payload = mapLocalEventToLinco({
    type: 'slash_command_result',
    command: 'history',
    version: 1,
    data: { rounds: [] },
  }, {
    id: 'session-history-result',
    workspace: process.cwd(),
  }, {}, {
    messageId: 'm-history-result',
    streamId: 'linco-stream-history-result',
  });

  assert.strictEqual(payload.type, 'slash_command_result');
  assert.strictEqual(payload.command, 'history');
  assert.deepStrictEqual(payload.data, { rounds: [] });
  assert.strictEqual(payload.requestId, 'm-history-result');
  assert.strictEqual(payload.streamId, 'linco-stream-history-result');
}

{
  const imageBase64 = Buffer.from('fake image').toString('base64');
  const payload = mapLocalEventToLinco({
    type: 'outbound_message',
    text: '已生成图片：[generated deer.png](D:\\workspace\\generated deer.png)',
    mediaName: 'generated deer.png',
    mediaType: 'image/png',
    mediaBase64: imageBase64,
  }, {
    id: 'session-image-files',
    workspace: process.cwd(),
  }, {}, {
    messageId: 'm-image-files',
    streamId: 'linco-stream-image-files',
  });

  assert.strictEqual(payload.type, 'outbound_message');
  assert.strictEqual(payload.mediaBase64, imageBase64);
  assert.strictEqual(payload.files.length, 1);
  assert.strictEqual(payload.files[0].name, 'generated deer.png');
  assert.strictEqual(payload.files[0].type, 'image/png');
  assert.strictEqual(payload.files[0].base64, imageBase64);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-get-'));
  const filePath = path.join(workspace, 'note.txt');
  fs.writeFileSync(filePath, 'hello mobile\n');
  const ws = createCaptureWs();
  const session = {
    id: 'session-3',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  assert.strictEqual(handleSlashCommand('/get note.txt:12', ws, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }), true);

  const fileMessage = ws.sent.find(msg => msg.type === 'outbound_message' && msg.mediaBase64);
  assert(fileMessage);
  assert.strictEqual(fileMessage.mediaName, 'note.txt');
  assert.strictEqual(fileMessage.mediaType, 'text/plain; charset=utf-8');
  assert.strictEqual(fileMessage.mediaBase64, Buffer.from('hello mobile\n').toString('base64'));
  assert.strictEqual(fileMessage.references[0].command, `/get ${filePath}`);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');

}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-get-remote-'));
  const filePath = path.join(workspace, 'remote.txt');
  fs.writeFileSync(filePath, 'hello remote\n');
  const ws = createCaptureWs();
  const session = {
    id: 'session-4',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
    linco: {
      messageId: 'm-4',
      streamId: 'linco-stream-m-4',
    },
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  assert.strictEqual(handleSlashCommand('/get remote.txt', ws, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }), true);

  const fileMessage = ws.sent.find(msg => msg.type === 'outbound_message' && msg.mediaBase64);
  assert(fileMessage);
  assert.strictEqual(fileMessage.mediaName, 'remote.txt');
  assert.strictEqual(fileMessage.mediaType, 'text/plain; charset=utf-8');
  assert.strictEqual(fileMessage.mediaBase64, Buffer.from('hello remote\n').toString('base64'));
  assert.strictEqual(fileMessage.references[0].command, `/get ${filePath}`);
  assert.strictEqual(ws.sent.at(-1).type, 'turn_end');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-get-file-uri-'));
  const filePath = path.join(workspace, 'uri file.txt');
  fs.writeFileSync(filePath, 'hello uri\n');
  const ws = createCaptureWs();
  const session = {
    id: 'session-get-file-uri',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  assert.strictEqual(handleSlashCommand(`/get ${pathToFileURL(filePath).href}`, ws, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }), true);

  const fileMessage = ws.sent.find(msg => msg.type === 'outbound_message' && msg.mediaBase64);
  assert(fileMessage);
  assert.strictEqual(fileMessage.mediaName, 'uri file.txt');
  assert.strictEqual(fileMessage.mediaBase64, Buffer.from('hello uri\n').toString('base64'));
  assert.strictEqual(fileMessage.references[0].command, `/get "${filePath.replace(/"/g, '\\"')}"`);
}

if (process.platform === 'win32') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-command-get-msys-'));
  const filePath = path.join(workspace, 'msys-note.txt');
  fs.writeFileSync(filePath, 'hello msys\n');
  const msysPath = filePath
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
  const ws = createCaptureWs();
  const session = {
    id: 'session-get-msys',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
    agentType: 'codex',
    messageQueue: [],
    agentSessionHistory: [],
  };
  fs.mkdirSync(session.attachmentsDir, { recursive: true });

  assert.strictEqual(handleSlashCommand(`/get ${msysPath}`, ws, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }), true);

  const fileMessage = ws.sent.find(msg => msg.type === 'outbound_message' && msg.mediaBase64);
  assert(fileMessage);
  assert.strictEqual(fileMessage.mediaName, 'msys-note.txt');
  assert.strictEqual(fileMessage.mediaBase64, Buffer.from('hello msys\n').toString('base64'));
  assert.strictEqual(fileMessage.references[0].command, `/get ${filePath}`);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-'));
  const filePath = path.join(workspace, 'report.txt');
  fs.writeFileSync(filePath, 'referenced file\n');
  const session = {
    id: 'session-ref',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = {
    streamId: 'linco-stream-ref',
    fullText: `已生成文件：[report.txt](${filePath})`,
  };

  const payload = mapLocalEventToLinco({ type: 'assistant_end' }, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }, linco);

  assert.strictEqual(payload.type, 'stream_chunk');
  assert.strictEqual(payload.done, true);
  assert.strictEqual(payload.references.length, 1);
  assert.strictEqual(payload.references[0].command, `/get ${filePath}`);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-image-fallback-'));
  const filePath = path.join(workspace, 'generated.png');
  fs.writeFileSync(filePath, Buffer.from('generated image'));
  const session = {
    id: 'session-ref-image-fallback',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = {
    streamId: 'linco-stream-ref-image-fallback',
    fullText: `图片已生成。\n\n![](${filePath})\n\n[打开原图](${filePath})`,
  };

  const payload = mapLocalEventToLinco({ type: 'assistant_end' }, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }, linco);

  assert.strictEqual(payload.type, 'stream_chunk');
  assert.strictEqual(payload.done, true);
  assert.strictEqual(payload.fullText, '图片已生成。');
  assert.strictEqual(
    payload.text,
    `图片已生成。\n\n![](${filePath})\n\n[打开原图](${filePath})`,
  );
  assert.strictEqual(payload.mediaName, 'generated.png');
  assert.strictEqual(payload.mediaType, 'image/png');
  assert.strictEqual(
    payload.mediaBase64,
    Buffer.from('generated image').toString('base64'),
  );
  assert.deepStrictEqual(payload.references, []);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-image-existing-media-'));
  const filePath = path.join(workspace, 'already-delivered.png');
  fs.writeFileSync(filePath, Buffer.from('generated image'));
  const session = {
    id: 'session-ref-image-existing-media',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = { streamId: 'linco-stream-ref-image-existing-media' };
  const config = {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  };

  mapLocalEventToLinco({ type: 'assistant_start' }, session, config, linco);
  mapLocalEventToLinco({
    type: 'outbound_message',
    mediaName: 'already-delivered.png',
    mediaType: 'image/png',
    mediaBase64: Buffer.from('generated image').toString('base64'),
  }, session, config, linco);
  linco.finalText = `![生成图片](${filePath})`;
  linco.hasFinalChunks = true;

  const payload = mapLocalEventToLinco(
    { type: 'assistant_end' },
    session,
    config,
    linco,
  );

  assert.strictEqual(payload.fullText, `![生成图片](${filePath})`);
  assert.strictEqual(payload.mediaBase64, undefined);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-file-uri-'));
  const filePath = path.join(workspace, 'uri-report.txt');
  fs.writeFileSync(filePath, 'referenced uri file\n');
  const session = {
    id: 'session-ref-file-uri',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = {
    streamId: 'linco-stream-ref-file-uri',
    fullText: `已生成文件：[uri-report.txt](${pathToFileURL(filePath).href})`,
  };

  const payload = mapLocalEventToLinco({ type: 'assistant_end' }, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }, linco);

  assert.strictEqual(payload.type, 'stream_chunk');
  assert.strictEqual(payload.done, true);
  assert.strictEqual(payload.references.length, 1);
  assert.strictEqual(payload.references[0].command, `/get ${filePath}`);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-plain-'));
  const filePath = path.join(workspace, 'plain.txt');
  fs.writeFileSync(filePath, 'plain file\n');
  const session = {
    id: 'session-ref-plain',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = {
    streamId: 'linco-stream-ref-plain',
    fullText: `已生成文件：${filePath}`,
  };

  const payload = mapLocalEventToLinco({ type: 'assistant_end' }, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }, linco);

  assert.strictEqual(payload.type, 'stream_chunk');
  assert.deepStrictEqual(payload.references, []);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-reference-relative-'));
  const filePath = path.join(workspace, 'relative.txt');
  fs.writeFileSync(filePath, 'relative file\n');
  const session = {
    id: 'session-ref-relative',
    workspace,
    runtimeDir: workspace,
    attachmentsDir: path.join(workspace, 'attachments'),
  };
  const linco = {
    streamId: 'linco-stream-ref-relative',
    fullText: '已生成文件：[relative.txt](relative.txt)',
  };

  const payload = mapLocalEventToLinco({ type: 'assistant_end' }, session, {
    maxOutgoingAttachmentBytes: 1024 * 1024,
    allowUnsafeAttachments: false,
    unsafeAttachmentExtensions: ['.exe', '.bat', '.cmd', '.ps1'],
  }, linco);

  assert.strictEqual(payload.type, 'stream_chunk');
  assert.deepStrictEqual(payload.references, []);
}

{
  const session = { id: 'session-stream-phase' };
  const linco = { streamId: 'linco-stream-phase' };
  const config = {};

  mapLocalEventToLinco({ type: 'assistant_start' }, session, config, linco);
  const progress = mapLocalEventToLinco({
    type: 'assistant_chunk',
    text: 'I will inspect first.',
    phase: 'progress',
    ephemeral: true,
  }, session, config, linco);
  const final = mapLocalEventToLinco({
    type: 'assistant_chunk',
    text: 'Final answer.',
  }, session, config, linco);
  const done = mapLocalEventToLinco({ type: 'assistant_end' }, session, config, linco);

  assert.strictEqual(progress.type, 'stream_chunk');
  assert.strictEqual(progress.phase, 'progress');
  assert.strictEqual(progress.ephemeral, true);
  assert.strictEqual(progress.fullText, 'I will inspect first.');
  assert.strictEqual(final.phase, 'final_answer');
  assert.strictEqual(final.ephemeral, false);
  assert.strictEqual(final.replacePrevious, true);
  assert.strictEqual(final.fullText, 'Final answer.');
  assert.strictEqual(done.fullText, 'Final answer.');
}

{
  const session = { id: 'session-progress-finalize' };
  const linco = { streamId: 'linco-stream-progress-finalize' };
  const config = {};

  mapLocalEventToLinco({ type: 'assistant_start' }, session, config, linco);
  const firstProgress = mapLocalEventToLinco({
    type: 'assistant_chunk',
    text: 'I will inspect first.',
    phase: 'progress',
    ephemeral: true,
  }, session, config, linco);
  mapLocalEventToLinco({
    type: 'tool_call',
    id: 'tool-1',
    name: 'exec',
    input: 'dir',
  }, session, config, linco);
  const finalProgress = mapLocalEventToLinco({
    type: 'assistant_chunk',
    text: '\n\nFinal answer after tool.',
    phase: 'progress',
    ephemeral: true,
  }, session, config, linco);
  const done = mapLocalEventToLinco({ type: 'assistant_end' }, session, config, linco);

  assert.strictEqual(firstProgress.fullText, 'I will inspect first.');
  assert.strictEqual(finalProgress.fullText, '\n\nFinal answer after tool.');
  assert.strictEqual(done.phase, 'final_answer');
  assert.strictEqual(done.replacePrevious, true);
  assert.strictEqual(done.fullText, 'Final answer after tool.');
}

console.log('linco local command turn_end ok');
