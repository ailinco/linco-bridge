const DEFAULT_CODEX_REASONING_EFFORT = 'high';
const MAX_CAPABILITY_ID_LENGTH = 120;
const MAX_CAPABILITY_LABEL_LENGTH = 200;
const MAX_CAPABILITY_DESCRIPTION_LENGTH = 1000;
const ASCII_CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

function codexTurnModelOverride(session) {
  if (!session.codexModelOverrideDirty) return {};
  const model = String(session.codexModelOverride || '').trim();
  session.codexModelOverrideDirty = false;
  return { model: model || null };
}

function codexTurnReasoningOverride(session, agentConfig = {}, options = {}) {
  if (!session.codexReasoningEffortDirty && !options.includeDefault) return {};
  const effort = normalizeCodexReasoningEffort(session.codexReasoningEffortOverride || '')
    || (options.includeDefault ? codexDefaultReasoningEffort(agentConfig) : '');
  session.codexReasoningEffortDirty = false;
  session.codexActiveReasoningEffort = effort || '';
  return { effort: effort || null };
}

function codexDefaultReasoningEffort(agentConfig = {}) {
  const configured = normalizeCodexReasoningEffort(
    agentConfig.reasoningEffort || agentConfig.defaultReasoningEffort || agentConfig.effort || DEFAULT_CODEX_REASONING_EFFORT
  );
  return isSupportedCodexReasoningEffort(configured) ? configured : DEFAULT_CODEX_REASONING_EFFORT;
}

function currentCodexReasoningEffort(session) {
  return normalizeCodexReasoningEffort(
    session?.codexReasoningEffortOverride || session?.codexActiveReasoningEffort || ''
  );
}

function codexModelInputNeedsLookup(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return true;
  return !raw.includes('/') && !raw.includes('-') && !raw.includes('.');
}

function codexReasoningInputNeedsLookup(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  return /^\d+$/.test(raw);
}

function resolveModelNameFromList(input, models) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const index = Number.parseInt(raw, 10);
  if (String(index) === raw && index >= 1 && index <= models.length) return models[index - 1];
  const exact = models.find(model => model.toLowerCase() === raw.toLowerCase());
  return exact || raw;
}

function normalizeCodexModelList(result) {
  const source = Array.isArray(result)
    ? result
    : Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.models)
        ? result.models
        : Array.isArray(result?.items)
          ? result.items
          : [];
  return source
    .map(item => String(item?.id || item?.model || item?.displayName || item?.name || item || '').trim())
    .filter(Boolean);
}

function normalizeCodexModelEntries(result) {
  const source = Array.isArray(result)
    ? result
    : Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.models)
        ? result.models
        : Array.isArray(result?.items)
          ? result.items
          : [];
  const entries = [];
  const seen = new Set();
  for (const item of source) {
    const rawName = item && typeof item === 'object'
      ? item.id || item.model || item.name
      : item;
    const name = safeCapabilityId(rawName);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);

    const hasReasoningEffortMetadata = Boolean(
      item && typeof item === 'object'
      && Object.prototype.hasOwnProperty.call(item, 'supportedReasoningEfforts')
    );
    const supportedReasoningEfforts = normalizeCodexReasoningOptions(item?.supportedReasoningEfforts);
    const requestedDefault = safeCapabilityId(
      item?.defaultReasoningEffort || item?.defaultEffort,
      normalizeCodexReasoningEffort
    );
    const defaultReasoningEffort = supportedReasoningEfforts.some(option => option.id === requestedDefault)
      ? requestedDefault
      : supportedReasoningEfforts[0]?.id || '';
    entries.push({
      name,
      label: firstBoundedText([item?.displayName, item?.label, item?.name], MAX_CAPABILITY_LABEL_LENGTH) || name,
      description: boundedText(item?.description, MAX_CAPABILITY_DESCRIPTION_LENGTH),
      supportedReasoningEfforts,
      defaultReasoningEffort,
      isDefault: Boolean(item?.isDefault),
      hasReasoningEffortMetadata,
    });
  }
  return entries;
}

function normalizeCodexReasoningOptions(options) {
  if (!Array.isArray(options)) return [];
  const normalizedOptions = [];
  const seen = new Set();
  for (const option of options) {
    const rawId = option && typeof option === 'object'
      ? option.reasoningEffort || option.effort || option.id
      : option;
    const id = safeCapabilityId(rawId, normalizeCodexReasoningEffort);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalizedOptions.push({
      id,
      label: firstBoundedText([option?.label, option?.displayName], MAX_CAPABILITY_LABEL_LENGTH)
        || formatCodexReasoningEffortLabel(id),
      description: boundedText(option?.description, MAX_CAPABILITY_DESCRIPTION_LENGTH),
    });
  }
  return normalizedOptions;
}

