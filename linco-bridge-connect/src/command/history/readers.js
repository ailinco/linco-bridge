
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { _internal: agentPromptInternals } = require('../../core/agentPrompt');
const { candidatePathsFromMarkdownLinks, mimeFromFilename } = require('../../core/fileReferences');
const { SESSION_SUMMARY_SCAN_LIMIT } = require('./constants');
const { sanitizeCodexHostDirectives } = require('../../agent/codex/hostDirectives');
const {
  extractHistoryTimestamp,
  stringOrEmpty,
  timestampToMs,
} = require('./utils');
const {
  decodeHistoryCursor,
  describeHistorySource,
  encodeHistoryCursor,
  historySessionToken,
  historySnapshotId,
  invalidHistoryCursor,
} = require('./cursor');

// Codex JSONL records can contain multi-megabyte context snapshots. A larger
// block avoids repeatedly copying the same partial line while staying bounded.
const HISTORY_READ_BLOCK_SIZE = 1024 * 1024;
const HISTORY_ORDER_SAMPLE_BYTES = 128 * 1024;
const MAX_RECENT_HISTORY_CACHE_SIZE = 24;
const recentHistoryCache = new Map();
const HISTORY_THINKING_KEYS = Symbol('historyThinkingKeys');

const INTERNAL_HINT_PATTERN = new RegExp(
  `\\s*(?:${escapeRegExp(agentPromptInternals.BRIDGE_INPUT_HINT_MARKER)}|System note: The user is asking to send or deliver a file\\/image\\.|系统提示：用户正在要求发送或获取文件\\/图片。)`,
  'u'
);
const CLAUDE_CONTROL_TEXT_PATTERNS = [
  /^<ide_opened_file>[\s\S]*<\/ide_opened_file>$/u,
  /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/u,
  /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/u,
  /^<local-command-stderr>[\s\S]*<\/local-command-stderr>$/u,
  /^<command-name>[\s\S]*?<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>[\s\S]*?<\/command-args>$/u,
];
const CLAUDE_LEADING_CONTROL_TEXT_PATTERNS = [
  /^<ide_opened_file>[\s\S]*?<\/ide_opened_file>[ \t]*(?:\r?\n)+/u,
  /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>[ \t]*(?:\r?\n)+/u,
  /^<local-command-stdout>[\s\S]*?<\/local-command-stdout>[ \t]*(?:\r?\n)+/u,
  /^<local-command-stderr>[\s\S]*?<\/local-command-stderr>[ \t]*(?:\r?\n)+/u,
  /^<command-name>[\s\S]*?<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>[\s\S]*?<\/command-args>[ \t]*(?:\r?\n)+/u,
];

function readClaudeSessionSummary(filePath) {
  const result = { firstMessage: '', lastMessage: '', title: '' };
  readJsonlRecordsUntil(filePath, SESSION_SUMMARY_SCAN_LIMIT, item => {
    if (isClaudeActualUserRecord(item)) {
      const text = extractClaudeUserPrompt(item);
      if (text) {
        result.firstMessage = text;
        return false;
      }
    }
    return true;
  });
  result.lastMessage = readClaudeLatestPrompt(filePath) || result.firstMessage;
  result.title = result.lastMessage || result.firstMessage;
  return result;
}

function readClaudeLatestPrompt(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const recent = readRecentAscendingRecords(
      fd,
      stat.size,
      1,
      'claude',
    ).records;
    let fallback = '';

    for (let index = recent.length - 1; index >= 0; index--) {
      const item = recent[index];
      if (item?.type === 'last-prompt') {
        const text = sanitizeClaudeHistoryUserText(item.lastPrompt);
        if (text) return text;
      }
      if (!fallback && isClaudeActualUserRecord(item)) {
        fallback = extractClaudeUserPrompt(item);
      }
    }
    return fallback;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures while reading local history.
      }
    }
  }
}

function isCodexSubagentSource(threadSource, source) {
  if (stringOrEmpty(threadSource).trim().toLowerCase() === 'subagent') return true;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return Object.prototype.hasOwnProperty.call(source, 'subagent');
  }
  const text = stringOrEmpty(source).trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return !!parsed && typeof parsed === 'object' &&
      Object.prototype.hasOwnProperty.call(parsed, 'subagent');
  } catch {
    return false;
  }
}

