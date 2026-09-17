export const SETTINGS_VIEW = 'settings';
export const SESSION_SETTINGS_LABEL = '本会话设置';

export const SETTINGS_TABS = [
    { id: 'agent', label: 'Agent 工作流', scope: '当前用户' },
    { id: 'tools', label: '工具与 MCP', scope: '当前用户' },
    { id: 'memory', label: '记忆', scope: '当前用户' },
    { id: 'appearance', label: '外观与语音', scope: '当前浏览器' },
    { id: 'versions', label: '配置版本', scope: '当前用户' },
];

export function openSettings(onViewChange) {
    return onViewChange?.(SETTINGS_VIEW);
}
