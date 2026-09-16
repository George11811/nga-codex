#!/usr/bin/env bash
# 用无头 Edge 给预览 HTML 截图。
#
# 为什么需要这个脚本而不是一行命令：
#   1. headless Edge 经常不自己退出（截图写完了进程还在），残留进程会锁住
#      user-data-dir，下一次直接静默失败（截图文件根本不生成）。所以每次先清掉
#      **只属于我们的 profile** 的残留进程再跑。
#   2. Edge 在已有实例运行时会把命令行「转交」给已有进程，加上独立
#      --user-data-dir 才能保证真的起一个无头实例。
#   3. 必须加 MSYS_NO_PATHCONV，否则 MSYS 会把 /B 这种参数改写成路径。
#
# 注意：清理进程时只匹配 C:\ngatest\eprof 这个我们专用的 profile，
# 绝不会动用户正在用的 Edge。
#
# 用法：.build/shot.sh <预览html文件名> <输出png名> [宽x高]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE='C:\ngatest\eprof'
EDGE='/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

IN="${1:-preview-wow.html}"
OUT="${2:-shot.png}"
SIZE="${3:-1500,2000}"

# 1) 清掉上一次遗留的无头实例（只认我们自己的 profile）
MSYS_NO_PATHCONV=1 powershell -NoProfile -Command \
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" |
   Where-Object { \$_.CommandLine -like '*ngatest\\eprof*' } |
   ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
  >/dev/null 2>&1
sleep 1

rm -f "$HERE/$OUT"

# 2) 起一个独立 profile 的无头实例
MSYS_NO_PATHCONV=1 timeout 180 "$EDGE" \
  --headless --disable-gpu --no-sandbox --disable-extensions --no-first-run \
  --disable-sync --disable-background-networking \
  --user-data-dir="$PROFILE" \
  --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=8000 \
  --window-size="$SIZE" \
  --screenshot="$(cygpath -w "$HERE/$OUT")" \
  "file:///$(cygpath -m "$HERE/$IN")" >/dev/null 2>&1

# 3) 收尾：截图已经落盘就没必要留着进程
MSYS_NO_PATHCONV=1 powershell -NoProfile -Command \
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" |
   Where-Object { \$_.CommandLine -like '*ngatest\\eprof*' } |
   ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
  >/dev/null 2>&1

if [ -f "$HERE/$OUT" ]; then
  echo "✓ $OUT  $(stat -c%s "$HERE/$OUT") 字节"
else
  echo "✗ 截图失败（$IN）" >&2
  exit 1
fi
