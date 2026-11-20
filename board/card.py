#!/usr/bin/env python3
"""卡片命令：主脑用它记事，不再手写卡片文件。

每个项目在台账旁边有两份文件：
  events.jsonl  事件记录，只追加，是唯一的事实来源；
  cards.json    由事件算出来的“现在”，看板读它；每条命令执行完自动重新生成，不要手改。

用法（在项目仓库里任意目录执行；不在项目里时用 -p <看板登记的项目键>）：
  card.py init --project 名称 --brain-name 主脑会话名 --brain-id local_...
  card.py import                       从旧的手写 cards.json 导入（迁移时用一次）
  card.py new F-3 --title 下单流程 --kind 功能 --priority 1 --now 待派 [--milestone] [--caused-by F-1] [--frozen]
  card.py dispatch F-3 --session local_... [--now 已派 f-3]
  card.py link F-3 --session local_...  记下另一个相关会话，不换列
  card.py verify F-3 [--now 分支回报完成，待验收]
  card.py reject F-3 --reason 变异探针存活
  card.py done F-3 [--evidence <产物路径>] [--review] [--now 已合入]
                                       --review：请用户看（看板首屏“待你看”）；只给有录屏截图、用户能看到变化的事
  card.py review F-3                    给已完成的卡补上“请用户看”
  card.py ask D-1 --decide|--act --ask 在三个渠道里选一个 [--now ...]
  card.py answer D-1 [--now ...]
  card.py external L-1 --now 等律所书面意见
  card.py block F-3 --reason ...  /  card.py unblock F-3
  card.py move F-3 todo|doing|verify|frozen [--now ...]
  card.py edit F-3 [--title] [--kind] [--priority 1|none] [--milestone yes|no] [--now] [--detail]
  card.py drop F-3 --reason 作废原因      从看板拿掉（记录还在）
  card.py stage --stage 内测 --goal 测试环境跑通完整业务流程   （--clear 清空）
  card.py brain --name ... --id local_...
  card.py leftovers 3
  card.py show                          打印当前卡片
  card.py log [--days 7]                按天列出事件，填周流水用
  card.py check                         重算并检查

时间默认取当前时刻；测试时可用环境变量 CARD_NOW 指定（ISO 格式）。
"""
import argparse, datetime, importlib.util, json, os, sys

HERE = os.path.dirname(os.path.realpath(__file__))
REGISTRY = os.environ.get("BOARD_REGISTRY") or os.path.expanduser("~/.claude/board/projects.json")
COLUMNS = ("todo", "doing", "verify", "done", "frozen")
COLUMN_LABEL = {"todo": "待办", "doing": "进行中", "verify": "待验收", "done": "已完成", "frozen": "冻结"}
KINDS = ("功能", "缺陷", "调研", "决策", "事务")
DONE_WINDOW_DAYS = 14  # 没有阶段时，已完成的卡在看板上留多少天

_spec = importlib.util.spec_from_file_location("check_cards", os.path.join(HERE, "check-cards.py"))
check_cards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_cards)


class CardError(Exception):
    pass


def now_iso():
    fixed = os.environ.get("CARD_NOW")
    if fixed:
        return datetime.datetime.fromisoformat(fixed).astimezone().isoformat(timespec="seconds")
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def day(at):
    return at[:10]


def today():
    return datetime.date.fromisoformat(day(now_iso()))


# ---------- 找文件 ----------

def locate(args):
    if args.dir:
        return os.path.abspath(args.dir)
    if args.project:
        try:
            with open(REGISTRY, encoding="utf-8") as f:
                reg = json.load(f)
        except OSError:
            raise CardError(f"读不到看板登记表 {REGISTRY}")
        for p in reg.get("projects", []):
            if p.get("key") == args.project:
                return os.path.dirname(p["file"])
        raise CardError(f"看板登记表里没有项目 {args.project}")
    d = os.getcwd()
    while True:
        for sub in (os.path.join("docs", "brain"), "brain"):
            cand = os.path.join(d, sub)
            if os.path.exists(os.path.join(cand, "events.jsonl")) or os.path.exists(os.path.join(cand, "cards.json")):
                return cand
        parent = os.path.dirname(d)
        if parent == d:
            raise CardError("当前目录往上找不到 docs/brain/ 或 brain/ 下的卡片文件；用 -p <项目键> 或 --dir <台账目录> 指定。")
        d = parent


