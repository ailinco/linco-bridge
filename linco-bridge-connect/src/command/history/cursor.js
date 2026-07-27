const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HISTORY_CURSOR_VERSION = 1;
const HISTORY_CURSOR_PREFIX_BYTES = 4096;
const MAX_HISTORY_CURSOR_LENGTH = 2048;

function historySessionToken(agentType, sessionId) {
  return digest([String(agentType || ''), String(sessionId || '')].join('\u0000'));
}

function describeHistorySource(fd, filePath, stat, prefixBytes) {
  const requestedPrefixBytes = Number.isInteger(prefixBytes)
    ? prefixBytes
    : Math.min(Number(stat.size) || 0, HISTORY_CURSOR_PREFIX_BYTES);
  if (requestedPrefixBytes < 0 || requestedPrefixBytes > stat.size) {
    throw invalidHistoryCursor('历史文件已被截断');
  }
  const prefix = Buffer.allocUnsafe(requestedPrefixBytes);
  const bytesRead = requestedPrefixBytes > 0
    ? fs.readSync(fd, prefix, 0, requestedPrefixBytes, 0)
    : 0;
  const sourceKey = digest(JSON.stringify([
    path.resolve(filePath),
    Number(stat.dev) || 0,
    Number(stat.ino) || 0,
    Math.trunc(Number(stat.birthtimeMs) || 0),
  ]));
  return {
    sourceKey,
    prefixBytes: bytesRead,
    prefixHash: digest(prefix.subarray(0, bytesRead)),
  };
}

function encodeHistoryCursor(input) {
  const payload = {
    v: HISTORY_CURSOR_VERSION,
    a: input.agentType,
    s: historySessionToken(input.agentType, input.sessionId),
    f: input.source.sourceKey,
    n: input.source.prefixBytes,
    h: input.source.prefixHash,
    z: input.snapshotSize,
    d: input.storageOrder === 'descending' ? 'd' : 'a',
    p: input.boundaryOffset,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeHistoryCursor(rawCursor) {
  const raw = String(rawCursor || '').trim();
  if (!raw || raw.length > MAX_HISTORY_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw invalidHistoryCursor('历史游标格式无效');
  }
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid payload');
    }
    if (
      value.v !== HISTORY_CURSOR_VERSION ||
      !['claude', 'codex'].includes(value.a) ||
      typeof value.s !== 'string' ||
      typeof value.f !== 'string' ||
      !Number.isInteger(value.n) ||
      value.n < 0 ||
      value.n > HISTORY_CURSOR_PREFIX_BYTES ||
      typeof value.h !== 'string' ||
      !Number.isSafeInteger(value.z) ||
      value.z < 0 ||
      !['a', 'd'].includes(value.d) ||
      !Number.isSafeInteger(value.p) ||
      value.p < 0 ||
      value.p > value.z
    ) {
      throw new Error('invalid fields');
    }
    return {
      agentType: value.a,
      sessionToken: value.s,
      sourceKey: value.f,
      prefixBytes: value.n,
      prefixHash: value.h,
      snapshotSize: value.z,
      storageOrder: value.d === 'd' ? 'descending' : 'ascending',
      boundaryOffset: value.p,
    };
  } catch (error) {
    if (error?.code === 'bridge_history_cursor_invalid') throw error;
    throw invalidHistoryCursor('历史游标无法解析');
  }
}

function historySnapshotId(source, snapshotSize) {
  return `bridge_history_snapshot_${digest(JSON.stringify([
    source.sourceKey,
    source.prefixHash,
    snapshotSize,
  ]))}`;
}

function invalidHistoryCursor(message) {
  const error = new Error(`bridge_history_cursor_invalid: ${message}`);
  error.code = 'bridge_history_cursor_invalid';
  return error;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

module.exports = {
  MAX_HISTORY_CURSOR_LENGTH,
  decodeHistoryCursor,
  describeHistorySource,
  encodeHistoryCursor,
  historySessionToken,
  historySnapshotId,
  invalidHistoryCursor,
};
