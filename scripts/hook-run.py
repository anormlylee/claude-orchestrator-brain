#!/usr/bin/env python3
"""钩子统一记录：包在任意命令钩子外面跑，原样转交输入输出，并把拦截和出错记到同一份日志。

用法（写在钩子配置的 command 里）：
  python3 hook-run.py <钩子名> <原命令> [参数...]

记录位置 ~/.claude/logs/hooks.log（可用 HOOK_LOG 改），每行用制表符分隔：
  时间  钩子名  结果（拦截 / 出错）  工具名  说明  工作目录
放行不记，日志只增不改。包装器自己出错时退回直接放行，不挡正常工作。
"""
import datetime, json, os, subprocess, sys


def log(name, decision, tool, detail, cwd):
    try:
        path = os.environ.get("HOOK_LOG") or os.path.expanduser("~/.claude/logs/hooks.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        detail = " ".join(str(detail).split())[:240]
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S}\t{name}\t{decision}\t{tool}\t{detail}\t{cwd}\n")
    except Exception:
        pass


def main():
    if len(sys.argv) < 3:
        return 0
    name, cmd = sys.argv[1], sys.argv[2:]
    data = sys.stdin.buffer.read()
    # 插件设置里关掉的钩子直接放行（设置项名 = 钩子名把 - 换成 _）
    if os.environ.get("CLAUDE_PLUGIN_OPTION_" + name.upper().replace("-", "_"), "").lower() in ("false", "0", "no"):
        return 0
    try:
        event = json.loads(data or b"{}")
    except Exception:
        event = {}
    tool, cwd = event.get("tool_name") or event.get("hook_event_name") or "", event.get("cwd") or os.getcwd()
    try:
        p = subprocess.run(cmd, input=data, capture_output=True, timeout=9)
    except subprocess.TimeoutExpired:
        log(name, "出错", tool, "超时（9 秒）", cwd)
        return 0
    except Exception as exc:
        log(name, "出错", tool, repr(exc), cwd)
        return 0
    out, err = p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
    if p.returncode not in (0, 2) or "Traceback" in err:
        log(name, "出错", tool, (err.strip().splitlines() or [f"退出码 {p.returncode}"])[-1], cwd)
    if p.returncode == 2:
        log(name, "拦截", tool, err, cwd)
    elif out.strip():
        try:
            r = json.loads(out)
            hso = r.get("hookSpecificOutput") or {}
            if r.get("decision") == "block" or hso.get("permissionDecision") == "deny":
                log(name, "拦截", tool, hso.get("permissionDecisionReason") or r.get("reason") or "", cwd)
        except Exception:
            pass
    sys.stdout.write(out)
    sys.stderr.write(err)
    return p.returncode if p.returncode in (0, 2) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
