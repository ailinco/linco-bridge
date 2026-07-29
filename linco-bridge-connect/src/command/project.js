const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { send, sendError, sendSystem } = require('../core/protocol');
const { saveSessionMetadata } = require('../core/session');
const { encodeClaudeProjectDir } = require('../runtime/claudeProject');
const { unquoteProjectPath } = require('./args');
const { rejectLockedIdentityChange, sessionIdentityLocked } = require('./agentSelection');

const MAX_REALPATH_CACHE_SIZE = 4096;
const realpathCache = new Map();

function agentRunner() {
  return require('../runtime/agentRunner');
}

function normalizePathKey(value) {
  return path.resolve(String(value || '')).toLowerCase();
}

function canonicalProjectPath(value) {
  const resolved = path.resolve(String(value || ''));
  return safeRealpath(resolved) || resolved;
}

function canonicalPathKey(value) {
  return canonicalProjectPath(value).toLowerCase();
}

function safeRealpath(value) {
  const cacheKey = path.resolve(String(value || ''));
  if (realpathCache.has(cacheKey)) return realpathCache.get(cacheKey);
  try {
    const realpath = fs.realpathSync.native(value);
    if (realpathCache.size >= MAX_REALPATH_CACHE_SIZE) realpathCache.clear();
    realpathCache.set(cacheKey, realpath);
    return realpath;
  } catch {
    return '';
  }
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function projectIdentity(agentType, projectPath) {
  const key = `${agentType || 'agent'}\0${normalizePathKey(projectPath)}`;
  const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `${agentType || 'agent'}:${digest}`;
}

function projectPathLabelKeys(projectPath) {
  const keys = [normalizePathKey(projectPath), canonicalPathKey(projectPath)].filter(Boolean);
  return [...new Set(keys)];
}

function projectNameKey(value) {
  return stringOrEmpty(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
}

function candidateLabelMatchesPath(candidate, projectPath) {
  const labelKey = projectNameKey(candidate.label || candidate.name);
  return Boolean(labelKey) && labelKey === projectNameKey(path.basename(projectPath));
}

function workspaceRootLabel(labels, projectPath) {
  for (const key of projectPathLabelKeys(projectPath)) {
    const label = labels.get(key);
    if (label) return label;
  }
  return '';
}

function sendSlashCommandResult(ws, command, data = {}) {
  send(ws, 'slash_command_result', {
    command,
    version: 1,
    data,
  });
}

function projectAction(label, command, extra = {}) {
  return {
    label,
    text: command,
    command,
    type: 'command',
    ...extra,
  };
}

function quoteProjectPath(targetPath) {
  const value = String(targetPath || '');
  if (!value) return '""';
  if (/[\s"]/u.test(value)) return `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return value;
}

function parseProjectArgs(rawArg) {
  const trimmed = String(rawArg || '').trim();
  if (!trimmed) return { mode: 'known' };

  const selectMatch = trimmed.match(/^--select(?:\s+(.+))?$/s);
  if (selectMatch) {
    return { mode: 'select', targetPath: unquoteProjectPath(selectMatch[1] || '') };
  }

  return { mode: 'unsupported' };
}

function handleProject(rawArg, ws, session, config) {
  const args = parseProjectArgs(rawArg);

  if (args.mode === 'known') {
    sendKnownProjects(ws, session, { homeDir: config?.homeDir });
    return;
  }

  if (args.mode === 'select') {
    selectWorkspace(args.targetPath, ws, session);
    return;
  }

  sendError(ws, '用法：/project 查看已知项目，或 /project --select <路径> 绑定项目。');
}

function handleCd(rawArg, ws, session) {
  const targetPath = unquoteProjectPath(rawArg);
  if (!targetPath) {
    sendError(ws, '用法：/cd <路径>');
    return;
  }
  selectWorkspace(targetPath, ws, session);
}

function sendKnownProjects(ws, session, options = {}) {
  const agentType = session.agentType || 'claude';
  if (!['claude', 'codex'].includes(agentType)) {
    sendError(ws, '/project 目前只支持 Claude 和 Codex 模式。');
    return;
  }

  const projects = knownProjectCandidates(session, { homeDir: options.homeDir });
  if (projects.length === 0) {
    sendSlashCommandResult(ws, 'project', buildProjectsPayload(agentType, session.workspace || '', [], []));
    return;
  }

  const actions = projects.map(project => projectAction(
    `选为项目 ${project.label}`,
    `/project --select ${quoteProjectPath(project.path)}`,
    { action: 'select', path: project.path, projectId: project.projectId, project_id: project.projectId, source: project.source },
  ));

  sendSlashCommandResult(ws, 'project', buildProjectsPayload(agentType, session.workspace || '', projects, actions));
}

function formatKnownProjectList(projects) {
  return projects.map((project, index) => `${index + 1}. ${project.label}\n   ${project.path}`).join('\n\n');
}

function buildProjectsPayload(agentType, currentWorkspace, projects, actions) {
  return {
    version: 1,
    agentType,
    currentWorkspace: currentWorkspace ? path.resolve(currentWorkspace) : '',
    items: projects.map((project, index) => {
      const projectId = project.projectId || projectIdentity(agentType, project.path);
      const sessionsCommand = agentType === 'codex'
        ? `/sessions --project ${quoteProjectPath(project.path)} --project-id ${quoteProjectPath(projectId)} 10`
        : `/sessions --project ${quoteProjectPath(project.path)}`;
      return {
        index: index + 1,
        label: project.label,
        name: project.label,
        path: project.path,
        displayPath: project.displayPath || project.path,
        parentPath: project.parentPath || path.dirname(project.path),
        basename: project.basename || path.basename(project.path),
        projectId,
        project_id: projectId,
        projectKey: project.projectKey || projectId,
        project_key: project.projectKey || projectId,
        canonicalPath: project.canonicalPath || '',
        source: project.source || '',
        command: actions[index]?.command || `/project --select ${quoteProjectPath(project.path)}`,
        sessionsCommand,
      };
    }),
  };
}

function knownProjectCandidates(session, options = {}) {
  const agentType = session.agentType || 'claude';
  const homeDir = options.homeDir || os.homedir();
  if (agentType === 'codex') {
    const stateProjects = normalizeKnownProjectCandidates(collectCodexStateProjects(homeDir), homeDir, agentType);
    if (stateProjects.length > 0) return stateProjects.slice(0, 20);
    return normalizeKnownProjectCandidates(collectCodexSessionProjects(homeDir), homeDir, agentType).slice(0, 20);
  }

  const candidates = agentType === 'claude'
      ? collectClaudeKnownProjects(homeDir)
      : [];
  return normalizeKnownProjectCandidates(candidates, homeDir, agentType).slice(0, 20);
}

function collectClaudeKnownProjects(homeDir) {
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const candidates = [];
  if (!isReadableDirectory(projectsDir)) return candidates;

  for (const dir of safeReadDir(projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const dirPath = path.join(projectsDir, dir.name);
    const files = safeReadDir(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => ({ fullPath: path.join(dirPath, entry.name), updatedAt: safeMtimeMs(path.join(dirPath, entry.name)) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);

    for (const file of files) {
      const cwdValues = readJsonlCwdValues(file.fullPath, 20);
      for (const cwd of cwdValues) {
        candidates.push({ path: cwd, source: 'claude-session', updatedAt: file.updatedAt });
      }
      if (cwdValues.length > 0) break;
    }
  }

  return candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function collectCodexStateProjects(homeDir) {
  const codexDir = path.join(homeDir, '.codex');
  const candidates = [];
  const stateFile = path.join(codexDir, '.codex-global-state.json');
  const state = readJsonFile(stateFile);
  const labels = collectCodexWorkspaceRootLabels(state);
  const updatedAt = safeMtimeMs(stateFile);
  const localProjects = collectCodexLocalProjects(state);
  const projectOrder = collectStringArraysByKeys(state, new Set(['project-order']));

  for (const [order, value] of projectOrder.entries()) {
    if (path.isAbsolute(value)) {
      candidates.push({
        path: value,
        label: workspaceRootLabel(labels, value),
        source: 'codex-state',
        priority: 30,
        order,
        updatedAt,
      });
      continue;
    }

    const project = localProjects.get(value);
    if (!project) continue;
    for (const rootPath of project.rootPaths) {
      candidates.push({
        path: rootPath,
        label: project.name || workspaceRootLabel(labels, rootPath),
        projectId: project.id,
        source: 'codex-state',
        priority: 30,
        order,
        updatedAt: project.updatedAt || updatedAt,
      });
    }
  }

  const fallbackKeys = new Set(['active-workspace-roots', 'electron-saved-workspace-roots']);
  for (const projectPath of collectStringArraysByKeys(state, fallbackKeys)) {
    candidates.push({
      path: projectPath,
      label: workspaceRootLabel(labels, projectPath),
      source: 'codex-state',
      priority: 20,
      updatedAt,
    });
  }
  return candidates.sort(compareKnownProjectCandidates);
}

function collectCodexLocalProjects(state) {
  const projects = new Map();
  for (const records of collectObjectsByKeys(state, new Set(['local-projects']))) {
    for (const [fallbackId, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const id = stringOrEmpty(value.id) || stringOrEmpty(fallbackId);
      if (!id) continue;
      const rootPaths = Array.isArray(value.rootPaths)
        ? value.rootPaths
          .filter(rootPath => typeof rootPath === 'string' && rootPath.trim())
          .map(rootPath => rootPath.trim())
        : [];
      projects.set(id, {
        id,
        name: stringOrEmpty(value.name),
        rootPaths,
        updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
      });
    }
  }
  return projects;
}

function collectCodexWorkspaceRootLabels(state) {
  const labels = new Map();
  for (const item of collectObjectsByKeys(state, new Set(['electron-workspace-root-labels']))) {
    for (const [projectPath, label] of Object.entries(item)) {
      const value = stringOrEmpty(label);
      if (!value) continue;
      for (const labelKey of projectPathLabelKeys(projectPath)) {
        if (labelKey && !labels.has(labelKey)) labels.set(labelKey, value);
      }
    }
  }
  return labels;
}

function collectCodexSessionProjects(homeDir) {
  const codexDir = path.join(homeDir, '.codex');
  const candidates = [];
  for (const file of safeReadFilesRecursive(path.join(codexDir, 'sessions'), { extension: '.jsonl', limit: 200 })) {
    for (const cwd of readJsonlCwdValues(file.fullPath, 10)) {
      candidates.push({ path: cwd, source: 'codex-session', priority: 10, updatedAt: file.updatedAt });
    }
  }
  return candidates.sort(compareKnownProjectCandidates);
}

function normalizeKnownProjectCandidates(candidates, homeDir, agentType = 'agent') {
  const seen = new Map();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate?.path || typeof candidate.path !== 'string') continue;
    if (!path.isAbsolute(candidate.path)) continue;
    const resolved = path.resolve(candidate.path);
    const canonical = canonicalProjectPath(resolved);
    const key = normalizePathKey(resolved);
    if (!isReadableDirectory(resolved)) continue;
    if (!isSelectableProjectDirectory(canonical)) continue;
    if (isLincoRuntimeWorkspace(canonical, homeDir)) continue;
    if (isUnsafeKnownProjectPath(canonical, homeDir)) continue;
    const label = stringOrEmpty(candidate.label) || path.basename(resolved) || resolved;
    const explicitProjectId = stringOrEmpty(candidate.projectId) ||
      stringOrEmpty(candidate.project_id) ||
      stringOrEmpty(candidate.projectKey) ||
      stringOrEmpty(candidate.project_key);
    const projectId = explicitProjectId || projectIdentity(agentType, resolved);
    const canonicalPath = normalizePathKey(canonical) === normalizePathKey(resolved) ? '' : canonical;
    const normalizedCandidate = {
      ...candidate,
      path: resolved,
      label,
      name: label,
      displayPath: resolved,
      parentPath: path.dirname(resolved),
      basename: path.basename(resolved),
      projectId,
      project_id: projectId,
      projectKey: projectId,
      project_key: projectId,
      canonicalPath,
    };
    const ownership = {
      index: result.length,
      hasExplicitProjectId: Boolean(explicitProjectId),
      labelMatchesPath: candidateLabelMatchesPath(normalizedCandidate, resolved),
    };
    const existing = seen.get(key);
    if (existing) {
      const shouldReplace =
        (ownership.hasExplicitProjectId && !existing.hasExplicitProjectId) ||
        (ownership.hasExplicitProjectId === existing.hasExplicitProjectId &&
          ownership.labelMatchesPath &&
          !existing.labelMatchesPath);
      if (shouldReplace) {
        result[existing.index] = normalizedCandidate;
        seen.set(key, { ...ownership, index: existing.index });
      }
      continue;
    }
    seen.set(key, ownership);
    result.push(normalizedCandidate);
  }
  return result;
}

function compareKnownProjectCandidates(a, b) {
  const priorityDelta = (b.priority || 0) - (a.priority || 0);
  if (priorityDelta) return priorityDelta;
  const orderDelta = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
  if (orderDelta) return orderDelta;
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function readJsonlCwdValues(filePath, maxValues = 20) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const values = [];
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      const cwd = item?.cwd || item?.payload?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) values.push(cwd.trim());
      if (values.length >= maxValues) break;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return values;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function collectStringArraysByKeys(value, keys, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectStringArraysByKeys(item, keys, result);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === 'string' && entry.trim()) result.push(entry.trim());
      }
      continue;
    }
    collectStringArraysByKeys(item, keys, result);
  }
  return result;
}

function collectObjectsByKeys(value, keys, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectsByKeys(item, keys, result);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && item && typeof item === 'object' && !Array.isArray(item)) {
      result.push(item);
      continue;
    }
    collectObjectsByKeys(item, keys, result);
  }
  return result;
}

function safeReadDir(dirPath, options) {
  try {
    return fs.readdirSync(dirPath, options);
  } catch {
    return [];
  }
}

function safeReadFilesRecursive(rootDir, { extension, limit = 200 } = {}) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    for (const entry of safeReadDir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
        files.push({ fullPath, updatedAt: safeMtimeMs(fullPath) });
      }
    }
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function safeMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isLincoRuntimeWorkspace(projectPath, homeDir = os.homedir()) {
  const normalized = canonicalPathKey(projectPath);
  const home = canonicalPathKey(homeDir);
  const relative = path.relative(home, normalized).toLowerCase();
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return relative.startsWith('.linco' + path.sep) ||
    relative.startsWith('linco-') ||
    relative.startsWith('ddchat-claude-sessions' + path.sep) ||
    relative.startsWith('ddchat-sessions' + path.sep);
}