function readCodexSessionMeta(filePath) {
  const result = { id: '', cwd: '', firstMessage: '', source: undefined };
  let fallbackFirstMessage = '';
  readJsonlRecordsUntil(filePath, SESSION_SUMMARY_SCAN_LIMIT, item => {
    if (item?.type === 'session_meta') {
      result.id = stringOrEmpty(item.payload?.id || item.id) || result.id;
      result.cwd = stringOrEmpty(item.payload?.cwd || item.cwd) || result.cwd;
      if (Object.prototype.hasOwnProperty.call(item.payload || {}, 'source')) {
        result.source = item.payload.source;
      }
    }

    if (!result.firstMessage) {
      result.firstMessage = extractCodexEventUserText(item);
    }
    if (!fallbackFirstMessage) {
      fallbackFirstMessage = extractCodexUserText(item);
    }
    return !(result.id && result.cwd && result.firstMessage);
  });
  result.firstMessage = result.firstMessage || fallbackFirstMessage;
  return result;
}

function readCodexSessionIndex(filePath) {
  const index = new Map();
  for (const item of readJsonlRecords(filePath, 5000)) {
    const id = stringOrEmpty(item?.id);
    if (!id) continue;
    index.set(id, {
      threadName: stringOrEmpty(item.thread_name || item.threadName),
      updatedAt: stringOrEmpty(item.updated_at || item.updatedAt),
    });
  }
  return index;
}

function readJsonlRecords(filePath, maxRecords = 100) {
  const records = [];
  readJsonlRecordsUntil(filePath, maxRecords, item => {
    records.push(item);
    return records.length < maxRecords;
  });
  return records;
}

function readJsonlRecordsUntil(filePath, maxRecords = 100, visitor = () => true) {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return;
  const limit = Math.floor(maxRecords);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let fd;
  let pending = '';
  let records = 0;

  try {
    fd = fs.openSync(filePath, 'r');
    while (records < limit) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const text = pending + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split('\n');
      pending = lines.pop() || '';
      if (!visitJsonlLines(lines, visitor, () => records++, () => records >= limit)) return;
    }
    const tail = pending + decoder.end();
    if (tail && records < limit) {
      visitJsonlLines([tail], visitor, () => records++, () => records >= limit);
    }
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures while reading local history.
      }
    }
  }
}

