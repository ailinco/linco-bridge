const { sendError } = require('../core/protocol');
const claudeAgent = require('../agent/claude');
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

const COMPATIBLE_CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

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
  const compatibleReasoningOptions = COMPATIBLE_CODEX_REASONING_EFFORTS.map(effort => ({
    id: effort,
    label: formatReasoningLabel(effort),
  }));
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
  const defaultEffort = String(agentConfig.effort || 'medium').trim();
  const supportedReasoningEfforts = claudeAgent._internal.availableClaudeEfforts().map(effort => compactReasoningOption({
    id: effort.name,
    label: formatReasoningLabel(effort.name),
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
  const supportedDefaultEffort = supportedReasoningEfforts.some(effort => effort.id === defaultEffort)
    ? defaultEffort
    : supportedReasoningEfforts[0]?.id || '';
  return {
    capabilitiesVersion: 2,
    agentType: 'claude',
    reasoning: {
      current: currentReasoning,
      defaultEffort,
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
        defaultReasoningEffort: supportedDefaultEffort,
        supportedReasoningEfforts,
      })),
    },
  };
}

function buildCodexModelItem(entry, connectorDefaultEffort, compatibleReasoningOptions) {
  const supportedReasoningEfforts = entry.supportedReasoningEfforts.length
    ? entry.supportedReasoningEfforts.map(compactReasoningOption)
    : compatibleReasoningOptions;
  const requestedDefault = entry.defaultReasoningEffort || connectorDefaultEffort;
  const defaultReasoningEffort = supportedReasoningEfforts.some(option => option.id === requestedDefault)
    ? requestedDefault
    : supportedReasoningEfforts[0]?.id || '';
  return {
    id: entry.name,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    command: `/model ${entry.name}`,
    defaultReasoningEffort,
    supportedReasoningEfforts,
  };
}

function compactReasoningOption(option) {
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
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
