const {
  buildMarkdownImageFallback,
  extractFileReferences,
} = require("../../core/fileReferences");
const {
  isLincoMessage,
  lincoFilesToAttachments,
  normalizeLincoFiles,
  normalizeOutboundFiles,
  buildStreamId,
  lincoMetaDefaults,
  pruneUndefined,
} = require("../../package/protocol");

const HISTORY_RESULT_SINGLE_FRAME_MAX_BYTES = 256 * 1024;
const HISTORY_RESULT_CHUNK_BASE64_CHARS = 128 * 1024;

function toInternal(msg) {
  if (msg.type === "inbound_message") {
    return {
      _lincoMode: true,
      type: "message",
      text: String(msg.text || "").trim(),
      attachments: lincoFilesToAttachments(normalizeLincoFiles(msg)),
      openclawAgentId: msg.openclawAgentId,
      agentId: msg.agentId,
      _lincoMeta: {
        accountId: msg.accountId,
        messageId: msg.messageId,
        agentId: msg.agentId,
        openclawAgentId: msg.openclawAgentId,
      },
    };
  }
  return { ...msg };
}

function createLincoAdapter(rawWs, session, config) {
  const linco = session.linco || {};
  linco.fullText = linco.fullText || "";
  linco.finalText = linco.finalText || "";
  linco.progressText = linco.progressText || "";
  linco.thinkingText = linco.thinkingText || "";
  linco.streamId = linco.streamId || `linco-stream-${Date.now()}`;
  linco.toolStartedAtById = linco.toolStartedAtById || new Map();
  linco.agentActionStartedAtById = linco.agentActionStartedAtById || new Map();
  session.linco = linco;

  const closed = { current: false };

  return {
    send(jsonString) {
      let event;
      try {
        event = JSON.parse(jsonString);
      } catch {
        event = { type: "system", text: String(jsonString || "") };
      }
      const payload = mapLocalEventToLinco(event, session, config, linco);
      if (!payload || closed.current) return;
      if (Array.isArray(payload)) {
        for (const item of payload) {
          rawWs.send(JSON.stringify(wrapLincoEnvelope(item, config, session)));
        }
        return;
      }
      const wrapped = wrapLincoEnvelope(payload, config, session);
      rawWs.send(JSON.stringify(wrapped));
    },
    rawSend(data) {
      if (!closed.current) rawWs.send(data);
    },
    close() {
      closed.current = true;
    },
    get readyState() {
      return rawWs.readyState;
    },
  };
}

function wrapLincoEnvelope(payload, config, session) {
  const meta = lincoMetaDefaults(config, {});
  return pruneUndefined({
    ...payload,
    from:
      payload.from ||
      session?.agentType ||
      (config.agents ? Object.keys(config.agents)[0] : "claude"),
    to: payload.to || "robot",
    source: payload.source || "ws",
    ts: payload.ts || Date.now(),
    accountId: payload.accountId || meta.accountId,
    agentId: payload.agentId || meta.agentId,
    channel: payload.channel || meta.channel,
  });
}