function visitJsonlLines(lines, visitor, countRecord, shouldStop) {
  for (const rawLine of lines) {
    const trimmed = String(rawLine || '').replace(/\r$/u, '').trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      countRecord();
      if (visitor(item) === false || shouldStop()) return false;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return true;
}

function parseRecentHistoryRounds(filePath, options = {}) {
  const agentType = stringOrEmpty(options.agentType).toLowerCase();
  const limit = Number(options.limit);
  if (!['claude', 'codex'].includes(agentType)) {
    throw new Error(`Unsupported history agent type: ${agentType || '(empty)'}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid history limit: ${options.limit}`);
  }

  const startedAt = Date.now();
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const decodedCursor = options.beforeCursor
      ? decodeHistoryCursor(options.beforeCursor)
      : null;
    const sessionId = stringOrEmpty(options.sessionId);
    if (decodedCursor && !sessionId) {
      throw invalidHistoryCursor('历史游标缺少会话身份');
    }
    const source = describeHistorySource(
      fd,
      filePath,
      stat,
      decodedCursor?.prefixBytes,
    );
    if (decodedCursor) {
      const cursorSessionToken = historySessionToken(agentType, sessionId);
      if (
        decodedCursor.agentType !== agentType ||
        decodedCursor.sessionToken !== cursorSessionToken ||
        decodedCursor.sourceKey !== source.sourceKey ||
        decodedCursor.prefixHash !== source.prefixHash ||
        stat.size < decodedCursor.snapshotSize
      ) {
        throw invalidHistoryCursor('历史来源或会话已变化');
      }
    }
    const snapshotSize = decodedCursor?.snapshotSize ?? stat.size;
    const sourceVersion = `${stat.ino || 0}:${snapshotSize}:${Math.trunc(stat.mtimeMs || 0)}`;
    const cacheKey = [
      agentType,
      path.resolve(filePath),
      sourceVersion,
      limit,
      options.includeThinking === true ? 'thinking' : 'plain',
      options.beforeCursor || 'latest',
    ].join('|');
    const cached = recentHistoryCache.get(cacheKey);
    if (cached) {
      recentHistoryCache.delete(cacheKey);
      recentHistoryCache.set(cacheKey, cached);
      return {
        rounds: cached.rounds,
        syncMeta: {
          ...cached.syncMeta,
          strategy: 'memory_cache',
          cacheHit: true,
          parseMs: Date.now() - startedAt,
        },
        pageInfo: cached.pageInfo,
      };
    }

    const order = decodedCursor
      ? { storageOrder: decodedCursor.storageOrder, source: 'cursor' }
      : detectHistoryStorageOrder(fd, snapshotSize, agentType);
    const readLimit = limit + 1;
    let selected;
    if (decodedCursor && order.storageOrder === 'descending') {
      selected = readDescendingRecords(
        fd,
        snapshotSize,
        readLimit,
        agentType,
        decodedCursor.boundaryOffset,
      );
    } else if (decodedCursor) {
      selected = readRecentAscendingRecords(
        fd,
        decodedCursor.boundaryOffset,
        readLimit,
        agentType,
      );
    } else if (order.storageOrder === 'descending') {
      selected = readDescendingRecords(
        fd,
        snapshotSize,
        readLimit,
        agentType,
        0,
      );
    } else {
      selected = readRecentAscendingRecords(
        fd,
        snapshotSize,
        readLimit,
        agentType,
      );
    }

    const parsed = agentType === 'codex'
      ? parseCodexHistoryRecords(selected.records, options)
      : parseClaudeHistoryRecords(selected.records, options);
    const rounds = parsed.slice(-limit);
    const hasMore = parsed.length > limit;
    const boundaryRound = rounds[0];
    const boundaryOffset = order.storageOrder === 'descending'
      ? boundaryRound?.sourceEndOffset
      : boundaryRound?.sourceOffset;
    const snapshotId = historySnapshotId(source, snapshotSize);
    const nextCursor = hasMore && Number.isSafeInteger(boundaryOffset)
      ? encodeHistoryCursor({
          agentType,
          sessionId,
          source,
          snapshotSize,
          storageOrder: order.storageOrder,
          boundaryOffset,
        })
      : null;
    const pageInfo = { hasMore, nextCursor, snapshotId };
    const syncMeta = {
      strategy: selected.strategy,
      storageOrder: order.storageOrder,
      orderSource: order.source,
      sourceVersion,
      sourceBytes: snapshotSize,
      currentSourceBytes: stat.size,
      scannedBytes: selected.scannedBytes,
      parsedRecords: selected.records.length,
      returnedRounds: rounds.length,
      thinkingItems: rounds.reduce(
        (total, round) => total + (round.thinkingItems?.length || 0),
        0,
      ),
      cacheHit: false,
      pageMode: decodedCursor ? 'older' : 'latest',
      snapshotId,
      parseMs: Date.now() - startedAt,
    };
    putRecentHistoryCache(cacheKey, { rounds, syncMeta, pageInfo });
    return { rounds, syncMeta, pageInfo };
  } finally {
    fs.closeSync(fd);
  }
}

function putRecentHistoryCache(key, value) {
  recentHistoryCache.set(key, value);
  while (recentHistoryCache.size > MAX_RECENT_HISTORY_CACHE_SIZE) {
    recentHistoryCache.delete(recentHistoryCache.keys().next().value);
  }
}

function detectHistoryStorageOrder(fd, snapshotSize, agentType) {
  if (snapshotSize <= 0) {
    return { storageOrder: 'ascending', source: 'format_default' };
  }
  const sampleBytes = Math.min(HISTORY_ORDER_SAMPLE_BYTES, snapshotSize);
  const head = readJsonlRangeRecords(fd, 0, sampleBytes, {
    includePartialStart: true,
    includePartialEnd: false,
  });
  const tailStart = Math.max(0, snapshotSize - sampleBytes);
  const tail = readJsonlRangeRecords(fd, tailStart, snapshotSize, {
    includePartialStart: tailStart === 0,
    includePartialEnd: true,
  });
  const headTimes = historyOrderTimestamps(head.records, agentType);
  const tailTimes = historyOrderTimestamps(tail.records, agentType);
  if (headTimes.length > 0 && tailTimes.length > 0) {
    const headMedian = median(headTimes);
    const tailMedian = median(tailTimes);
    if (headMedian !== tailMedian) {
      return {
        storageOrder: headMedian < tailMedian ? 'ascending' : 'descending',
        source: 'timestamp_sample',
      };
    }
  }
  return { storageOrder: 'ascending', source: 'format_default' };
}

