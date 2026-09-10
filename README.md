# cmd-bridge

**把一台远程 Linux 机器的 shell，变成任何支持 MCP 的 AI 客户端可以直接调用的工具。**

不写服务端代码。三层全部使用现成组件拼装，5 分钟部署，一条命令启动，跑完就能从网页 AI 或任意 MCP 客户端操作那台机器。

---

## 它解决什么问题

网页版 AI 自带 30～60 秒的硬超时，也拿不到你远程机器的 shell。想让 AI 直接操作那台机器，缺的是一层"能被 MCP 客户端接入、又不会被超时打断"的执行通道。

cmd-bridge 就是这层通道。它把本地 stdio 类型的 MCP 执行引擎（desktop-commander）转换成带公网地址的 Streamable HTTP 服务，并用"异步启动 + 增量轮询"的方式绕开客户端超时。

## 架构

```
MCP 客户端（网页 AI / 桌面客户端 / 脚本）
        │  HTTPS + 路径 token
        ▼
cloudflared quick tunnel        ← 公网入口，零配置
        │  http://localhost:8000
        ▼
supergateway（--stateful）       ← stdio ⇄ Streamable HTTP 转换
        │  stdio
        ▼
desktop-commander               ← 执行引擎，26 个工具
        │
        ▼
宿主 shell（真实机器权限）
```

可选：在 supergateway 与执行引擎之间插入 `filter-proxy.js`，把工具面收敛到 6 个终端工具（`BRIDGE_MODE=safe`）。它只是收敛工具面，**不是沙箱**。

| 层 | 组件 | 作用 | 安装方式 |
| --- | --- | --- | --- |
| 公网入口 | cloudflared | quick tunnel，免登录出公网地址 | `install.sh` 自动下载 |
| 协议转换 | supergateway | stdio MCP → Streamable HTTP | npm 安装 |
| 执行引擎 | desktop-commander | 提供 26 个终端/文件工具 | npm 安装 |
| 可选代理 | filter-proxy.js | 工具白名单 + 调用拦截 | 仓库自带 |

## 快速开始

### 1. 环境要求

- Linux x86_64 / arm64（已在 Debian 系内核 6.x 实测），或 Windows 10/11、Windows Server 2016+（PowerShell 5.1+，脚本未在真机验证）
- Node.js ≥ 18（实测 v24）
- 能访问 npm 与 github.com

### 2. 安装

**Linux / macOS：**

```bash
git clone <你的仓库地址> cmd-bridge
cd cmd-bridge
bash install.sh
```

**Windows（PowerShell）：**

```powershell
git clone <你的仓库地址> cmd-bridge
cd cmd-bridge
powershell -ExecutionPolicy Bypass -File install.ps1
```

装完后：

- MCP 组件在 `~/.bridge-npm`（Windows 为 `%USERPROFILE%\.bridge-npm`：supergateway、desktop-commander）
- cloudflared 在 `~/.bridge/bin/cloudflared`（Windows 为 `%USERPROFILE%\.bridge\bin\cloudflared.exe`）
- 都可用环境变量改路径，见下方配置项

### 3. 启动

**Linux / macOS：**

```bash
bash start.sh
```

**Windows（PowerShell）：**

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

首次运行会自动生成 32 位十六进制 token，保存在 `~/.bridge/token`，之后复用。启动完成后打印：

```
本地入口: http://localhost:8000/mcp/<TOKEN>
公网入口: https://<随机域名>.trycloudflare.com/mcp/<TOKEN>
```

> 一定要用 `bash start.sh` 运行。脚本内部会 `pkill` 同名进程；若把脚本内容整段粘进 shell 执行，pkill 可能匹配到当前命令行把自己杀掉。

### 4. 接入客户端

把公网入口填进任意支持 Streamable HTTP 的 MCP 客户端：

```json
{
  "mcpServers": {
    "cmd-bridge": {
      "type": "streamable-http",
      "url": "https://<随机域名>.trycloudflare.com/mcp/<TOKEN>"
    }
  }
}
```

部分客户端把 `type` 写作 `transport`、或要求 `"headers": {}`，按客户端规范调整即可。

### 5. 自测（不依赖客户端）