function mapLocalEventToLinco(event, session, config, linco) {
  const meta = lincoMetaDefaults(config, linco || {});
  const base = {
    accountId: meta.accountId,
    agentId: meta.agentId,
    userId: meta.userId,
    chatType: meta.chatType,
    targetType: meta.targetType,
    targetId: meta.targetId,
    sessionKey: session.id,
    streamId: meta.streamId,
    messageId: meta.messageId,
  };

  switch (event.type) {
    case "turn_start":
      linco.hasDeliveredMedia = false;
      return {
        ...base,
        type: "turn_start",
        reason: event.reason || "started",
        ts: Date.now(),
      };
    case "assistant_start":
      linco.fullText = "";
      linco.finalText = "";
      linco.progressText = "";
      linco.hasEphemeralChunks = false;
      linco.hasFinalChunks = false;
      if (linco.hasDeliveredMedia === undefined) {
        linco.hasDeliveredMedia = false;
      }
      linco.streamId = linco.streamId || `linco-stream-${Date.now()}`;
      return null;
    case "assistant_chunk": {
      const delta = String(event.text || "");
      const phase = normalizeStreamChunkPhase(event.phase);
      const ephemeral = event.ephemeral === true || phase === "progress";
      const replacePrevious =
        event.replacePrevious === true ||
        (!ephemeral && linco.hasEphemeralChunks && !linco.hasFinalChunks);

      linco.fullText = `${linco.fullText || ""}${delta}`;
      if (ephemeral) {
        linco.progressText = `${linco.progressText || ""}${delta}`;
        linco.hasEphemeralChunks = true;
      } else {
        linco.finalText = `${linco.finalText || ""}${delta}`;
        linco.hasFinalChunks = true;
      }

      return {
        ...base,
        type: "stream_chunk",
        mode: "chunk",
        streamId: linco.streamId,
        delta,
        fullText: ephemeral ? linco.progressText : linco.finalText,
        phase,
        ephemeral,
        replacePrevious,
        done: false,
      };
    }
    case "assistant_end": {
      const fallbackText = linco.progressText || linco.fullText || "";
      const finalText = linco.finalText || (!linco.hasFinalChunks ? normalizeFinalText(fallbackText, linco) : "");
      const imageFallback = linco.hasDeliveredMedia
        ? null
        : buildMarkdownImageFallback(finalText, session, config);
      const deliveredText = imageFallback?.text ?? finalText;
      if (imageFallback) linco.hasDeliveredMedia = true;
      return {
        ...base,
        type: "stream_chunk",
        mode: "chunk",
        streamId: linco.streamId,
        delta: "",
        fullText: deliveredText,
        phase: "final_answer",
        ephemeral: false,
        replacePrevious: Boolean(linco.hasEphemeralChunks && !linco.hasFinalChunks),
        references: extractFileReferences(deliveredText, session, config),
        ...(imageFallback
          ? {
              text: finalText,
              mediaName: imageFallback.mediaName,
              mediaType: imageFallback.mediaType,
              mediaBase64: imageFallback.mediaBase64,
              size: imageFallback.size,
            }
          : {}),
        done: true,
      };
    }
    case "thinking":
      linco.thinkingText =
        event.mode === "progress"
          ? String(event.text || event.delta || "")
          : appendThinkingText(linco.thinkingText || "", event);
      return {
        ...base,
        type: "thinking",
        messageId: `linco-thinking-${Date.now()}`,
        streamId: linco.streamId,
        mode: event.mode || "summary",
        text: event.text || event.delta || "",
        delta: event.delta || event.text || "",
        fullText: linco.thinkingText,
        done: false,
      };
    case "thinking_clear":
      linco.thinkingText = "";
      return {
        ...base,
        type: "thinking_clear",
        messageId: `linco-thinking-clear-${Date.now()}`,
        streamId: linco.streamId,
        done: true,
      };
    case "context_compaction":
      return {
        ...base,
        ...event,
        type: "context_compaction",
        requestId: event.requestId || event.request_id || base.messageId,
        streamId:
          event.streamId || event.stream_id || linco.streamId || base.streamId,
        sessionKey: event.sessionKey || event.session_key || session.id,
        ts: event.ts || Date.now(),
      };
    case "agent_task":
      return withLincoAgentTaskTiming(
        {
          ...base,
          ...event,
          type: "agent_task",
          streamId: linco.streamId,
        },
        linco,
      );
    case "agent_action":
      return withLincoAgentActionTiming(
        {
          ...base,
          ...event,
          type: "agent_action",
          streamId: linco.streamId,
        },
        linco,
      );
    case "tool_call":
      clearConfirmedProgressText(linco);
      return withLincoToolCallTiming(
        {
          ...base,
          ...event,
          type: "tool_call",
          streamId: linco.streamId,
        },
        linco,
      );
    case "tool_result":
      clearConfirmedProgressText(linco);
      return withLincoToolResultTiming(
        {
          ...base,
          ...event,
          type: "tool_result",
          streamId: linco.streamId,
        },
        linco,
      );
    case "system":
    case "error":
      return {
        ...base,
        type: "outbound_message",
        messageId: `linco-${event.type}-${Date.now()}`,
        text: event.text || "",
        code: event.code,
        actions: event.actions,
        quickActions: event.quickActions,
        quickReplies: event.quickReplies,
      };
    case "slash_command_result": {
      const result = {
        ...base,
        ...event,
        type: "slash_command_result",
        requestId: event.requestId || event.request_id || base.messageId,
        streamId: event.streamId || event.stream_id || linco.streamId || base.streamId,
        sessionKey: event.sessionKey || event.session_key || session.id,
      };
      return chunkLargeHistoryResult(result);
    }
    case "turn_end":
      return {
        ...base,
        ...event,
        type: "turn_end",
        requestId: event.requestId || event.request_id || base.messageId,
        streamId:
          event.streamId || event.stream_id || linco.streamId || base.streamId,
        sessionKey: event.sessionKey || event.session_key || session.id,
        reason: event.reason || "completed",
        ts: event.ts || Date.now(),
      };
    case "agent_session":
      return {
        ...base,
        ...event,
        type: "agent_session",
        requestId: event.requestId || event.request_id || base.messageId,
        streamId:
          event.streamId || event.stream_id || linco.streamId || base.streamId,
        sessionKey: event.sessionKey || event.session_key || session.id,
        established: event.established !== false,
        ts: event.ts || Date.now(),
      };
    default:
      if (event.mediaBase64 || event.mediaUrl || event.files?.length) {
        linco.hasDeliveredMedia = true;
      }
      return withLincoOutboundFiles({
        ...base,
        ...event,
        type: event.type || "outbound_message",
      });
  }
}