function historyOrderTimestamps(records, agentType) {
  const values = [];
  for (const item of records) {
    if (!isHistoryConversationRecord(item, agentType)) continue;
    const value = timestampToMs(extractHistoryTimestamp(item));
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function isHistoryConversationRecord(item, agentType) {
  if (agentType === 'claude') {
    return item?.type === 'user' || item?.type === 'assistant';
  }
  if (item?.type === 'event_msg') {
    return item.payload?.type === 'user_message' ||
      item.payload?.type === 'agent_message';
  }
  return item?.type === 'response_item' &&
    item.payload?.type === 'message' &&
    ['user', 'assistant'].includes(item.payload?.role);
}

function isActualHistoryUserRecord(item, agentType) {
  if (agentType === 'claude') return isClaudeActualUserRecord(item);
  if (item?.type !== 'event_msg' || item.payload?.type !== 'user_message') {
    return false;
  }
  const raw = stringOrEmpty(item.payload.message);
  return normalizeCodexUserText(raw).length > 0 ||
    raw.includes('# Files mentioned by the user:');
}

function readRecentAscendingRecords(
  fd,
  snapshotSize,
  limit,
  agentType,
) {
  const located = locateRecentAscendingStart(
    fd,
    snapshotSize,
    limit,
    agentType,
  );
  const range = readJsonlRangeRecords(
    fd,
    located.startOffset,
    snapshotSize,
    { includePartialStart: true, includePartialEnd: true },
  );
  return {
    records: range.records,
    scannedBytes: Math.max(located.scannedBytes, range.scannedBytes),
    strategy: located.found ? 'reverse_tail' : 'full_stream_fallback',
  };
}

function locateRecentAscendingStart(
  fd,
  snapshotSize,
  limit,
  agentType,
) {
  let position = snapshotSize;
  let carry = Buffer.alloc(0);
  let userCount = 0;
  let scannedBytes = 0;

  while (position > 0) {
    const start = Math.max(0, position - HISTORY_READ_BLOCK_SIZE);
    const chunk = Buffer.allocUnsafe(position - start);
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, start);
    const data = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
    scannedBytes += bytesRead;
    let lineEnd = data.length;
    let earliestNewline = -1;

    for (let index = data.length - 1; index >= 0; index--) {
      if (data[index] !== 0x0a) continue;
      earliestNewline = index;
      const lineStart = index + 1;
      const item = parseJsonlBuffer(
        data.subarray(lineStart, lineEnd),
        start + lineStart,
      );
      if (item && isActualHistoryUserRecord(item, agentType)) {
        userCount += 1;
        if (userCount >= limit) {
          return {
            startOffset: start + lineStart,
            scannedBytes,
            found: true,
          };
        }
      }
      lineEnd = index;
    }

    if (start === 0) {
      const item = parseJsonlBuffer(data.subarray(0, lineEnd), 0);
      if (item && isActualHistoryUserRecord(item, agentType)) {
        userCount += 1;
      }
      return { startOffset: 0, scannedBytes, found: userCount >= limit };
    }
    carry = earliestNewline >= 0
      ? data.subarray(0, earliestNewline)
      : data;
    position = start;
  }
  return { startOffset: 0, scannedBytes, found: false };
}

function readDescendingRecords(
  fd,
  snapshotSize,
  limit,
  agentType,
  startOffset,
) {
  const records = [];
  let userCount = 0;
  const range = readJsonlRangeRecords(fd, startOffset, snapshotSize, {
    includePartialStart: true,
    includePartialEnd: true,
    visitor(item) {
      records.push(item);
      if (isActualHistoryUserRecord(item, agentType)) userCount += 1;
      return userCount < limit;
    },
  });
  records.reverse();
  return {
    records,
    scannedBytes: range.scannedBytes,
    strategy: 'forward_head',
  };
}

function readJsonlRangeRecords(fd, start, end, options = {}) {
  const records = [];
  const visitor = options.visitor || (() => true);
  let position = start;
  let pending = Buffer.alloc(0);
  let pendingOffset = start;
  let scannedBytes = 0;
  let firstChunk = true;
  let shouldContinue = true;

  while (position < end && shouldContinue) {
    const length = Math.min(HISTORY_READ_BLOCK_SIZE, end - position);
    const chunk = Buffer.allocUnsafe(length);
    const chunkStart = position;
    const bytesRead = fs.readSync(fd, chunk, 0, length, chunkStart);
    if (bytesRead <= 0) break;
    scannedBytes += bytesRead;
    position += bytesRead;
    let data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let dataOffset = pending.length > 0 ? pendingOffset : chunkStart;
    if (firstChunk && start > 0 && options.includePartialStart !== true) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) {
        data = Buffer.alloc(0);
        dataOffset = position;
      } else {
        data = data.subarray(newline + 1);
        dataOffset += newline + 1;
      }
    }
    firstChunk = false;
    let lineStart = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const item = parseJsonlBuffer(
        data.subarray(lineStart, index),
        dataOffset + lineStart,
        dataOffset + index + 1,
      );
      if (item) {
        records.push(item);
        if (options.visitor && visitor(item) === false) {
          shouldContinue = false;
          break;
        }
      }
      lineStart = index + 1;
    }
    pending = shouldContinue ? data.subarray(lineStart) : Buffer.alloc(0);
    pendingOffset = dataOffset + lineStart;
  }

  if (shouldContinue && pending.length > 0 && options.includePartialEnd === true) {
    const item = parseJsonlBuffer(
      pending,
      pendingOffset,
      pendingOffset + pending.length,
    );
    if (item) {
      records.push(item);
      if (options.visitor) visitor(item);
    }
  }
  return { records, scannedBytes };
}

