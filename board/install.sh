#!/usr/bin/env bash
# 安装项目看板：
#   1. 把看板改造目录（board/mod）写进 ~/.claude/settings.json 的 env.CLAUDE_CODE_PLUGIN_DIRS，
#      之后新开的会话里输入 /board 就能打开看板
#   2. 软链接卡片检查脚本到 ~/.claude/hooks/board/，并挂上 PostToolUse(Write|Edit|MultiEdit) 钩子：
#      主脑保存 brain/cards.json 后自动检查，不合格退回
#   3. 建本机登记表 ~/.claude/board/projects.json（已有就不动）
# 改设置前备份。卸载：./install.sh --uninstall（登记表保留）
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
DEST="$CLAUDE_DIR/hooks/board"
SETTINGS="$CLAUDE_DIR/settings.json"
BOARD_DATA="$CLAUDE_DIR/board"
SCRIPT="check-cards.py"
CMD="python3 \"$DEST/$SCRIPT\""
MOD="$REPO/mod"

command -v jq >/dev/null || { echo "需要 jq：brew install jq"; exit 1; }

backup_settings() {
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d%H%M%S)"
}

# 插件目录变量是冒号分隔的列表，可能还有别的目录，只增删本看板这一项
if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$SETTINGS" ]; then
    backup_settings
    tmp="$(mktemp)"
    jq --arg s "$SCRIPT" --arg m "$MOD" '
      (if .hooks.PostToolUse then
        .hooks.PostToolUse |= (map(.hooks |= map(select((.command // "") | contains($s) | not)))
                               | map(select(.hooks | length > 0)))
      else . end)
      | (if .env.CLAUDE_CODE_PLUGIN_DIRS then
          .env.CLAUDE_CODE_PLUGIN_DIRS |= (split(":") | map(select(. != $m and . != "")) | join(":"))
          | (if .env.CLAUDE_CODE_PLUGIN_DIRS == "" then del(.env.CLAUDE_CODE_PLUGIN_DIRS) else . end)
        else . end)' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  fi
  rm -f "$DEST/$SCRIPT"
  echo "已卸载（登记表 $BOARD_DATA/projects.json 保留）"
  exit 0
fi

# python3 不可用时钩子会报错但不阻塞，等于静默失效，所以装之前先查
if ! python3 -c 'import json, re, datetime' >/dev/null 2>&1; then
  echo "python3 不可用（macOS 需先 xcode-select --install），未安装"
  exit 1
fi

mkdir -p "$DEST"
link_dst="$DEST/$SCRIPT"
if [ -e "$link_dst" ] && [ ! -L "$link_dst" ]; then
  mv "$link_dst" "$link_dst.bak-$(date +%Y%m%d%H%M%S)"
  echo "已备份原有 $link_dst"
fi
ln -sf "$REPO/$SCRIPT" "$link_dst"
echo "$link_dst -> $REPO/$SCRIPT"

mkdir -p "$BOARD_DATA"
if [ ! -f "$BOARD_DATA/projects.json" ]; then
  echo '{ "projects": [] }' > "$BOARD_DATA/projects.json"
  echo "已建登记表 $BOARD_DATA/projects.json（各主脑开局时把自己的项目登记进来）"
fi

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
changed=0
tmp="$(mktemp)"
cp "$SETTINGS" "$tmp"

if jq -e --arg s "$SCRIPT" '.hooks.PostToolUse // [] | any(.[].hooks[]?; (.command // "") | contains($s))' "$tmp" >/dev/null; then
  echo "settings.json 已有 $SCRIPT 的钩子，跳过"
else
  jq --arg c "$CMD" \
    '.hooks.PostToolUse = ((.hooks.PostToolUse // []) + [{matcher: "Write|Edit|MultiEdit", hooks: [{type: "command", command: $c, timeout: 10}]}])' \
    "$tmp" > "$tmp.n" && mv "$tmp.n" "$tmp"
  changed=1
  echo "已写入 PostToolUse 钩子"
fi

if jq -e --arg m "$MOD" '(.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":") | index($m)' "$tmp" >/dev/null; then
  echo "插件目录变量里已有 $MOD，跳过"
else
  jq --arg m "$MOD" \
    '.env.CLAUDE_CODE_PLUGIN_DIRS = ([(.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":")[] | select(. != "")] + [$m] | join(":"))' \
    "$tmp" > "$tmp.n" && mv "$tmp.n" "$tmp"
  changed=1
  echo "已把 $MOD 加进 env.CLAUDE_CODE_PLUGIN_DIRS"
fi

if [ "$changed" = 1 ]; then
  backup_settings
  mv "$tmp" "$SETTINGS"
else
  rm -f "$tmp"
fi

echo "验证：新开一个会话，输入 /board 应打开项目看板。已开着的会话要重启才生效"
