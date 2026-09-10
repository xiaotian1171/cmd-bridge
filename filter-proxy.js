#!/usr/bin/env node
/**
 * 纯命令行 MCP 桥 —— 工具白名单代理
 * 出站：node filter-proxy.js -> desktop-commander (stdio)
 * 上游：supergateway (streamableHttp) -> 本代理 stdin/stdout
 * 作用：只放行终端类工具，屏蔽文件/搜索/配置类工具
 */
const { spawn } = require('child_process');
const readline = require('readline');

const CHILD = process.env.BRIDGE_CHILD || '/tmp/npmg/bin/desktop-commander';
const ALLOW = new Set(process.env.BRIDGE_ALLOW
  ? process.env.BRIDGE_ALLOW.split(',')
  : ['start_process', 'read_process_output', 'interact_with_process',
     'list_processes', 'kill_process', 'force_terminate']);

const child = spawn(CHILD, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pendingList = new Set();

const w = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }

  if (msg.method === 'tools/list') {
    if (msg.id !== undefined) pendingList.add(msg.id);
    child.stdin.write(line + '\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (!ALLOW.has(name)) {
      w({ jsonrpc: '2.0', id: msg.id, error: { code: -32601,
        message: `Tool "${name}" is blocked. This bridge exposes terminal tools only: ${[...ALLOW].join(', ')}` } });
      return;
    }
  }
  child.stdin.write(line + '\n');
});

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  if (msg.id !== undefined && pendingList.has(msg.id) && msg.result && Array.isArray(msg.result.tools)) {
    msg.result.tools = msg.result.tools.filter(t => ALLOW.has(t.name));
    pendingList.delete(msg.id);
  }
  w(msg);
});

process.stdin.on('end', () => child.stdin.end());
child.on('exit', (c) => process.exit(typeof c === 'number' ? c : 0));
