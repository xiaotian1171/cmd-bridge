# cmd-bridge 偶发 `-32603 Internal error` 排查与修复报告（第三轮：上线前最后一轮核对）

> 排查方式：对线上 `@near` **只读**（未改文件、配置、进程，未重启服务）。
> 所有代码修改与测试都在独立副本 `cmd-bridge-fix/` 内完成，**未部署、未上线**。
> 本报告已隐藏 token、完整 MCP URL、隧道凭据与主机名细节。

---

## 0. 一句话结论

1. 第一轮的 `dc-hub-client` / 守护 / 误杀 / 假健康 / 在途挂死这一组**代码缺陷已确认并修复**。
2. 本轮做"首次从旧版切换到新版"的验证时，**又抓出两个真实代码问题**（A12、A13），其中 A12 会在 TLS 关闭时把**同机另一套桥的网关**当成"本桥旧实例"强杀 —— 已修复，t11 复现 → 修 → 全绿。
3. "空闲修剪 + 60 上限"和"会话自然过期"这两条路径，**已用真实第三方 MCP 客户端（mcporter，基于官方 SDK）在独立测试桥上实测**：客户端在下一次调用时能自动重建会话并成功，不需要人工干预；同时**明确区分**了"中枢短暂断开、转发进程存活（可继续用同一会话）"与"整桥重启、旧会话与缓冲随进程消失（必须客户端重建会话）"。
4. 线上 398 个 `dc-hub-client` 与高负载是**观察到的事实**；"进程堆积 → 负载高 → 某次客户端 `-32603`"仍是**推测**（缺客户端报错时间戳，无法与服务端日志对齐）。

测试汇总：**152 通过 / 0 失败**（8 个套件，见第三节）。

---

## 一、三类信息的严格区分

### A. 确认的代码问题（有复现或测试证据）

| # | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| A1 | 中枢暂缺或退出时，`dc-hub-client` **直接 exit**，该 session 转发进程死亡 | `test/repro-old-defect.cjs` 旧版（HEAD 原始实现）：A 场景 `已退出: true (exitCode=1)`、B `true`、C `true`；修复版三场景均 `false` | 连接失败/断开都进重连，不再退出（仅上游 kill 或 stdin 结束才退） |
| A2 | 旧版没有可用重连：中枢事后恢复也接不回来 | 同脚本旧版 `能否重连并应答: false`，修复版 `true` | 指数退避 + 抖动（500ms 起、封顶 15s、±20%）、重试上限 20 次、未连上期间缓冲请求并在连上后按序补发 |
| A3 | 守护**升级判据错误**：按"修剪后总量仍超上限"判定 → 客户端持续新建 session 时误判"修剪无效" → 整桥重启 | `test/t7-client-cap.cjs` 首跑 `restarts=1`，`keepalive.log` 显示 2 次"修剪→复查仍超限"后触发重启 | 判据改为"被要求退出的进程还有几个没退出"（straggler）；持续超限只记日志、不重启整桥 |
| A4 | 修剪排序精度不足（秒级 `etimes` 同岁乱序）→ 可能剔掉最新 session | t7 首跑"修剪期间新 session 的调用未被打断"失败（`status=400`） | client 每转发一条消息 `utimes activity/<pid>.act`；守护按"空闲毫秒降序 + 启动 tick 升序"剔除 |
| A5 | 按进程名匹配判活/强杀范围过宽，**误杀网关与别人的进程** | ① supergateway 的 cmdline 含 `--stdio .../dc-hub-client.cjs`，会杀掉网关本体；② t8 反证：`BRIDGE_KILL_LEGACY=1` 连带杀掉诱饵与另一套桥的网关 | 所有子进程带 `BRIDGE_OWNER=<BRIDGE_HOME绝对路径>`；停止/判活只认"cmdline 匹配 且 environ 带本桥标记"；client 匹配排除网关；legacy 全量 `pkill -f` 默认关闭 |
| A6 | 守护与手动 `stop.sh` **抢重启** | t8/t10 验证 stopping 标志生效 | `stop.sh` 先立 `$BRIDGE_HOME/stopping`；`keepalive` 每轮与 restart 前检查即退出；`start.sh` 顶部同样加闸门 |
| A7 | 健康检查是**假健康**：只看端口/socket 存在 | t10：`SIGSTOP` 网关后 TCP 仍可连但 healthz 已答不出来；`SIGSTOP` 中枢后 socket 仍可 connect 但 MCP 探测无响应 | 网关探 `/healthz`，中枢做真实 MCP 探测；stale socket 不算健康 |
| A8 | 在途请求**挂死**（无响应也无错误） | t9：中枢 `SIGSTOP` 后在途请求 15s 内收到明确 `-32603 "…retry the request"` | client 只对"真正写给中枢"的 request id 登记 pending；断连时对未完成 id 回明确可重试错误 |
| A9 | 中枢自愈拉起被 sh 包装进程干扰，单例判定失败（`hub=2`） | t9 "中枢单例"用例失败 | 优先用 `DC_HUB_NODE/DC_HUB_SCRIPT/DC_HUB_ENGINE` 直接 spawn argv；`O_EXCL` 文件锁（60s stale） |
| A10 | 僵尸进程被算作存活 | 计数/强杀改用 `/proc/pid/stat` 第 3 字段，`Z` 不算活 | `pid_state` / `pid_alive_real` |
| A11 | 引擎进程堆积：每个 session 独占一份引擎 | 历史观察 + `dc-hub` 单例引擎复用改动 | 所有 session 复用一份 `dc-hub` → 一份引擎 |
| **A12** | **旧实例识别的端口口径错**：`bridge_ports` 无条件把 `BRIDGE_PORT+1` 当本桥端口。TLS 关闭时本桥只监听 `BRIDGE_PORT`，`+1` 是**别人的端口**；同机另一套桥正好用相邻端口时，stop.sh 会把它的**网关当成"本桥旧实例"强杀**（还会报"端口已释放"的假象） | 本轮 t11 首次跑：`stop.sh A` 输出 `端口 8810 仍被占用: 116，尝试强制释放 → 已强杀占用者: 116`，随后 B 的网关死亡、B 无法建会话（2 项失败）。原因已用单独探针复现并确认（A=8809，B=8810 相邻端口） | `bridge_ports` 改为**只有本桥启用 TLS 时才包含 `BRIDGE_PORT+1`**（读 `run_tls`，与 start.sh 的 `SG_PORT=PORT+1` 语义一致）；端口释放核对阶段再增加一道保护：**环境指向别的 home/sock 的进程一律跳过，不强杀** |
| **A13** | `stop.sh` 立完 stopping 标志**立刻 SIGTERM 守护**，守护来不及记日志，事后无法判断"是谁先动的手" | 本轮全套回归时 t8 报 `守护日志记录了「检测到 stopping 标志」` 失败，`keepalive.log` 只有启动行 | `stop.sh` 改为：立标志后**先等守护自己退**（每 1s 复查，最多 12s），再对残余守护发 TERM。修复后 `keepalive.log` 有 `检测到 stopping 标志（手动停止进行中），守护退出` |

### B. 观察到的现象（线上只读采集，只说事实）

1. `dc-hub-client.cjs` 进程数 **398 个**；同机还有 1 个 `supergateway`、1 个 `dc-hub.cjs`、1 个 `cloudflared`、若干 `desktop-commander`。
2. 容器 1 核 / 512MB，当时 **load average ≈ 34.8 / 33.3 / 33.5**，446 个任务，内存 used ≈ 211MB（**未见 OOM**）。
3. `sg.log` 中出现 **4 次** `[sg-hook] unhandledRejection kept-alive: Error: No connection established for request ID: 0`。**这 4 次不等于客户端全部报错次数。**
4. `keepalive.log`：曾出现 109 次 `bridge down, restarting`，集中在启动期抖动时段，其后长期无重启。
5. `hub.log` 仅 1 行 listening；`dc-hub.sock` 正常。
6. `cf.log` 有隧道抖动记录（`failed to dial to edge with quic: timeout` 等）。
7. 客户端侧报过 `-32603`，但**没有拿到准确报错时间戳**，无法与服务端日志按时间对齐。

### C. 推测的因果关系（未证明，仅列假设与验证方式）

1. **推测**：398 个 client 进程 → 1 核调度压力 → supergateway 转发/超时失败 → 客户端 `-32603`。
   **未证明**：无法把客户端报错时刻与三份日志对齐；`sg.log` 里 `-32603` 计数为 0。
   **验证方式**：客户端报错时记录时间戳后再对齐日志。
2. **推测**：cloudflared 隧道抖动造成部分断连。**未证明**：抖动有记录，但缺同刻客户端证据。
3. **推测**：`sessionTimeout` 过长是进程堆积的放大器。**本轮已用真实客户端验证了一部分**（见第二节第 7 项）：过期与修剪后客户端能自动重建会话，**但 ChatGPT 连接器 / Operit 仍未实测**。

