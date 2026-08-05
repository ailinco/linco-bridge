const fs = require('fs');
const path = require('path');
const { buildAgentSystemPrompt, buildFileDeliveryInstructions } = require('./agentPrompt');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const FILE_REFERENCE_HINT_MARKER = 'System note: The user is asking to send or deliver a file/image.';

function buildFileReferenceSystemPrompt(session, config) {
  return buildAgentSystemPrompt(session, config);
}

function buildFileReferenceHint(input, session) {
  const text = extractText(input);
  if (!shouldAddFileReferenceHint(text)) return input;

  const hint = `${FILE_REFERENCE_HINT_MARKER}
Save the final file in the current workspace or conversation runtime directory, then return it using this exact Markdown file reference format:
[filename.ext](absolute-local-path)

The link target must be the original local absolute path. Do not return bare file paths, relative paths, file:// URLs, download commands, or delivery implementation details.

Current workspace: ${session.workspace}
Conversation runtime directory: ${session.runtimeDir}
Attachment directory: ${session.attachmentsDir}`;

  if (Array.isArray(input)) {
    return [...input, { type: 'text', text: hint }];
  }
  return `${String(input || '')}\n\n${hint}`;
}

function buildImageGenerationDeliveryHint(input) {
  const text = extractText(input);
  if (!isImageGenerationRequest(text)) return input;

  const hint = `System note: This is an image generation request.
If you used a built-in image generation tool, the bridge will deliver the generated image automatically. Reply briefly, and do not include local paths, Markdown file links, download commands, or delivery instructions.

If you can only deliver the image as a saved file, save it in the current workspace or conversation runtime directory, then return it using this exact Markdown file reference format:
[filename.ext](absolute-local-path)`;
  if (Array.isArray(input)) {
    return [...input, { type: 'text', text: hint }];
  }
  return `${String(input || '')}\n\n${hint}`;
}

function shouldAddFileReferenceHint(text) {
  const value = String(text || '');
  if (hasCodeImplementationContext(value) && !isExplicitFileDeliveryRequest(value)) {
    return false;
  }
  if (isImageGenerationRequest(value) && !isExplicitFileDeliveryRequest(value)) {
    return false;
  }
  return /(send|upload|attach|file|image|download|发送|文件|图片|发给我|下载)/i.test(String(text || ''));
}

function isImageGenerationRequest(text) {
  const value = String(text || '');
  if (hasCodeImplementationContext(value) && !hasDirectImageGenerationIntent(value)) return false;
  const hasImageSubject = /(image|picture|photo|pic|png|jpg|jpeg|webp|drawing|illustration|poster|wallpaper|图片|照片|图像|插画|海报|壁纸|头像)/i.test(value);
  const hasGenerateVerb = /(generate|create|draw|paint|make|生成|画|绘制|做|制作|创建|来一张|出一张)/i.test(value);
  return hasImageSubject && hasGenerateVerb;
}

function hasCodeImplementationContext(text) {
  return /(code|function|bug|fix|implement|support|feature|component|page|api|endpoint|route|代码|函数|方法|页面|接口|组件|修复|实现|支持|功能|开发|按钮|前端|后端)/i.test(String(text || ''));
}

function hasDirectImageGenerationIntent(text) {
  return /(直接|现在|马上|立即|给我|发给我|生成一张|画一张|来一张|出一张|draw me|generate an? image|create an? image)/i.test(String(text || ''));
}

function isExplicitFileDeliveryRequest(text) {
  return /(file|download|attach|保存到|保存成|保存为|文件|下载|附件|路径|链接|本地)/i.test(String(text || ''));
}

