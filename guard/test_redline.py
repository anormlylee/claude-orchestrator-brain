#!/usr/bin/env python3
"""redline.py 的用例。运行：python3 guard/test_redline.py"""
import json, os, subprocess, sys, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redline.py")


class Redline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reg = os.path.join(self.tmp.name, "redlines.json")
        self.log = os.path.join(self.tmp.name, "hooks.log")
        with open(self.reg, "w") as f:
            json.dump({"production": [{"name": "记账生产", "match": ["acct-prod", "10.9.9.9"]}]}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, cmd, desc="", reg=True, raw=None):
        env = dict(os.environ, HOOK_LOG=self.log, REDLINES_FILE=self.reg if reg else "/不存在.json")
        payload = raw if raw is not None else json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd, "description": desc}})
        p = subprocess.run([sys.executable, SCRIPT], input=payload, capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 0)
        return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecisionReason"] if p.stdout else None

    def logged(self):
        return open(self.log, encoding="utf-8").read() if os.path.exists(self.log) else ""

    def test_force_push_main(self):
        for c in ("git push -f origin main", "git push --force origin master", "git push origin +main",
                  "cd x && git push --force-with-lease origin main"):
            self.assertIn("强制推送", self.run_hook(c) or "", c)
        for c in ("git push origin main", "git push -f origin feat/x", "git push --force origin fix-mainline"):
            self.assertIsNone(self.run_hook(c), c)
        self.assertIn("强制推送", self.run_hook("git push -f origin main", reg=False))
        self.assertIn("强制推送", self.run_hook("git push -f origin main", desc="lee 已在对话中同意：强推"))

    def test_prod_reads_pass(self):
        for c in ('ssh acct-prod "docker ps"', 'ssh acct-prod "docker logs api --tail 50" > out.txt',
                  "scp acct-prod:~/app/log.txt ./", 'psql -h 10.9.9.9 -c "SELECT count(*) FROM t"',
                  "curl -s http://10.9.9.9:8080/health", "ping acct-prod 2>/dev/null"):
            self.assertIsNone(self.run_hook(c), c)

    def test_prod_writes_blocked(self):
        for c in ("scp build.tar acct-prod:~/deploy/", "sshpass -p x scp a.go acct-prod:~/src/a.go",
                  'sshpass -p x ssh acct-prod "cd deploy && docker compose up -d --build"',
                  'ssh acct-prod "sudo systemctl restart nginx"', 'ssh acct-prod "rm -rf /tmp/x"',
                  'ssh acct-prod "echo 1 > /etc/flag"', 'psql -h 10.9.9.9 -c "DELETE FROM orders"',
                  "curl -X POST http://10.9.9.9/api/reset", "rsync -av dist/ acct-prod:/srv/www/"):
            self.assertIn("生产环境「记账生产」", self.run_hook(c) or "", c)
        self.assertIn("拦截", self.logged())

    def test_approval_passes_and_is_logged(self):
        self.assertIsNone(self.run_hook("scp a acct-prod:~/a", desc="lee 已在对话中同意：上传配置"))
        self.assertIn("放行（已同意）", self.logged())

    def test_other_hosts_and_no_registry(self):
        self.assertIsNone(self.run_hook('ssh test-box "docker compose down"'))
        self.assertIsNone(self.run_hook("scp a acct-prod:~/a", reg=False))

    def test_bad_input(self):
        self.assertIsNone(self.run_hook("", raw="不是 json"))
        self.assertIsNone(self.run_hook("", raw=""))


if __name__ == "__main__":
    unittest.main(verbosity=1)
