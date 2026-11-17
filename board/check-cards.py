#!/usr/bin/env python3
"""项目看板卡片文件的格式检查。格式见 board/cards-format.md。

两种用法：
1. 命令行：python3 board/check-cards.py <卡片文件>...
   合格时不输出、退出码 0；不合格时逐条打印问题、退出码 1。
2. PostToolUse(Write|Edit|MultiEdit) 钩子：从标准输入读事件。
   只检查路径以 brain/cards.json 结尾的文件；不合格就输出 decision=block，把问题退回给主脑。
   钩子模式下任何异常一律放行：检查程序出错不能挡住主脑干活。
"""
import datetime, json, os, re, sys

COLUMNS = ("todo", "doing", "verify", "done", "frozen")
KINDS = ("功能", "缺陷", "调研", "决策", "事务")
BALLS = ("you", "external", "brain")
ASK_KINDS = ("decide", "act")
TOP_KEYS = ("project", "stage", "stageGoal", "brain", "leftovers", "cards")
TOP_OPTIONAL = ("generatedBy", "stats")
CARD_KEYS = ("id", "title", "column", "kind", "priority", "milestone", "ball",
             "ask", "askKind", "now", "blocked", "since", "doneAt")
CARD_OPTIONAL = ("detail", "rejects", "causedBy", "sessions", "evidence")
TITLE_MAX = 20
ASK_MAX = 40
NOW_MAX = 40
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HOOK_SUFFIX = os.path.join("brain", "cards.json")
EVENTS_SUFFIX = os.path.join("brain", "events.jsonl")


def is_str(v):
    return isinstance(v, str)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def date_problem(v, today):
    """合格返回 None，否则返回问题说明。"""
    if not is_str(v) or not DATE.match(v):
        return "要写成 YYYY-MM-DD"
    try:
        d = datetime.date.fromisoformat(v)
    except ValueError:
        return "不是有效日期"
    if d > today:
        return "不能晚于今天"
    return None


def check_card(c, where, today, has_goal):
    problems = []
    if not isinstance(c, dict):
        return [f"{where}：每张卡片要是一个对象。"]

    missing = [k for k in CARD_KEYS if k not in c]
    if missing:
        problems.append(f"{where}：缺字段 {'、'.join(missing)}（没有内容也要写，空文字写 \"\"，空值写 null）。")
    unknown = [k for k in c if k not in CARD_KEYS + CARD_OPTIONAL]
    if unknown:
        problems.append(f"{where}：多了不认识的字段 {'、'.join(unknown)}，主脑自用的内容放进 detail。")

    title = c.get("title")
    if not is_str(title) or not title.strip():
        problems.append(f"{where}：title 不能为空。")
    elif len(title) > TITLE_MAX:
        problems.append(f"{where}：title 超过 {TITLE_MAX} 字（现在 {len(title)} 字）。")

    col = c.get("column")
    if col not in COLUMNS:
        problems.append(f"{where}：column 只能是 {' / '.join(COLUMNS)}。")
    if c.get("kind") not in KINDS:
        problems.append(f"{where}：kind 只能是 {'、'.join(KINDS)}。")

    pr = c.get("priority")
    if pr is not None and (not is_int(pr) or pr not in (1, 2, 3)):
        problems.append(f"{where}：priority 只能是 1、2、3 或 null。")
    elif pr is None and col in ("todo", "doing"):
        problems.append(f"{where}：待办和进行中的卡片必须写 priority（1 到 3）。")

    ms = c.get("milestone")
    if not isinstance(ms, bool):
        problems.append(f"{where}：milestone 只能是 true 或 false。")
    elif ms and not has_goal:
        problems.append(f"{where}：标了属于阶段目标，但项目还没有阶段目标（stageGoal 为 null）。先提出阶段目标、等用户确认。")

    ball = c.get("ball")
    if ball not in BALLS:
        problems.append(f"{where}：ball 只能是 {' / '.join(BALLS)}。")

    ask, ask_kind = c.get("ask"), c.get("askKind")
    if "ask" in c and not is_str(ask):
        problems.append(f"{where}：ask 要是文字，没有就写 \"\"。")
    if ask_kind is not None and ask_kind not in ASK_KINDS:
        problems.append(f"{where}：askKind 只能是 decide、act 或 null。")
    if ball == "you" and col != "done":
        if not is_str(ask) or not ask.strip():
            problems.append(f"{where}：球在用户时必须写 ask：要用户做的一个动作，动词开头。")
        if ask_kind not in ASK_KINDS:
            problems.append(f"{where}：球在用户时必须写 askKind：拍板写 decide，动手写 act。")
    if is_str(ask) and len(ask) > ASK_MAX:
        problems.append(f"{where}：ask 超过 {ASK_MAX} 字（现在 {len(ask)} 字）。")

    now = c.get("now")
    if not is_str(now) or not now.strip():
        problems.append(f"{where}：now 不能为空，写一句话现状。")
    elif len(now) > NOW_MAX:
        problems.append(f"{where}：now 超过 {NOW_MAX} 字（现在 {len(now)} 字）。")

    if "blocked" in c and not is_str(c.get("blocked")):
        problems.append(f"{where}：blocked 要是文字，没有就写 \"\"。")

    p = date_problem(c.get("since"), today)
    if p:
        problems.append(f"{where}：since（进入本列的日期）{p}。")
    done_at = c.get("doneAt")
    if col == "done":
        p = date_problem(done_at, today)
        if p:
            problems.append(f"{where}：已完成的卡片必须写 doneAt，{p}。")
    elif done_at is not None:
        problems.append(f"{where}：没完成的卡片 doneAt 要写 null。")

    if "detail" in c and not is_str(c.get("detail")):
        problems.append(f"{where}：detail 要是文字。")
    if "rejects" in c and (not is_int(c.get("rejects")) or c.get("rejects") < 0):
        problems.append(f"{where}：rejects（验收打回次数）要是不小于 0 的整数；没打回过可以不写。")
    if "causedBy" in c:
        cb = c.get("causedBy")
        if not is_str(cb) or not cb.strip():
            problems.append(f"{where}：causedBy 要写引入这个问题的那张卡的编号；不是返工就不写这个字段。")
        elif c.get("kind") != "缺陷":
            problems.append(f"{where}：只有缺陷卡能写 causedBy（合入后才发现的问题，指向引入它的卡）。")
    if "sessions" in c and (not isinstance(c.get("sessions"), list) or not all(is_str(x) and x for x in c["sessions"])):
        problems.append(f"{where}：sessions 要是会话编号的列表。")
    if "evidence" in c and not is_str(c.get("evidence")):
        problems.append(f"{where}：evidence 要是验证产物的路径。")
    return problems