---

## 二、上线前验证：方法、命令、结果

所有测试命令均在副本目录执行，使用 `/tmp` 临时 `BRIDGE_HOME` 与高位端口，不触碰线上：

```bash
cd cmd-bridge-fix
bash test/run-suite.sh        # 一键跑全套（含新旧对照复现）
```

### 1. 会话过期语义 → `test/t6-session-expiry.cjs`：**9 / 0**
过期 session 再被使用：**HTTP 400 + JSON-RPC -32000**（不是规范建议的 404 / -32001）；对应 client 被回收；可重新 initialize；**带旧 session ID 不能自愈**；持有 GET SSE 流的在线客户端**不会**被回收。

### 2. 进程上限 → `test/t7-client-cap.cjs`：**19 / 0**
超限只按空闲修剪、不重启整桥（38+ session、`restarts=0`）；正在频繁使用的 session 不会被打断；`start.sh` 失败按 COOLDOWN 退避。

### 3. 停止/重启作用域 → `test/t8-scope.cjs`：**22 / 0**
`stop.sh` / `start.sh` 只影响本桥；同机另一套桥 B 与"别人的同名 supergateway"诱饵全程存活；守护不与手动停止抢重启；反证 `BRIDGE_KILL_LEGACY=1` 会连带误杀。

### 4. 端到端可用性 → `test/t9-mcp-e2e.cjs` **21 / 0**、`test/t10-probe.cjs` **13 / 0**
完整 `initialize → tools/list → tools/call`、长任务游标读、中枢 `SIGSTOP` 时在途请求得到明确 `-32603` 而非挂死、中枢自动拉回且保持单例、真探测识别假健康、stopping 标志生效。

### 5. 继续追查 `-32603`
仍**无法确定直接成因**（缺客户端时间戳）；代码层面已把"挂死"改成"明确可重试错误"。

### 6. 首次从"无 `BRIDGE_OWNER` 的旧版"切到新版 → `test/t11-legacy-switch.cjs`：**26 / 0**

测试构造（全部 `/tmp` + 高位端口）：旧桥 A（HEAD 原始代码，`/tmp/bridge-t11/dir`）+ 旧 keepalive 守护（自身**没有任何 home 标记**）→ 同机另一套桥 B（新版代码，HOME/端口都不同）→ 三个"同机同名诱饵"（别人的 `supergateway`、别人 home 的中枢、别人 home 的转发进程）→ 把新版代码**原地覆盖**到 A 的目录（模拟真实升级方式）→ 用新 `stop.sh` 只停 A → 再用新 `start.sh` 在同目录同端口起 A。

结论（断言全部通过）：

- 新 `stop.sh` **不依赖 `BRIDGE_KILL_LEGACY=1`**，就能精确停掉这套桥的旧实例：旧网关（按本桥端口）、旧中枢（按 env/sock）、旧 session 转发进程、**旧 keepalive 守护（靠"是本桥网关的祖先"识别，旧守护自己没有任何标记）**。
- 停下后**旧网关不再占用端口**，`stop.sh` 自带端口释放核对并输出"端口已释放"；观察 12s（旧守护循环 5s/次）没有被旧守护偷偷拉起。
- 同机另一套桥 B 与三个同名诱饵**全部存活**，B 在 A 被停之后仍能建立 MCP session；识别口径不会把诱饵算成 A 的进程。
- 原地升级后，新 `start.sh` 能在**同一个目录、同一个端口**起桥：`healthz` 200 + `initialize` + `tools/call` 全通过。
- **本轮新增的 A12 就是这里抓出来的**：`bridge_ports` 把 `BRIDGE_PORT+1` 无条件当本桥端口，A(8809) 的 `stop.sh` 把相邻端口上 B 的网关(8810)当成"本桥旧实例"强杀 —— 修 A12 后 t11 从 24/2（修 A12 前）转为 26/0。

### 7. 真实客户端三语义 → `test/t12-real-client.cjs`：**22 / 0**

客户端用 **mcporter**（第三方 MCP CLI，基于官方 `@modelcontextprotocol/sdk`，免费、不消耗 LLM）：`lifecycle=ephemeral` 模拟"每次调用新建会话"的客户端，`lifecycle=keep-alive` + `mcporter daemon` 模拟"长连接复用会话"的客户端。独立测试桥：`/tmp/bridge-test-t12`，端口 8825，`sessionTimeout=8000ms`。