function resolveGetTarget(rawTarget, session) {
  const target = normalizeFileUriPath(stripWrappingQuotes(stripLineSuffix(String(rawTarget || '').trim())));
  if (!target) return null;

  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }

  const roots = allowedGetRoots(session);
  const seen = new Set();
  const candidates = [];

  function pushCandidate(root, relativePath) {
    if (!root || !relativePath) return;
    const resolved = path.resolve(path.join(root, relativePath));
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  }

  for (const root of roots) {
    pushCandidate(root, target);
    const basename = path.basename(target);
    if (basename && basename !== target) {
      pushCandidate(root, basename);
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  return path.resolve(path.join(session.workspace, target));
}

function allowedGetRoots(session) {
  return [session.workspace, session.runtimeDir, session.attachmentsDir].filter(Boolean);
}

function validateGetFile(filePath, session, config, options = {}) {
  const resolved = path.resolve(filePath);
  const access = resolveAllowedFileAccess(resolved, session, options);
  if (!access) {
    return {
      ok: false,
      code: 'outside_allowed_roots',
      message: '拒绝读取该路径：只能获取当前工作目录、/project 项目、运行目录或附件目录内的文件。',
    };
  }

  if (!config.allowHiddenGetFiles && hasHiddenAccessPathSegment(access)) {
    return { ok: false, code: 'hidden_path', message: `拒绝读取隐藏文件或隐藏目录下的文件：${path.basename(resolved)}` };
  }

  let stat;
  try {
    stat = fs.statSync(access.filePath);
  } catch {
    return { ok: false, code: 'missing', message: `文件不存在：${resolved}` };
  }

  if (!stat.isFile()) {
    return { ok: false, code: 'not_file', message: `不是普通文件：${resolved}` };
  }

  if (stat.size <= 0) {
    return { ok: false, code: 'empty', message: `文件为空：${resolved}` };
  }

  if (stat.size > config.maxOutgoingAttachmentBytes) {
    return {
      ok: false,
      code: 'too_large',
      message: `文件超过发送大小限制 ${(config.maxOutgoingAttachmentBytes / 1024 / 1024).toFixed(0)}MB：${resolved}`,
    };
  }

  if (!config.allowUnsafeAttachments && isUnsafeAttachmentPath(access.filePath, config)) {
    return { ok: false, code: 'unsafe', message: `出于安全原因，默认不允许下发该类型文件：${path.basename(resolved)}` };
  }

  return {
    ok: true,
    path: resolved,
    readPath: access.filePath,
    size: stat.size,
  };
}

function buildOutboundFileMessage(session, filePath, size, options = {}) {
  const name = path.basename(filePath);
  const readPath = options.readPath || filePath;
  return {
    messageId: `linco-get-${Date.now()}`,
    text: `文件：${name}`,
    references: [buildFileReference(filePath, session)],
    mediaName: name,
    mediaType: mimeFromFilename(name),
    mediaBase64: fs.readFileSync(readPath).toString('base64'),
    size,
  };
}

function buildFileReference(filePath, session) {
  const resolved = path.resolve(filePath);
  const relative = relativePathForReference(resolved, session);
  return {
    type: 'file',
    name: path.basename(resolved),
    path: resolved,
    relativePath: relative,
    command: `/get ${quoteGetPath(resolved)}`,
  };
}

function extractFileReferences(text, session, config) {
  const candidates = candidatePathsFromText(text, session);
  const seen = new Set();
  const references = [];

  for (const candidate of candidates) {
    const resolved = resolveGetTarget(candidate, session);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (validateGetFile(resolved, session, config).ok) {
      references.push(buildFileReference(resolved, session));
    }
  }

  return references;
}

function buildMarkdownImageFallback(text, session, config) {
  const source = String(text || '');
  const links = markdownLinksFromText(source);
  for (const link of links) {
    const candidate = normalizeFileUriPath(cleanMarkdownTarget(link.target));
    const resolved = resolveGetTarget(candidate, session);
    if (!resolved || kindFromFilename(resolved) !== 'image') continue;
    const validation = validateGetFile(resolved, session, config);
    if (!validation.ok) continue;

    let file;
    try {
      file = buildOutboundFileMessage(
        session,
        validation.path,
        validation.size,
        { readPath: validation.readPath },
      );
    } catch {
      continue;
    }
    const cleanedText = source
      .replace(markdownLinkPattern(), (match, rawTarget) => {
        const target = normalizeFileUriPath(cleanMarkdownTarget(rawTarget));
        const linkedPath = resolveGetTarget(target, session);
        return linkedPath && path.resolve(linkedPath) === path.resolve(validation.path)
          ? ''
          : match;
      })
      .replace(/[ \t]+\r?\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      text: cleanedText,
      mediaName: file.mediaName,
      mediaType: file.mediaType,
      mediaBase64: file.mediaBase64,
      size: file.size,
    };
  }
  return null;
}

function candidatePathsFromText(text, session) {
  const source = String(text || '');
  return candidatePathsFromMarkdownLinks(source);
}

function candidatePathsFromMarkdownLinks(text) {
  const candidates = [];
  for (const link of markdownLinksFromText(text)) {
    const target = normalizeFileUriPath(cleanMarkdownTarget(link.target));
    if (path.isAbsolute(target)) candidates.push(target);
  }
  return candidates;
}

function markdownLinkPattern() {
  return /!?\[[^\]]*\]\(([^)]+)\)/g;
}

