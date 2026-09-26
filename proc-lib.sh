#!/usr/bin/env bash
# cmd-bridge 进程身份与操作范围工具
# 由 start.sh / stop.sh / keepalive.sh source。
#
# 为什么需要它：
#   老版本用 `pkill -f 'supergateway'`、`pkill -f 'cloudflared tunnel'`、
#   `pkill -f 'desktop-commander'` 这种「命令行子串」匹配，会把同一台机器上
#   别人的 supergateway / cloudflared / ngrok / desktop-commander 一起杀掉；
#   判活用 `pgrep -f 'supergateway'` 也会把别人的进程当成自己的桥。
#
# 现在只操作「命令行匹配 pattern」且「/proc/<pid>/environ 里 BRIDGE_OWNER
# 等于本桥 BRIDGE_HOME」的进程，再用 $BRIDGE_HOME/pids/<role>.pid 记录主进程。
# 需要兼容改造前启动的旧实例（environ 里没有 BRIDGE_OWNER）时，显式设置
# BRIDGE_KILL_LEGACY=1 才回退到旧的全量 pkill 语义。
#
# 依赖：bash、/proc（Linux）。pgrep/ps 缺失时有纯 /proc 回退路径。

BRIDGE_OWNER_VAL="${BRIDGE_HOME:-$HOME/.bridge}"
BRIDGE_OWNER_ENV="BRIDGE_OWNER=${BRIDGE_OWNER_VAL}"

pids_matching() { # $1 = ERE 模式
  [ -n "${1:-}" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$1" 2>/dev/null || true
  else
    local d pid cmd
    for d in /proc/[0-9]*; do
      pid="${d#/proc/}"
      [ -r "$d/cmdline" ] || continue
      cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)"
      [ -n "$cmd" ] || continue
      printf '%s\n' "$cmd" | grep -Eq "$1" && printf '%s\n' "$pid"
    done
  fi
}

pid_owned() { # 0 = 属于本桥
  local pid="$1" env=""
  [ -r "/proc/$pid/environ" ] || return 1
  env="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null)"
  printf '%s\n' "$env" | grep -qxF "$BRIDGE_OWNER_ENV"
}

pid_cmdline() { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || echo ""; }

ppid_of() { awk '{print $4}' "/proc/$1/stat" 2>/dev/null; }

# 进程已运行秒数；取不到就给超大值（按「最老」处理）
pid_etimes() {
  local t=""
  command -v ps >/dev/null 2>&1 && t="$(ps -o etimes= -p "$1" 2>/dev/null | tr -d ' ')"
  case "$t" in ''|*[!0-9]*) echo 999999999 ;; *) echo "$t" ;; esac
}

# 进程状态：R/S/D/T/Z... 读不到为空。Z = 僵尸（已退出，等父进程回收）
pid_state() {
  local s=""
  [ -r "/proc/$1/stat" ] && s="$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)"
  printf '%s' "$s"
}

# 进程是否真的还在跑（僵尸不算：它已经不再服务请求，只是父进程还没回收）
pid_alive_real() {
  local s
  s="$(pid_state "$1")"
  [ -n "$s" ] && [ "$s" != "Z" ]
}

# /proc/<pid>/stat 第 22 字段 = 开机以来的 tick 数，越小越老（10ms 粒度，用于同龄排序）
pid_startticks() {
  local v=""
  [ -r "/proc/$1/stat" ] && v="$(awk '{print $22}' "/proc/$1/stat" 2>/dev/null)"
  case "$v" in ''|*[!0-9]*) echo 999999999999 ;; *) echo "$v" ;; esac
}

pidfile_path() { printf '%s' "${BRIDGE_OWNER_VAL}/pids/$1.pid"; }

