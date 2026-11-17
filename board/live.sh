#!/bin/sh
# 会话实况钩子：每个会话把自己现在的状态写进一个共享目录，看板读它显示“在跑 / 等你批准 / 停了多久”。
# 用法（由插件钩子调用）：live.sh <running|waiting|idle|error|started|ended>
#   running  用户发了消息、工具调用完成（权限批准后也会回到这里）
#   waiting  弹出权限确认、需要用户输入
#   idle     这一轮结束，等用户下一句
#   error    这一轮因接口错误中断
#   ended    会话结束，删掉自己的文件
# 文件：~/.claude/board/live/<桌面版会话编号>.json（可用 BOARD_LIVE_DIR 改位置）
# 只在桌面版会话里生效（靠环境变量 CLAUDE_CODE_HOST_SESSION_ID 拿会话编号）；任何失败都静默放过，不挡正常工作。
# 每次工具调用都会跑一次，所以用 sh 写、不解析输入，越快越好。
cat >/dev/null 2>&1
id="${CLAUDE_CODE_HOST_SESSION_ID:-}"
[ -n "$id" ] || exit 0
dir="${BOARD_LIVE_DIR:-$HOME/.claude/board/live}"
state="$1"
if [ "$state" = "ended" ]; then
  rm -f "$dir/$id.json" 2>/dev/null
  exit 0
fi
mkdir -p "$dir" 2>/dev/null || exit 0
tmp="$dir/.$id.$$"
printf '{"id":"%s","state":"%s","at":%s,"project":"%s"}\n' \
  "$id" "$state" "$(date +%s)" "${CLAUDE_PROJECT_DIR:-}" >"$tmp" 2>/dev/null \
  && mv -f "$tmp" "$dir/$id.json" 2>/dev/null
if [ "$state" = "started" ]; then
  # 崩溃没走到 ended 的会话留下的旧文件，一周后清掉
  find "$dir" -name '*.json' -mtime +7 -delete 2>/dev/null
fi
exit 0
