const { sendError, sendSystem } = require('../core/protocol');
const { handleHistory } = require('./history');
const { handleUpdate } = require('./update');
const {
  agentRunner,
  completeLocalCommand,
} = require('./common');

function handleCompactCommand(rawArg, ws, session, config) {
  const agentType = session.agentType || 'claude';
  const mode = String(rawArg || '').trim().toLowerCase();
  if (mode && !['native'].includes(mode)) {
    sendError(ws, '/compact currently supports native mode only. Use /compact or /compact native.');
    return completeLocalCommand(ws, session);
  }
  const nativeCommand = agentType === 'hermes' ? '/compress' : '/compact';
  const handled = agentRunner().compactAgentContext(ws, session, config, { trigger: 'manual', nativeCommand });
  if (!handled) {
    sendError(ws, 'Current agent does not support /compact.');
    return completeLocalCommand(ws, session);
  }
  return true;
}

function handleReload(ws, session, config) {
  runReload(ws, session, config)
    .finally(() => {
      completeLocalCommand(ws, session);
    });
}

function runReload(ws, session, config) {
  const agentType = session.agentType || 'claude';
  const resumeId = session.agentSessionId || '';
  agentRunner().stopAgentProcess(session, { clearAgentSession: false });
  sendSystem(ws, [
    `🔄 已刷新当前 ${agentType} 会话。`,
    resumeId ? `保留的 Session ID: ${resumeId}` : '当前还没有可恢复的 Session ID。',
    '下次消息会重新加载本地 Agent 历史。'
  ].join('\n'));
  return Promise.resolve(agentRunner().warmupAgentProcess(ws, session, config))
    .then(result => {
      if (result?.supported === false) {
        sendSystem(ws, `${agentType} 模式不支持空预启动，下次消息会按需启动。`);
        return;
      }
      sendSystem(ws, `${agentType} Agent 进程已预启动。`);
    })
    .catch(err => {
      sendError(ws, `${agentType} Agent 预启动失败: ${err.message}`);
    });
}

function handleHistoryReload(rawArg, ws, session, config = {}) {
  if (isSessionBusyForHistoryReload(session)) {
    return completeLocalCommand(ws, session);
  }

  const trackingWs = trackHistoryResult(ws, { defer: true });
  handleHistory(rawArg, trackingWs, session, {
    homeDir: config?.homeDir,
    bindExplicitHistorySession: true,
    allowExplicitHistorySessionSwitch: true,
    historyReload: true,
  });

  runReload(ws, session, config)
    .then(() => {
      trackingWs.flush();
    })
    .finally(() => {
      completeLocalCommand(ws, session);
    });
  return true;
}

function isSessionBusyForHistoryReload(session) {
  return Boolean(
    session?.isTurnActive ||
    session?.claudeCompaction ||
    session?.codexCompaction ||
    session?.pendingCodexManualCompaction ||
    session?.pendingPermission ||
    session?.pendingDanger
  );
}

function trackHistoryResult(ws, options = {}) {
  const pending = [];
  return {
    ...ws,
    linco: ws?.linco,
    sawHistoryResult: false,
    send(raw) {
      try {
        const item = JSON.parse(raw);
        if (item?.type === 'slash_command_result' && item.command === 'history') {
          this.sawHistoryResult = true;
        }
      } catch {}
      if (options.defer) {
        pending.push(raw);
        return;
      }
      return ws.send(raw);
    },
    flush() {
      for (const raw of pending.splice(0)) {
        ws.send(raw);
      }
    },
  };
}

function handleUpdateCommand(rawArg, ws, session, config) {
  handleUpdate(rawArg, ws, session, config)
    .catch(err => {
      sendError(ws, `Linco Connect 升降级失败: ${err.message}`);
    })
    .finally(() => {
      completeLocalCommand(ws, session);
    });
}

module.exports = {
  handleCompactCommand,
  handleReload,
  runReload,
  handleHistoryReload,
  isSessionBusyForHistoryReload,
  trackHistoryResult,
  handleUpdateCommand,
};
