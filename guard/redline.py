#!/usr/bin/env python3
"""PreToolUse(Bash) 红线守卫。

两条：
1. 强制推送到主分支（main / master）：一律拦，没有放行路径。
2. 对登记过的生产环境做写操作：拦下，要用户在对话里同意。
   同意后，命令说明（description）里写“lee 已在对话中同意：<动作>”再试，就放行并记一笔。
   只读操作（查日志、查库 SELECT、下载文件）不拦。

生产环境清单是本机私有数据，不进仓库：~/.claude/redlines.json（可用环境变量 REDLINES_FILE 改位置）
  { "production": [ { "name": "某项目生产", "match": ["prod-host-alias", "10.0.0.1", "db.example.com"] } ] }
各项目主脑开局登记项目时，把本项目的生产主机别名、地址、域名加进来。

每次拦截、放行、出错都写一行到 ~/.claude/logs/hooks.log（可用 HOOK_LOG 改位置）。
脚本出错时放行，但会记下来，闸坏了能被发现。
"""
import datetime, json, os, re, sys

HOOK = "redline"
APPROVAL = "已在对话中同意"


def log(decision, detail):
    try:
        path = os.environ.get("HOOK_LOG") or os.path.expanduser("~/.claude/logs/hooks.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\t{HOOK}\t{decision}\tBash\t{' '.join(detail.split())[:240]}\t{os.getcwd()}\n")
    except Exception:
        pass


def production():
    path = os.environ.get("REDLINES_FILE") or os.path.expanduser("~/.claude/redlines.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    out = []
    for p in data.get("production", []):
        for m in p.get("match", []):
            if isinstance(m, str) and m.strip():
                out.append((p.get("name") or m, m.strip()))
    return out


FORCE_PUSH = re.compile(
    r"\bgit\b[^;&|\n]*\bpush\b(?=[^;&|\n]*(\s-f\b|\s--force\b|\s--force-with-lease\b|\s\+\S*\b(main|master)\b))"
    r"[^;&|\n]*\b(main|master)\b"
)

# 写操作的特征：出现在指向生产的命令里才算数
WRITE = re.compile(
    r"(?:^|[\s;&|'\"(])(?:"
    r"rm|mv|cp|tee|truncate|dd|chmod|chown|mkdir|touch|ln|crontab|reboot|shutdown|kill|pkill|killall"
    r"|sed\s+-i|perl\s+-i"
    r"|docker(?:\s+compose|-compose)?\s+(?:up|down|restart|rm|stop|start|exec|run|pull|build|kill|cp|volume\s+rm|system\s+prune)"
    r"|systemctl\s+(?:restart|stop|start|reload|enable|disable)|service\s+\S+\s+(?:restart|stop|start|reload)"
    r"|apt(?:-get)?\s+(?:install|remove|purge|upgrade)|yum\s+(?:install|remove)|dnf\s+(?:install|remove)"
    r"|git\s+(?:pull|checkout|reset|push|merge|rebase|clean)"
    r"|goose\s+(?:up|down|reset)|migrate\b|alembic\s+(?:upgrade|downgrade)"
    r"|curl\b[^;&|\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|\s-d\s|--form|\s-F\s)"
    r")(?=\s|$|['\";&|)])"
    r"|(?-i:\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b)"
    r"|(?<![0-9&])>{1,2}(?!&)",
    re.I,
)


def copies_to(cmd, ident):
    """scp / rsync 把文件传到生产（目标参数里带生产标识加冒号）。"""
    for seg in re.split(r"[;&|\n]", cmd):
        toks = seg.split()
        names = [t.rsplit("/", 1)[-1] for t in toks]
        for tool in ("scp", "rsync"):
            if tool in names:
                args = [t for t in toks[names.index(tool) + 1:] if not t.startswith("-")]
                if args and ident in args[-1] and ":" in args[-1]:
                    return True
    return False


def verdict(cmd, desc):
    if FORCE_PUSH.search(cmd):
        return "deny", ("红线：禁止强制推送到主分支（main / master）。"
                        "改成在功能分支上提交，再按正常流程合入；这一条没有放行路径。")
    for name, ident in production():
        if ident not in cmd:
            continue
        # 只看指向生产的那一段命令；去掉末尾写到本机文件的重定向（那是本机写，不是生产写）
        i = cmd.index(ident)
        start = max(cmd.rfind(ch, 0, i) for ch in ";&|\n") + 1
        tail = re.sub(r"([\"'])\s*(?:&>|>{1,2})\s*\S+\s*$", r"\1", cmd[start:])
        if not (copies_to(cmd, ident) or WRITE.search(tail)):
            continue  # 指向生产，但是只读
        if APPROVAL in (desc or ""):
            return "approved", f"{name}：{desc}"
        return "deny", (
            f"红线：这条命令要对生产环境「{name}」做写操作，需要用户本人同意。"
            "在正文里用一句大白话说明要做什么、会影响什么，等用户在对话里回复同意；"
            f"同意后原样重试，并在命令说明里写“lee {APPROVAL}：<动作>”。"
            "只读操作（查日志、查库、下载文件）不受限制，能用只读方式完成的先用只读方式。"
            "不要把命令转交用户执行。"
        )
    return None, ""


def main():
    raw = sys.stdin.read()
    try:
        event = json.loads(raw)
    except Exception:
        return
    args = event.get("tool_input") or {}
    cmd = args.get("command") or ""
    decision, msg = verdict(cmd, args.get("description") or "")
    if decision is None:
        return
    if decision == "approved":
        log("放行（已同意）", msg)
        return
    log("拦截", cmd)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": msg,
    }}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 闸坏了要留下痕迹，但不挡正常工作
        log("出错", repr(exc))
