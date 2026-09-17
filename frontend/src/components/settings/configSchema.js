const AGENT_DEFAULTS = {
    'agent.router.instruction': '',
    'agent.search.instruction': '',
    'agent.knowledge.instruction': '',
    'agent.general.instruction': '',
    'agent.code.instruction': '',
    'agent.synthesizer.instruction': '',
};

const TOOL_DEFAULTS = {
    'tool.web_search.description': '搜索互联网获取实时信息。返回搜索结果摘要。注意使用当前年份作为搜索参数。',
    'tool.search_knowledge_base.description': '搜索用户上传的知识库文档。输入为自然语言查询，返回相关文档片段。',
    'tool.get_system_time.description': '获取服务器当前的系统时间。无需参数。',
    'tool.get_db_message_count.description': '获取本地 SQLite 数据库中的历史对话总条数。无需参数。',
    'tool.memory.description': '管理用户记忆。支持 add、search、consolidate、forget 等操作。输入为 JSON 字符串。',
};

export const AGENT_CONFIGS = [
    {
        key: 'agent.router.instruction',
        label: 'Router 路由器',
        responsibility: '识别用户意图并选择后续工作流。',
        when: '每次请求进入主 Graph 时生效。',
        summary: '负责判断请求走直接回答、规划、搜索、知识库或代码路径。',
        defaultValue: AGENT_DEFAULTS['agent.router.instruction'],
    },
    {
        key: 'agent.search.instruction',
        label: 'Search 搜索 Agent',
        responsibility: '检索外部信息并整理来源。',
        when: '请求被路由到联网搜索任务时生效。',
        summary: '负责查询拆解、来源质量与搜索结果去重。',
        defaultValue: AGENT_DEFAULTS['agent.search.instruction'],
    },
    {
        key: 'agent.knowledge.instruction',
        label: 'Knowledge 知识 Agent',
        responsibility: '从用户知识库和记忆上下文中检索依据。',
        when: '请求需要本地知识或 RAG 上下文时生效。',
        summary: '负责知识库检索、上下文筛选与依据整理。',
        defaultValue: AGENT_DEFAULTS['agent.knowledge.instruction'],
    },
    {
        key: 'agent.general.instruction',
        label: 'General 通用 Agent',
        responsibility: '处理不需要专业检索的通用对话任务。',
        when: '请求进入通用回答分支时生效。',
        summary: '负责通用 ReAct 对话与无需专业工具的回答。',
        defaultValue: AGENT_DEFAULTS['agent.general.instruction'],
    },
    {
        key: 'agent.code.instruction',
        label: 'Code 代码 Agent',
        responsibility: '处理代码理解、工作区上下文与编码任务。',
        when: '请求被识别为代码或工作区任务时生效。',
        summary: '负责代码任务的上下文整理、执行边界与验证结果。',
        defaultValue: AGENT_DEFAULTS['agent.code.instruction'],
    },
    {
        key: 'agent.synthesizer.instruction',
        label: 'Synthesizer 汇总器',
        responsibility: '汇总专业 Agent 结果并生成最终回答。',
        when: '一个或多个专业分支返回结果后生效。',
        summary: '负责结果融合、引用整理和最终答复表达。',
        defaultValue: AGENT_DEFAULTS['agent.synthesizer.instruction'],
    },
];

export const TOOL_CONFIGS = [
    {
        key: 'tool.web_search.description',
        label: '联网搜索',
        responsibility: '内置联网搜索工具的描述。',
        defaultValue: TOOL_DEFAULTS['tool.web_search.description'],
    },
    {
        key: 'tool.search_knowledge_base.description',
        label: '搜索知识库',
        responsibility: '内置知识库检索工具的描述。',
        defaultValue: TOOL_DEFAULTS['tool.search_knowledge_base.description'],
    },
    {
        key: 'tool.get_system_time.description',
        label: '获取系统时间',
        responsibility: '内置系统时间工具的描述。',
        defaultValue: TOOL_DEFAULTS['tool.get_system_time.description'],
    },
    {
        key: 'tool.get_db_message_count.description',
        label: '历史消息统计',
        responsibility: '内置历史消息统计工具的描述。',
        defaultValue: TOOL_DEFAULTS['tool.get_db_message_count.description'],
    },
    {
        key: 'tool.memory.description',
        label: '记忆工具',
        responsibility: '内置记忆管理工具的描述。',
        defaultValue: TOOL_DEFAULTS['tool.memory.description'],
    },
];