pidfile_alive() { # $1 role：存活则输出 pid
  local f pid
  f="$(pidfile_path "$1")"; [ -f "$f" ] || return 1
  pid="$(tr -dc '0-9' < "$f" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

pidfile_write() { # $1 role $2 pid
  mkdir -p "$(dirname "$(pidfile_path "$1")")"
  printf '%s' "$2" > "$(pidfile_path "$1")"
}

pidfile_clear() { rm -f "$(pidfile_path "$1")" 2>/dev/null || true; }

# 本桥拥有的、命令行匹配 $1 的 PID（去重，排除自身与父进程）
bridge_pids() {
  local pid
  for pid in $(pids_matching "$1"); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    pid_owned "$pid" && printf '%s\n' "$pid"
  done | sort -u
}

# 同 bridge_pids，但额外排除命令行匹配 $2 的进程。
# 典型用途：supergateway 自己的命令行里就带着 `--stdio .../dc-hub-client.cjs`，
# 不做排除会把网关本身当成 session 转发进程一起处理（实测会误杀网关）。
pids_excluding() { # $1 pattern $2 exclude(ERE，可为空)
  local pid cmd
  for pid in $(pids_matching "$1"); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    if [ -n "${2:-}" ]; then
      cmd="$(pid_cmdline "$pid")"
      printf '%s\n' "$cmd" | grep -Eq "$2" && continue
    fi
    pid_owned "$pid" && printf '%s\n' "$pid"
  done | sort -u
}

# 结束本桥拥有的匹配进程；$3=1 时允许 legacy 全量回退
bridge_kill() { # $1 pattern [$2 signal] [$3 legacy]
  local pat="$1" sig="${2:-TERM}" legacy="${3:-0}" pid pids=()
  while read -r pid; do [ -n "$pid" ] && pids+=("$pid"); done < <(bridge_pids "$pat")
  if [ "${#pids[@]}" -gt 0 ]; then
    for pid in "${pids[@]}"; do kill "-$sig" "$pid" 2>/dev/null || true; done
    echo "已停止(owned,$sig): ${pids[*]}"
    return 0
  fi
  if [ "$legacy" = "1" ]; then
    if pkill -f "$pat" 2>/dev/null; then
      echo "已停止(legacy 全量匹配,$sig): $pat"
      return 0
    fi
  fi
  return 1
}

# 同 pids_excluding，但只输出本桥拥有且命令行匹配 $1、不匹配 $2 的 PID
bridge_pids_excluding() { pids_excluding "$1" "$2"; }

# 结束本桥拥有的匹配进程，同时排除匹配 $2 的进程（典型：停 session 转发进程时
# 排除 supergateway —— 它的 --stdio 参数里也带着 dc-hub-client.cjs）。
bridge_kill_excluding() { # $1 pattern $2 exclude [$3 signal] [$4 legacy]
  local pat="$1" ex="$2" sig="${3:-TERM}" legacy="${4:-0}" pid pids=()
  while read -r pid; do [ -n "$pid" ] && pids+=("$pid"); done < <(pids_excluding "$pat" "$ex")
  if [ "${#pids[@]}" -gt 0 ]; then
    for pid in "${pids[@]}"; do kill "-$sig" "$pid" 2>/dev/null || true; done
    echo "已停止(owned,$sig): ${pids[*]}"
    return 0
  fi
  if [ "$legacy" = "1" ]; then
    if pkill -f "$pat" 2>/dev/null; then
      echo "已停止(legacy 全量匹配,$sig): $pat"
      return 0
    fi
  fi
  return 1
}

# 命令行匹配 $1、但不属于本桥的 PID（用于提示「已跳过别人的进程」，不做任何操作）
unowned_pids() {
  local pid
  for pid in $(pids_matching "$1"); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    pid_owned "$pid" || printf '%s\n' "$pid"
  done | sort -u
}

# ============================================================
# 旧实例（改造前启动、environ 里没有 BRIDGE_OWNER）的精确识别
# ============================================================
# 首次从旧版切到新版时，旧进程的 environ 里没有 BRIDGE_OWNER 标记。
# 这里不靠全局 `pkill -f`，而是用「本桥独占的运行时资源」来认定它们：
#   P1 监听本桥端口（supergateway / tls-proxy）——端口是本桥独有的
#   P2 environ 里 DC_HUB_SOCK / BRIDGE_HOME 指向本桥（中枢、session 转发进程）
#   P3 持有本桥 dc-hub.sock（socket inode 匹配）——env 也拿不到时的兜底
#   P4 cmdline 里出现本桥 BRIDGE_HOME 路径（tunnel、日志路径等）
#   P5 已确认进程的祖先里、命令行匹配本次角色的进程（旧 keepalive 守护——
#      它自己没有任何 home 标记，但它是本桥网关的父进程）
# 反向排除：environ 里 BRIDGE_OWNER / BRIDGE_HOME / DC_HUB_SOCK 指向别的桥，
#   或 cmdline 里出现别的 dc-hub.sock，一律不算本桥（同机第二套桥必须活下来）。

all_pids() { ls -d /proc/[0-9]* 2>/dev/null | sed 's#/proc/##' | sort -n; }

pid_env() { tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null; }

pid_env_value() { pid_env "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -n1; }

bridge_sock_path() { printf '%s' "${DC_HUB_SOCK:-$BRIDGE_OWNER_VAL/dc-hub.sock}"; }

# 本桥可能占用的端口（普通模式 BRIDGE_PORT；BRIDGE_TLS=1 时网关退到 PORT+1）
# 本桥是否启用强制 HTTPS（TLS 代理占 BRIDGE_PORT，supergateway 退到 BRIDGE_PORT+1）
bridge_tls_on() {
  local v="${BRIDGE_TLS:-}"
  if [ -z "$v" ]; then
    local f="${BRIDGE_OWNER_VAL}/run_tls"
    [ -r "$f" ] && v="$(tr -d ' \t\n' < "$f")"
  fi
  [ "$v" = "1" ]
}

# 本桥端口。只有启用 TLS 时 BRIDGE_PORT+1 才是本桥端口（否则那是别人的端口，
# 同机另一套桥正好用相邻端口时会把它的网关误判成本桥旧实例）。
bridge_ports() {
  local p="${BRIDGE_PORT:-${PORT:-8000}}"
  printf '%s\n' "$p"
  case "$p" in ''|*[!0-9]*) return 0 ;; esac
  bridge_tls_on && printf '%s\n' "$((p + 1))"
  return 0
}

# 监听 $1 端口的 PID（ss 优先，退回 lsof）
port_owner_pids() {
  local port="$1" out=""
  [ -n "$port" ] || return 0
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -ltnpH 2>/dev/null | awk -v p="$port" '{split($4,a,":"); if (a[length(a)]==p) print}' \
           | grep -oE 'pid=[0-9]+' | cut -d= -f2)"
  fi
  if [ -z "$out" ] && command -v lsof >/dev/null 2>&1; then
    out="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  [ -z "$out" ] || printf '%s\n' "$out" | sort -un
}