def check_data(data, today=None):
    """返回问题列表；空列表表示合格。"""
    today = today or datetime.date.today()
    if not isinstance(data, dict):
        return ["顶层要是一个对象。"]
    problems = []
    missing = [k for k in TOP_KEYS if k not in data]
    if missing:
        problems.append(f"顶层缺字段 {'、'.join(missing)}。")
    unknown = [k for k in data if k not in TOP_KEYS + TOP_OPTIONAL]
    if unknown:
        problems.append(f"顶层多了不认识的字段 {'、'.join(unknown)}。")

    if not is_str(data.get("project")) or not data.get("project", "").strip():
        problems.append("project（项目名）不能为空。")
    for k in ("stage", "stageGoal"):
        v = data.get(k)
        if v is not None and (not is_str(v) or not v.strip()):
            problems.append(f"{k} 要是非空文字，没有就写 null。")
    goal = data.get("stageGoal")
    has_goal = is_str(goal) and bool(goal.strip())

    brain = data.get("brain")
    if not isinstance(brain, dict) or not all(is_str(brain.get(k)) and brain.get(k).strip() for k in ("name", "id")):
        problems.append("brain 要写成 {\"name\": 主脑会话名, \"id\": 主脑会话编号}，两项都不能为空。")

    left = data.get("leftovers")
    if not is_int(left) or left < 0:
        problems.append("leftovers（遗留小项件数）要是不小于 0 的整数。")

    cards = data.get("cards")
    if not isinstance(cards, list):
        problems.append("cards 要是列表，没有卡片就写 []。")
        return problems
    seen = set()
    for i, c in enumerate(cards, 1):
        cid = c.get("id") if isinstance(c, dict) else None
        where = f"第 {i} 张卡片" + (f"（{cid}）" if is_str(cid) and cid else "")
        if isinstance(c, dict):
            if not is_str(cid) or not cid.strip():
                problems.append(f"{where}：id 不能为空。")
            elif cid in seen:
                problems.append(f"{where}：id 和前面的卡片重复。")
            else:
                seen.add(cid)
        problems.extend(check_card(c, where, today, has_goal))
    return problems


def check_file(path, today=None):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return [f"读不出来：{e.strerror}"]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return [f"不是合法的 JSON：第 {e.lineno} 行第 {e.colno} 列，{e.msg}"]
    return check_data(data, today)


def hook():
    try:
        event = json.load(sys.stdin)
        if event.get("tool_name") not in ("Write", "Edit", "MultiEdit"):
            return
        path = (event.get("tool_input") or {}).get("file_path") or ""
        if not (path.endswith(HOOK_SUFFIX) or path.endswith(EVENTS_SUFFIX)):
            return
        if event.get("hook_event_name") == "PreToolUse":
            # 卡片文件由 card 命令根据事件生成，手改会被下一条命令覆盖，也会丢掉历史
            json.dump({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "卡片文件和事件记录不能手改：用卡片命令记事，它会追加事件并重新生成 cards.json。"
                    "命令：python3 ~/.claude/bin/card <子命令>，比如 new、dispatch、verify、reject、done、ask、answer；"
                    "python3 ~/.claude/bin/card --help 看全部。说明见 claude-orchestrator-brain 仓库的 board/cards-format.md。"),
            }}, sys.stdout, ensure_ascii=False)
            return
        if not path.endswith(HOOK_SUFFIX):
            return
        problems = check_file(path)
    except Exception:
        return
    if not problems:
        return
    reason = (f"卡片文件 {path} 格式不合格，看板会把这个项目标成红框。请改好后重新保存：\n"
              + "\n".join(f"{n}. {p}" for n, p in enumerate(problems, 1))
              + "\n格式见 claude-orchestrator-brain 仓库的 board/cards-format.md。")
    json.dump({"decision": "block", "reason": reason}, sys.stdout, ensure_ascii=False)


def main(paths):
    bad = 0
    for path in paths:
        problems = check_file(path)
        if problems:
            bad += 1
            print(f"{path}：{len(problems)} 个问题")
            for n, p in enumerate(problems, 1):
                print(f"  {n}. {p}")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(main(sys.argv[1:]))
    hook()