function parseJsonlBuffer(buffer, byteOffset, byteEndOffset) {
  const value = buffer.toString('utf8').replace(/\r$/u, '').trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        Number.isInteger(byteOffset) && byteOffset >= 0) {
      Object.defineProperty(parsed, '__historyByteOffset', {
        value: byteOffset,
        enumerable: false,
      });
      Object.defineProperty(parsed, '__historyByteEndOffset', {
        value: Number.isInteger(byteEndOffset)
          ? byteEndOffset
          : byteOffset + buffer.length,
        enumerable: false,
      });
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractCodexUserText(item) {
  if (item?.type === 'response_item' && item.payload?.type === 'message' && item.payload?.role === 'user') {
    return normalizeCodexUserText(extractTextFromMessageContent(item.payload.content));
  }
  if (item?.type === 'message' && item.role === 'user') {
    return normalizeCodexUserText(extractTextFromMessageContent(item.content));
  }
  return '';
}

function extractCodexEventUserText(item) {
  if (item?.type !== 'event_msg' || item.payload?.type !== 'user_message') return '';
  return normalizeCodexUserText(item.payload.message);
}

function normalizeCodexUserText(text) {
  const value = stripCodexFileReferenceHint(unwrapCodexUserRequest(stringOrEmpty(text)));
  if (!value) return '';
  if (isCodexSyntheticUserContext(value)) return '';
  return value;
}

function unwrapCodexUserRequest(text) {
  const value = stringOrEmpty(text);
  if (!value) return '';
  const marker = value.match(/^##\s+My request for Codex:\s*$/im);
  if (!marker || marker.index === undefined) return value;
  const request = value.slice(marker.index + marker[0].length).trim();
  return request || value;
}

function stripCodexFileReferenceHint(text) {
  const value = stringOrEmpty(text);
  if (!value) return '';
  return value.split(INTERNAL_HINT_PATTERN)[0].trim();
}

function normalizeCodexTitle(text) {
  return normalizeCodexUserText(text);
}

function isCodexSyntheticUserContext(text) {
  return /^<environment_context>\s*[\s\S]*<\/environment_context>$/u.test(String(text || '').trim());
}

function extractTextFromMessageContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (typeof part?.text === 'string') {
      parts.push(part.text);
    } else if (typeof part?.content === 'string') {
      parts.push(part.content);
    } else if (typeof part?.input_text === 'string') {
      parts.push(part.input_text);
    }
  }
  return parts.join(' ').trim();
}

