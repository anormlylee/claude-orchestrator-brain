#!/usr/bin/env python3
"""check-cards.py 的用例。运行：python3 board/test_check_cards.py"""
import copy, datetime, importlib.util, json, os, re, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "check-cards.py")
spec = importlib.util.spec_from_file_location("check_cards", SCRIPT)
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

TODAY = datetime.date(2026, 11, 12)


def example():
    """格式说明里的示例：说明和检查必须一致。"""
    with open(os.path.join(HERE, "cards-format.md"), encoding="utf-8") as f:
        md = f.read()
    return json.loads(re.search(r"```json\n(.*?)```", md, re.S).group(1))


def problems(data):
    return cc.check_data(data, TODAY)


def with_card(**changes):
    d = example()
    d["cards"][0].update(changes)
    return d


def joined(data):
    return "\n".join(problems(data))


class Format(unittest.TestCase):
    def test_example_passes(self):
        self.assertEqual(problems(example()), [])

    def test_empty_project_passes(self):
        d = example()
        d.update(stage=None, stageGoal=None, leftovers=0, cards=[])
        self.assertEqual(problems(d), [])

    def test_top_level(self):
        d = example()
        del d["leftovers"]
        d["extra"] = 1
        r = joined(d)
        self.assertIn("顶层缺字段 leftovers", r)
        self.assertIn("顶层多了不认识的字段 extra", r)
        for k, v, word in (("project", "", "project"), ("brain", {"name": "x"}, "brain"),
                           ("leftovers", -1, "leftovers"), ("leftovers", True, "leftovers"),
                           ("cards", {}, "cards"), ("stage", "", "stage")):
            d = example()
            d[k] = v
            self.assertIn(word, joined(d), (k, v))

    def test_missing_and_unknown_card_fields(self):
        d = example()
        del d["cards"][1]["blocked"]
        d["cards"][1]["branch"] = "feat/x"
        r = joined(d)
        self.assertIn("缺字段 blocked", r)
        self.assertIn("不认识的字段 branch", r)
        d = example()
        del d["cards"][0]["detail"]
        self.assertEqual(problems(d), [])  # detail 可以不写

    def test_trust_fields(self):
        self.assertEqual(problems(with_card(rejects=0)), [])
        self.assertIn("rejects", joined(with_card(rejects=-1)))
        self.assertIn("rejects", joined(with_card(rejects="2")))
        self.assertIn("只有缺陷卡能写 causedBy", joined(with_card(causedBy="F-1")))
        self.assertIn("causedBy 要写", joined(with_card(kind="缺陷", causedBy="")))
        self.assertEqual(problems(with_card(kind="缺陷", causedBy="F-1")), [])

    def test_enums(self):
        self.assertIn("column 只能是", joined(with_card(column="待办")))
        self.assertIn("kind 只能是", joined(with_card(kind="需求")))
        self.assertIn("ball 只能是", joined(with_card(ball="user")))
        self.assertIn("askKind 只能是", joined(with_card(askKind="both")))
        self.assertIn("priority 只能是", joined(with_card(priority=4)))
        self.assertIn("priority 只能是", joined(with_card(priority=True)))
        self.assertIn("milestone 只能是", joined(with_card(milestone="是")))

    def test_lengths(self):
        self.assertIn("title 超过 20 字", joined(with_card(title="字" * 21)))
        self.assertEqual(problems(with_card(title="字" * 20)), [])
        self.assertIn("ask 超过 40 字", joined(with_card(ask="选" * 41)))
        self.assertIn("now 超过 40 字", joined(with_card(now="字" * 41)))
        self.assertIn("now 不能为空", joined(with_card(now="")))
        self.assertIn("title 不能为空", joined(with_card(title="  ")))

    def test_priority_required_for_todo_and_doing(self):
        self.assertIn("必须写 priority", joined(with_card(priority=None)))
        d = example()
        d["cards"][1]["priority"] = None
        self.assertIn("必须写 priority", joined(d))
        d = example()
        d["cards"][0].update(column="verify", priority=None)
        self.assertEqual(problems(d), [])

    def test_ball_on_user_needs_ask(self):
        self.assertIn("必须写 ask", joined(with_card(ask="")))
        self.assertIn("必须写 askKind", joined(with_card(askKind=None)))
        # 已完成的卡不再要求
        d = example()
        d["cards"][0].update(column="done", ask="", askKind=None, doneAt="2026-11-11")
        self.assertEqual(problems(d), [])

    def test_milestone_needs_stage_goal(self):
        d = example()
        d["stageGoal"] = None
        self.assertIn("还没有阶段目标", joined(d))
        for c in d["cards"]:
            c["milestone"] = False
        self.assertEqual(problems(d), [])

    def test_dates(self):
        self.assertIn("YYYY-MM-DD", joined(with_card(since="11-10")))
        self.assertIn("YYYY-MM-DD", joined(with_card(since=None)))
        self.assertIn("不是有效日期", joined(with_card(since="2026-02-30")))
        self.assertIn("不能晚于今天", joined(with_card(since="2026-11-13")))
        self.assertIn("doneAt 要写 null", joined(with_card(doneAt="2026-11-11")))
        d = example()
        d["cards"][2]["doneAt"] = None
        self.assertIn("必须写 doneAt", joined(d))

    def test_ids(self):
        d = example()
        d["cards"][1]["id"] = d["cards"][0]["id"]
        self.assertIn("id 和前面的卡片重复", joined(d))
        self.assertIn("id 不能为空", joined(with_card(id="")))

    def test_card_not_object(self):
        d = example()
        d["cards"].append("F-9")
        self.assertIn("每张卡片要是一个对象", joined(d))

    def test_does_not_mutate(self):
        d = example()
        before = copy.deepcopy(d)
        problems(d)
        self.assertEqual(d, before)


