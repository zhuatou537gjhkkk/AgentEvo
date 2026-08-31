// 手动验证：连接高德地图官方 MCP server（真实服务，需 API key）
// 前置: 把 AMAP_MAPS_API_KEY=你的key 写进 backend/.env（本脚本通过 dotenv 读取）
// 用法: cd backend && node verify-mcp-amap.mjs
import "dotenv/config";
import { connectToMCPServer, discoverTools } from './src/mcp/client.js';

const client = await connectToMCPServer({
  name: 'amap',
  command: 'npx',
  args: ['-y', '@amap/amap-maps-mcp-server'],
  // 显式传入：SDK 白名单不会自动继承自定义 env
  env: { AMAP_MAPS_API_KEY: process.env.AMAP_MAPS_API_KEY },
});

const tools = await discoverTools(client);
console.log('✅ 高德 MCP 发现', tools.length, '个工具:');
for (const t of tools) {
  console.log('  -', t.name, ':', (t.description || '').slice(0, 60));
}

// 想真正调用，取消下面注释（参数以 list 出来的 inputSchema 为准）:
// const r = await client.callTool({ name: 'maps_weather', arguments: { city: '北京' } });
// console.log('✅ maps_weather =>', JSON.stringify(r.content?.[0]?.text ?? r).slice(0, 300));

await client.close();
console.log('✅ 高德 MCP 连接 + 工具发现验证通过');