function chunkLargeHistoryResult(result) {
  if (result.command !== "history") return result;
  const payloadJson = JSON.stringify(result.data ?? null);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes <= HISTORY_RESULT_SINGLE_FRAME_MAX_BYTES) return result;

  const encoded = Buffer.from(payloadJson, "utf8").toString("base64");
  const chunkCount = Math.ceil(
    encoded.length / HISTORY_RESULT_CHUNK_BASE64_CHARS,
  );
  return Array.from({ length: chunkCount }, (_, chunkIndex) => ({
    ...result,
    type: "slash_command_result_chunk",
    messageId: `${result.messageId || result.requestId}:history-chunk:${chunkIndex}`,
    encoding: "base64",
    chunkIndex,
    chunkCount,
    payloadBytes,
    chunkData: encoded.slice(
      chunkIndex * HISTORY_RESULT_CHUNK_BASE64_CHARS,
      (chunkIndex + 1) * HISTORY_RESULT_CHUNK_BASE64_CHARS,
    ),
    data: undefined,
  }));
}

function withLincoOutboundFiles(payload) {
  const files = normalizeOutboundFiles(payload);
  if (files.length === 0) return payload;
  return {
    ...payload,
    files,
  };
}

function withLincoToolCallTiming(payload, linco) {
  const id = lincoToolId(payload);
  const startedAt =
    numberValue(payload.started_at ?? payload.startedAt) || Date.now();
  if (id) {
    linco.toolStartedAtById = linco.toolStartedAtById || new Map();
    linco.toolStartedAtById.set(id, startedAt);
  }
  return {
    ...payload,
    started_at: startedAt,
  };
}

function withLincoAgentTaskTiming(payload, linco) {
  const status = String(payload.status || "").trim();
  const event = String(payload.event || "").trim();
  const now = Date.now();
  const startedAt =
    numberValue(payload.started_at ?? payload.startedAt) ||
    numberValue(linco.agentTaskStartedAt) ||
    now;
  linco.agentTaskStartedAt = startedAt;
  const isTerminal =
    event === "completed" ||
    event === "failed" ||
    event === "cancelled" ||
    status === "task_success" ||
    status === "task_failed" ||
    status === "task_cancelled";
  const completedAt = isTerminal
    ? numberValue(payload.completed_at ?? payload.completedAt) || now
    : numberValue(payload.completed_at ?? payload.completedAt);
  return pruneUndefined({
    ...payload,
    started_at: startedAt,
    ...(completedAt > 0 ? { completed_at: completedAt } : {}),
    ...(completedAt > 0 &&
    !numberValue(payload.total_duration ?? payload.totalDuration)
      ? { total_duration: completedAt - startedAt }
      : {}),
  });
}