def write_tmp(dirname, content):
    os.makedirs(os.path.join(dirname, "brain"), exist_ok=True)
    path = os.path.join(dirname, "brain", "cards.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def run_hook(payload):
    p = subprocess.run([sys.executable, SCRIPT], input=payload, capture_output=True, text=True)
    return p.returncode, p.stdout


class Cli(unittest.TestCase):
    def test_exit_codes(self):
        with tempfile.TemporaryDirectory() as t:
            good = write_tmp(t, json.dumps(example(), ensure_ascii=False))
            p = subprocess.run([sys.executable, SCRIPT, good], capture_output=True, text=True)
            self.assertEqual((p.returncode, p.stdout), (0, ""))
            write_tmp(t, "{ 坏 json")
            p = subprocess.run([sys.executable, SCRIPT, good], capture_output=True, text=True)
            self.assertEqual(p.returncode, 1)
            self.assertIn("不是合法的 JSON", p.stdout)
        p = subprocess.run([sys.executable, SCRIPT, "/不存在/brain/cards.json"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn("读不出来", p.stdout)


class Hook(unittest.TestCase):
    def event(self, path, tool="Write"):
        return json.dumps({"tool_name": tool, "tool_input": {"file_path": path}}, ensure_ascii=False)

    def test_blocks_bad_cards_file(self):
        with tempfile.TemporaryDirectory() as t:
            path = write_tmp(t, json.dumps(with_card(kind="需求"), ensure_ascii=False))
            for tool in ("Write", "Edit", "MultiEdit"):
                code, out = run_hook(self.event(path, tool))
                self.assertEqual(code, 0)
                r = json.loads(out)
                self.assertEqual(r["decision"], "block")
                self.assertIn("kind 只能是", r["reason"])

    def test_denies_direct_edits_before_they_happen(self):
        for path in ("/r/docs/brain/cards.json", "/r/brain/events.jsonl"):
            for tool in ("Write", "Edit", "MultiEdit"):
                ev = json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool,
                                 "tool_input": {"file_path": path}}, ensure_ascii=False)
                code, out = run_hook(ev)
                r = json.loads(out)["hookSpecificOutput"]
                self.assertEqual((code, r["permissionDecision"]), (0, "deny"))
                self.assertIn("卡片命令", r["permissionDecisionReason"])
        other = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Write",
                            "tool_input": {"file_path": "/r/docs/brain/ledger.md"}})
        self.assertEqual(run_hook(other), (0, ""))

    def test_passes_good_file_and_others(self):
        with tempfile.TemporaryDirectory() as t:
            good = write_tmp(t, json.dumps(example(), ensure_ascii=False))
            self.assertEqual(run_hook(self.event(good)), (0, ""))
            other = os.path.join(t, "cards.json")  # 不在 brain/ 下
            with open(other, "w") as f:
                f.write("{")
            self.assertEqual(run_hook(self.event(other)), (0, ""))
            write_tmp(t, "{")
            self.assertEqual(run_hook(self.event(good, tool="Read")), (0, ""))
        self.assertEqual(run_hook("不是 json"), (0, ""))
        self.assertEqual(run_hook(""), (0, ""))


if __name__ == "__main__":
    unittest.main(verbosity=1)