function parseClaudeHistoryRounds(filePath, options = {}) {
  return parseClaudeHistoryRecords(
    readJsonlRecords(filePath, Number.MAX_SAFE_INTEGER),
    options,
  );
}

function parseClaudeHistoryRecords(records, options = {}) {
  const rounds = [];
  let current = null;
  const includeThinking = options.includeThinking === true;

  for (const item of records) {
    if (isClaudeActualUserRecord(item)) {
      const userPayload = extractClaudeUserPayload(item);
      current = {
        ordinal: rounds.length + 1,
        user: userPayload.text,
        identityUser: userPayload.rawText,
        userFiles: userPayload.files,
        assistant: '',
        assistantFiles: [],
        userTimestamp: extractHistoryTimestamp(item),
        sourceOffset: item.__historyByteOffset,
        sourceEndOffset: item.__historyByteEndOffset,
      };
      if (includeThinking) {
        current.thinkingItems = [];
        current._pendingThinkingText = '';
      }
      if (userPayload.text || userPayload.files.length > 0) rounds.push(current);
      continue;
    }

    if (!current || !isClaudeAssistantRecord(item)) continue;
    const content = item?.message?.content;
    if (includeThinking) {
      collectClaudeHistoryThinking(current, content, extractHistoryTimestamp(item));
    }
    const text = extractClaudeAssistantText(item);
    const files = extractClaudeContentFiles(content);
    if (text) {
      current.assistant = text;
      current.assistantTimestamp = extractHistoryTimestamp(item);
      if (includeThinking) current._pendingThinkingText = text;
    }
    if (files.length > 0) {
      current.assistantFiles = files;
    }
  }

  if (includeThinking) {
    for (const round of rounds) delete round._pendingThinkingText;
  }

  return rounds.filter(round => round.user || round.assistant || round.userFiles?.length || round.assistantFiles?.length);
}

function isClaudeActualUserRecord(item) {
  if (item?.type !== 'user' || item.message?.role !== 'user') return false;
  if (item.toolUseResult || item.sourceToolAssistantUUID) return false;
  const content = item.message?.content ?? item.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return false;
  const payload = extractClaudeUserPayload(item);
  return !!payload.text || payload.files.length > 0;
}

function extractClaudeContentFiles(content) {
  if (!Array.isArray(content)) return [];
  const files = [];
  let imageIndex = 0;

  for (const block of content) {
    if (block?.type === 'image' && block.source?.type === 'base64') {
      imageIndex += 1;
      const mimeType = stringOrEmpty(block.source.media_type) || 'image/png';
      const base64 = stringOrEmpty(block.source.data);
      if (!base64) continue;
      files.push({
        name: `image-${imageIndex}.${mimeType.includes('jpeg') ? 'jpg' : 'png'}`,
        mimeType,
        base64,
      });
      continue;
    }

    if (block?.type === 'document' && block.source?.type === 'base64') {
      const mimeType = stringOrEmpty(block.source.media_type) || 'application/octet-stream';
      const base64 = stringOrEmpty(block.source.data);
      if (!base64) continue;
      files.push({
        name: stringOrEmpty(block.name) || 'document',
        mimeType,
        base64,
      });
    }
  }

  return files;
}

function extractClaudeUserPayload(item) {
  const content = item?.message?.content ?? item?.content;
  if (typeof content === 'string') {
    const rawText = content.trim();
    return {
      text: sanitizeClaudeHistoryUserText(rawText),
      rawText,
      files: [],
    };
  }
  if (!Array.isArray(content)) {
    return { text: '', rawText: '', files: [] };
  }
  const textBlocks = content
    .filter(block => block?.type === 'text')
    .map(block => stringOrEmpty(block.text));
  const rawText = textBlocks
    .join('\n')
    .trim();
  const text = textBlocks
    .map(sanitizeClaudeHistoryUserText)
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    text,
    rawText,
    files: extractClaudeContentFiles(content),
  };
}

