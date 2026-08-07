function buildHelpPayload(session) {
  const agentType = session?.agentType || 'claude';
  const items = [
    helpItem('/update', '查看、升级或降级 Linco Connect；安装完成后自动后台重启'),
    helpItem('/help', '显示当前模式可用命令'),
    helpItem('/status', '显示当前会话状态'),
    helpItem('/stop', '停止当前 Agent 进程，保留可恢复会话 ID'),
    helpItem('/reload', '刷新当前 Agent 记忆，并尝试预启动进程'),
    helpItem('/approve manual', '切换为手动确认权限请求'),
    helpItem('/approve auto', '切换为自动确认权限请求'),
    helpItem('/approve yolo', '切换为 YOLO 权限模式，跳过权限/沙箱限制'),
    helpItem('/model', '显示/切换当前 Agent 模型'),
    helpItem('/usage', '显示 Token 用量统计'),
    helpItem('/compact', '触发当前 Agent 原生上下文整理（若支持）'),
    helpItem('/accounts --channel <channel>', '列出指定 channel 下已配置的账号 ID'),
    helpItem('/remove-account', '删除当前或指定 Agent 下的账号配置'),
  ];

  if (agentType === 'claude' || agentType === 'codex') {
    items.splice(2, 0,
      helpItem('/pwd', '显示当前项目目录'),
      helpItem('/cd <路径>', '绑定指定项目目录'),
      helpItem('/history [数量]', '显示当前会话最近聊天内容，默认 3 轮'),
      helpItem('/pc', '显示 PC 端打开当前 Agent 会话的命令'),
    );
    const usageIndex = items.findIndex(item => item.command === '/usage');
    const desc = agentType === 'claude'
      ? 'Show/switch Claude effort'
      : 'Show/switch Codex reasoning effort';
    items.splice(usageIndex >= 0 ? usageIndex : items.length, 0, helpItem('/reasoning', desc));
  } else if (agentType === 'openclaw') {
    items.splice(2, 0, helpItem('/agent', '查看/绑定后续 OpenClaw Agent'));
  } else if (agentType === 'hermes') {
    items.splice(2, 0, helpItem('/profile', '查看/绑定后续 Hermes Profile'));
  }

  return {
    agentType,
    returnedCount: items.length,
    items,
    notes: [
      '支持附件：默认允许普通文件（如 csv、xlsx、sql、txt、md、pdf、docx 等），高风险可执行/脚本文件默认拦截',
      'Agent 生成文件后会返回文件路径引用，点击引用后通过 /get 按需下发',
      '其他 /xxx 命令会透传给当前 Agent，优先使用当前 Agent 原生斜杠命令能力',
    ],
  };
}

function helpItem(command, description) {
  return {
    command,
    label: command,
    description,
  };
}

module.exports = {
  buildHelpPayload,
};