def read_events(folder):
    path = os.path.join(folder, "events.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                raise CardError(f"events.jsonl 第 {n} 行不是合法的 JSON；这份文件只能由 card 命令追加。")
    return out


# ---------- 重放：事件 → 现在 ----------

def empty_project():
    return {"project": "", "stage": None, "stageGoal": None, "stageSince": None,
            "brain": {"name": "", "id": ""}, "leftovers": 0}


def apply(state, ev):
    """把一条事件作用到 state 上；违反规则时抛 CardError。state = {"head":..., "cards": {id: card}, "order": [...]}"""
    head, cards, order = state["head"], state["cards"], state["order"]
    op, at, cid = ev["op"], ev["at"], ev.get("card")

    def card():
        if cid not in cards:
            raise CardError(f"没有编号为 {cid} 的卡片（或已经 drop 掉了）。")
        return cards[cid]

    def to_column(c, col):
        if col not in COLUMNS:
            raise CardError(f"列只能是 {' / '.join(COLUMNS)}。")
        if c["column"] != col:
            c["column"] = col
            c["since"] = day(at)
        c["doneAt"] = day(at) if col == "done" else None
        if col == "done":
            c["ball"], c["ask"], c["askKind"] = "brain", "", None
        else:
            c.pop("review", None)

    def set_now(c):
        if ev.get("now"):
            c["now"] = ev["now"]

    if op == "project":
        head["project"] = ev["project"]
        head["brain"] = {"name": ev["brainName"], "id": ev["brainId"]}
    elif op == "brain":
        head["brain"] = {"name": ev["name"], "id": ev["id"]}
    elif op == "stage":
        head["stage"], head["stageGoal"] = ev.get("stage"), ev.get("goal")
        head["stageSince"] = day(at) if ev.get("goal") else None
        if not ev.get("goal"):
            for c in cards.values():
                c["milestone"] = False
    elif op == "leftovers":
        head["leftovers"] = ev["count"]
    elif op in ("new", "import"):
        if not cid:
            raise CardError("卡片编号不能为空。")
        if cid in cards:
            raise CardError(f"编号 {cid} 已经有了。")
        c = {"id": cid, "title": ev["title"], "column": ev.get("column", "todo"), "kind": ev["kind"],
             "priority": ev.get("priority"), "milestone": bool(ev.get("milestone")),
             "ball": ev.get("ball", "brain"), "ask": ev.get("ask", ""), "askKind": ev.get("askKind"),
             "now": ev.get("now", ""), "blocked": ev.get("blocked", ""),
             "since": ev.get("since") or day(at), "doneAt": ev.get("doneAt"),
             "rejects": ev.get("rejects", 0), "sessions": list(ev.get("sessions", []))}
        for k in ("causedBy", "detail", "evidence"):
            if ev.get(k):
                c[k] = ev[k]
        if c["kind"] not in KINDS:
            raise CardError(f"类型只能是 {'、'.join(KINDS)}。")
        if c.get("causedBy") and c["kind"] != "缺陷":
            raise CardError("只有缺陷卡能写返工来源（--caused-by）。")
        cards[cid] = c
        order.append(cid)
    elif op == "edit":
        c = card()
        for k in ("title", "kind", "now", "detail"):
            if k in ev:
                c[k] = ev[k]
        if "priority" in ev:
            c["priority"] = ev["priority"]
        if "milestone" in ev:
            c["milestone"] = ev["milestone"]
        if c["kind"] not in KINDS:
            raise CardError(f"类型只能是 {'、'.join(KINDS)}。")
    elif op == "dispatch":
        c = card()
        if ev["session"] not in c["sessions"]:
            c["sessions"].append(ev["session"])
        to_column(c, "doing")
        c["ball"] = "brain"
        set_now(c)
    elif op == "link":
        c = card()
        if ev["session"] not in c["sessions"]:
            c["sessions"].append(ev["session"])
    elif op == "verify":
        c = card()
        to_column(c, "verify")
        set_now(c)
    elif op == "reject":
        c = card()
        c["rejects"] = c.get("rejects", 0) + 1
        to_column(c, "doing")
        c["now"] = ev["reason"]
    elif op == "done":
        c = card()
        to_column(c, "done")
        if ev.get("evidence"):
            c["evidence"] = ev["evidence"]
        if ev.get("review"):
            c["review"] = True
        set_now(c)
    elif op == "review":
        c = card()
        if c["column"] != "done":
            raise CardError(f"{cid} 还没完成；完成时用 done --review。")
        c["review"] = True
    elif op == "ask":
        c = card()
        c["ball"], c["ask"], c["askKind"] = "you", ev["ask"], ev["askKind"]
        set_now(c)
    elif op == "answer":
        c = card()
        c["ball"], c["ask"], c["askKind"] = "brain", "", None
        set_now(c)
    elif op == "external":
        c = card()
        c["ball"], c["ask"], c["askKind"] = "external", "", None
        set_now(c)
    elif op == "block":
        card()["blocked"] = ev["reason"]
    elif op == "unblock":
        card()["blocked"] = ""
    elif op == "move":
        c = card()
        to_column(c, ev["column"])
        set_now(c)
    elif op == "drop":
        card()
        del cards[cid]
        order.remove(cid)
    else:
        raise CardError(f"不认识的事件 {op}")


def replay(events):
    state = {"head": empty_project(), "cards": {}, "order": []}
    for n, ev in enumerate(events, 1):
        try:
            apply(state, ev)
        except CardError as e:
            raise CardError(f"重放第 {n} 条事件（{ev.get('op')} {ev.get('card') or ''}）出错：{e}")
    return state


def stats(events, head, on):
    """信任指标：本阶段、近 7 天的完成、打回、返工、派出件数。"""
    def window(since):
        w = {"done": 0, "rejects": 0, "rework": 0, "dispatched": 0}
        for ev in events:
            if since and day(ev["at"]) < since:
                continue
            op = ev["op"]
            if op == "done":
                w["done"] += 1
            elif op == "reject":
                w["rejects"] += 1
            elif op == "new" and ev.get("causedBy"):
                w["rework"] += 1
            elif op == "dispatch":
                w["dispatched"] += 1
        return w
    week_since = (on - datetime.timedelta(days=6)).isoformat()
    out = {"week": dict(window(week_since), since=week_since)}
    if head.get("stageSince"):
        out["stage"] = dict(window(head["stageSince"]), since=head["stageSince"])
    return out


def build(events, on=None):
    on = on or today()
    state = replay(events)
    head = state["head"]
    keep_from = head.get("stageSince") or (on - datetime.timedelta(days=DONE_WINDOW_DAYS)).isoformat()
    cards = []
    for cid in state["order"]:
        c = state["cards"][cid]
        if c["column"] == "done" and (c.get("doneAt") or "") < keep_from:
            continue  # 本阶段之前完成的不上板，记录在 events.jsonl
        cards.append(c)
    return {
        "generatedBy": "card.py：由 events.jsonl 生成，不要手改",
        "project": head["project"], "stage": head["stage"], "stageGoal": head["stageGoal"],
        "brain": head["brain"], "leftovers": head["leftovers"],
        "stats": stats(events, head, on),
        "cards": cards,
    }


# ---------- 写入 ----------

def write_all(folder, events):
    data = build(events)
    problems = check_cards.check_data(data, today())
    if problems:
        raise CardError("生成的卡片不合格，这条命令没有生效：\n" + "\n".join(f"{n}. {p}" for n, p in enumerate(problems, 1)))
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, ".cards.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, os.path.join(folder, "cards.json"))
    return data


def commit(folder, new_events):
    """先在内存里重放和检查，全部通过才追加到 events.jsonl。"""
    events = read_events(folder) + new_events
    data = build(events)
    problems = check_cards.check_data(data, today())
    if problems:
        raise CardError("这条命令会让卡片不合格，没有生效：\n" + "\n".join(f"{n}. {p}" for n, p in enumerate(problems, 1)))
    with open(os.path.join(folder, "events.jsonl"), "a", encoding="utf-8") as f:
        for ev in new_events:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return write_all(folder, events)


# ---------- 命令 ----------

def ev(op, card=None, **fields):
    out = {"at": now_iso(), "op": op}
    if card is not None:
        out["card"] = card
    out.update({k: v for k, v in fields.items() if v is not None})
    return out


def parse_priority(v):
    if v in (None, ""):
        return None
    if v in ("none", "null", "无"):
        return "none"
    if v not in ("1", "2", "3"):
        raise CardError("优先级只能是 1、2、3 或 none。")
    return int(v)


def repo_root(folder):
    """台账目录所在的仓库根目录：docs/brain → 上两级，brain → 上一级。"""
    parts = os.path.normpath(folder).split(os.sep)
    if parts[-2:] == ["docs", "brain"]:
        return os.sep.join(parts[:-2])
    return os.path.dirname(os.path.normpath(folder))


def check_evidence(folder, path):
    """验证产物必须是确实存在的文件或目录（绝对路径，或相对仓库根目录）；提交号、说明文字写进现状。"""
    full = path if os.path.isabs(path) else os.path.join(repo_root(folder), path)
    if not os.path.exists(full):
        raise CardError(f"验证产物 {path} 不存在（相对路径按仓库根目录 {repo_root(folder)} 算）。"
                        "这一栏只写录屏、截图、报告等产物的路径；提交号和说明写进 --now。")


def cmd_import(folder):
    if read_events(folder):
        raise CardError("events.jsonl 已经有记录，不能再导入。")
    path = os.path.join(folder, "cards.json")
    with open(path, encoding="utf-8") as f:
        old = json.load(f)
    problems = check_cards.check_data(old, today())
    if problems:
        raise CardError("旧卡片文件本身不合格，先按 check-cards.py 的提示改好再导入：\n" + "\n".join(problems))
    at = now_iso()
    out = [{"at": at, "op": "project", "project": old["project"],
            "brainName": old["brain"]["name"], "brainId": old["brain"]["id"]}]
    if old.get("stageGoal"):
        out.append({"at": at, "op": "stage", "stage": old.get("stage"), "goal": old["stageGoal"]})
    elif old.get("stage"):
        out.append({"at": at, "op": "stage", "stage": old["stage"], "goal": None})
    out.append({"at": at, "op": "leftovers", "count": old.get("leftovers", 0)})
    for c in old["cards"]:
        e = {"at": at, "op": "import", "card": c["id"]}
        for k in ("title", "column", "kind", "priority", "milestone", "ball", "ask", "askKind",
                  "now", "blocked", "since", "doneAt", "detail", "rejects", "causedBy", "sessions", "evidence"):
            if k in c and c[k] is not None:
                e[k] = c[k]
        out.append(e)
    # 导入时保留阶段内已完成的卡：阶段起点取最早的 doneAt
    dones = [c["doneAt"] for c in old["cards"] if c.get("doneAt")]
    for e in out:
        if e["op"] == "stage" and e.get("goal") and dones:
            e["at"] = min(dones) + at[10:]
    out.sort(key=lambda e: 0 if e["op"] in ("project", "stage", "leftovers") else 1)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="card", description="主脑记卡片的命令；卡片文件由事件生成，不要手改。")
    ap.add_argument("-p", "--project", help="看板登记表里的项目键")
    ap.add_argument("--dir", help="台账目录（放 cards.json 和 events.jsonl 的目录）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.add_argument("--project", dest="name", required=True)
    s.add_argument("--brain-name", required=True); s.add_argument("--brain-id", required=True)
    sub.add_parser("import")
    s = sub.add_parser("new"); s.add_argument("id"); s.add_argument("--title", required=True)
    s.add_argument("--kind", required=True, choices=KINDS); s.add_argument("--priority")
    s.add_argument("--now", required=True); s.add_argument("--milestone", action="store_true")
    s.add_argument("--caused-by"); s.add_argument("--frozen", action="store_true"); s.add_argument("--detail")
    for name in ("dispatch", "link"):
        s = sub.add_parser(name); s.add_argument("id"); s.add_argument("--session", required=True)
        if name == "dispatch":
            s.add_argument("--now")
    for name in ("verify", "answer", "unblock"):
        s = sub.add_parser(name); s.add_argument("id")
        if name != "unblock":
            s.add_argument("--now")
    s = sub.add_parser("reject"); s.add_argument("id"); s.add_argument("--reason", required=True)
    s = sub.add_parser("done"); s.add_argument("id"); s.add_argument("--evidence"); s.add_argument("--now")
    s.add_argument("--review", action="store_true")
    s = sub.add_parser("review"); s.add_argument("id")
    s = sub.add_parser("ask"); s.add_argument("id"); g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--decide", action="store_true"); g.add_argument("--act", action="store_true")
    s.add_argument("--ask", required=True); s.add_argument("--now")
    s = sub.add_parser("external"); s.add_argument("id"); s.add_argument("--now", required=True)
    s = sub.add_parser("block"); s.add_argument("id"); s.add_argument("--reason", required=True)
    s = sub.add_parser("move"); s.add_argument("id"); s.add_argument("column", choices=("todo", "doing", "verify", "frozen"))
    s.add_argument("--now")
    s = sub.add_parser("edit"); s.add_argument("id")
    for k in ("--title", "--kind", "--priority", "--milestone", "--now", "--detail"):
        s.add_argument(k)
    s = sub.add_parser("drop"); s.add_argument("id"); s.add_argument("--reason", required=True)
    s = sub.add_parser("stage"); s.add_argument("--stage"); s.add_argument("--goal"); s.add_argument("--clear", action="store_true")
    s = sub.add_parser("brain"); s.add_argument("--name", required=True); s.add_argument("--id", required=True)
    s = sub.add_parser("leftovers"); s.add_argument("count", type=int)
    sub.add_parser("show"); sub.add_parser("check")
    s = sub.add_parser("log"); s.add_argument("--days", type=int, default=7)

    a = ap.parse_args(argv)
    try:
        folder = locate(a)
        c = a.cmd
        if c not in ("init", "import") and not read_events(folder):
            if os.path.exists(os.path.join(folder, "cards.json")):
                raise CardError("这个项目还没迁移到卡片命令：先执行 import，把手写的 cards.json 导入成事件。")
            raise CardError("这个项目还没有卡片记录：先执行 init。")
        if c == "init":
            if read_events(folder):
                raise CardError("这个项目已经有事件记录了；改主脑用 brain 命令。")
            data = commit(folder, [ev("project", project=a.name, brainName=a.brain_name, brainId=a.brain_id),
                                   ev("leftovers", count=0)])
        elif c == "import":
            data = commit(folder, cmd_import(folder))
        elif c == "new":
            pr = parse_priority(a.priority)
            data = commit(folder, [ev("new", a.id, title=a.title, kind=a.kind,
                                      priority=None if pr in (None, "none") else pr,
                                      milestone=True if a.milestone else None, now=a.now,
                                      causedBy=a.caused_by, detail=a.detail,
                                      column="frozen" if a.frozen else None)])
        elif c in ("dispatch", "link"):
            data = commit(folder, [ev(c, a.id, session=a.session, now=getattr(a, "now", None))])
        elif c in ("verify", "answer"):
            data = commit(folder, [ev(c, a.id, now=a.now)])
        elif c == "unblock":
            data = commit(folder, [ev(c, a.id)])
        elif c == "reject":
            data = commit(folder, [ev(c, a.id, reason=a.reason)])
        elif c == "done":
            if a.evidence is not None:
                check_evidence(folder, a.evidence)
            data = commit(folder, [ev(c, a.id, evidence=a.evidence, review=True if a.review else None, now=a.now)])
        elif c == "review":
            data = commit(folder, [ev(c, a.id)])
        elif c == "ask":
            data = commit(folder, [ev(c, a.id, ask=a.ask, askKind="decide" if a.decide else "act", now=a.now)])
        elif c == "external":
            data = commit(folder, [ev(c, a.id, now=a.now)])
        elif c == "block":
            data = commit(folder, [ev(c, a.id, reason=a.reason)])
        elif c == "move":
            data = commit(folder, [ev(c, a.id, column=a.column, now=a.now)])
        elif c == "edit":
            fields = {k: getattr(a, k) for k in ("title", "kind", "now", "detail") if getattr(a, k) is not None}
            if a.priority is not None:
                pr = parse_priority(a.priority)
                fields["priority"] = None if pr == "none" else pr
            if a.milestone is not None:
                if a.milestone not in ("yes", "no"):
                    raise CardError("--milestone 只能写 yes 或 no。")
                fields["milestone"] = a.milestone == "yes"
            if not fields:
                raise CardError("edit 至少要改一项。")
            e = ev("edit", a.id); e.update(fields)
            data = commit(folder, [e])
        elif c == "drop":
            data = commit(folder, [ev(c, a.id, reason=a.reason)])
        elif c == "stage":
            if a.clear:
                data = commit(folder, [{"at": now_iso(), "op": "stage", "stage": None, "goal": None}])
            else:
                if not a.goal:
                    raise CardError("stage 要写 --goal（用户确认过的阶段目标），或者用 --clear 清空。")
                data = commit(folder, [{"at": now_iso(), "op": "stage", "stage": a.stage, "goal": a.goal}])
        elif c == "brain":
            data = commit(folder, [ev("brain", name=a.name, id=a.id)])
        elif c == "leftovers":
            data = commit(folder, [ev("leftovers", count=a.count)])
        elif c == "check":
            data = write_all(folder, read_events(folder))
            print(f"合格：{len(data['cards'])} 张卡片上板。")
            return 0
        elif c == "log":
            return print_log(read_events(folder), a.days)
        elif c == "show":
            data = build(read_events(folder))
        print_cards(data)
        return 0
    except CardError as e:
        print(f"没有生效：{e}", file=sys.stderr)
        return 1


OP_LABEL = {"new": "建卡", "import": "导入", "dispatch": "派活", "link": "关联会话", "verify": "回报待验收",
            "reject": "打回", "done": "完成", "review": "请用户看", "ask": "请用户", "answer": "用户已答复", "external": "等外部",
            "block": "阻塞", "unblock": "解除阻塞", "move": "换列", "edit": "修改", "drop": "拿掉",
            "stage": "阶段目标", "brain": "换主脑", "leftovers": "遗留小项", "project": "建项目"}


def print_log(events, days):
    since = (datetime.date.fromisoformat(day(now_iso())) - datetime.timedelta(days=days - 1)).isoformat()
    for e in events:
        if day(e["at"]) < since or e["op"] in ("import", "project", "leftovers"):
            continue
        extra = e.get("reason") or e.get("ask") or e.get("now") or e.get("title") or e.get("goal") or e.get("column") or ""
        if e["op"] == "dispatch":
            extra = f"会话 {e['session']}" + (f"；{e['now']}" if e.get("now") else "")
        if e["op"] == "done" and e.get("evidence"):
            extra = f"产物 {e['evidence']}"
        print(f"- {e['at'][5:16].replace('T', ' ')} {e.get('card', '')} {OP_LABEL.get(e['op'], e['op'])}" + (f"：{extra}" if extra else ""))
    return 0


def print_cards(data):
    s = data["stats"]["week"]
    print(f"{data['project']}｜阶段：{data['stage'] or '未定'}｜近 7 天 完成 {s['done']}、打回 {s['rejects']}、返工 {s['rework']}")
    for col in COLUMNS:
        cs = [c for c in data["cards"] if c["column"] == col]
        if not cs:
            continue
        print(f"{COLUMN_LABEL[col]}（{len(cs)}）")
        for c in cs:
            tag = {"you": "【等用户】", "external": "【等外部】"}.get(c["ball"], "")
            print(f"  {c['id']} {c['title']} {tag}{c['now']}")


if __name__ == "__main__":
    sys.exit(main())