```bash
python3 - <<'PY'
import json, urllib.request
url = "https://<随机域名>.trycloudflare.com/mcp/<TOKEN>"
def post(body, sid=None):
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if sid: h["Mcp-Session-Id"] = sid
    req = urllib.request.Request(url, json.dumps(body).encode(), h)
    r = urllib.request.urlopen(req)
    txt = r.read().decode()
    sid = r.headers.get("Mcp-Session-Id") or sid
    if txt.startswith("event:"):                      # SSE 响应
        txt = "".join(l[5:] for l in txt.splitlines() if l.startswith("data:"))
    return json.loads(txt), sid

r, sid = post({"jsonrpc":"2.0","id":1,"method":"initialize",
               "params":{"protocolVersion":"2024-11-05","capabilities":{},
                         "clientInfo":{"name":"probe","version":"1"}}})
post({"jsonrpc":"2.0","method":"notifications/initialized"}, sid)
r, _ = post({"jsonrpc":"2.0","id":2,"method":"tools/call",
             "params":{"name":"start_process",
                       "arguments":{"command":"uname -a && whoami","timeout_ms":8000}}}, sid)
print(r["result"]["content"][0]["text"])
PY
```

输出里出现机器内核信息和用户名，说明全链路已通。

## 配置项

全部通过环境变量传入，都有默认值。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BRIDGE_TOKEN` | 首次自动生成 | 路径 token，也是访问凭据 |
| `BRIDGE_PORT` | `8000` | supergateway 监听端口 |
| `BRIDGE_MODE` | `full` | `full` = 26 个工具全开；`safe` = 白名单 6 个终端工具 |
| `BRIDGE_NO_TUNNEL` | `0` | 设为 `1` 只监听本地，不起 cloudflared |
| `BRIDGE_NPM_PREFIX` | `~/.bridge-npm` | MCP 组件安装位置 |
| `BRIDGE_HOME` | `~/.bridge` | token、日志、cloudflared 的存放位置 |

例：只在本机用、换端口、开白名单模式：

```bash
BRIDGE_NO_TUNNEL=1 BRIDGE_PORT=9000 BRIDGE_MODE=safe bash start.sh
```

### 停止

```bash
bash stop.sh                # Linux / macOS
powershell -ExecutionPolicy Bypass -File stop.ps1   # Windows
```

## 交互模型（用之前必须理解）

客户端发一条长命令不能同步等结果——30～60 秒就会被掐断。正确姿势是四拍：

1. `start_process` 启动命令，立刻拿到 PID 和首批输出；**超时不等于失败**，进程仍在后台跑。
2. `read_process_output` 带 `offset` 增量续读，返回是否结束、退出码、还可读多少行。
3. `interact_with_process` 给交互式进程写输入（如 REPL、需要确认的脚本）。
4. `kill_process` / `force_terminate` 收尾。

网页 AI 场景下，务必把"异步启动 + 轮询续读"写进提示词，否则模型会把超时当成失败反复重跑同一条命令。

## 连接后的示例提示词

把下面这段放进客户端的系统提示词 / 自定义指令里（网页 AI 在创建 MCP Connector 时通常有"指令"输入框），AI 就会按正确的节奏使用工具：

```
你通过名为 cmd-bridge 的 MCP 服务操作一台远程机器（Linux 是 bash，Windows 是 PowerShell，由桥所在端决定），只有它提供的工具可用。