function sanitizeClaudeHistoryUserText(value) {
  let text = stringOrEmpty(value).trim();
  if (!text || CLAUDE_CONTROL_TEXT_PATTERNS.some(pattern => pattern.test(text))) {
    return '';
  }

  let changed = true;
  while (changed && text) {
    changed = false;
    for (const pattern of CLAUDE_LEADING_CONTROL_TEXT_PATTERNS) {
      const stripped = text.replace(pattern, '').trimStart();
      if (stripped === text) continue;
      text = stripped;
      changed = true;
      break;
    }
  }
  return text.trim();
}

function extractClaudeUserPrompt(item) {
  return extractClaudeUserPayload(item).text;
}

function isClaudeAssistantRecord(item) {
  return item?.type === 'assistant' && item.message?.role === 'assistant';
}

function extractClaudeAssistantText(item) {
  const content = item?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n')
    .trim();
}

function collectClaudeHistoryThinking(round, content, timestamp) {
  if (!round || !Array.isArray(content)) return;
  for (const block of content) {
    if (isClaudeThinkingBlock(block)) {
      const text = extractClaudeThinkingBlockText(block);
      appendHistoryThinking(round, text, 'summary', timestamp);
      continue;
    }
    if (block?.type === 'text' && block.text) {
      round._pendingThinkingText = block.text;
      continue;
    }
    if (block?.type === 'tool_use') {
      appendHistoryThinking(round, round._pendingThinkingText, 'progress', timestamp);
      round._pendingThinkingText = '';
    }
  }
}

function isClaudeThinkingBlock(block) {
  const type = stringOrEmpty(block?.type).toLowerCase();
  return type.includes('thinking') || type.includes('reasoning');
}

function extractClaudeThinkingBlockText(block) {
  if (!block || typeof block !== 'object') return '';
  return stringOrEmpty(block.thinking || block.text || block.summary || block.content);
}

