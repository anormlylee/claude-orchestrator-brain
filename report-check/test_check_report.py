#!/usr/bin/env python3
"""check-report.py 的用例。运行：python3 report-check/test_check_report.py"""
import json, os, subprocess, sys, unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-report.py")

GOOD = """F-12 最终回报：完成，可以合入，召见改签式已落地

【1. 需要决定】
1. 旧接口是否保留；类型：价值取舍；需求：商户端切换期间不报错；选项：立即删、保留一周、长期保留；推荐：保留一周；不按推荐的代价：商户端两个页面会报错；能否撤回：能；阻塞：不阻塞；依据：实测 pm-front/src/api.ts:42
【2. 与派活设想的出入】
1. 派活说表里没有 status 字段，实际有；依据：实测 migrations/012.sql:8；处理：沿用该字段
【3. 遗留】无
【4. tip】pm-backend：feat/f-12 = 3fb16e7（基于 main 1c53d3a），已 push
【5. 测试】go test ./... 全部通过（42 包）
【6. 变异】M1：去掉签名校验 → TestSign 变红
【7. 偏离规则】无
【8. 验证产物】路径：.local/evidence/F-12/；复现：make verify FLOW=召见；覆盖：召见、改签两条流程
"""

RESEARCH = """R-3 最终回报：完成，无需合入，官方接口支持批量查单

【1. 需要决定】无
【2. 与派活设想的出入】无
【3. 遗留】无
【4–8】不适用：调研任务，没有改代码
"""


def run(message, tool="SendMessage"):
    p = subprocess.run([sys.executable, HOOK], input=json.dumps(
        {"tool_name": tool, "tool_input": {"to": "brain", "message": message}}, ensure_ascii=False),
        capture_output=True, text=True)
    return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecisionReason"] if p.stdout.strip() else None


class T(unittest.TestCase):
    def test_good_passes(self):
        self.assertIsNone(run(GOOD))
        self.assertIsNone(run(RESEARCH))
        self.assertIsNone(run(RESEARCH.replace("【4–8】", "【4–7】")))  # 旧写法仍然认

    def test_artifacts(self):
        base = GOOD.split("【8.")[0]
        self.assertIn("缺第 8 栏", run(base) or "")
        self.assertIn("缺：产物路径、复现命令", run(base + "【8. 验证产物】跑过了，没问题\n") or "")
        self.assertIn("没写理由", run(base + "【8. 验证产物】不适用：\n") or "")
        self.assertIsNone(run(base + "【8. 验证产物】不适用：本项目还没有验证技能\n"))

    def test_non_report_passes(self):
        self.assertIsNone(run("已收到"))
        self.assertIsNone(run("主脑已换成 brain-w46，之后回报发给我"))
        self.assertIsNone(run("最终回报的格式改了，见派活模板\n第二行"))  # 只认「最终回报：」
        self.assertIsNone(run("第一行\nF-12 最终回报：完成"))  # 只看第一行
        self.assertIsNone(run(""))

    def test_first_line(self):
        r = run(GOOD.replace("最终回报：完成", "最终回报：搞定了"))
        self.assertIn("第一行", r)

    def test_missing_sections(self):
        r = run(GOOD.replace("【3. 遗留】无\n", ""))
        self.assertIn("缺第 3 栏", r)
        r = run(GOOD.replace("【6. 变异】M1：去掉签名校验 → TestSign 变红\n", ""))
        self.assertIn("缺第 6 栏", r)

    def test_merged_needs_reason(self):
        r = run(RESEARCH.replace("不适用：调研任务，没有改代码", "略"))
        self.assertIn("不适用", r)

    def test_decision_fields(self):
        r = run(GOOD.replace("；阻塞：不阻塞", "").replace("能否撤回：能；", ""))
        self.assertIn("第 1 栏第 1 项缺：撤回、阻塞", r)
        r = run(GOOD.replace("；依据：实测 pm-front/src/api.ts:42", ""))
        self.assertIn("依据", r)
        r = run(GOOD.replace("需求：商户端切换期间不报错；选项：立即删、保留一周、长期保留；", ""))
        self.assertIn("第 1 栏第 1 项缺：需求、选项", r)

    def test_decision_type(self):
        self.assertIsNone(run(GOOD.replace("类型：价值取舍", "类型：技术裁决")))
        r = run(GOOD.replace("类型：价值取舍", "类型：随便"))
        self.assertIn("类型只能是", r)

    def test_mismatch_evidence(self):
        r = run(GOOD.replace("依据：实测 migrations/012.sql:8；", ""))
        self.assertIn("第 2 栏第 1 项没标依据", r)

    def test_multiple_items_checked_separately(self):
        two = GOOD.replace("处理：沿用该字段", "处理：沿用该字段\n2. 测试库端口不是 5432；处理：改成 5433")
        self.assertIn("第 2 栏第 2 项", run(two))

    def test_banned_phrase(self):
        bad = "视" + "情况"
        r = run(GOOD.replace("沿用该字段", f"{bad}沿用该字段"))
        self.assertIn("含糊说法", r)
        # 代码格式里的不算
        self.assertIsNone(run(GOOD.replace("沿用该字段", f"沿用该字段（原文 `{bad}`）")))

    def test_bad_input_passes(self):
        p = subprocess.run([sys.executable, HOOK], input="不是 JSON", capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
