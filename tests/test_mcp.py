"""MCP server tests: a real stdio subprocess with no third-party packages."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TESTS)
sys.path.insert(0, TESTS)
sys.path.insert(0, ROOT)

from fake_redmine import API_KEY, FakeRedmine  # noqa: E402

SERVER = os.path.join(ROOT, "mcp", "server.py")


class McpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeRedmine().__enter__()
        os.environ["REDMINE_BOARD_DATA_DIR"] = self.tmp.name
        from rb_core import settings

        settings.save(base_url=self.fake.base, api_key=API_KEY)
        # -S -I: no site-packages, isolated mode: proves stdlib-only imports
        self.proc = subprocess.Popen(
            [sys.executable, "-S", "-I", SERVER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", env={"REDMINE_BOARD_DATA_DIR": self.tmp.name, "PATH": os.environ.get("PATH", "")},
        )
        self.next_id = 0

    def tearDown(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)
        self.proc.stdout.close()
        self.proc.stderr.close()
        self.fake.__exit__()
        self.tmp.cleanup()
        os.environ.pop("REDMINE_BOARD_DATA_DIR", None)

    def rpc(self, method, params=None):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def tool(self, name, args=None):
        res = self.rpc("tools/call", {"name": name, "arguments": args or {}})["result"]
        text = res["content"][0]["text"]
        return res.get("isError", False), (text if res.get("isError") else json.loads(text))

    def test_initialize_and_list(self):
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18"})
        self.assertEqual(init["result"]["serverInfo"]["name"], "redmine-board")
        names = [t["name"] for t in self.rpc("tools/list")["result"]["tools"]]
        self.assertEqual(names, ["redmine_search", "redmine_get_issue", "redmine_list_statuses",
                                 "redmine_list_projects", "redmine_add_comment", "redmine_update_status"])

    def test_search_wraps_untrusted_and_hides_key(self):
        err, out = self.tool("redmine_search", {"status": "*", "limit": 5})
        self.assertFalse(err)
        self.assertEqual(out["total"], 30)
        self.assertIn("untrusted_content", out["issues"][0])
        self.assertNotIn("subject", out["issues"][0])
        self.assertIn("notice", out)

    def test_get_issue_puts_injection_text_under_untrusted(self):
        err, out = self.tool("redmine_get_issue", {"id": 3})
        self.assertFalse(err)
        self.assertIn("Ignore previous", out["untrusted_content"]["description"])
        self.assertNotIn("description", out)
        self.assertNotIn(API_KEY, json.dumps(out))

    def test_comment_and_status(self):
        err, out = self.tool("redmine_add_comment", {"id": 3, "notes": "from agent"})
        self.assertFalse(err, out)
        err, out = self.tool("redmine_update_status", {"id": 3, "statusId": 5})
        self.assertTrue(err)
        self.assertIn("not allowed", out)

    def test_errors_are_tool_errors(self):
        err, out = self.tool("redmine_get_issue", {})
        self.assertTrue(err)
        err, out = self.tool("nope")
        self.assertTrue(err)
        self.assertEqual(self.rpc("bogus")["error"]["code"], -32601)

    def test_not_configured(self):
        os.remove(os.path.join(self.tmp.name, "settings.json"))
        err, out = self.tool("redmine_list_statuses")
        self.assertTrue(err)
        self.assertIn("not configured", out)


if __name__ == "__main__":
    unittest.main()