执行规则：
1. 一切命令用 start_process 发起。它会立刻返回 PID 和首批输出；若提示进程仍在运行（Process is running），不要重试，进入第 2 步。
2. 用 read_process_output 并传上次返回的 offset 参数继续读取，直到看到 "Process completed with exit code"。超时截断不代表失败，进程还在跑，继续轮询即可。
3. 交互式程序（python REPL、需要 y/n 确认的脚本）用 interact_with_process 写入；不再需要的进程用 kill_process 或 force_terminate 清掉。
4. 每条命令只做一件事，输出尽量精简（Linux 可加 2>&1 | tail -n 50；Windows 用 Select-Object -Last 50）。禁止启动会永久占住前台的命令（top、watch、无 -y 的交互安装器）；需要常驻服务时 Linux 用 nohup ... >log 2>&1 &，Windows 用 Start-Process。
5. 对机器的任何破坏性操作（rm -rf / Remove-Item -Recurse、覆盖配置、改网络）先向我说明要做什么、影响什么，等我确认再执行。
```

上面这段是"通用模板"。也可以只写一句轻量版：

```
执行命令时用 start_process 启动、read_process_output 带 offset 轮询到退出码为止，
超时不算失败；交互输入用 interact_with_process；危险操作先问我。（连接 Windows 端时命令写 PowerShell 语法）
```

## 安全边界（必读）

- **URL 里的 token 就是全部凭据**，且执行引擎通常以部署用户身份运行，等价于把这台机器的 shell 交出去。
- 默认情况下**没有** header 校验、没有来源 IP 限制、没有命令黑名单、没有审计日志。
- 公网隧道地址随 cloudflared 进程变化，但 token 不变；token 泄露后地址可能被扫到并滥用。
- 建议：仅自用；`~/.bridge/token` 权限设 600；定期轮换 token；不要在群里、截图里、公开仓库里贴带 token 的完整 URL；更稳妥的做法是把部署机器本身做成隔离环境（容器/独立账号）。

要收敛风险，可用 `BRIDGE_MODE=safe` 只暴露终端类工具——注意这挡不住 `cat` 读文件，它是"减少误触面"，不是安全边界。

## 目录结构

```
cmd-bridge/
├── install.sh       # 安装 MCP 组件与 cloudflared（幂等）——Linux / macOS
├── start.sh         # 启动桥（含公网隧道）——Linux / macOS
├── stop.sh          # 停止——Linux / macOS
├── install.ps1      # 同 install.sh——Windows（PowerShell 5.1+）
├── start.ps1        # 同 start.sh——Windows
├── stop.ps1         # 停止——Windows
├── check.ps1        # 环境与进程检查——Windows
├── filter-proxy.js  # 可选白名单代理（BRIDGE_MODE=safe 时启用，两端通用）
└── README.md
```

运行期产物都在 `~/.bridge/`（Windows 为 `%USERPROFILE%\.bridge`）：`token`、`logs/sg.log`、`logs/cf.log`、`bin/cloudflared(.exe)`。

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| `read_process_output` 报 `No session found for PID xxx` | supergateway 少了 `--stateful`，每个请求都会重开执行引擎实例，进程 session 丢失。本仓库脚本已内置。 |
| 自定义客户端第二次请求返回 `400 Bad Request` | 有状态模式下必须回传首个响应头里的 `Mcp-Session-Id`，检查客户端是否把它丢了。 |
| 启动后 stdout 全空、连接断开 | 命令里含 `pkill -f supergateway` 之类的自匹配串，把承载命令的 shell 自己杀了。放进脚本文件再执行。 |
| 重启后旧公网地址失效 | quick tunnel 的域名随进程变化，去 `~/.bridge/logs/cf.log` 取新地址。 |
| npm 安装后命令不存在 | npm 11 会拦 `postinstall`，可试 `npm rebuild -g --prefix <prefix> desktop-commander`。 |
| Windows：PowerShell 提示"禁止运行脚本" | 用 `powershell -ExecutionPolicy Bypass -File xxx.ps1` 运行，仓库脚本都不改系统执行策略。 |
| Windows：`npm install` 卡在 desktop-commander 的下载/编译 | 确认 Node 是 x64 官方构建；或在 `%USERPROFILE%\.bridge-npm` 下手动 `npm rebuild`。 |
| Windows：cloudflared 下载失败 | 手动从 [cloudflared releases](https://github.com/cloudflare/cloudflared/releases/latest) 下载 `cloudflared-windows-amd64.exe`，放到 `%USERPROFILE%\.bridge\bin\cloudflared.exe`。 |
| Windows：stop.ps1 后端口仍被占用 | 有残留 node 进程，`Get-Process node` 看 PID 后手动 `Stop-Process -Id <pid> -Force`。 |

## 已验证环境

- Debian 系 Linux x86_64，96 核 / 499 GB / 11 TB，Node v24.19.0，npm 11.17.0；另在 Alpine/musl（Node v24.20.0）环境跑通
- supergateway + desktop-commander 0.2.50，协议版本 2024-11-05
- 已验证：工具列表拉取、真实命令执行（含中文输出）、长驻进程增量轮询、交互写输入、通过公网隧道回环调用
- **Windows 端（install.ps1 / start.ps1 / stop.ps1 / check.ps1）未在真机验证**，桌面执行引擎等组件均声明支持 Windows，理论上可直接跑；遇到问题请开 issue 附日志

## 说明

本仓库是组件编排方案，不含自研服务端逻辑（`filter-proxy.js` 为可选的 60 行白名单层）。部署前请确认你对该机器有合法操作权限。
