#!/usr/bin/env python3
"""hook-run.py 的用例。运行：python3 scripts/test_hook_run.py"""
import json, os, subprocess, sys, tempfile, unittest

RUN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hook-run.py")
EVENT = json.dumps({"tool_name": "Bash", "cwd": "/项目", "tool_input": {"command": "x"}})


class HookRun(unittest.TestCase):
    def go(self, body, payload=EVENT):
        with tempfile.TemporaryDirectory() as t:
            script = os.path.join(t, "h.py")
            open(script, "w").write(body)
            log = os.path.join(t, "hooks.log")
            p = subprocess.run([sys.executable, RUN, "测试钩子", sys.executable, script], input=payload,
                               capture_output=True, text=True, env=dict(os.environ, HOOK_LOG=log))
            return p.returncode, p.stdout, (open(log, encoding="utf-8").read() if os.path.exists(log) else "")

    def test_pass_is_silent(self):
        self.assertEqual(self.go("import sys; sys.stdin.read()"), (0, "", ""))

    def test_deny_is_forwarded_and_logged(self):
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "不行"}}
        code, stdout, log = self.go(f"import json; print(json.dumps({out!r}))")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), out)
        self.assertIn("测试钩子\t拦截\tBash\t不行\t/项目", log)

    def test_block_and_exit2(self):
        self.assertIn("拦截", self.go('print(\'{"decision": "block", "reason": "改"}\')')[2])
        code, _, log = self.go("import sys; sys.stderr.write('不准'); sys.exit(2)")
        self.assertEqual(code, 2)
        self.assertIn("拦截\tBash\t不准", log)

    def test_crash_is_logged_and_passes(self):
        code, stdout, log = self.go("raise RuntimeError('坏了')")
        self.assertEqual((code, stdout), (0, ""))
        self.assertIn("出错\tBash\tRuntimeError: 坏了", log)

    def test_disabled_by_plugin_option(self):
        with tempfile.TemporaryDirectory() as t:
            script = os.path.join(t, "h.py")
            open(script, "w").write('print(\'{"decision": "block", "reason": "x"}\')')
            env = dict(os.environ, HOOK_LOG=os.path.join(t, "l"), CLAUDE_PLUGIN_OPTION_DEMO_HOOK="false")
            p = subprocess.run([sys.executable, RUN, "demo-hook", sys.executable, script], input=EVENT,
                               capture_output=True, text=True, env=env)
            self.assertEqual((p.returncode, p.stdout), (0, ""))
            env["CLAUDE_PLUGIN_OPTION_DEMO_HOOK"] = "true"
            p = subprocess.run([sys.executable, RUN, "demo-hook", sys.executable, script], input=EVENT,
                               capture_output=True, text=True, env=env)
            self.assertIn("block", p.stdout)

    def test_bad_input(self):
        self.assertEqual(self.go("import sys; sys.stdin.read()", payload="不是 json")[0], 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
