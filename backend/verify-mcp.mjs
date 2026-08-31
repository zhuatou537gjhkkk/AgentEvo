// 手动验证 MCP 协议栈：连接内置 agent-evo-local MCP server
// 用法: cd backend && node verify-mcp.mjs
import { connectToMCPServer, discoverTools } from './src/mcp/client.js';

const client = await connectToMCPServer({
  name: 'agent-evo-local',
  command: 'node',
  args: ['src/mcp/run-server.js'],
});

const tools = await discoverTools(client);
console.log('✅ tools/list 发现', tools.length, '个工具:', tools.map(t => t.name).join(', '));

const r = await client.callTool({ name: 'get_system_time', arguments: { input: '' } });
console.log('✅ tools/call get_system_time =>', r.content[0].text);

await client.close();
console.log('✅ MCP Stdio 协议栈验证通过（list + call + close）');
