# cmd-bridge

**把一台远程机器的 shell，变成任何支持 MCP 的 AI 客户端可以直接调用的工具。**

不写服务端代码。三层全部使用现成组件拼装，5 分钟部署，一条命令启动，跑完就能从网页 AI 或任意 MCP 客户端操作那台机器。

公网出口内置两种隧道：**cloudflared（默认，零配置）** 与 **ngrok（需免费账号）**，按机器网络情况二选一。

---

## 它解决什么问题

网页版 AI 自带 30～60 秒的硬超时，也拿不到你远程机器的 shell。想让 AI 直接操作那台机器，缺的是一层"能被 MCP 客户端接入、又不会被超时打断"的执行通道。

cmd-bridge 就是这层通道。它把本地 stdio 类型的 MCP 执行引擎（desktop-commander）转换成带公网地址的 Streamable HTTP 服务，并用"异步启动 + 增量轮询"的方式绕开客户端超时。

## 架构

```
MCP 客户端（网页 AI / 桌面客户端 / 脚本）
        │  HTTPS + 路径 token
        ▼
公网隧道（二选一）
  · cloudflared quick tunnel   ← 默认，免登录
  · ngrok                      ← 需 authtoken，适合 Cloudflare 连不通的机器
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
| 公网入口 | cloudflared / ngrok | 把本地端口暴露到公网 | `install.sh` 自动下载 |
| 协议转换 | supergateway | stdio MCP → Streamable HTTP | npm 安装 |
| 执行引擎 | desktop-commander | 提供 26 个终端/文件工具 | npm 安装 |
| 可选代理 | filter-proxy.js | 工具白名单 + 调用拦截 | 仓库自带 |

## 快速开始

### 1. 环境要求

- Linux x86_64 / arm64（已在 Debian 系内核 6.x 实测），或 Windows 10/11、Windows Server 2016+（PowerShell 5.1+，脚本未在真机验证）
- Node.js ≥ 18（实测 v24）
- 能访问 npm、github.com、bin.equinox.io

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

两个隧道二进制各自独立安装，任一失败只告警、不阻断另一个：

- MCP 组件在 `~/.bridge-npm`（Windows 为 `%USERPROFILE%\.bridge-npm`）
- cloudflared 在 `~/.bridge/bin/cloudflared`（Windows 为 `%USERPROFILE%\.bridge\bin\cloudflared.exe`）
- ngrok 在 `~/.bridge/bin/ngrok`（Windows 为 `%USERPROFILE%\.bridge\bin\ngrok.exe`）

都可用环境变量改路径，见下方配置项。

### 3. 启动

**Linux / macOS：**

```bash
bash start.sh                      # 默认走 cloudflared
BRIDGE_TUNNEL=ngrok bash start.sh  # 改走 ngrok
BRIDGE_TUNNEL=none  bash start.sh  # 只监听本机
```

**Windows（PowerShell）：**

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
$env:BRIDGE_TUNNEL='ngrok'; powershell -ExecutionPolicy Bypass -File start.ps1
```

首次运行会自动生成 32 位十六进制 token，保存在 `~/.bridge/token`，之后复用。启动完成后打印：

```
本地入口: http://localhost:8000/mcp/<TOKEN>
公网入口: https://<随机域名>.trycloudflare.com/mcp/<TOKEN>
隧道类型: cloudflare
```

> 一定要用 `bash start.sh` 运行。脚本内部会 `pkill` 同名进程；若把脚本内容整段粘进 shell 执行，pkill 可能匹配到当前命令行把自己杀掉。

### 4. 接入客户端

把公网入口填进任意支持 Streamable HTTP 的 MCP 客户端：

```json
{
  "mcpServers": {
    "cmd-bridge": {
      "type": "streamable-http",
      "url": "https://<随机域名>/mcp/<TOKEN>"
    }
  }
}
```

部分客户端把 `type` 写作 `transport`、或要求 `"headers": {}`，按客户端规范调整即可。

### 5. 自测（不依赖客户端）

