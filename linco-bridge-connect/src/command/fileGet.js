const { buildOutboundFileMessage, resolveGetTarget, validateGetFile } = require('../core/fileReferences');
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
  }).map(project => project.path);
  const validation = validateGetFile(resolved, session, config, {
    projectRoots,
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