function isUnsafeKnownProjectPath(projectPath, homeDir = os.homedir()) {
  const resolved = canonicalPathKey(projectPath);
  const home = canonicalPathKey(homeDir);
  if (resolved === home) return true;
  if (isAgentInternalProjectPath(resolved)) return true;
  if (isClaudeCwdlessTempPath(resolved, home)) return true;
  const homeRelative = path.relative(home, resolved).toLowerCase();
  const isInsideHome = !!homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative);

  const tempDir = normalizePathKey(os.tmpdir());
  const tempRelative = path.relative(tempDir, resolved);
  if (!isInsideHome && (!tempRelative || (!tempRelative.startsWith('..') && !path.isAbsolute(tempRelative)))) return true;

  if (!isInsideHome) return false;
  return false;
}

function isAgentInternalProjectPath(resolvedLowerPath) {
  return resolvedLowerPath.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ||
    resolvedLowerPath.includes(`${path.sep}.codex${path.sep}`);
}

function isClaudeCwdlessTempPath(resolvedLowerPath) {
  return /^claude-cwdless-(chat|write)-/.test(path.basename(resolvedLowerPath));
}

function resolveWorkspacePath(targetPath, currentWorkspace) {
  if (!targetPath) return path.resolve(currentWorkspace || process.cwd());
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(currentWorkspace || process.cwd(), targetPath);
}