| 场景 | 实测结果 |
| --- | --- |
| A 会话自然过期（ephemeral 客户端，空闲 12s > 8s） | 会话转发进程被回收（会话过期）；**客户端下一次工具调用自动成功**（客户端自行新建会话，`clients=1→0→1`） |
| A′ keep-alive 客户端持流 | `sg.log` 有 `GET request for existing session`：客户端持 SSE GET 流时**不会被 sessionTimeout 回收**（与 t6 结论一致） |
| B 空闲转发进程被上限修剪（`CLIENT_MAX=1`，两条会话） | 守护按空闲从长到短回收最老的那条；**被修剪客户端的下一次调用仍然成功**：mcporter 输出 `Restarting 'ta' before retrying callTool: Streamable HTTP error: Error POSTing …`，即**第一次请求被旧会话拒绝（400/-32000）后，客户端自动重建连接并重试成功**，之后重新持有会话 |
| C1 中枢短暂断开、转发进程存活 | 杀掉中枢（模拟短暂断开）后，客户端仍能调用成功，**同一会话继续用**（转发进程没有整体换代） |
| C2 整桥重启（`stop.sh` + `start.sh`） | 旧 session id 被拒 **400 / -32000**（不会把在途请求伪装成成功）；**客户端下一次调用自动重建会话并成功** |

要点：**"能自动恢复"是客户端侧的行为**。mcporter 会在失败后重建连接并重试；**未实现这种重试的客户端（裸 SDK，t6 用原始 HTTP 复现）会直接看到一次 400/-32000 失败**，需要自己重新 initialize。

---

## 三、报告与上线口径的修正（两类"断连"必须分开说）

之前报告里有一处表述必须纠正：**不能说"整桥重启后 client 会自动重连并补发在途缓冲请求"**。两种情形是不同机制、也必须分开测（t12 的 C1/C2 就是分开测的）：

| 情形 | 进程状态 | 会话与缓冲 | 客户端体验 | 证据 |
| --- | --- | --- | --- | --- |
| **中枢短暂断开**（`dc-hub.cjs` 消失/卡住，网关与 session 转发进程还活着） | 转发进程存活 | 会话保留；转发进程把未完成的 request 缓冲，连上后按序补发 | 在途请求可能收到一次明确的 `-32603 "…retry the request"`；**同一会话可以继续用**，不需要重新 initialize | t9（在途请求 15s 内得到明确错误、中枢自动拉回）；t12-C1（杀中枢后同一会话仍可调用） |
| **整桥重启**（`stop.sh` + `start.sh`） | 网关与**全部 session 转发进程消失** | 会话与其中的**在途缓冲随进程一起消失**，桥侧没有任何东西可补发 | 旧 session id 一律被拒（400/-32000）；**必须由客户端重新建立会话**（会重试的客户端在下次调用时自动重建；不会重试的客户端会看到一次失败） | t12-C2；t6 |

因此上线说明里不再出现"整桥重启不会丢请求/会自动补发"的说法。

---

## 四、测试汇总

| 套件 | 内容 | 结果 |
| --- | --- | --- |
| `test/run-tests.cjs` | 核心链路回归（t1–t5） | **20 / 0** |
| `test/t6-session-expiry.cjs` | 会话过期语义 | **9 / 0** |
| `test/t7-client-cap.cjs` | 进程上限、修剪、守护 | **19 / 0** |
| `test/t8-scope.cjs` | 停止/重启作用域、抢重启 | **22 / 0** |
| `test/t9-mcp-e2e.cjs` | 完整 MCP 链路、中枢退出/恢复 | **21 / 0** |
| `test/t10-probe.cjs` | 真探测、stopping 标志 | **13 / 0** |
| `test/t11-legacy-switch.cjs` | 首次从无 BRIDGE_OWNER 旧版切换（含相邻端口误杀回归） | **26 / 0** |
| `test/t12-real-client.cjs` | 真实客户端（mcporter）过期/修剪/重启三语义 | **22 / 0** |
| `test/repro-old-defect.cjs` | 旧/新对照最小复现（诊断，不计通过数） | 旧版必退、新版必活 |
| **合计** | | **152 通过 / 0 失败** |

---

## 五、明确回答四个问题（本轮更新）