```bash
python3 - <<'PY'
import json, urllib.request
url = "https://<随机域名>/mcp/<TOKEN>"
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
| `BRIDGE_MODE` | `full` | `full` = 26 个工具全开（默认安全黑名单）；`admin` = 全开且清空黑名单（sudo/apt 等不再拦截，权限全开）；`safe` = 白名单 6 个终端工具 |
| `BRIDGE_TUNNEL` | `cloudflare` | 公网出口：`cloudflare` \| `ngrok` \| `none` |
| `BRIDGE_NO_TUNNEL` | — | 旧参数，设为 `1` 等价于 `BRIDGE_TUNNEL=none` |
| `NGROK_AUTHTOKEN` | — | `BRIDGE_TUNNEL=ngrok` 时使用，ngrok 自身也会读取该变量 |
| `BRIDGE_NPM_PREFIX` | `~/.bridge-npm` | MCP 组件安装位置 |
| `BRIDGE_HOME` | `~/.bridge` | token、日志、隧道二进制的存放位置 |

例：换端口、开白名单模式、只在本机用：

```bash
BRIDGE_TUNNEL=none BRIDGE_PORT=9000 BRIDGE_MODE=safe bash start.sh
BRIDGE_MODE=admin bash start.sh                     # 权限全开：清空命令黑名单（sudo 等不再拦截）
```

### 隧道怎么选

| | cloudflared quick tunnel（默认） | ngrok |
| --- | --- | --- |
| 账号 | 不需要 | 需注册免费账号并拿 authtoken |
| 每次启动的域名 | 随机 `*.trycloudflare.com`，重启必换 | 随机 `*.ngrok-free.app`，重启必换 |
| 适用场景 | 通用，开箱即用 | Cloudflare 出口被限制或连不通的机器 |
| 已知限制 | 首次域名 DNS 传播可能需一两分钟 | 免费版同一账号同时只允许 1 个 agent 会话在线；浏览器直接访问会撞警告页（MCP 客户端不受影响） |

ngrok 首次配置（只需一次）：

```bash
~/.bridge/bin/ngrok config add-authtoken <TOKEN>
```

也可以不落盘、每次启动前临时给：

```bash
export NGROK_AUTHTOKEN=<TOKEN>
BRIDGE_TUNNEL=ngrok bash start.sh
```

### 进程守护（可选）

supergateway 3.4.3 有一个已知 bug：MCP 客户端断开连接时会产生未处理异常并使进程退出（表现为桥突然失联，`~/.bridge/logs/sg.log` 尾部有异常栈）。本仓库已内置修复：`start.sh` 检测到 `dist/index.js` 时会用 `node -r sg-hook.cjs` 预加载异常护栏，这类异常只记录（`[sg-hook]` 前缀）不再杀进程，一个客户端断开不影响其他人继续使用。

如需"桥挂了自动拉起"，另起一个守护进程（每 5 秒检查进程与端口，按 `~/.bridge/tunnel_mode` 里记录的上次隧道模式重启）：

```bash
nohup bash keepalive.sh >/dev/null 2>&1 &
```

`bash stop.sh` 会一并停掉守护；手动停守护：`pkill -f cmd-bridge/keepalive.sh`。

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| `read_process_output` 报 `No session found for PID xxx` | supergateway 少了 `--stateful`，每个请求都会重开执行引擎实例，进程 session 丢失。本仓库脚本已内置。 |
| 自定义客户端第二次请求返回 `400 Bad Request` | 有状态模式下必须回传首个响应头里的 `Mcp-Session-Id`，检查客户端是否把它丢了。 |
| 桥突然失联，`~/.bridge/logs/sg.log` 尾部有 `[sg-hook]` 异常记录 | supergateway 3.4.3 已知 bug：客户端断开连接时未处理异常会杀掉整个进程。本仓库 `start.sh` 已自动挂护栏（`sg-hook.cjs`），异常只记日志不再崩；也可加 `keepalive.sh` 守护自动拉起（见下文"进程守护"）。 |
| ChatGPT 创建连接器报 Something went wrong | desktop-commander 0.2.50 给部分工具带了 OpenAI Apps SDK 的 widget 元数据（`_meta`），ChatGPT 会转去读 widget 资源导致创建失败。仓库已内置 `chatgpt-compat.cjs` 兼容层并由 `start.sh` 自动挂载（full 模式），无需额外配置。 |
| 启动后 stdout 全空、连接断开 | 命令里含 `pkill -f supergateway` 之类的自匹配串，把承载命令的 shell 自己杀了。放进脚本文件再执行。 |
| 重启后旧公网地址失效 | 两种隧道的域名都随进程变化，去 `~/.bridge/logs/cf.log` 或 `ng.log` 取新地址。 |
| ngrok 启动后取不到地址，日志有 `ERR_NGROK_4018` | 没配 authtoken。执行 `~/.bridge/bin/ngrok config add-authtoken <TOKEN>`，或启动前 `export NGROK_AUTHTOKEN=<TOKEN>`。 |
| 另一台机器启动后，原来的 ngrok 隧道掉线 | ngrok 免费版同一账号只允许 1 个 agent 会话在线，先在那台机器上 `bash stop.sh`。 |
| ngrok 报其他 `ERR_NGROK_xxxx` | `~/.bridge/logs/ng.log` 里有完整原因说明，按提示处理。 |
| 桥能本地访问但公网连不通 | 先 `bash stop.sh` 再换一种隧道重试（`BRIDGE_TUNNEL=ngrok` 或 `cloudflare`），多见于云厂商到 Cloudflare / ngrok 其中一方的网络不通。 |
| npm 安装后命令不存在 | npm 11 会拦 `postinstall`，可试 `npm rebuild -g --prefix <prefix> desktop-commander`。 |
| Windows：PowerShell 提示"禁止运行脚本" | 用 `powershell -ExecutionPolicy Bypass -File xxx.ps1` 运行，仓库脚本都不改系统执行策略。 |
| Windows：`npm install` 卡在 desktop-commander 的下载/编译 | 确认 Node 是 x64 官方构建；或在 `%USERPROFILE%\.bridge-npm` 下手动 `npm rebuild`。 |
| Windows：cloudflared / ngrok 下载失败 | 手动从 [cloudflared releases](https://github.com/cloudflare/cloudflared/releases/latest) 取 `cloudflared-windows-amd64.exe`，或从 [bin.equinox.io](https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip) 取 ngrok，分别放到 `%USERPROFILE%\.bridge\bin\` 下。 |
| Windows：stop.ps1 后端口仍被占用 | 有残留 node 进程，`Get-Process node` 看 PID 后手动 `Stop-Process -Id <pid> -Force`。 |

## 安全边界（必读）

- **URL 里的 token 就是全部凭据**，且执行引擎通常以部署用户身份运行，等价于把这台机器的 shell 交出去。
- 默认情况下**没有** header 校验、没有来源 IP 限制、没有命令黑名单、没有审计日志。
- 公网隧道地址随隧道进程变化，但 token 不变；token 泄露后地址可能被扫到并滥用。
- ngrok 免费版的隧道域名会被第三方扫描器高频扫描，且 ngrok 面板本身记录访问来源；敏感机器优先选 cloudflared，或干脆 `BRIDGE_TUNNEL=none` 只走内网。
- 建议：仅自用；`~/.bridge/token` 权限设 600；定期轮换 token；不要在群里、截图里、公开仓库里贴带 token 的完整 URL；更稳妥的做法是把部署机器本身做成隔离环境（容器/独立账号）。

`BRIDGE_MODE=admin` 会清空 desktop-commander 的命令黑名单（`sudo`、`apt` 等全部放行），`sudo docker`、`sudo apt` 等均直接可用。此模式下桥等价于一台无限制的 root 远程终端，**只建议在隔离环境（容器/一次性虚拟机/独立低权账号）中开启**。

要收敛风险，可用 `BRIDGE_MODE=safe` 只暴露终端类工具——注意这挡不住 `cat` 读文件，它是"减少误触面"，不是安全边界。

## 目录结构

```
cmd-bridge/
├── install.sh       # 安装 MCP 组件与两种隧道二进制（幂等）——Linux / macOS
├── start.sh         # 启动桥（含公网隧道，默认 cloudflared）——Linux / macOS
├── stop.sh          # 停止（含 keepalive 守护）——Linux / macOS
├── keepalive.sh     # 可选进程守护：桥意外退出 5 秒内自动拉起——Linux / macOS
├── sg-hook.cjs      # supergateway 崩溃护栏（start.sh 自动通过 node -r 挂载，勿单独运行）
├── chatgpt-compat.cjs # ChatGPT 兼容层：剥离 Apps SDK widget 元数据（full 模式自动挂载）
├── install.ps1      # 同 install.sh——Windows（PowerShell 5.1+）
├── start.ps1        # 同 start.sh——Windows
├── stop.ps1         # 停止——Windows
├── check.ps1        # 环境与进程检查——Windows
├── filter-proxy.js  # 可选白名单代理（BRIDGE_MODE=safe 时启用，两端通用）
└── README.md
```

运行期产物都在 `~/.bridge/`（Windows 为 `%USERPROFILE%\.bridge`）：`token`、`logs/sg.log`、`logs/cf.log`、`logs/ng.log`、`bin/cloudflared(.exe)`、`bin/ngrok(.exe)`。

## 已验证环境

- Debian 系 Linux x86_64，96 核 / 499 GB / 11 TB，Node v24.19.0，npm 11.17.0；另在 Alpine/musl（Node v24.20.0）环境跑通
- supergateway 3.4.3 + desktop-commander 0.2.50，协议版本 2024-11-05
- Ubuntu 22.x x86_64（Oracle Cloud，2 核 / 954 MB）：`BRIDGE_TUNNEL=none` 公网直连与 ngrok https 出口实测；supergateway 客户端断开崩溃 bug 已复现，`sg-hook.cjs` 护栏修复后断开 90 秒存活验证
- 同机实测 `BRIDGE_MODE=admin`：黑名单清空，`sudo` 与 `sudo docker` 经桥执行正常
- ngrok v3.39.11（Linux x86_64）：下载源、`http` 与 `config` 子命令参数已实测；未配 authtoken 时的 `ERR_NGROK_4018` 报错形态已实测；取地址逻辑用真实日志验证（认 logfmt 的 `url=` 字段，不会误抓日志里的 `dashboard.ngrok.com`）
- ngrok 免费版实测：MCP 客户端直接 POST 即可，不需要 `ngrok-skip-browser-warning` 头；浏览器警告页只影响用浏览器手动打开域名
- 已验证：工具列表拉取（26 个）、真实命令执行（含中文输出）、长驻进程增量轮询、交互写输入、通过 cloudflared 与 ngrok 两种公网隧道从外网回环调用（`start_process` 真实执行 + `read_file` 读回）
- **Windows 端（install.ps1 / start.ps1 / stop.ps1 / check.ps1）未在真机验证**，桌面执行引擎等组件均声明支持 Windows，理论上可直接跑；遇到问题请开 issue 附日志

## 说明

本仓库是组件编排方案，不含自研服务端逻辑（`filter-proxy.js` 为可选的 60 行白名单层）。部署前请确认你对该机器有合法操作权限。