function markdownLinksFromText(text) {
  return [...String(text || '').matchAll(markdownLinkPattern())].map(match => ({
    isImage: match[0].startsWith('!'),
    target: match[1],
  }));
}

function relativePathForReference(filePath, session) {
  const workspace = path.resolve(session.workspace || '');
  if (isInsideOrSame(filePath, workspace)) {
    return path.relative(workspace, filePath) || path.basename(filePath);
  }
  return filePath;
}

function quoteGetPath(value) {
  const text = String(value || '');
  if (!/\s/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function mimeFromFilename(name) {
  switch (path.extname(name).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.vue': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.json': return 'application/json';
    case '.pdf': return 'application/pdf';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.sql': return 'application/sql';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function kindFromFilename(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'image' : 'file';
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text.startsWith('<') && text.endsWith('>')) {
    return text.slice(1, -1);
  }
  return text;
}

function stripLineSuffix(value) {
  return String(value || '').replace(/:(\d+)(?::\d+)?$/, '');
}

function isUnsafeAttachmentPath(filePath, config) {
  const ext = path.extname(filePath).toLowerCase();
  return new Set(config.unsafeAttachmentExtensions || []).has(ext);
}

function resolveAllowedFileAccess(filePath, session = {}, options = {}) {
  const requestedPath = path.resolve(filePath);
  const realFilePath = safeRealpath(requestedPath);
  const roots = allowedAbsoluteGetRoots(session, options.projectRoots);

  if (realFilePath) {
    const root = roots.find(item =>
      item.realPath && isInsideOrSame(realFilePath, item.realPath)
    );
    if (root) {
      return {
        requestedPath,
        filePath: realFilePath,
        root,
      };
    }
  } else {
    const root = roots.find(item => isInsideOrSame(requestedPath, item.requestedPath));
    if (root) {
      return {
        requestedPath,
        filePath: requestedPath,
        root,
      };
    }
  }

  const allowedFiles = Array.isArray(options.allowedFiles) ? options.allowedFiles : [];
  const exactFile = allowedFiles.find(file =>
    typeof file === 'string' && sameResolvedPath(requestedPath, file)
  );
  if (!exactFile) return null;

  const allowedRealPath = safeRealpath(path.resolve(exactFile));
  if (realFilePath && (!allowedRealPath || !sameResolvedPath(realFilePath, allowedRealPath))) {
    return null;
  }
  if (
    realFilePath &&
    !sameResolvedPath(requestedPath, realFilePath) &&
    !isKnownMacSystemPathAlias(requestedPath, realFilePath)
  ) {
    return null;
  }
  return {
    requestedPath,
    filePath: realFilePath || requestedPath,
    exactFile: true,
  };
}

function allowedAbsoluteGetRoots(session, projectRoots = []) {
  const knownProjectRoots = Array.isArray(projectRoots) ? projectRoots : [];
  const roots = [...allowedGetRoots(session), ...knownProjectRoots].filter(Boolean);
  const seen = new Set();
  return roots
    .map(root => {
      const requestedPath = path.resolve(root);
      const realPath = safeRealpath(requestedPath);
      const key = realPath || requestedPath;
      if (seen.has(key)) return null;
      seen.add(key);
      return { requestedPath, realPath };
    })
    .filter(Boolean)
    .sort((a, b) =>
      (b.realPath || b.requestedPath).length -
      (a.realPath || a.requestedPath).length
    );
}

function safeRealpath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return '';
  }
}