export const MEMORY_CONFIGS = [
    {
        key: 'memory.consolidateThreshold',
        label: '记忆巩固阈值',
        description: '记忆巩固的默认重要性阈值。手动巩固按钮当前仍使用固定阈值 0.7。',
        inputType: 'ratio',
        defaultValue: '0.7',
    },
    {
        key: 'memory.autoForgetThreshold',
        label: '自动遗忘阈值',
        description: '自动遗忘策略使用的评分阈值。',
        inputType: 'ratio',
        defaultValue: '0.3',
    },
    {
        key: 'memory.autoForgetDays',
        label: '自动遗忘天数',
        description: '预留：当前运行时未读取此配置。',
        inputType: 'days',
        defaultValue: '30',
    },
    {
        key: 'memory.crossSource.experimentAllocation',
        label: '跨源实验分配比例',
        description: '跨源记忆实验的 0～1 分配比例；功能开关或环境变量可能覆盖保存值。',
        inputType: 'ratio',
        defaultValue: '0',
    },
    {
        key: 'memory.crossSource.experimentKey',
        label: '跨源实验键',
        description: '跨源实验使用的稳定分组键；功能开关或环境变量可能覆盖保存值。',
        inputType: 'text',
        defaultValue: 'memory-cross-source-v1',
    },
    {
        key: 'memory.crossSource.scoreWeights',
        label: '跨源评分权重',
        description: 'JSON 对象，必须包含 relevance、confidence、importance、recency、trust 五个非负有限数字。',
        inputType: 'json',
        defaultValue: '{"relevance":0.5,"confidence":0.2,"importance":0.1,"recency":0.1,"trust":0.1}',
    },
    {
        key: 'memory.crossSource.configVersionId',
        label: '跨源配置版本号',
        description: '可留空；功能开关或环境变量可能覆盖保存值。',
        inputType: 'nullableText',
        defaultValue: '',
    },
];

export const CONFIG_GROUPS = {
    agent: AGENT_CONFIGS,
    tool: TOOL_CONFIGS,
    memory: MEMORY_CONFIGS,
};

export const ALL_CONFIGS = [...AGENT_CONFIGS, ...TOOL_CONFIGS, ...MEMORY_CONFIGS];

const CONFIG_BY_KEY = new Map(ALL_CONFIGS.map((config) => [config.key, config]));

export function getConfigMeta(key) {
    return CONFIG_BY_KEY.get(key) || null;
}

export function configValueMap(configs = []) {
    const values = new Map();
    for (const config of Array.isArray(configs) ? configs : []) {
        if (config?.key) values.set(config.key, String(config.value ?? ''));
    }
    return values;
}

export function getConfigValue(configs, meta) {
    const values = configValueMap(configs);
    return values.has(meta.key) ? values.get(meta.key) : String(meta.defaultValue ?? '');
}

function invalid(message) {
    return { ok: false, value: null, error: message };
}

export function validateConfigValue(key, rawValue) {
    const meta = getConfigMeta(key);
    if (!meta) return invalid('未知配置项。');

    const value = String(rawValue ?? '');
    if (meta.inputType === 'ratio') {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 1) {
            return invalid('请输入 0 到 1 之间的有限数字。');
        }
        return { ok: true, value: String(number), error: '' };
    }

    if (meta.inputType === 'days') {
        if (!/^\d+$/.test(value.trim())) return invalid('请输入非负整数天数。');
        return { ok: true, value: String(Number(value)), error: '' };
    }

    if (meta.inputType === 'json') {
        let parsed;
        try {
            parsed = JSON.parse(value);
        } catch {
            return invalid('请输入有效的 JSON。');
        }
        const requiredKeys = ['relevance', 'confidence', 'importance', 'recency', 'trust'];
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return invalid('评分权重必须是 JSON 对象。');
        }
        if (requiredKeys.some((requiredKey) => !Number.isFinite(Number(parsed[requiredKey])) || Number(parsed[requiredKey]) < 0)) {
            return invalid('五个评分权重都必须是非负有限数字。');
        }
        return { ok: true, value: JSON.stringify(parsed), error: '' };
    }

    if (meta.inputType === 'nullableText') {
        return { ok: true, value: value.trim(), error: '' };
    }

    return { ok: true, value, error: '' };
}

export function formatConfigError(error, fallback = '保存失败，请重试。') {
    if (error?.status === 403 || error?.statusCode === 403) return '需要管理员权限。';
    return error?.message || fallback;
}
