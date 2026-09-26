#!/usr/bin/env bash
# 一键跑全部测试并汇总（交付用）。
# 只使用 /tmp 下的临时 BRIDGE_HOME 与高位端口，不触碰线上或用户目录。
#
#   bash test/run-suite.sh
#
set -u
cd "$(dirname "$0")/.." || exit 1

SUITES=(
  test/run-tests.cjs
  test/t6-session-expiry.cjs
  test/t7-client-cap.cjs
  test/t8-scope.cjs
  test/t9-mcp-e2e.cjs
  test/t10-probe.cjs
  test/t11-legacy-switch.cjs
  test/t12-real-client.cjs
)

total_pass=0
total_fail=0
declare -a rows=()
failed_suites=()

for s in "${SUITES[@]}"; do
  echo "=============================================================="
  echo ">>> node $s"
  out="$(timeout 900 node "$s" 2>&1)"
  rc=$?
  echo "$out"
  line="$(printf '%s\n' "$out" | grep -E '结果: [0-9]+ 通过 / [0-9]+ 失败' | tail -n1)"
  p="$(printf '%s' "$line" | sed -n 's/.*结果: \([0-9][0-9]*\) 通过.*/\1/p')"
  f="$(printf '%s' "$line" | sed -n 's/.*通过 \/ \([0-9][0-9]*\) 失败.*/\1/p')"
  p="${p:-0}"; f="${f:-1}"
  total_pass=$((total_pass + p))
  total_fail=$((total_fail + f))
  if [ "$rc" -ne 0 ] || [ "$f" -ne 0 ]; then failed_suites+=("$s"); fi
  rows+=("$(printf '%-32s %3s 通过 / %3s 失败   rc=%s' "$s" "$p" "$f" "$rc")")
done

# 缺陷最小复现：对照"旧版（HEAD 原始 dc-hub-client）"与"修复版"，输出为诊断信息，不做通过/失败判定
LEGACY="/tmp/cmdbridge-legacy-dc-hub-client.cjs"
git show HEAD:dc-hub-client.cjs > "$LEGACY" 2>/dev/null

echo "=============================================================="
echo ">>> 缺陷最小复现对照（diagnostic，无通过/失败判定）"
echo "--- 旧版（HEAD 原始实现）---"
timeout 200 node test/repro-old-defect.cjs "$LEGACY" 2>&1
echo "--- 修复版（本次改动）---"
timeout 200 node test/repro-old-defect.cjs ./dc-hub-client.cjs 2>&1

echo
echo "=============================================================="
echo "汇总"
for r in "${rows[@]}"; do echo "  $r"; done
echo "  test/repro-old-defect.cjs          diagnostic 对照，见上方输出"
echo "--------------------------------------------------------------"
echo "  合计: $total_pass 通过 / $total_fail 失败"
if [ "${#failed_suites[@]}" -gt 0 ]; then
  echo "  未通过: ${failed_suites[*]}"
  exit 1
fi
echo "  全部通过"