function readLocalHistoryFileAttachment(filePath, maxBytes = 4 * 1024 * 1024) {
  try {
    const resolved = path.resolve(String(filePath || '').trim());
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const name = path.basename(resolved);
    return {
      name,
      mimeType: mimeFromFilename(name),
      path: resolved,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function extractCodexMentionedUserFiles(message) {
  const text = stringOrEmpty(message);
  if (!text.includes('# Files mentioned by the user:')) return [];

  const files = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const match = line.match(/^##\s+([^:]+):\s+(.+)$/);
    if (!match) continue;
    const label = match[1].trim();
    const filePath = match[2].trim();
    const attachment = readLocalHistoryFileAttachment(filePath);
    if (attachment) {
      files.push({ ...attachment, name: label || attachment.name });
    }
  }
  return files;
}

function extractCodexAssistantFiles(text) {
  const files = [];
  const seen = new Set();
  for (const filePath of candidatePathsFromMarkdownLinks(text)) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const attachment = readLocalHistoryFileAttachment(resolved);
    if (attachment) files.push(attachment);
  }
  return files;
}

function parseCodexHistoryRounds(filePath, options = {}) {
  return parseCodexHistoryRecords(
    readJsonlRecords(filePath, Number.MAX_SAFE_INTEGER),
    options,
  );
}

function parseCodexHistoryRecords(records, options = {}) {
  const rounds = [];
  let current = null;
  const includeThinking = options.includeThinking === true;

  for (const item of records) {
    const payload = item?.payload || {};

    if (includeThinking && current) {
      collectCodexHistoryThinking(current, item, extractHistoryTimestamp(item));
    }

    if (item?.type !== 'event_msg') continue;

    if (payload.type === 'user_message') {
      const text = normalizeCodexUserText(payload.message);
      const userFiles = extractCodexMentionedUserFiles(payload.message);
      if (!text && userFiles.length === 0) continue;
      current = {
        ordinal: rounds.length + 1,
        user: text,
        userFiles,
        assistant: '',
        assistantFiles: [],
        userTimestamp: extractHistoryTimestamp(item),
        sourceOffset: item.__historyByteOffset,
        sourceEndOffset: item.__historyByteEndOffset,
      };
      if (includeThinking) current.thinkingItems = [];
      rounds.push(current);
      continue;
    }

    if (!current) continue;
    if (payload.type === 'agent_message' && payload.phase === 'final_answer') {
      const text = sanitizeCodexHistoryAssistantText(payload.message);
      const assistantFiles = extractCodexAssistantFiles(text);
      if (text) {
        current.assistant = text;
        current.assistantTimestamp = extractHistoryTimestamp(item);
      }
      if (assistantFiles.length > 0) {
        current.assistantFiles = assistantFiles;
      }
    }
  }

  return rounds.filter(round =>
    round.user ||
    round.assistant ||
    round.userFiles?.length ||
    round.assistantFiles?.length,
  );
}

function collectCodexHistoryThinking(round, item, timestamp) {
  if (!round || !item || typeof item !== 'object') return;
  const payload = item.payload || {};

  if (item.type === 'event_msg') {
    if (payload.type === 'agent_message') {
      const phase = stringOrEmpty(payload.phase);
      if (phase && phase !== 'final_answer') {
        appendHistoryThinking(round, sanitizeCodexHistoryAssistantText(payload.message), 'progress', timestamp);
      }
      return;
    }
    if (isCodexHistoryReasoningPayload(payload)) {
      appendHistoryThinking(round, extractCodexHistoryThinkingText(payload), 'summary', timestamp);
    }
    return;
  }

  if (item.type !== 'response_item') return;
  if (isCodexHistoryReasoningPayload(payload)) {
    appendHistoryThinking(round, extractCodexHistoryThinkingText(payload), 'summary', timestamp);
    return;
  }
  if (payload.type === 'message' && payload.role === 'assistant') {
    const phase = stringOrEmpty(payload.phase);
    if (phase && phase !== 'final_answer') {
      appendHistoryThinking(
        round,
        sanitizeCodexHistoryAssistantText(extractTextFromMessageContent(payload.content)),
        'progress',
        timestamp,
      );
    }
  }
}

function isCodexHistoryReasoningPayload(payload) {
  const type = stringOrEmpty(payload?.type).toLowerCase();
  const itemType = stringOrEmpty(payload?.item?.type).toLowerCase();
  return type.includes('reasoning') ||
    type.includes('thinking') ||
    itemType.includes('reasoning') ||
    itemType.includes('thinking');
}

function extractCodexHistoryThinkingText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.delta === 'string') return payload.delta;
  if (typeof payload.summary === 'string') return payload.summary;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.item?.text === 'string') return payload.item.text;
  if (typeof payload.item?.summary === 'string') return payload.item.summary;
  if (Array.isArray(payload.summary)) return extractTextFromMessageContent(payload.summary);
  if (Array.isArray(payload.content)) return extractTextFromMessageContent(payload.content);
  if (Array.isArray(payload.item?.content)) return extractTextFromMessageContent(payload.item.content);
  if (Array.isArray(payload.item?.summary)) return extractTextFromMessageContent(payload.item.summary);
  return '';
}

function sanitizeCodexHistoryAssistantText(value) {
  return sanitizeCodexHostDirectives(stringOrEmpty(value));
}

function appendHistoryThinking(round, value, mode, timestamp) {
  const text = stringOrEmpty(value);
  if (!text) return;
  if (!Array.isArray(round.thinkingItems)) round.thinkingItems = [];
  if (!(round[HISTORY_THINKING_KEYS] instanceof Set)) {
    round[HISTORY_THINKING_KEYS] = new Set(
      round.thinkingItems.map(item => `${item.mode || 'summary'}\u0000${item.text}`),
    );
  }
  const normalizedMode = mode || 'summary';
  const key = `${normalizedMode}\u0000${text}`;
  if (round[HISTORY_THINKING_KEYS].has(key)) return;
  round[HISTORY_THINKING_KEYS].add(key);
  round.thinkingItems.push({
    text,
    mode: normalizedMode,
    timestamp: timestamp || null,
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  extractClaudeContentFiles,
  extractCodexAssistantFiles,
  extractCodexMentionedUserFiles,
  extractTextFromMessageContent,
  isCodexSubagentSource,
  normalizeCodexTitle,
  parseClaudeHistoryRounds,
  parseCodexHistoryRounds,
  parseRecentHistoryRounds,
  readClaudeSessionSummary,
  readCodexSessionIndex,
  readCodexSessionMeta,
  readJsonlRecords,
};