# $1 = socket 路径 → inode（ss -lxH 第 6 列）
sock_inode() {
  local sock="$1"
  [ -S "$sock" ] || return 1
  command -v ss >/dev/null 2>&1 || return 1
  ss -lxH 2>/dev/null | awk -v s="$sock" '$5==s {print $6; exit}'
}

# $1 = pid，$2 = inode：该进程是否持有这个 socket
pid_holds_inode() {
  local pid="$1" inode="$2"
  [ -n "$inode" ] || return 1
  ls -l "/proc/$pid/fd" 2>/dev/null | grep -q "socket:\[$inode\]"
}

# 0 = 该进程引用了「别的桥」的 home / sock（必须排除）
pid_refs_other_bridge() {
  local pid="$1" v val
  for v in BRIDGE_OWNER BRIDGE_HOME; do
    val="$(pid_env_value "$pid" "$v")"
    [ -n "$val" ] || continue
    [ "$val" = "$BRIDGE_OWNER_VAL" ] || return 0
  done
  val="$(pid_env_value "$pid" DC_HUB_SOCK)"
  if [ -n "$val" ] && [ "$val" != "$(bridge_sock_path)" ]; then return 0; fi
  return 1
}

# 0 = 凭「本桥独占资源」判定该进程是本桥的旧实例（不含祖先/后代推导）
pid_legacy_direct() {
  local pid="$1" sock port inode cmd
  [ -r "/proc/$pid/cmdline" ] || return 1
  pid_alive_real "$pid" || return 1
  pid_refs_other_bridge "$pid" && return 1

  # P2：env 指向本桥 sock / home
  [ "$(pid_env_value "$pid" DC_HUB_SOCK)" = "$(bridge_sock_path)" ] && return 0
  if pid_env "$pid" 2>/dev/null | grep -qxF "BRIDGE_HOME=$BRIDGE_OWNER_VAL"; then return 0; fi

  # P3：持有本桥 sock（env 缺失时的兜底）
  sock="$(bridge_sock_path)"
  inode="$(sock_inode "$sock" 2>/dev/null || true)"
  if [ -n "$inode" ] && pid_holds_inode "$pid" "$inode"; then return 0; fi

  # P1：监听本桥端口
  for port in $(bridge_ports); do
    port_owner_pids "$port" | grep -qx "$pid" && return 0
  done

  # P4：cmdline 里出现本桥 home 路径
  cmd="$(pid_cmdline "$pid")"
  printf '%s' "$cmd" | grep -qF "$BRIDGE_OWNER_VAL" && return 0

  return 1
}

