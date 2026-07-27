
const path = require('path');
const { splitCommandArgs } = require('../args');
const { resolveWorkspacePath } = require('../project');
const {
  DEFAULT_HISTORY_ROUNDS_LIMIT,
  DEFAULT_LOCAL_SESSIONS_LIMIT,
  MAX_HISTORY_ROUNDS_LIMIT,
  MAX_LOCAL_SESSIONS_LIMIT,
  DEFAULT_CODEX_CHATS_LIMIT,
} = require('./constants');
const { MAX_HISTORY_CURSOR_LENGTH } = require('./cursor');

function parseSessionsArgs(rawArg) {
  const trimmed = String(rawArg || '').trim();
  if (!trimmed) return { ok: true, limit: DEFAULT_LOCAL_SESSIONS_LIMIT };
  if (trimmed.includes('--project')) return parseProjectSessionsArgs(trimmed);
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: '用法：/sessions [数量]，数量范围 1-50，例如 /sessions 10。' };
  }
  const limit = Number(trimmed);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOCAL_SESSIONS_LIMIT) {
    return { ok: false, message: `用法：/sessions [数量]，数量范围 1-${MAX_LOCAL_SESSIONS_LIMIT}。` };
  }
  return { ok: true, limit };
}

function parseChatsArgs(rawArg) {
  const trimmed = String(rawArg || '').trim();
  if (!trimmed) return { ok: true, limit: DEFAULT_CODEX_CHATS_LIMIT };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: `/chats [limit], limit range is 1-${MAX_LOCAL_SESSIONS_LIMIT}.` };
  }
  const limit = Number(trimmed);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOCAL_SESSIONS_LIMIT) {
    return { ok: false, message: `/chats [limit], limit range is 1-${MAX_LOCAL_SESSIONS_LIMIT}.` };
  }
  return { ok: true, limit };
}

function parseProjectSessionsArgs(trimmed) {
  const parsed = splitCommandArgs(trimmed);
  if (!parsed.ok) return parsed;

  let projectPath = '';
  let limit = DEFAULT_LOCAL_SESSIONS_LIMIT;
  let sawLimit = false;
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i];
    if (arg === '--project') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: '用法：/sessions --project <项目路径> [数量]。' };
      projectPath = next;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectPath = arg.slice('--project='.length);
      if (!projectPath) return { ok: false, message: '用法：/sessions --project <项目路径> [数量]。' };
      continue;
    }
    if (/^\d+$/.test(arg) && !sawLimit) {
      limit = Number(arg);
      sawLimit = true;
      continue;
    }
    return { ok: false, message: '用法：/sessions --project <项目路径> [数量]。' };
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOCAL_SESSIONS_LIMIT) {
    return { ok: false, message: `用法：/sessions --project <项目路径> [数量]，数量范围 1-${MAX_LOCAL_SESSIONS_LIMIT}。` };
  }
  return { ok: true, limit, projectPath };
}

function parseBindArgs(rawArg) {
  const parsed = splitCommandArgs(rawArg);
  if (!parsed.ok) return parsed;
  if (parsed.args.length === 2 && parsed.args[0] === '--chat') {
    return parsed.args[1]
      ? { ok: true, chatId: parsed.args[1] }
      : { ok: false, message: 'Usage: /bind --chat <chat-id>.' };
  }
  if (parsed.args.length === 1 && parsed.args[0].startsWith('--chat=')) {
    const chatId = parsed.args[0].slice('--chat='.length);
    return chatId
      ? { ok: true, chatId }
      : { ok: false, message: 'Usage: /bind --chat <chat-id>.' };
  }

  let projectPath = '';
  let sessionId = '';
  let chatId = '';
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i];
    if (arg === '--project') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: '用法：/bind [--project <项目路径>] <session-id>。' };
      projectPath = next;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectPath = arg.slice('--project='.length);
      if (!projectPath) return { ok: false, message: '用法：/bind [--project <项目路径>] <session-id>。' };
      continue;
    }
    if (arg === '--chat') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: 'Usage: /bind --chat <chat-id>.' };
      chatId = next;
      continue;
    }
    if (arg.startsWith('--chat=')) {
      chatId = arg.slice('--chat='.length);
      if (!chatId) return { ok: false, message: 'Usage: /bind --chat <chat-id>.' };
      continue;
    }
    if (!sessionId) {
      sessionId = arg;
      continue;
    }
    return { ok: false, message: '用法：/bind [--project <项目路径>] <session-id>。' };
  }

  if (chatId) {
    if (projectPath || sessionId) return { ok: false, message: 'Usage: /bind --chat <chat-id>.' };
    return { ok: true, chatId };
  }
  if (!sessionId) return { ok: false, message: '用法：/bind <session-id>。请先使用 /sessions 查看可接入的 PC 会话。' };
  return { ok: true, projectPath, sessionId };
}