function safeCapabilityId(value, normalize = raw => raw) {
  if (value === undefined || value === null) return '';
  const raw = String(value);
  if (ASCII_CONTROL_CHARACTER.test(raw)) return '';
  const normalized = String(normalize(raw.trim()) || '').trim();
  if (!normalized || normalized.length > MAX_CAPABILITY_ID_LENGTH || ASCII_CONTROL_CHARACTER.test(normalized)) return '';
  return normalized;
}

function boundedText(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function firstBoundedText(values, maxLength) {
  for (const value of values) {
    const text = boundedText(value, maxLength);
    if (text) return text;
  }
  return '';
}

function findCodexModelEntry(entries, model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return null;
  return entries.find(entry => entry.name.toLowerCase() === raw) || null;
}

function withCodexFallbackModels(models) {
  return uniqueModelNames([...(models || []), ...codexFallbackModels()]);
}

function codexFallbackModels() {
  return [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.2',
    'codex-mini-latest',
    'gpt-4.1',
    'gpt-4.1-mini',
    'o4-mini',
    'o3',
  ];
}

function uniqueModelNames(models) {
  const seen = new Set();
  const result = [];
  for (const model of models) {
    const name = String(model || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function formatCodexModelList(models, current) {
  if (!models.length) return `Current model: ${current || '(default)'}\nCodex returned no model entries.`;
  return [
    `Current model: ${current || '(default)'}`,
    '',
    ...models.map((model, index) => `${index + 1}. ${model}${model === current ? ' (current)' : ''}`),
  ].join('\n');
}

function codexReasoningEffortValues() {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
}

function codexFallbackReasoningEfforts() {
  return ['low', 'medium', 'high', 'xhigh'];
}

function normalizeCodexReasoningEffort(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[\s_]+/g, '-');
  if (normalized === 'extra-high' || normalized === 'extra' || normalized === 'x-high') return 'xhigh';
  return normalized;
}

function isSupportedCodexReasoningEffort(effort) {
  return codexReasoningEffortValues().includes(normalizeCodexReasoningEffort(effort));
}

function uniqueReasoningEfforts(efforts) {
  const allowed = new Set(codexReasoningEffortValues());
  const seen = new Set();
  const result = [];
  for (const effort of efforts || []) {
    const normalized = normalizeCodexReasoningEffort(effort);
    if (!allowed.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length ? result : codexFallbackReasoningEfforts();
}

function formatCodexReasoningEffortLabel(effort) {
  const normalized = normalizeCodexReasoningEffort(effort);
  if (normalized === 'xhigh') return 'Extra High';
  if (normalized === 'max') return 'Max';
  if (normalized === 'ultra') return 'Ultra';
  if (normalized === 'minimal') return 'Minimal';
  if (normalized === 'none') return 'None';
  if (normalized === 'low') return 'Low';
  if (normalized === 'medium') return 'Medium';
  if (normalized === 'high') return 'High';
  return String(effort || '');
}

function formatCodexReasoningList(efforts, current, options = {}) {
  const defaultEffort = options.defaultEffort || '';
  const model = options.model || '';
  if (!efforts.length) return `Current reasoning effort: ${current ? formatCodexReasoningEffortLabel(current) : '(model default)'}\nCodex returned no reasoning effort entries.`;
  const lines = [
    `Current reasoning effort: ${current ? formatCodexReasoningEffortLabel(current) : '(model default)'}`,
  ];
  if (defaultEffort) lines.push(`Model default: ${formatCodexReasoningEffortLabel(defaultEffort)}${model ? ` (${model})` : ''}`);
  lines.push('');
  lines.push(...efforts.map((effort, index) => {
    const tags = [];
    if (effort === current) tags.push('current');
    if (!current && defaultEffort && effort === defaultEffort) tags.push('default');
    return `${index + 1}. ${formatCodexReasoningEffortLabel(effort)}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  }));
  return lines.join('\n');
}

module.exports = {
  codexDefaultReasoningEffort,
  codexFallbackModels,
  codexFallbackReasoningEfforts,
  codexModelInputNeedsLookup,
  codexReasoningEffortValues,
  codexReasoningInputNeedsLookup,
  codexTurnModelOverride,
  codexTurnReasoningOverride,
  currentCodexReasoningEffort,
  findCodexModelEntry,
  formatCodexModelList,
  formatCodexReasoningEffortLabel,
  formatCodexReasoningList,
  isSupportedCodexReasoningEffort,
  normalizeCodexModelEntries,
  normalizeCodexModelList,
  normalizeCodexReasoningEffort,
  normalizeCodexReasoningOptions,
  resolveModelNameFromList,
  uniqueReasoningEfforts,
  withCodexFallbackModels,
};