# 某 pid 的祖先链（不含自身，最多 20 层，到 pid 1 为止）
process_ancestors() {
  local pid="$1" p i=0
  p="$(ppid_of "$pid")"
  while [ -n "$p" ] && [ "$p" != "1" ] && [ "$p" != "0" ] && [ "$i" -lt 20 ]; do
    printf '%s\n' "$p"
    p="$(ppid_of "$p")"
    i=$((i + 1))
  done
}

# 某 pid 的全部后代
process_descendants() {
  local root="$1" map cur frontier pid
  map="$(all_pids | while read -r pid; do printf '%s %s\n' "$pid" "$(ppid_of "$pid")"; done)"
  frontier="$root"
  while [ -n "${frontier// /}" ]; do
    cur="$frontier"; frontier=""
    while read -r pid ppid; do
      [ -n "${ppid:-}" ] || continue
      case " $cur " in *" $ppid "*) printf '%s\n' "$pid"; frontier="$frontier $pid" ;; esac
    done <<EOF
$map
EOF
  done
}

# 本桥「已拥有（有 BRIDGE_OWNER）」∪「旧实例（凭独占资源识别）」里，
# 命令行匹配 $1、且不匹配排除模式 $2 的 PID。
# 旧 keepalive 守护（自身没有 home 标记）通过「是本桥网关的祖先」被识别。
scoped_pids() { # $1 pattern [$2 exclude]
  local pat="$1" ex="${2:-}" pid cmd base=""
  local -a seed=() out=()
  for pid in $(pids_matching "$pat"); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    if pid_owned "$pid"; then out+=("$pid"); seed+=("$pid"); continue; fi
    if pid_legacy_direct "$pid"; then out+=("$pid"); seed+=("$pid"); fi
  done
  # 旧守护：本桥已确认进程的祖先里，命令行匹配本角色的
  for pid in "${seed[@]:-}"; do
    [ -n "$pid" ] || continue
    for base in $(process_ancestors "$pid"); do
      cmd="$(pid_cmdline "$base")"
      printf '%s' "$cmd" | grep -Eq "$pat" || continue
      pid_refs_other_bridge "$base" && continue
      out+=("$base")
    done
  done
  # 后代（引擎等）：命令行匹配本角色的
  for pid in "${seed[@]:-}"; do
    [ -n "$pid" ] || continue
    for base in $(process_descendants "$pid"); do
      cmd="$(pid_cmdline "$base")"
      printf '%s' "$cmd" | grep -Eq "$pat" || continue
      pid_refs_other_bridge "$base" && continue
      out+=("$base")
    done
  done
  local -a uniq=()
  for pid in "${out[@]:-}"; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    if [ -n "$ex" ]; then
      cmd="$(pid_cmdline "$pid")"
      printf '%s' "$cmd" | grep -Eq "$ex" && continue
    fi
    uniq+=("$pid")
  done
  [ "${#uniq[@]}" -eq 0 ] || printf '%s\n' "${uniq[@]}" | sort -un
}

# 结束本桥进程（= 新版 owned ∪ 旧实例），排除匹配 $2 的进程。
scoped_kill() { # $1 pattern [$2 exclude] [$3 signal]
  local pat="$1" ex="${2:-}" sig="${3:-TERM}" pid pids=()
  while read -r pid; do [ -n "$pid" ] && pids+=("$pid"); done < <(scoped_pids "$pat" "$ex")
  if [ "${#pids[@]}" -gt 0 ]; then
    for pid in "${pids[@]}"; do kill "-$sig" "$pid" 2>/dev/null || true; done
    echo "已停止(scoped,$sig): ${pids[*]}"
    return 0
  fi
  return 1
}

# 仅用于「首次从旧版切换」的核对：报告哪些旧实例被识别出来
legacy_only_pids() { # $1 pattern
  local pid
  for pid in $(scoped_pids "$1"); do
    pid_owned "$pid" && continue
    printf '%s\n' "$pid"
  done
}

# 等本桥某个角色出现并写 pidfile；输出 pid
record_role_pid() { # $1 role $2 pattern
  local pid="" i
  for i in $(seq 1 20); do
    pid="$(bridge_pids "$2" | tail -n1)"
    [ -n "$pid" ] && break
    sleep 0.3
  done
  if [ -n "$pid" ]; then
    pidfile_write "$1" "$pid"
    printf '%s' "$pid"
    return 0
  fi
  return 1
}