function parseHistoryArgs(rawArg) {
  const trimmed = String(rawArg || '').trim();
  if (!trimmed) return { ok: true, limit: DEFAULT_HISTORY_ROUNDS_LIMIT, includeThinking: false };
  if (trimmed.includes('--chat')) return parseChatHistoryArgs(trimmed);
  if (trimmed.includes('--project') || trimmed.includes('--session')) return parseProjectHistoryArgs(trimmed);
  {
    const parsed = splitCommandArgs(trimmed);
    if (!parsed.ok) return parsed;

    let limit = DEFAULT_HISTORY_ROUNDS_LIMIT;
    let sawLimit = false;
    let includeThinking = false;
    let beforeCursor = '';
    for (let i = 0; i < parsed.args.length; i++) {
      const arg = parsed.args[i];
      if (isHistoryThinkingFlag(arg)) {
        includeThinking = true;
        continue;
      }
      const cursor = readHistoryCursorArg(parsed.args, i);
      if (cursor) {
        if (cursor.invalid) return invalidHistoryCursorUsage();
        if (beforeCursor) return invalidHistoryCursorUsage();
        beforeCursor = cursor.value;
        i = cursor.nextIndex;
        continue;
      }
      if (/^\d+$/.test(arg) && !sawLimit) {
        limit = Number(arg);
        sawLimit = true;
        continue;
      }
      return { ok: false, message: 'Usage: /history [--thinking] [limit].' };
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_ROUNDS_LIMIT) {
      return { ok: false, message: `/history [--thinking] [limit], limit range is 1-${MAX_HISTORY_ROUNDS_LIMIT}.` };
    }
    return {
      ok: true,
      limit,
      includeThinking,
      ...(beforeCursor ? { beforeCursor } : {}),
    };
  }
}

function parseChatHistoryArgs(trimmed) {
  const parsed = splitCommandArgs(trimmed);
  if (!parsed.ok) return parsed;

  let chatId = '';
  let limit = DEFAULT_HISTORY_ROUNDS_LIMIT;
  let sawLimit = false;
  let includeThinking = false;
  let beforeCursor = '';
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i];
    if (isHistoryThinkingFlag(arg)) {
      includeThinking = true;
      continue;
    }
    const cursor = readHistoryCursorArg(parsed.args, i);
    if (cursor) {
      if (cursor.invalid) return invalidHistoryCursorUsage();
      if (beforeCursor) return invalidHistoryCursorUsage();
      beforeCursor = cursor.value;
      i = cursor.nextIndex;
      continue;
    }
    if (arg === '--chat') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: 'Usage: /history --chat <chat-id> [limit].' };
      chatId = next;
      continue;
    }
    if (arg.startsWith('--chat=')) {
      chatId = arg.slice('--chat='.length);
      if (!chatId) return { ok: false, message: 'Usage: /history --chat <chat-id> [limit].' };
      continue;
    }
    if (/^\d+$/.test(arg) && !sawLimit) {
      limit = Number(arg);
      sawLimit = true;
      continue;
    }
    return { ok: false, message: 'Usage: /history --chat <chat-id> [limit].' };
  }
  if (!chatId) return { ok: false, message: 'Usage: /history --chat <chat-id> [limit].' };
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_ROUNDS_LIMIT) {
    return { ok: false, message: `/history --chat <chat-id> [limit], limit range is 1-${MAX_HISTORY_ROUNDS_LIMIT}.` };
  }
  return {
    ok: true,
    chatId,
    limit,
    includeThinking,
    ...(beforeCursor ? { beforeCursor } : {}),
  };
}