**1. 30 分钟超时能否安全使用？**
**仍建议不要直接改成 30 分钟作为第一步**，但风险已比上一轮清楚得多：真实客户端 mcporter（官方 SDK 之上）在"会话过期 / 被修剪"之后，**下一次调用能自动重建会话并成功**（t12-A、t12-B）；持 SSE 流的 keep-alive 客户端则压根不会被超时回收（t12-A′）。
仍不确定的是 **ChatGPT 连接器 / Operit**（云机上跑不起来，未实测）。建议上线后先按 `BRIDGE_SESSION_TIMEOUT=1800000`（30 分钟）观察 1–2 天，同时盯客户端有没有出现"失败一次再成功"的报错；没有异常再固化，有异常就回到 2 小时。

**2. 60 进程阈值会否造成重启循环？**
**不会。** 判据是"被要求退出的进程是否真的退出"，持续超限只修剪不重启整桥（t7：38+ session、`restarts=0`）。而且 t12-B 实测：被修剪的客户端**下一次调用能自动恢复**，不会持续堆积、也不会持续打断。

**3. 线上重启会影响哪些进程？**
会重启/重建：`supergateway`、`dc-hub.cjs`、`desktop-commander`、**全部 session 转发进程 `dc-hub-client`**（现场约 398 个会随之清掉）。
已连接的客户端**会中断，且必须由客户端重新建立会话**：旧 session id 会被拒（400/-32000），会话内的在途缓冲随转发进程消失，**桥侧不会补发**（t12-C2）。
同机**不会**波及：其它桥的进程（`BRIDGE_OWNER` 隔离）、别人的同名进程、隧道进程。
旧实例：本轮 t11 证明新 `stop.sh` **不需要 `BRIDGE_KILL_LEGACY=1`** 也能精确停掉改造前启动的旧实例（含旧守护），并且不会误停同机另一套桥与同名诱饵。

**4. 还有哪些原因未查明？**
- `-32603` 的**直接成因**：缺客户端报错时间戳，无法与服务端日志对齐。
- `cf.log` 隧道抖动与 `-32603` 是否有因果：无同刻客户端证据。
- 历史上是否触发过 OOM / oom-killer：未见证据，内存曲线未留档。
- **ChatGPT 连接器 / Operit 的自动恢复行为**：本轮用 mcporter 拿到的证据**不能直接外推到它们**（云机上无法运行这两个客户端），仍需上线后观察。

---

## 六、精准的首次切换步骤（未执行，等你确认）

前提：新代码已在副本中，线上仍是旧版（无 `BRIDGE_OWNER`），线上 `@near` 保持不动。

1. **备份**：`cp -a ~/.bridge ~/.bridge.bak-$(date +%F)`（token 与日志留在本机，不外发）。
2. **切代码**：把副本的 `start.sh` / `stop.sh` / `keepalive.sh` / `proc-lib.sh` / `dc-hub.cjs` / `dc-hub-client.cjs` / `sg-hook.cjs` / `chatgpt-compat.cjs` / `tls-proxy.cjs` / `engine-guard.sh` / `filter-proxy.js` **原地覆盖**到线上目录（t11 就是按这个方式验证的）。
3. **先停旧桥（不设 `BRIDGE_KILL_LEGACY`）**：`bash stop.sh`。期望输出里能看到：
   - `停止 keepalive 守护…` → 守护日志出现 `检测到 stopping 标志…`（先自己退，再兜底 TERM）；
   - 各角色 `已停止: <pid>` 且带 `（其中旧实例/无 BRIDGE_OWNER: <pid>）`；
   - 最后 `端口已释放`（若报"端口未能释放"，说明还有进程占着，先查清再动，别强杀别人的进程）。
4. **确认停干净**：`ss -ltnp | grep <端口>` 无输出；`pgrep -af dc-hub-client | wc -l` 为 0。
5. **起新桥**：`bash start.sh`，确认 `/healthz` 200，客户端做一次 `initialize → tools/list → tools/call`。
6. **观察**：`keepalive.log` 无故重启次数、`dc-hub-client` 数量是否收敛、`sg.log` 中 `No connection established` 次数、客户端是否出现"失败一次再成功"。
7. **回滚**：恢复备份文件 + `stop.sh` / `start.sh` 各一次即可（改动全部在文件层，不涉及数据迁移）。

> 本轮**未做**：未部署、未重启线上、未修改 Jev 项目、未用任何客户端连线上桥。停在代码与报告阶段。
