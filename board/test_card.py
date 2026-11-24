#!/usr/bin/env python3
"""card.py 的用例。运行：python3 board/test_card.py"""
import json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.join(HERE, "card.py")


class Card(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dir = os.path.join(self.tmp, "repo", "docs", "brain")
        os.makedirs(self.dir)
        self.now = "2026-11-17T10:00:00+08:00"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_card(self, *args, ok=True, cwd=None):
        env = dict(os.environ, CARD_NOW=self.now, BOARD_REGISTRY=os.path.join(self.tmp, "none.json"))
        p = subprocess.run([sys.executable, CARD, *args], capture_output=True, text=True, env=env,
                           cwd=cwd or os.path.join(self.tmp, "repo"))
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        else:
            self.assertNotEqual(p.returncode, 0, p.stdout)
        return p

    def cards(self):
        with open(os.path.join(self.dir, "cards.json"), encoding="utf-8") as f:
            return json.load(f)

    def events(self):
        with open(os.path.join(self.dir, "events.jsonl"), encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]

    def init(self):
        # 新项目：先建空的台账目录里的事件文件，命令靠它定位
        open(os.path.join(self.dir, "events.jsonl"), "w").close()
        self.run_card("init", "--project", "演示", "--brain-name", "演示主脑", "--brain-id", "local_b")

    def test_full_flow_and_stats(self):
        self.init()
        self.run_card("stage", "--stage", "内测", "--goal", "跑通主流程")
        self.run_card("new", "F-3", "--title", "下单流程", "--kind", "功能", "--priority", "1",
                      "--now", "待派", "--milestone")
        self.run_card("dispatch", "F-3", "--session", "local_x", "--now", "已派")
        c = self.cards()["cards"][0]
        self.assertEqual((c["column"], c["sessions"], c["since"]), ("doing", ["local_x"], "2026-11-17"))
        self.now = "2026-11-18T09:00:00+08:00"
        self.run_card("verify", "F-3")
        self.run_card("reject", "F-3", "--reason", "变异探针存活")
        c = self.cards()["cards"][0]
        self.assertEqual((c["column"], c["rejects"], c["now"], c["since"]), ("doing", 1, "变异探针存活", "2026-11-18"))
        self.run_card("verify", "F-3")
        # 产物必须是存在的路径；提交号之类的文字不收
        self.run_card("done", "F-3", "--evidence", "合入 abc123", ok=False)
        os.makedirs(os.path.join(self.tmp, "repo", ".local", "evidence", "F-3"))
        self.run_card("done", "F-3", "--evidence", ".local/evidence/F-3/")
        c = self.cards()["cards"][0]
        self.assertEqual((c["column"], c["doneAt"], c["evidence"]), ("done", "2026-11-18", ".local/evidence/F-3/"))
        self.run_card("new", "B-1", "--title", "首页白屏", "--kind", "缺陷", "--priority", "1",
                      "--now", "待查", "--caused-by", "F-3")
        st = self.cards()["stats"]
        self.assertEqual({k: st["stage"][k] for k in ("done", "rejects", "rework", "dispatched")},
                         {"done": 1, "rejects": 1, "rework": 1, "dispatched": 1})
        self.assertEqual(st["week"]["done"], 1)
        log = self.run_card("log").stdout
        self.assertIn("F-3 打回：变异探针存活", log)
        self.assertIn("F-3 完成：产物 .local/evidence/F-3/", log)

    def test_review(self):
        self.init()
        self.run_card("new", "F-1", "--title", "登录页", "--kind", "功能", "--priority", "1", "--now", "待派")
        self.run_card("review", "F-1", ok=False)  # 没完成不能请用户看
        self.run_card("done", "F-1", "--review", ok=False)  # 请用户看必须带产物
        os.makedirs(os.path.join(self.tmp, "repo", "art"))
        self.run_card("done", "F-1", "--evidence", "art", "--review")
        self.assertTrue(self.cards()["cards"][0]["review"])
        self.run_card("move", "F-1", "doing")  # 重开后不再请用户看
        self.assertNotIn("review", self.cards()["cards"][0])
        self.run_card("done", "F-1", "--evidence", "art")
        self.assertNotIn("review", self.cards()["cards"][0])
        self.run_card("review", "F-1")  # 事后补标
        self.assertTrue(self.cards()["cards"][0]["review"])

    def test_ask_answer_and_rules(self):
        self.init()
        self.run_card("new", "D-1", "--title", "选渠道", "--kind", "决策", "--priority", "1", "--now", "已查清")
        self.run_card("ask", "D-1", "--decide", "--ask", "在三个渠道里选一个")
        c = self.cards()["cards"][0]
        self.assertEqual((c["ball"], c["askKind"]), ("you", "decide"))
        self.run_card("answer", "D-1", "--now", "选了渠道二")
        c = self.cards()["cards"][0]
        self.assertEqual((c["ball"], c["ask"], c["askKind"], c["now"]), ("brain", "", None, "选了渠道二"))
        before = len(self.events())
        # 违反规则的命令不生效，也不留事件
        p = self.run_card("new", "F-9", "--title", "x", "--kind", "功能", "--priority", "2", "--now", "y", "--milestone", ok=False)
        self.assertIn("阶段目标", p.stderr)
        p = self.run_card("new", "F-8", "--title", "x", "--kind", "功能", "--now", "y", ok=False)
        self.assertIn("priority", p.stderr)
        self.run_card("reject", "NOPE", "--reason", "r", ok=False)
        self.run_card("new", "D-1", "--title", "x", "--kind", "决策", "--priority", "1", "--now", "y", ok=False)
        self.run_card("new", "F-7", "--title", "x", "--kind", "功能", "--priority", "1", "--now", "y", "--caused-by", "D-1", ok=False)
        self.assertEqual(len(self.events()), before)
        self.run_card("drop", "D-1", "--reason", "重复")
        self.assertEqual(self.cards()["cards"], [])

    def test_approval(self):
        self.init()
        self.run_card("new", "D-1", "--title", "选渠道", "--kind", "决策", "--priority", "1", "--now", "已查清")
        self.run_card("new", "D-2", "--title", "定费率", "--kind", "决策", "--priority", "2", "--now", "已查清")
        self.run_card("new", "F-1", "--title", "接入", "--kind", "功能", "--priority", "1", "--now", "待派")
        by = lambda: {c["id"]: c for c in self.cards()["cards"]}
        # 新建的决策卡默认待审，非决策卡没有审批状态
        self.assertEqual(by()["D-1"]["approval"], "pending")
        self.assertNotIn("approval", by()["F-1"])
        self.assertIn("【待审】", self.run_card("show").stdout)
        self.run_card("ask", "D-1", "--decide", "--ask", "在三个渠道里选一个")
        before = len(self.events())
        self.run_card("done", "D-1", ok=False)       # 待审的决策卡不能直接完成
        self.run_card("approve", "F-1", ok=False)    # 只有决策卡走审批
        self.run_card("veto", "D-2", "--reason", "", ok=False)  # 否决必须写原因
        self.run_card("veto", "D-2", ok=False)
        self.assertEqual(len(self.events()), before)
        self.run_card("approve", "D-1", "--note", "lee：就按推荐的渠道二")
        c = by()["D-1"]
        self.assertEqual((c["approval"], c["approvalNote"], c["approvalAt"], c["column"], c["ball"], c["ask"], c["now"]),
                         ("approved", "lee：就按推荐的渠道二", "2026-11-17", "done", "brain", "", "已通过"))
        self.run_card("approve", "D-1", ok=False)    # 不重复通过
        self.run_card("veto", "D-2", "--reason", "费率太高", "--now", "改谈阶梯费率")
        c = by()["D-2"]
        self.assertEqual((c["approval"], c["approvalNote"], c["column"], c["now"]), ("vetoed", "费率太高", "done", "改谈阶梯费率"))
        out = self.run_card("show").stdout
        self.assertIn("【通过】", out)
        self.assertIn("【否决】", out)
        self.assertNotIn("等用户", out)
        log = self.run_card("log").stdout
        self.assertIn("D-1 审批通过：lee：就按推荐的渠道二", log)
        self.assertIn("D-2 审批否决：费率太高", log)
        # 否决后重新提审：回待办、再请用户拍板，回到待审
        self.run_card("move", "D-2", "todo")
        self.assertEqual(by()["D-2"]["approval"], "vetoed")
        self.run_card("ask", "D-2", "--decide", "--ask", "认阶梯费率")
        c = by()["D-2"]
        self.assertEqual(c["approval"], "pending")
        self.assertNotIn("approvalNote", c)
        # 已审批的决策卡过了 14 天也不下架：挪进 decided，按“通过”“否决”筛选时查得到
        self.now = "2026-12-20T10:00:00+08:00"
        self.run_card("check")
        d = self.cards()
        self.assertNotIn("D-1", [c["id"] for c in d["cards"]])
        self.assertEqual([(c["id"], c["approval"]) for c in d["decided"]], [("D-1", "approved")])
        self.assertIn("更早审批过的决策", self.run_card("show").stdout)

    def test_legacy_decisions_replay(self):
        """旧事件不带审批状态：没完成的决策卡视为待审，已完成的不标；已完成的旧卡可以补记审批，不动完成日期。"""
        legacy = [
            {"at": "2026-11-10T10:00:00+08:00", "op": "project", "project": "旧", "brainName": "b", "brainId": "local_b"},
            {"at": "2026-11-10T10:00:00+08:00", "op": "new", "card": "D-1", "title": "旧决策一", "kind": "决策", "priority": 1, "now": "等拍板"},
            {"at": "2026-11-10T10:00:00+08:00", "op": "ask", "card": "D-1", "ask": "拍板", "askKind": "decide"},
            {"at": "2026-11-10T10:00:00+08:00", "op": "new", "card": "D-2", "title": "旧决策二", "kind": "决策", "priority": 3, "now": "暂按推荐写"},
            {"at": "2026-11-10T10:00:00+08:00", "op": "new", "card": "D-3", "title": "旧决策三", "kind": "决策", "priority": 2, "now": "定了"},
            {"at": "2026-11-11T10:00:00+08:00", "op": "done", "card": "D-3"},
        ]
        with open(os.path.join(self.dir, "events.jsonl"), "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in legacy))
        self.run_card("check")
        by = {c["id"]: c for c in self.cards()["cards"]}
        self.assertEqual(by["D-1"]["approval"], "pending")
        self.assertEqual(by["D-2"]["approval"], "pending")
        self.assertNotIn("approval", by["D-3"])
        self.run_card("approve", "D-3", "--note", "补记：11-11 口头同意")
        c = {c["id"]: c for c in self.cards()["cards"]}["D-3"]
        self.assertEqual((c["approval"], c["doneAt"]), ("approved", "2026-11-11"))

    def test_done_cards_leave_board_after_window(self):
        self.init()
        self.run_card("new", "E-1", "--title", "部署", "--kind", "事务", "--priority", "2", "--now", "待做")
        self.run_card("done", "E-1")
        self.assertEqual(len(self.cards()["cards"]), 1)
        self.now = "2026-12-20T10:00:00+08:00"  # 没有阶段时只留 14 天
        self.run_card("check")
        self.assertEqual(self.cards()["cards"], [])
        self.assertEqual(len([e for e in self.events() if e["op"] == "done"]), 1)  # 记录还在

    def test_import_from_hand_written_file(self):
        md = open(os.path.join(HERE, "cards-format.md"), encoding="utf-8").read()
        old = json.loads(re.search(r"```json\n(.*?)```", md, re.S).group(1))  # 说明里的示例
        with open(os.path.join(self.dir, "cards.json"), "w", encoding="utf-8") as f:
            json.dump(old, f, ensure_ascii=False)
        self.now = "2026-11-12T10:00:00+08:00"
        self.run_card("import")
        new = self.cards()
        self.assertEqual([c["id"] for c in new["cards"]], [c["id"] for c in old["cards"]])
        for o, n in zip(old["cards"], new["cards"]):
            for k in ("column", "ball", "since", "doneAt", "now", "priority", "milestone"):
                self.assertEqual(o[k], n[k], f"{o['id']} {k}")
        self.assertEqual(new["stageGoal"], old["stageGoal"])
        self.run_card("import", ok=False)  # 只能导入一次

    def test_locate_from_subdir(self):
        self.init()
        sub = os.path.join(self.tmp, "repo", "apps", "web")
        os.makedirs(sub)
        self.assertIn("演示", self.run_card("show", cwd=sub).stdout)


if __name__ == "__main__":
    unittest.main()
