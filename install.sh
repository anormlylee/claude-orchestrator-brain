#!/usr/bin/env bash
# 本机安装（在仓库里改文件，新开的会话立即用上新版本）：
#   1. 把仓库根目录作为插件加进 ~/.claude/settings.json 的 env.CLAUDE_CODE_PLUGIN_DIRS：
#      技能 /brain、/brain-handback，项目看板 /board，钩子（杀进程守卫、红线守卫、回报格式检查、卡片格式检查）
#   2. 软链接 output style 到 ~/.claude/output-styles/（插件里的 output style 会带插件前缀，所以单独装，名字保持 brain）
#   3. 建本机私有数据文件（已有就不动）：看板登记表 ~/.claude/board/projects.json、生产环境清单 ~/.claude/redlines.json
#   4. 清掉旧版分散安装留下的软链接和设置条目
# 改设置前备份。参数：
#   --styles-only  只装 output style（已经通过插件市场装了插件时用）
#   --notify       另装派活卡片通知（仅 macOS 桌面 App，见 notify/；不在插件里）
#   --uninstall    卸载（私有数据文件保留）
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
BACKUP="$CLAUDE_DIR/backups/claude-orchestrator-brain-$(date +%Y%m%d%H%M%S)"
OLD_HOOK_SCRIPTS='["block-broad-kill.py","check-report.py","check-cards.py"]'

command -v jq >/dev/null || { echo "需要 jq：brew install jq"; exit 1; }

link() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    rm "$dst"
  elif [ -e "$dst" ]; then
    mkdir -p "$BACKUP"
    mv "$dst" "$BACKUP/"
    echo "已备份 $dst -> $BACKUP/"
  fi
  ln -s "$src" "$dst"
  echo "$dst -> $src"
}

# 删掉指向本仓库的旧软链接（旧版把技能和钩子脚本逐个链到 ~/.claude 下）
unlink_old() {
  local p
  for p in "$CLAUDE_DIR"/skills/brain "$CLAUDE_DIR"/skills/brain-handback \
           "$CLAUDE_DIR"/hooks/guard/block-broad-kill.py \
           "$CLAUDE_DIR"/hooks/report-check/check-report.py "$CLAUDE_DIR"/hooks/report-check/banned-phrases.txt \
           "$CLAUDE_DIR"/hooks/board/check-cards.py; do
    if [ -L "$p" ] && [[ "$(readlink "$p")" == "$REPO"* ]]; then
      rm "$p" && echo "已删旧链接 $p"
    fi
  done
  rmdir "$CLAUDE_DIR"/hooks/guard "$CLAUDE_DIR"/hooks/report-check "$CLAUDE_DIR"/hooks/board 2>/dev/null || true
}

# 改设置：去掉旧版手挂的钩子条目和旧插件目录，按需加上或去掉本仓库
edit_settings() {
  local mode="$1"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  local tmp; tmp="$(mktemp)"
  jq --arg repo "$REPO" --arg mode "$mode" --argjson old "$OLD_HOOK_SCRIPTS" '
    (if .hooks then
       .hooks |= with_entries(.value |= (map(.hooks |= map(select(
                   (.command // "") as $c | ($old | any(. as $s | $c | contains($s))) | not)))
                 | map(select(.hooks | length > 0))))
       | .hooks |= with_entries(select(.value | length > 0))
     else . end)
    | ([(.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":")[]
        | select(. != "" and . != $repo and . != ($repo + "/board/mod"))]
       + (if $mode == "install" then [$repo] else [] end)) as $dirs
    | if ($dirs | length) > 0 then .env.CLAUDE_CODE_PLUGIN_DIRS = ($dirs | join(":"))
      else (if .env then del(.env.CLAUDE_CODE_PLUGIN_DIRS) else . end) end
    | if .env == {} then del(.env) else . end' "$SETTINGS" > "$tmp"
  if cmp -s "$tmp" "$SETTINGS"; then
    rm -f "$tmp"
  else
    cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d%H%M%S)"
    mv "$tmp" "$SETTINGS"
    echo "已更新 $SETTINGS（改前已备份）"
  fi
}

styles() {
  for f in "$REPO"/output-styles/*.md; do
    link "$f" "$CLAUDE_DIR/output-styles/$(basename "$f")"
  done
}

case "${1:-}" in
  --uninstall)
    edit_settings uninstall
    unlink_old
    for f in "$REPO"/output-styles/*.md; do
      d="$CLAUDE_DIR/output-styles/$(basename "$f")"
      [ -L "$d" ] && rm "$d" && echo "已删 $d"
    done
    echo "已卸载（私有数据 ~/.claude/board/projects.json、~/.claude/redlines.json 保留）"
    exit 0 ;;
  --styles-only)
    styles
    exit 0 ;;
esac

# python3 不可用时钩子会报错但不阻塞，等于静默失效，所以装之前先查
if ! python3 -c 'import json, re, datetime, subprocess' >/dev/null 2>&1; then
  echo "python3 不可用（macOS 需先 xcode-select --install），未安装"
  exit 1
fi

styles
unlink_old
edit_settings install

mkdir -p "$CLAUDE_DIR/board"
[ -f "$CLAUDE_DIR/board/projects.json" ] || { echo '{ "projects": [] }' > "$CLAUDE_DIR/board/projects.json"; echo "已建看板登记表 $CLAUDE_DIR/board/projects.json"; }
[ -f "$CLAUDE_DIR/redlines.json" ] || { echo '{ "production": [] }' > "$CLAUDE_DIR/redlines.json"; echo "已建生产环境清单 $CLAUDE_DIR/redlines.json（各主脑登记项目时把生产主机加进来）"; }

if [ "${1:-}" = "--notify" ]; then
  bash "$REPO/notify/install.sh"
fi

cat <<MSG

完成。新开的会话生效，已经开着的会话要重启：
  /brain          把当前会话设为主脑
  /board          打开项目看板
  钩子拦截和出错记在 $CLAUDE_DIR/logs/hooks.log
MSG