function validateWorkspaceDirectory(targetPath, ws) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      sendError(ws, `目录不存在: ${targetPath}`);
      return false;
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      sendError(ws, `不是目录: ${targetPath}`);
      return false;
    }

    return true;
  } catch (err) {
    sendError(ws, `无法访问目录: ${err.message}`);
    return false;
  }
}

function selectWorkspace(targetPath, ws, session) {
  const newPath = resolveWorkspacePath(targetPath, session.workspace);
  if (!validateWorkspaceDirectory(newPath, ws)) return;
  const canonicalPath = canonicalProjectPath(newPath);
  if (!isSelectableProjectDirectory(canonicalPath)) {
    sendError(ws, `请选择更具体的项目目录，不能直接选择磁盘根目录或一级目录: ${newPath}`);
    return;
  }

  if (sessionIdentityLocked(session)) {
    rejectLockedIdentityChange(ws);
    return;
  }

  agentRunner().stopAgentProcess(session, { clearAgentSession: true });
  session.workspace = newPath;
  saveSessionMetadata(session);

  sendSystem(ws, `📂 工作目录已切换至: ${newPath}\n🆕 已开启新 Agent 会话。`);
}

function isSelectableProjectDirectory(targetPath) {
  const resolved = path.resolve(targetPath || '');
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  if (!relative) return false;
  return relative.split(path.sep).filter(Boolean).length >= 2;
}

function isReadableDirectory(targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  handleProject,
  handleCd,
  encodeClaudeProjectDir,
  isReadableDirectory,
  isSelectableProjectDirectory,
  knownProjectCandidates,
  projectAction,
  quoteProjectPath,
  readJsonFile,
  resolveWorkspacePath,
  safeMtimeMs,
  safeReadDir,
  safeReadFilesRecursive,
};
