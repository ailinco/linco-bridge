const { buildOutboundFileMessage, resolveGetTarget, validateGetFile } = require('../core/fileReferences');
const { authorizedHistoryFiles } = require('../core/historyFileAccess');
const { send, sendError } = require('../core/protocol');
const { knownProjectCandidates } = require('./project');

function handleGet(rawTarget, ws, session, config) {
  const resolved = resolveGetTarget(rawTarget, session);
  if (!resolved) {
    sendError(ws, '用法：/get <文件路径>');
    return;
  }

  const projectRoots = knownProjectCandidates(session, {
    homeDir: config?.homeDir,
    limit: 20,
  }).map(project => project.path);
  const validation = validateGetFile(resolved, session, config, {
    projectRoots,
    allowedFiles: authorizedHistoryFiles(session),
  });
  if (!validation.ok) {
    sendError(ws, validation.message);
    return;
  }

  send(ws, 'outbound_message', buildOutboundFileMessage(
    session,
    validation.path,
    validation.size,
    { readPath: validation.readPath },
  ));
}

module.exports = {
  handleGet,
};
