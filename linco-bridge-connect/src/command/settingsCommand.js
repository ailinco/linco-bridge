const { sendError } = require('../core/protocol');
const claudeAgent = require('../agent/claude');
const { DEFAULT_CLAUDE_EFFORT } = require('../agent/claude/options');
const codexAgent = require('../agent/codex');
const {
  GET_MODELS_AND_REASONS_COMMAND,
  parseSettingsArgs,
  validateSettingsApplyArgs,
} = require('./settings');
const {
  agentRunner,
  completeLocalCommand,
  completeMaybeAsyncLocalCommand,
  sendSlashCommandResult,
} = require('./common');

const LEGACY_BRIDGE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function handleSettingsListCommand(ws, session, config = {}) {
  const agentType = session.agentType || 'claude';
  if (agentType !== 'codex' && agentType !== 'claude') {
    sendError(ws, `Current agent does not support ${GET_MODELS_AND_REASONS_COMMAND}.`);
    return completeLocalCommand(ws, session);
  }
  completeMaybeAsyncLocalCommand(
    buildBridgeSettingsPayload(session, config)
      .then(payload => sendSlashCommandResult(ws, GET_MODELS_AND_REASONS_COMMAND, payload))
      .catch(err => {
        sendError(ws, `Failed to load settings: ${err.message}`);
      }),
    ws,
    session,
  );
  return true;
}

function handleSettingsCommand(rawArg, ws, session, config = {}) {
  const args = parseSettingsArgs(rawArg);
  if (args.mode === 'apply') {
    return handleSettingsApplyCommand(args, ws, session, config);
  }

  return handleSettingsListCommand(ws, session, config);
}

function handleSettingsApplyCommand(args, ws, session, config = {}) {
  const validation = validateSettingsApplyArgs(args);
  if (!validation.ok) {
    sendError(ws, validation.message);
    return completeLocalCommand(ws, session);
  }

  const agentType = session.agentType || 'claude';
  if (agentType !== 'codex' && agentType !== 'claude') {
    sendError(ws, 'Current agent does not support /settings apply.');
    return completeLocalCommand(ws, session);
  }

  const handled = agentRunner().applyAgentSettings(ws, session, config, {
    reasoningEffort: args.reasoningEffort,
    modelId: args.modelId,
    nativeCommand: `/settings apply${args.reasoningEffort ? ` --reasoning ${args.reasoningEffort}` : ''}${args.modelId ? ` --model ${args.modelId}` : ''}`,
    agentType,
  });
  if (!handled) {
    sendError(ws, 'Current agent does not support /settings apply.');
    return completeLocalCommand(ws, session);
  }
  return true;
}

async function buildBridgeSettingsPayload(session, config = {}) {
  const agentType = session.agentType || 'claude';
  if (agentType === 'codex') return buildCodexSettingsPayload(session, config);
  return buildClaudeSettingsPayload(session, config);
}

async function buildCodexSettingsPayload(session, config = {}) {
  const agentConfig = config.agents?.codex || {};
  const currentReasoning = codexAgent._internal.currentCodexReasoningEffort(session);
  const defaultEffort = codexAgent._internal.codexDefaultReasoningEffort(agentConfig);
  const compatibleReasoningOptions = LEGACY_BRIDGE_REASONING_EFFORTS.map(effort => reasoningOptionFromId(effort));
  const reasoningOptions = compatibleReasoningOptions.map(option => ({
    ...option,
    command: `/reasoning ${option.id}`,
  }));
  const current = String(session.codexModelOverride || '').trim();
  const defaultModel = String(agentConfig.model || '').trim();
  let entries = [];
  let listError = '';
  try {
    entries = await codexAgent._internal.loadCodexActualModelEntries(session, config);
  } catch (err) {
    listError = err.message;
  }
  const runtimeDefaultEntry = findModelEntry(entries, defaultModel)
    || entries.find(entry => entry.isDefault)
    || entries[0]
    || null;
  return {
    capabilitiesVersion: 2,
    agentType: 'codex',
    reasoning: {
      current: currentReasoning,
      defaultEffort,
      model: current || defaultModel,
      options: reasoningOptions,
    },
    model: {
      current,
      defaultModel,
      runtimeDefaultModelId: runtimeDefaultEntry?.name || '',
      ...(listError ? { listError } : {}),
      items: entries.map(entry => buildCodexModelItem(entry, defaultEffort, compatibleReasoningOptions)),
    },
  };
}

