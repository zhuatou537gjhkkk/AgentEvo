/**
 * ToolRegistry 单元测试 — Phase 4 P0
 *
 * 覆盖：
 *   - getTool() 命名空间格式 (serverName/toolName)
 *   - getTool() 裸名回退 + 本地遮蔽
 *   - getToolCategories() 动态类别
 *   - hasToolCategory() 本地/MCP 类别判断
 *   - registerLocalTools 去重
 *
 * 运行: npx vitest run src/mcp/registry.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamicTool } from '@langchain/core/tools';
import { ToolRegistry } from './registry.js';

// ── 测试辅助：构造 mock DynamicTool ──
function makeTool(name, description = '', fn = async () => 'ok') {
    return new DynamicTool({ name, description, func: fn });
}

// ── 构造模拟 MCP client ──
function makeMockMCPClient(toolsOverride) {
    return {
        listTools: vi.fn().mockResolvedValue({
            tools: toolsOverride || [
                { name: 'read_file', description: 'Read a file from the filesystem' },
                { name: 'write_file', description: 'Write content to a file' },
                { name: 'list_directory', description: 'List directory contents' },
            ],
        }),
        callTool: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'mock result' }],
        }),
        close: vi.fn().mockResolvedValue(undefined),
    };
}

describe('ToolRegistry', () => {
    let registry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    // ═══════════════════════════════════════════════════════
    // registerLocalTools
    // ═══════════════════════════════════════════════════════

    describe('registerLocalTools', () => {
        it('注册本地工具后 getAllTools 返回正确的数量', () => {
            registry.registerLocalTools([
                makeTool('web_search', '搜索互联网'),
                makeTool('search_knowledge_base', '搜索知识库'),
                makeTool('get_system_time', '获取系统时间'),
            ]);
            const all = registry.getAllTools();
            expect(all).toHaveLength(3);
            expect(all.map(t => t.name).sort()).toEqual([
                'get_system_time', 'search_knowledge_base', 'web_search',
            ]);
        });

        it('重复注册同名工具会被跳过', () => {
            registry.registerLocalTools([makeTool('web_search')]);
            registry.registerLocalTools([makeTool('web_search')]);
            expect(registry.getAllTools()).toHaveLength(1);
        });

        it('非 DynamicTool 实例被跳过', () => {
            registry.registerLocalTools([{ name: 'not_a_tool', func: () => {} }]);
            expect(registry.getAllTools()).toHaveLength(0);
        });

        it('空数组不报错', () => {
            registry.registerLocalTools([]);
            expect(registry.getAllTools()).toHaveLength(0);
        });

        it('非数组参数不报错', () => {
            registry.registerLocalTools(null);
            registry.registerLocalTools(undefined);
            registry.registerLocalTools('not_array');
            expect(registry.getAllTools()).toHaveLength(0);
        });
    });

    // ═══════════════════════════════════════════════════════
    // getTool — 裸名查询 (向后兼容)
    // ═══════════════════════════════════════════════════════

    describe('getTool — 裸名查询', () => {
        beforeEach(() => {
            registry.registerLocalTools([
                makeTool('web_search', '搜索互联网'),
                makeTool('get_system_time', '获取系统时间'),
            ]);
        });

        // T1.4
        it('裸名查本地工具返回正确实例', () => {
            const tool = registry.getTool('web_search');
            expect(tool).toBeDefined();
            expect(tool.name).toBe('web_search');
        });

        // T1.6 🔑
        it('本地工具同名时优先返回本地版本（遮蔽 MCP）', async () => {
            // 模拟 MCP 连接 — 也注册了一个叫 web_search 的工具
            const mockClient = makeMockMCPClient([
                { name: 'web_search', description: 'MCP search' },
                { name: 'list_directory', description: 'List dir' },
            ]);

            // 绕过 connectToMCPServer 直接注入 MCP wrapper
            const prefixed = [
                makeTool('filesystem/web_search', 'MCP search'),
                makeTool('web_search', 'MCP search'),  // 裸名
                makeTool('filesystem/list_directory', 'List dir'),
            ];
            // 手动注入到 _mcpWrappers
            registry._mcpWrappers.set('filesystem', {
                client: mockClient,
                tools: prefixed,
            });

            // 裸名查询 → 本地工具优先
            const tool = registry.getTool('web_search');
            expect(tool).toBeDefined();
            // 应该返回本地注册的，不是 MCP 的
            expect(tool.description).toBe('搜索互联网');
        });

        it('裸名查不存在的工具返回 undefined', () => {
            expect(registry.getTool('nonexistent')).toBeUndefined();
        });

        it('裸名查 MCP fallback — 本地无同名时可用', async () => {
            const mockClient = makeMockMCPClient();
            const prefixed = [
                makeTool('filesystem/read_file', 'Read a file'),
                makeTool('read_file', 'Read a file'),  // 裸名 fallback
            ];
            registry._mcpWrappers.set('filesystem', { client: mockClient, tools: prefixed });

            // 本地没有 read_file → MCP fallback 生效
            const tool = registry.getTool('read_file');
            expect(tool).toBeDefined();
            expect(tool.name).toBe('read_file');
        });
    });

    // ═══════════════════════════════════════════════════════
    // getTool — 命名空间格式 (Phase 4 核心)
    // ═══════════════════════════════════════════════════════

    describe('getTool — 命名空间 "serverName/toolName"', () => {
        beforeEach(async () => {
            registry.registerLocalTools([
                makeTool('web_search', '搜索互联网'),
            ]);

            const mockClient = makeMockMCPClient();
            const prefixed = [
                makeTool('filesystem/read_file', 'Read a file from the filesystem'),
                makeTool('filesystem/write_file', 'Write content to a file'),
                makeTool('filesystem/list_directory', 'List directory contents'),
                makeTool('read_file', 'Read a file'),
                makeTool('write_file', 'Write content to a file'),
            ];
            registry._mcpWrappers.set('filesystem', { client: mockClient, tools: prefixed });
        });

        // T1.1
        it('命名空间格式查存在的 MCP 工具', () => {
            const tool = registry.getTool('filesystem/read_file');
            expect(tool).toBeDefined();
            expect(tool.name).toBe('filesystem/read_file');
        });

        // T1.2
        it('命名空间格式 — 不存在的 server 返回 undefined', () => {
            expect(registry.getTool('nonexistent/read_file')).toBeUndefined();
        });

        // T1.3
        it('命名空间格式 — 存在的 server 但不存在的 tool 返回 undefined', () => {
            expect(registry.getTool('filesystem/nonexistent_tool')).toBeUndefined();
        });

        it('命名空间格式 — server 名为空字符串', () => {
            expect(registry.getTool('/read_file')).toBeUndefined();
        });

        it('命名空间格式 — 多个斜杠 (取第一个)', () => {
            // "a/b/c" → serverName="a", toolName="b/c"
            const tool = registry.getTool('filesystem/read_file/extra');
            expect(tool).toBeUndefined(); // 找不到 "read_file/extra"
        });
    });

    // ═══════════════════════════════════════════════════════
    // hasTool
    // ═══════════════════════════════════════════════════════

    describe('hasTool', () => {
        beforeEach(() => {
            registry.registerLocalTools([makeTool('web_search')]);
        });

        it('存在的工具返回 true', () => {
            expect(registry.hasTool('web_search')).toBe(true);
        });

        it('不存在的工具返回 false', () => {
            expect(registry.hasTool('nonexistent')).toBe(false);
        });

        it('命名空间格式的存在工具返回 true', async () => {
            const mockClient = makeMockMCPClient();
            registry._mcpWrappers.set('filesystem', {
                client: mockClient,
                tools: [makeTool('filesystem/read_file')],
            });
            expect(registry.hasTool('filesystem/read_file')).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════
    // getToolCategories — Phase 4 动态工具感知
    // ═══════════════════════════════════════════════════════

    describe('getToolCategories', () => {
        // T2.1
        it('只有本地工具时返回 search/knowledge/system 类别', () => {
            registry.registerLocalTools([
                makeTool('web_search', '搜索互联网'),
                makeTool('search_knowledge_base', '搜索知识库'),
                makeTool('get_system_time', '获取系统时间'),
                makeTool('get_db_message_count', '数据库统计'),
                makeTool('ask_user_question', '向用户提问'),
            ]);

            const categories = registry.getToolCategories();
            expect(categories).toHaveLength(3);

            const searchCat = categories.find(c => c.category === 'search');
            expect(searchCat).toBeDefined();
            expect(searchCat.type).toBe('local');
            expect(searchCat.tools.map(t => t.name)).toContain('web_search');

            const kbCat = categories.find(c => c.category === 'knowledge');
            expect(kbCat).toBeDefined();
            expect(kbCat.tools.map(t => t.name)).toContain('search_knowledge_base');

            const sysCat = categories.find(c => c.category === 'system');
            expect(sysCat).toBeDefined();
            expect(sysCat.tools.map(t => t.name)).toEqual(
                expect.arrayContaining(['get_system_time', 'get_db_message_count', 'ask_user_question'])
            );
        });

        // T2.2
        it('有 MCP Server 时出现对应类别（仅含命名空间前缀的工具）', () => {
            registry.registerLocalTools([makeTool('web_search')]);

            const mockClient = makeMockMCPClient();
            const prefixed = [
                makeTool('filesystem/read_file', 'Read a file'),
                makeTool('filesystem/write_file', 'Write a file'),
                makeTool('read_file', 'Read a file'),   // 裸名 — 不应出现在类别中
            ];
            registry._mcpWrappers.set('filesystem', { client: mockClient, tools: prefixed });

            const categories = registry.getToolCategories();
            const fsCat = categories.find(c => c.category === 'filesystem');
            expect(fsCat).toBeDefined();
            expect(fsCat.type).toBe('mcp');
            expect(fsCat.tools).toHaveLength(2);
            // 只含 "/" 的版本
            expect(fsCat.tools.every(t => t.name.includes('/'))).toBe(true);
        });

        // T2.3
        it('MCP 工具不含裸名重复', () => {
            registry.registerLocalTools([makeTool('web_search')]);

            const mockClient = makeMockMCPClient();
            const prefixed = [
                makeTool('github/search_repos', 'Search repos'),
            ];
            registry._mcpWrappers.set('github', { client: mockClient, tools: prefixed });

            const categories = registry.getToolCategories();
            const ghCat = categories.find(c => c.category === 'github');
            expect(ghCat.tools).toHaveLength(1);
            expect(ghCat.tools[0].name).toBe('github/search_repos');
        });

        // T2.4
        it('空注册表返回空数组', () => {
            expect(registry.getToolCategories()).toEqual([]);
        });

        it('MCP wrapper 无 prefixed 工具时不生成空类别', () => {
            // 全部裸名无前缀 → 类别为空
            registry.registerLocalTools([makeTool('web_search')]);

            const mockClient = makeMockMCPClient();
            const bareOnly = [
                makeTool('read_file', 'Read a file'),   // 无 "/" 前缀
            ];
            registry._mcpWrappers.set('filesystem', { client: mockClient, tools: bareOnly });

            const categories = registry.getToolCategories();
            const fsCat = categories.find(c => c.category === 'filesystem');
            // 没有带命名空间的工具，不应出现该类别
            expect(fsCat).toBeUndefined();
        });

        it('多个 MCP Server 各自独立类别', () => {
            const fsClient = makeMockMCPClient();
            registry._mcpWrappers.set('filesystem', {
                client: fsClient,
                tools: [makeTool('filesystem/read_file')],
            });

            const ghClient = makeMockMCPClient([{ name: 'search_repos', description: 'Search GitHub repos' }]);
            registry._mcpWrappers.set('github', {
                client: ghClient,
                tools: [makeTool('github/search_repos')],
            });

            const categories = registry.getToolCategories();
            const catNames = categories.map(c => c.category);
            expect(catNames).toContain('filesystem');
            expect(catNames).toContain('github');
        });
    });

    // ═══════════════════════════════════════════════════════
    // hasToolCategory — Phase 4
    // ═══════════════════════════════════════════════════════

    describe('hasToolCategory', () => {
        // T3.1
        it.each(['search', 'knowledge', 'system', 'general', 'code'])(
            '本地已知类别 "%s" 返回 true', (cat) => {
                expect(registry.hasToolCategory(cat)).toBe(true);
            }
        );

        // T3.3
        it('已连接 MCP server 名返回 true', () => {
            const mockClient = makeMockMCPClient();
            registry._mcpWrappers.set('filesystem', {
                client: mockClient,
                tools: [makeTool('filesystem/read_file')],
            });

            expect(registry.hasToolCategory('filesystem')).toBe(true);
        });

        // T3.4
        it('不存在的类别返回 false', () => {
            expect(registry.hasToolCategory('aliens')).toBe(false);
        });

        it('未连接的 MCP server 名返回 false', () => {
            expect(registry.hasToolCategory('not_connected')).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════
    // getMCPServerNames / getMCPServerTools
    // ═══════════════════════════════════════════════════════

    describe('getMCPServerNames', () => {
        it('无 MCP 连接返回空数组', () => {
            expect(registry.getMCPServerNames()).toEqual([]);
        });

        it('有连接时返回 server 名列表', () => {
            registry._mcpWrappers.set('filesystem', { client: makeMockMCPClient(), tools: [] });
            registry._mcpWrappers.set('github', { client: makeMockMCPClient(), tools: [] });
            expect(registry.getMCPServerNames().sort()).toEqual(['filesystem', 'github']);
        });
    });

    describe('getMCPServerTools', () => {
        it('存在的 server 返回工具列表', () => {
            const tools = [makeTool('filesystem/read_file')];
            registry._mcpWrappers.set('filesystem', { client: makeMockMCPClient(), tools });

            const result = registry.getMCPServerTools('filesystem');
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('filesystem/read_file');
        });

        it('不存在的 server 返回空数组', () => {
            expect(registry.getMCPServerTools('nonexistent')).toEqual([]);
        });
    });

    // ═══════════════════════════════════════════════════════
    // getAllTools — 排序验证
    // ═══════════════════════════════════════════════════════

    describe('getAllTools', () => {
        it('本地工具在前，MCP 工具在后', () => {
            registry.registerLocalTools([makeTool('web_search')]);

            registry._mcpWrappers.set('filesystem', {
                client: makeMockMCPClient(),
                tools: [
                    makeTool('filesystem/read_file'),
                    makeTool('read_file'),
                ],
            });

            const all = registry.getAllTools();
            expect(all[0].name).toBe('web_search');
            // MCP tools 在后面
            const names = all.map(t => t.name);
            expect(names.indexOf('filesystem/read_file')).toBeGreaterThan(0);
        });
    });
});
