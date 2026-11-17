#!/usr/bin/env python3
"""PreToolUse(SendMessage) 钩子：分支会话发「最终回报」前检查格式。

只检查第一行含「最终回报：」的消息，其余消息一律放行。格式见 skills/brain/dispatch-template.md
「回报格式」。不合格就拒绝发送（permissionDecision=deny），把问题逐条告诉模型，让它改好后重发。
任何异常一律放行：检查程序出错不能挡住回报。
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.realpath(__file__))
EVIDENCE = ("实测", "推断", "未核实")
DECISION_FIELDS = ("类型", "需求", "选项", "推荐", "代价", "撤回", "阻塞")
DECISION_TYPES = ("价值取舍", "技术裁决")
SECTION = re.compile(r"【\s*(\d)(?:\s*[–—\-~～至]\s*(\d))?\s*[.．、]?\s*([^】]*)】")
ITEM = re.compile(r"^\s*\d+\s*[.．、]", re.M)


def banned_phrases():
    try:
        with open(os.path.join(HERE, "banned-phrases.txt"), encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    except Exception:
        return []


def sections(text):
    """返回 {栏号: (栏名, 内容)}；「【4–7】」这种合并栏记在 4 号下，栏名前加 "4-7"。"""
    found = {}
    marks = list(SECTION.finditer(text))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        name = (f"{m.group(1)}-{m.group(2)} " if m.group(2) else "") + m.group(3).strip()
        found.setdefault(int(m.group(1)), (name, text[m.end():end].strip()))
    return found


def items(body):
    """栏内条目：数字编号开头的行各算一条，没有编号就整栏算一条。"""
    if re.match(r"^无\s*$|^无[。；;，,\s]", body):
        return []
    starts = [m.start() for m in ITEM.finditer(body)]
    if not starts:
        return [body]
    return [body[a:b].strip() for a, b in zip(starts, starts[1:] + [len(body)])]


def check_artifacts(body):
    """第 8 栏：要么给出产物路径和复现命令，要么写清为什么不适用。"""
    m = re.search(r"不适用\s*[:：]\s*(.*)", body, re.S)
    if m:
        if len(m.group(1).strip()) < 4:
            return ["第 8 栏写了不适用但没写理由：只限本项目还没有验证技能，或改动没有用户能看到的行为（写清为什么）。"]
        return []
    miss = []
    if "/" not in body:
        miss.append("产物路径")
    if "复现" not in body:
        miss.append("复现命令")
    if miss:
        return [f"第 8 栏「验证产物」缺：{'、'.join(miss)}。写成「路径：<产物目录>；复现：<命令>；覆盖：<走了哪些流程>」。"]
    return []


def check(msg):
    problems = []
    first = msg.strip().splitlines()[0]
    if not re.search(r"最终回报[:：]\s*(完成|部分完成|卡住)", first):
        problems.append("第一行要写成「<任务名> 最终回报：<完成 | 部分完成 | 卡住>，<能否合入>，<一句话说明>」。")

    prose = re.sub(r"```.*?```|`[^`\n]*`", " ", msg, flags=re.S)
    secs = sections(prose)
    for no, key in ((1, "需要决定"), (2, "出入"), (3, "遗留")):
        if no not in secs or key not in secs[no][0]:
            problems.append(f"缺第 {no} 栏「{key}」：没有内容也要写这一栏，内容写「无」。")
    merged = 4 in secs and re.match(r"4-[78]\b", secs[4][0]) is not None
    if merged:
        if "不适用" not in secs[4][1]:
            problems.append("合并写的「【4–8】」要写成「不适用：<理由>」。")
    else:
        for no, key in ((4, "tip"), (5, "测试"), (6, "变异"), (7, "偏离"), (8, "验证")):
            if no not in secs or key not in secs[no][0]:
                problems.append(f"缺第 {no} 栏「{key}」；不产出代码的任务可以合成一行「【4–8】不适用：<理由>」。")
        if 8 in secs and "验证" in secs[8][0]:
            problems.extend(check_artifacts(secs[8][1]))

    if 1 in secs:
        for n, it in enumerate(items(secs[1][1]), 1):
            miss = [f for f in DECISION_FIELDS if f not in it]
            if not any(e in it for e in EVIDENCE):
                miss.append("依据（实测 / 推断 / 未核实）")
            if miss:
                problems.append(f"第 1 栏第 {n} 项缺：{'、'.join(miss)}。")
            elif not any(t in it for t in DECISION_TYPES):
                problems.append(f"第 1 栏第 {n} 项的类型只能是「价值取舍」或「技术裁决」：技术选择交主脑裁决，价值取舍才交用户。")
    if 2 in secs:
        for n, it in enumerate(items(secs[2][1]), 1):
            if not any(e in it for e in EVIDENCE):
                problems.append(f"第 2 栏第 {n} 项没标依据：实测（附位置）/ 推断（写理由）/ 未核实。")

    hits = [p for p in banned_phrases() if p in prose]
    if hits:
        problems.append(f"用了含糊说法：{'、'.join(hits)}。要么给出判断，要么写「不确定：缺什么；补上要做什么」。")
    return problems


def main():
    try:
        data = json.load(sys.stdin)
        msg = (data.get("tool_input") or {}).get("message") or ""
        if not isinstance(msg, str) or not re.search(r"最终回报\s*[:：]", (msg.strip().splitlines() or [""])[0]):
            return 0
        problems = check(msg)
    except Exception:
        return 0
    if not problems:
        return 0
    reason = ("回报格式检查没通过，这条回报没有发出去。按派活模板「回报格式」改好后重发：\n"
              + "\n".join(f"{i}. {p}" for i, p in enumerate(problems, 1)))
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
