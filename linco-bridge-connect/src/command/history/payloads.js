
const { createHash } = require('node:crypto');
const { buildPcResumeCommand } = require('../pc');
const { projectAction, quoteProjectPath } = require('../project');
const {
  formatDateTime,
  timestampToMs,
  truncateText,
} = require('./utils');

const CODEX_PUBLIC_ATTACHMENT_MARKER =
  /^\s*【(?:文件|图片)：([^】]+)】(?:\s*\([^\r\n]*\))?\s*$/u;
const CODEX_PARSED_ATTACHMENT_MARKER = /^\s*【附件：([^】]+)】\s*$/u;

function normalizeAttachmentName(value) {
  return String(value || '').trim().normalize('NFC');
}

function sanitizeCodexHistoryUserText(value) {
  const raw = String(value || '');
  if (!raw.includes('【附件：')) return raw;

  const visibleLines = [];
  const publicAttachmentNames = new Set();
  let skippingParsedContext = false;
  let removedParsedContext = false;

  for (const line of raw.split(/\r\n|\n|\r/u)) {
    const publicMarker = line.match(CODEX_PUBLIC_ATTACHMENT_MARKER);
    if (publicMarker) {
      publicAttachmentNames.add(normalizeAttachmentName(publicMarker[1]));
      if (skippingParsedContext &&
          visibleLines.length > 0 &&
          visibleLines[visibleLines.length - 1].trim()) {
        visibleLines.push('');
      }
      skippingParsedContext = false;
      visibleLines.push(line);
      continue;
    }

    const parsedMarker = line.match(CODEX_PARSED_ATTACHMENT_MARKER);
    if (!skippingParsedContext && parsedMarker) {
      const attachmentName = normalizeAttachmentName(parsedMarker[1]);
      if (publicAttachmentNames.has(attachmentName)) {
        skippingParsedContext = true;
        removedParsedContext = true;
        continue;
      }
    }

    if (!skippingParsedContext) visibleLines.push(line);
  }

  return removedParsedContext ? visibleLines.join('\n').trim() : raw;
}

function formatLocalProjectSessions(agentType, workspace, sessions, requestedLimit) {
  const lines = sessions.map((item, index) => {
    const command = buildPcResumeCommand(agentType, item.workspace || workspace, item.id);
    const title = truncateText(item.title || item.firstMessage || item.id, 80);
    return [
      `${index + 1}. ${title}`,
      `   ID: ${item.id}`,
      `   更新时间: ${formatDateTime(item.updatedAt)}`,
      `   恢复: ${command.text}`,
    ].join('\n');
  });
  return `当前工作目录最近 ${sessions.length} 个 ${agentType} session（请求 ${requestedLimit} 个）：\n${workspace}\n\n${lines.join('\n\n')}`;
}

function buildSessionsPayload(agentType, workspace, sessions, actions, requestedLimit) {
  return {
    version: 1,
    agentType,
    workspace,
    requestedLimit,
    returnedCount: sessions.length,
    items: sessions.map((item, index) => {
      const sessionWorkspace = item.workspace || workspace;
      const resumeCommand = buildPcResumeCommand(agentType, sessionWorkspace, item.id);
      return {
        index: index + 1,
        id: item.id,
        title: item.title || item.firstMessage || item.id,
        firstMessage: item.firstMessage || '',
        lastMessage: item.lastMessage || '',
        updatedAt: item.updatedAt || 0,
        updatedAtText: formatDateTime(item.updatedAt),
        transcriptPath: item.transcriptPath || '',
        workspace: sessionWorkspace,
        bindCommand: actions[index]?.command || `/bind ${quoteProjectPath(item.id)}`,
        resumeCommand,
      };
    }),
  };
}

function buildChatsPayload(chats, actions, requestedLimit) {
  return {
    version: 1,
    agentType: 'codex',
    requestedLimit,
    returnedCount: chats.length,
    items: chats.map((item, index) => ({
      index: index + 1,
      id: item.id,
      title: item.title || item.firstMessage || item.id,
      firstMessage: item.firstMessage || '',
      workspace: item.workspace || '',
      updatedAt: item.updatedAt || 0,
      updatedAtText: formatDateTime(item.updatedAt),
      transcriptPath: item.transcriptPath || '',
      source: item.source || 'codex-chats',
      historyCommand: `/history --chat ${quoteProjectPath(item.id)}`,
      bindCommand: actions[index]?.command || `/bind --chat ${quoteProjectPath(item.id)}`,
      resumeCommand: item.workspace ? buildPcResumeCommand('codex', item.workspace, item.id) : null,
    })),
  };
}

function formatHistoryRounds(agentType, sessionId, rounds, requestedLimit) {
  const lines = rounds.map((round, index) => {
    const user = round.user || '(无用户输入)';
    const assistant = round.assistant || '(无最终输出)';
    return [
      `${index + 1}. User`,
      user,
      '',
      'Assistant',
      assistant,
    ].join('\n');
  });
  return `当前 ${agentType} session 最近 ${rounds.length} 轮聊天（请求 ${requestedLimit} 轮）：\nAgent session: ${sessionId}\n\n${lines.join('\n\n')}`;
}