function withLincoAgentActionTiming(payload, linco) {
  const action =
    payload.action && typeof payload.action === "object"
      ? payload.action
      : null;
  const patch =
    payload.patch && typeof payload.patch === "object" ? payload.patch : null;
  const id = String(
    payload.id ||
      payload.action_id ||
      payload.actionId ||
      action?.id ||
      patch?.id ||
      "",
  ).trim();
  const event = String(payload.event || "").trim();
  const startedAtMap = linco.agentActionStartedAtById || new Map();
  linco.agentActionStartedAtById = startedAtMap;
  const now = Date.now();
  const target = action || patch || payload;
  const explicitStartedAt = numberValue(target.started_at ?? target.startedAt);
  const storedStartedAt = id ? numberValue(startedAtMap.get(id)) : 0;
  const startedAt =
    explicitStartedAt || storedStartedAt || (event === "started" ? now : 0);
  const isTerminal =
    event === "completed" ||
    event === "failed" ||
    event === "cancelled" ||
    event === "done" ||
    event === "success" ||
    String(target.status || "").match(
      /success|failed|cancelled|done|completed/,
    );
  const completedAt =
    numberValue(target.completed_at ?? target.completedAt) ||
    (isTerminal ? now : 0);
  const duration = numberValue(target.duration);
  if (id && startedAt > 0 && !completedAt) startedAtMap.set(id, startedAt);
  if (id && completedAt > 0) startedAtMap.delete(id);
  const timedTarget = pruneUndefined({
    ...target,
    ...(startedAt > 0 ? { started_at: startedAt } : {}),
    ...(completedAt > 0 ? { completed_at: completedAt } : {}),
    ...(completedAt > 0 && startedAt > 0 && !duration
      ? { duration: completedAt - startedAt }
      : {}),
  });
  if (action) return { ...payload, action: timedTarget };
  if (patch) return { ...payload, patch: timedTarget };
  return timedTarget;
}

function withLincoToolResultTiming(payload, linco) {
  const id = lincoToolId(payload);
  const completedAt =
    numberValue(payload.completed_at ?? payload.completedAt) || Date.now();
  const explicitStartedAt = numberValue(
    payload.started_at ?? payload.startedAt,
  );
  const storedStartedAt =
    id && linco.toolStartedAtById instanceof Map
      ? numberValue(linco.toolStartedAtById.get(id))
      : 0;
  const startedAt = explicitStartedAt || storedStartedAt || completedAt;
  const explicitDuration = numberValue(payload.duration);
  const duration =
    explicitDuration ||
    (completedAt >= startedAt ? completedAt - startedAt : undefined);
  if (id && linco.toolStartedAtById instanceof Map) {
    linco.toolStartedAtById.delete(id);
  }
  return pruneUndefined({
    ...payload,
    started_at: startedAt,
    completed_at: completedAt,
    duration,
  });
}

function lincoToolId(payload) {
  return String(
    payload.id || payload.toolUseId || payload.tool_use_id || "",
  ).trim();
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function normalizeStreamChunkPhase(phase) {
  const normalized = String(phase || "").trim();
  return normalized === "progress" ? "progress" : "final_answer";
}

function clearConfirmedProgressText(linco) {
  if (!linco) return;
  linco.progressText = "";
}

function normalizeFinalText(text, linco) {
  const value = String(text || "");
  return linco?.hasEphemeralChunks ? value.replace(/^\n+/, "") : value;
}

function appendThinkingText(current, event) {
  if (typeof event.fullText === "string") return event.fullText;
  const next = String(event.delta || event.text || "");
  if (event.replace === true) return next;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

module.exports = {
  isLincoMessage,
  toInternal,
  createLincoAdapter,
  mapLocalEventToLinco,
  lincoFilesToAttachments,
  normalizeLincoFiles,
  buildStreamId,
  lincoMetaDefaults,
  pruneUndefined,
};
