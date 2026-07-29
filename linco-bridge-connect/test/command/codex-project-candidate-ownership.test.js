const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { _internal: slashCommandInternals } = require('../../src/command');

test('Codex 项目路径重复归属时优先使用目录名匹配的项目', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linco-codex-project-ownership-'));
  const linkflowPath = path.join(homeDir, 'code', 'linkflow');
  const aichatPath = path.join(homeDir, 'code', 'aichat');
  const linkflowProjectId = 'codex-project-linkflow';
  const aichatProjectId = 'codex-project-aichat';
  fs.mkdirSync(linkflowPath, { recursive: true });
  fs.mkdirSync(aichatPath, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });

  fs.writeFileSync(path.join(homeDir, '.codex', '.codex-global-state.json'), JSON.stringify({
    'project-order': [linkflowProjectId, aichatProjectId],
    'local-projects': {
      [linkflowProjectId]: {
        id: linkflowProjectId,
        name: 'linkflow',
        rootPaths: [linkflowPath, aichatPath],
      },
      [aichatProjectId]: {
        id: aichatProjectId,
        name: 'aichat',
        rootPaths: [aichatPath],
      },
    },
  }));

  const candidates = slashCommandInternals.knownProjectCandidates(
    { agentType: 'codex' },
    { homeDir },
  );

  assert.deepStrictEqual(
    candidates.map(item => ({ path: item.path, label: item.label, projectId: item.projectId })),
    [
      { path: linkflowPath, label: 'linkflow', projectId: linkflowProjectId },
      { path: aichatPath, label: 'aichat', projectId: aichatProjectId },
    ],
  );
});