function hasHiddenAccessPathSegment(access) {
  if (access.exactFile) {
    return hasHiddenAbsolutePathSegment(access.requestedPath) ||
      hasHiddenAbsolutePathSegment(access.filePath);
  }
  const requestedRoot = access.root.requestedPath;
  if (
    isInsideOrSame(access.requestedPath, requestedRoot) &&
    hasHiddenRelativePath(access.requestedPath, requestedRoot)
  ) {
    return true;
  }
  const realRoot = access.root.realPath;
  return Boolean(
    realRoot &&
    isInsideOrSame(access.filePath, realRoot) &&
    hasHiddenRelativePath(access.filePath, realRoot)
  );
}

function hasHiddenAbsolutePathSegment(filePath) {
  const resolved = path.resolve(filePath);
  return hasHiddenRelativePath(resolved, path.parse(resolved).root);
}

function hasHiddenRelativePath(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative
    .split(path.sep)
    .filter(Boolean)
    .some(segment => segment.length > 1 && segment.startsWith('.'));
}

function hasHiddenPathSegment(filePath, session = {}) {
  const access = resolveAllowedFileAccess(filePath, session);
  if (!access) return false;
  return hasHiddenAccessPathSegment(access);
}

function isInsideOrSame(filePath, dir) {
  if (!dir) return false;
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameResolvedPath(first, second) {
  const firstPath = path.resolve(first);
  const secondPath = path.resolve(second);
  return process.platform === 'win32'
    ? firstPath.toLowerCase() === secondPath.toLowerCase()
    : firstPath === secondPath;
}

function isKnownMacSystemPathAlias(requestedPath, realFilePath) {
  if (process.platform !== 'darwin') return false;
  const requested = path.resolve(requestedPath);
  if (requested !== '/var' && !requested.startsWith(`/var${path.sep}`)) {
    return false;
  }
  return path.resolve(realFilePath) === path.resolve(`/private${requested}`);
}

function cleanCandidate(value) {
  return String(value || '').replace(/[.,，。；;:]+$/g, '');
}

function cleanMarkdownTarget(value) {
  const target = stripWrappingQuotes(String(value || '').trim());
  const withoutTitle = target.match(/^(\S+)\s+["'][^"']*["']$/);
  return cleanCandidate(withoutTitle ? withoutTitle[1] : target);
}

function normalizeFileUriPath(value) {
  const text = String(value || '').trim();
  if (!/^file:\/\//i.test(text)) return normalizeWindowsMsysPath(text);
  try {
    return normalizeWindowsMsysPath(decodeURIComponent(new URL(text).pathname)
      .replace(/^\/([A-Za-z]:[\\/])/, '$1')
      .replace(/\//g, path.sep));
  } catch {
    return normalizeWindowsMsysPath(text.replace(/^file:\/*/i, ''));
  }
}

function normalizeWindowsMsysPath(value) {
  const text = String(value || '');
  if (process.platform !== 'win32') return text;
  const match = text.match(/^[/\\]([A-Za-z])[/\\](.*)$/);
  if (!match) return text;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/[\\/]+/g, path.sep)}`;
}

function extractText(input) {
  if (!Array.isArray(input)) return String(input || '');
  return input
    .filter(block => block?.type === 'text' || typeof block === 'string')
    .map(block => typeof block === 'string' ? block : (block.text || ''))
    .join('\n');
}

module.exports = {
  buildImageGenerationDeliveryHint,
  buildFileReference,
  buildFileReferenceHint,
  buildFileReferenceSystemPrompt,
  buildMarkdownImageFallback,
  buildOutboundFileMessage,
  candidatePathsFromMarkdownLinks,
  extractFileReferences,
  kindFromFilename,
  mimeFromFilename,
  resolveGetTarget,
  validateGetFile,
  _internal: {
    hasCodeImplementationContext,
    hasDirectImageGenerationIntent,
    isExplicitFileDeliveryRequest,
    isImageGenerationRequest,
    hasHiddenPathSegment,
    shouldAddFileReferenceHint,
    FILE_REFERENCE_HINT_MARKER,
    buildFileDeliveryInstructions,
  },
};