function mapRoundThinking(items) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const mapped = items
    .map((item) => ({
      text: String(item?.text || '').trim(),
      mode: item?.mode || 'summary',
      timestamp: item?.timestamp || null,
      timestampMs: timestampToMs(item?.timestamp),
    }))
    .filter((item) => item.text);
  if (mapped.length === 0) return undefined;
  return {
    text: mapped.map((item) => item.text).join('\n\n'),
    missing: false,
    items: mapped,
  };
}

function stableHistoryRoundIdentity(agentType, sessionId, round, ordinal) {
  const normalizedUser = String(round.identityUser || round.user || '')
    .replace(/\s+/gu, ' ')
    .trim();
  const userTimestampMs = timestampToMs(round.userTimestamp) || 0;
  const sourceOffset = Number.isInteger(round.sourceOffset) && round.sourceOffset >= 0
    ? round.sourceOffset
    : 0;
  const digest = createHash('sha256')
    .update(JSON.stringify([
      String(agentType || ''),
      String(sessionId || ''),
      userTimestampMs,
      normalizedUser,
      sourceOffset || (userTimestampMs ? 0 : ordinal),
    ]))
    .digest('hex')
    .slice(0, 24);
  const sessionToken = Buffer.from(String(sessionId || ''), 'utf8').toString('base64url');
  return {
    roundId: `bridge_round_${digest}`,
    messageIdPrefix: `bridge_history_v2:${sessionToken}:${digest}`,
  };
}

function buildHistoryPayload(agentType, sessionId, requestedLimit, rounds, options = {}) {
  const payload = {
    version: options.pageInfo ? 3 : 2,
    agentType,
    agentSessionId: sessionId,
    workspace: options.workspace || undefined,
    replaceConversation: options.replaceConversation === true,
    switchedSession: options.switchedSession === true,
    requestedLimit,
    returnedRounds: rounds.length,
    rounds: rounds.map((round, index) => {
      const ordinal = Number.isInteger(round.ordinal) && round.ordinal > 0
        ? round.ordinal
        : index + 1;
      const identity = stableHistoryRoundIdentity(
        agentType,
        sessionId,
        round,
        ordinal,
      );
      const payloadRound = {
        index: index + 1,
        ordinal,
        roundId: identity.roundId,
        timestamp: round.userTimestamp || round.assistantTimestamp || null,
        timestampMs: timestampToMs(round.userTimestamp || round.assistantTimestamp),
        user: {
          messageId: `${identity.messageIdPrefix}:user`,
          text: agentType === 'codex'
            ? sanitizeCodexHistoryUserText(round.user)
            : round.user || '',
          timestamp: round.userTimestamp || null,
          timestampMs: timestampToMs(round.userTimestamp),
        },
        assistant: {
          messageId: round.assistant
            ? `${identity.messageIdPrefix}:assistant`
            : undefined,
          text: round.assistant || '',
          missing: !round.assistant,
          timestamp: round.assistantTimestamp || null,
          timestampMs: timestampToMs(round.assistantTimestamp),
        },
      };
      const thinking = mapRoundThinking(round.thinkingItems);
      if (thinking) payloadRound.thinking = thinking;
      return payloadRound;
    }),
  };
  if (options.pageInfo && typeof options.pageInfo === 'object') {
    payload.pageInfo = {
      hasMore: options.pageInfo.hasMore === true,
      nextCursor: options.pageInfo.nextCursor || null,
      snapshotId: options.pageInfo.snapshotId || null,
    };
  }
  if (options.syncMeta && typeof options.syncMeta === 'object') {
    payload.syncMeta = { ...options.syncMeta };
    payload.syncMeta.payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  }
  return payload;
}

function buildBindActions(sessions, workspace = '') {
  return sessions.map((item, index) => {
    const sessionWorkspace = workspace ? item.workspace || workspace : '';
    const command = sessionWorkspace
      ? `/bind --project ${quoteProjectPath(sessionWorkspace)} ${quoteProjectPath(item.id)}`
      : `/bind ${quoteProjectPath(item.id)}`;
    return projectAction(`Bind session ${index + 1}`, command, {
      action: 'bind',
      agentSessionId: item.id,
      sessionId: item.id,
      path: sessionWorkspace || undefined,
    });
  });
}

function buildChatBindActions(chats) {
  return chats.map((item, index) => projectAction(`Bind chat ${index + 1}`, `/bind --chat ${quoteProjectPath(item.id)}`, {
    action: 'bind',
    agentSessionId: item.id,
    sessionId: item.id,
    chatId: item.id,
    path: item.workspace || undefined,
  }));
}

module.exports = {
  buildBindActions,
  buildChatBindActions,
  buildChatsPayload,
  buildHistoryPayload,
  buildSessionsPayload,
  formatHistoryRounds,
  formatLocalProjectSessions,
  sanitizeCodexHistoryUserText,
};