function buildClaudeSettingsPayload(session, config = {}) {
  const agentConfig = config.agents?.claude || {};
  const currentReasoning = claudeAgent._internal.currentClaudeEffort(session, config);
  const efforts = claudeAgent._internal.availableClaudeEfforts();
  const effortIds = efforts.map(effort => reasoningOptionFromId(effort.name).id);
  const configuredDefaultEffort = String(agentConfig.effort || '').trim().toLowerCase();
  const fallbackDefaultEffort = effortIds.includes(DEFAULT_CLAUDE_EFFORT)
    ? DEFAULT_CLAUDE_EFFORT
    : effortIds[0] || '';
  const normalizedDefaultEffort = effortIds.includes(configuredDefaultEffort)
    ? configuredDefaultEffort
    : fallbackDefaultEffort;
  const supportedReasoningEfforts = efforts.map(effort => reasoningOptionFromId(effort.name, {
    description: effort.desc,
  }));
  const reasoningOptions = supportedReasoningEfforts.map(effort => ({
    ...effort,
    command: `/reasoning ${effort.id}`,
  }));
  const current = String(session.claudeModelOverride || '').trim();
  const defaultModel = String(agentConfig.model || '').trim();
  const models = claudeAgent._internal.availableClaudeModels();
  const runtimeDefaultModel = findModelEntry(models, defaultModel) || models[0] || null;
  return {
    capabilitiesVersion: 2,
    agentType: 'claude',
    reasoning: {
      current: currentReasoning,
      defaultEffort: normalizedDefaultEffort,
      model: current || defaultModel,
      options: reasoningOptions,
    },
    model: {
      current,
      defaultModel,
      runtimeDefaultModelId: runtimeDefaultModel?.name || '',
      items: models.map(model => ({
        id: model.name,
        label: model.name,
        ...(model.desc ? { description: model.desc } : {}),
        command: `/model ${model.name}`,
        defaultReasoningEffort: normalizedDefaultEffort,
        supportedReasoningEfforts,
      })),
    },
  };
}

function buildCodexModelItem(entry, connectorDefaultEffort, compatibleReasoningOptions) {
  const supportedReasoningEfforts = entry.hasReasoningEffortMetadata
    ? entry.supportedReasoningEfforts.map(option => reasoningOptionFromId(option.id, option))
    : compatibleReasoningOptions;
  const supportedEffortIds = new Set(supportedReasoningEfforts.map(option => option.id));
  const defaultReasoningEffort = [entry.defaultReasoningEffort, connectorDefaultEffort]
    .find(effort => supportedEffortIds.has(effort))
    || supportedReasoningEfforts[0]?.id
    || '';
  return {
    id: entry.name,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    command: `/model ${entry.name}`,
    defaultReasoningEffort,
    supportedReasoningEfforts,
  };
}

function reasoningOptionFromId(effort, source = {}) {
  const id = String(effort ?? '').trim().toLowerCase();
  const label = String(source.label ?? '').trim() || formatReasoningLabel(id);
  const description = String(source.description ?? '').trim();
  return {
    id,
    label,
    ...(description ? { description } : {}),
  };
}

function findModelEntry(entries, configuredModel) {
  const target = String(configuredModel || '').trim().toLowerCase();
  if (!target) return null;
  return entries.find(entry => String(entry.name || '').trim().toLowerCase() === target) || null;
}

function formatReasoningLabel(effort) {
  switch (String(effort || '').trim().toLowerCase()) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    case 'max':
      return 'Max';
    case 'ultra':
      return 'Ultra';
    case 'minimal':
      return 'Minimal';
    case 'none':
      return 'None';
    default:
      return String(effort || '').trim();
  }
}

module.exports = {
  handleSettingsListCommand,
  handleSettingsCommand,
  handleSettingsApplyCommand,
  buildBridgeSettingsPayload,
  formatReasoningLabel,
};