function parseProjectHistoryArgs(trimmed) {
  const parsed = splitCommandArgs(trimmed);
  if (!parsed.ok) return parsed;

  let projectPath = '';
  let sessionId = '';
  let limit = DEFAULT_HISTORY_ROUNDS_LIMIT;
  let sawLimit = false;
  let includeThinking = false;
  let beforeCursor = '';
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i];
    if (isHistoryThinkingFlag(arg)) {
      includeThinking = true;
      continue;
    }
    const cursor = readHistoryCursorArg(parsed.args, i);
    if (cursor) {
      if (cursor.invalid) return invalidHistoryCursorUsage();
      if (beforeCursor) return invalidHistoryCursorUsage();
      beforeCursor = cursor.value;
      i = cursor.nextIndex;
      continue;
    }
    if (arg === '--project') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: '用法：/history --project <项目路径> --session <session-id> [数量]。' };
      projectPath = next;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectPath = arg.slice('--project='.length);
      if (!projectPath) return { ok: false, message: '用法：/history --project <项目路径> --session <session-id> [数量]。' };
      continue;
    }
    if (arg === '--session') {
      const next = parsed.args[++i];
      if (!next) return { ok: false, message: '用法：/history --project <项目路径> --session <session-id> [数量]。' };
      sessionId = next;
      continue;
    }
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      if (!sessionId) return { ok: false, message: '用法：/history --project <项目路径> --session <session-id> [数量]。' };
      continue;
    }
    if (/^\d+$/.test(arg) && !sawLimit) {
      limit = Number(arg);
      sawLimit = true;
      continue;
    }
    return { ok: false, message: '用法：/history --project <项目路径> --session <session-id> [数量]。' };
  }
  if (!projectPath || !sessionId) {
    return { ok: false, message: '浏览指定历史时需要同时提供 --project 和 --session。' };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_ROUNDS_LIMIT) {
    return { ok: false, message: `用法：/history --project <项目路径> --session <session-id> [数量]，数量范围 1-${MAX_HISTORY_ROUNDS_LIMIT}。` };
  }
  return {
    ok: true,
    limit,
    projectPath,
    sessionId,
    includeThinking,
    ...(beforeCursor ? { beforeCursor } : {}),
  };
}

function readHistoryCursorArg(args, index) {
  const arg = args[index];
  let value = '';
  let nextIndex = index;
  if (arg === '--before-cursor') {
    value = String(args[index + 1] || '').trim();
    nextIndex = index + 1;
  } else if (arg.startsWith('--before-cursor=')) {
    value = arg.slice('--before-cursor='.length).trim();
  } else {
    return null;
  }
  if (
    !value ||
    value.length > MAX_HISTORY_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return { invalid: true, value: '', nextIndex };
  }
  return { value, nextIndex };
}

function invalidHistoryCursorUsage() {
  return { ok: false, message: 'Usage: /history [--before-cursor <cursor>] [--thinking] [limit].' };
}

function isHistoryThinkingFlag(arg) {
  return arg === '--thinking' || arg === '--with-thinking';
}

function resolveSlashProjectWorkspace(projectPath, currentWorkspace) {
  if (!projectPath) return path.resolve(currentWorkspace || process.cwd());
  return resolveWorkspacePath(projectPath, currentWorkspace);
}

module.exports = {
  parseBindArgs,
  parseChatsArgs,
  parseHistoryArgs,
  parseSessionsArgs,
  resolveSlashProjectWorkspace,
};
