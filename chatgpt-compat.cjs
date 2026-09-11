#!/usr/bin/env node
// chatgpt-compat.cjs —— ChatGPT 兼容层（full 模式下由 start.sh 自动挂载）
//
// desktop-commander 0.2.50 会给部分工具附上 OpenAI Apps SDK 的 widget 元数据
// （_meta: { "ui/resourceUri": "ui://...", "openai/widgetAccessible": true }）。
// ChatGPT 的自定义 MCP 连接器看到这些字段后会改走 widget 应用流程，
// 逐个去读 ui:// 资源，最终创建连接器失败（Something went wrong）。
//
// 本文件夹在 supergateway 与 desktop-commander 之间做 stdio 透传，
// 只把 tools/list 响应里每个工具的 _meta 剥掉、并去掉 initialize 响应中
// 的 resources 能力宣告，其余消息原样转发；普通 MCP 客户端不受影响。
// 用法（由 start.sh 自动构造，勿单独运行）：
//   node chatgpt-compat.cjs -- <desktop-commander 可执行文件>

const { spawn } = require("child_process");
const readline = require("readline");

const sep = process.argv.indexOf("--");
if (sep === -1 || sep + 1 >= process.argv.length) {
  console.error("用法: node chatgpt-compat.cjs -- <server命令...>");
  process.exit(1);
}
const cmd = process.argv.slice(sep + 1);
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
child.on("exit", (code) => process.exit(code == null ? 0 : code));

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let out = line;
  try {
    const msg = JSON.parse(line);
    if (msg && msg.result) {
      if (Array.isArray(msg.result.tools)) {
        for (const tool of msg.result.tools) delete tool._meta;
      }
      if (msg.result.capabilities) delete msg.result.capabilities.resources;
    }
    out = JSON.stringify(msg);
  } catch (_) { /* 非 JSON 行原样透传 */ }
  process.stdout.write(out + "\n");
});
