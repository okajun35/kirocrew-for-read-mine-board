"""rb_core tests against the in-process fake Redmine. Run: python3 -m unittest discover -s tests"""

import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake_redmine import API_KEY, FakeRedmine  # noqa: E402
from rb_core import issues, settings  # noqa: E402
from rb_core.client import RedmineClient, check_path  # noqa: E402
from rb_core.util import ToolError  # noqa: E402


class CoreCase(unittest.TestCase):
    any_searchable = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["REDMINE_BOARD_DATA_DIR"] = self.tmp.name
        self.fake = FakeRedmine(any_searchable=self.any_searchable).__enter__()
        self.client = RedmineClient(self.fake.base, API_KEY)

    def tearDown(self):
        self.fake.__exit__()
        self.tmp.cleanup()
        os.environ.pop("REDMINE_BOARD_DATA_DIR", None)


class SettingsTests(CoreCase):
    def test_key_never_in_view_and_file_is_0600(self):
        v = settings.save(base_url=self.fake.base + "/", api_key=API_KEY)
        self.assertEqual(v["baseUrl"], self.fake.base)
        self.assertTrue(v["apiKeySet"])
        self.assertNotIn(API_KEY, repr(v))
        mode = stat.S_IMODE(os.stat(os.path.join(self.tmp.name, "settings.json")).st_mode)
        self.assertEqual(mode, 0o600)

    def test_changing_host_drops_key(self):
        settings.save(base_url=self.fake.base, api_key=API_KEY)
        v = settings.save(base_url="https://other.example.com")
        self.assertFalse(v["apiKeySet"])

    def test_rejects_bad_urls(self):
        for bad in ("ftp://x", "http://u:p@x", "http://x/?a=1", "notaurl", ""):
            with self.assertRaises(ToolError):
                settings.normalize_base_url(bad)

    def test_unconfigured(self):
        with self.assertRaises(ToolError) as cm:
            settings.load_credentials()
        self.assertEqual(cm.exception.code, "not_configured")


class ClientTests(CoreCase):
    def test_path_guard(self):
        for bad in ("http://evil/x.json", "//evil/x.json", "/a/../b.json", "/a b.json", "/x", "/a?b=1.json", "@evil.json"):
            with self.assertRaises(ToolError):
                check_path(bad)
        check_path("/projects/demo-alpha/search.json")

    def test_key_sent_as_header_not_query(self):
        self.client.get("/issue_statuses.json")
        method, path, q, headers, _ = self.fake.requests[-1]
        self.assertEqual({k.lower(): v for k, v in headers.items()}.get("x-redmine-api-key"), API_KEY)
        self.assertNotIn("key", q)

    def test_bad_key_is_401_and_scrubbed(self):
        c = RedmineClient(self.fake.base, "wrong")
        with self.assertRaises(ToolError) as cm:
            c.get("/issues.json")
        self.assertEqual(cm.exception.code, "redmine_unauthorized")

    def test_redirect_not_followed(self):
        with self.assertRaises(ToolError) as cm:
            self.client.get("/redirect.json")
        self.assertEqual(cm.exception.code, "redmine_redirect")
        self.assertEqual(len(self.fake.requests), 1)

    def test_current_user_strips_api_key(self):
        u = issues.current_user(self.client)
        self.assertNotIn(API_KEY, repr(u))
        self.assertEqual(u["login"], "me")


class SearchTests(CoreCase):
    def test_default_is_open_only_and_star_is_all(self):
        open_ = issues.search(self.client, {})
        all_ = issues.search(self.client, {"status": "*"})
        self.assertEqual(all_["total"], 30)
        self.assertLess(open_["total"], 30)

    def test_keyword_uses_any_searchable_and_hits_comments(self):
        r = issues.search(self.client, {"q": "keyword-in-note", "status": "*"})
        self.assertEqual([i["id"] for i in r["issues"]], [7])
        sent = [q for (_, p, q, _, _) in self.fake.requests if p == "/issues.json"]
        self.assertTrue(any("any_searchable" in q for q in sent))

    def test_keyword_combined_with_filters(self):
        r = issues.search(self.client, {"q": "ログイン", "status": "*", "project": "alpha"})
        self.assertTrue(r["issues"])
        self.assertTrue(all(i["project"]["id"] == 1 for i in r["issues"]))

    def test_direct_id(self):
        r = issues.search(self.client, {"q": "#12"})
        self.assertEqual(r["direct"], 12)
        self.assertEqual(r["issues"][0]["id"], 12)
        r = issues.search(self.client, {"q": "9999"})
        self.assertEqual(r["total"], 0)

    def test_limit_validation(self):
        with self.assertRaises(ToolError):
            issues.search(self.client, {"limit": 101})
        with self.assertRaises(ToolError):
            issues.search(self.client, {"sort": "evil:desc"})
        with self.assertRaises(ToolError):
            issues.search(self.client, {"project": "../x"})

    def test_board_columns(self):
        b = issues.board(self.client, {"perColumn": 2})
        self.assertEqual([c["status"]["id"] for c in b["columns"]], [1, 2, 5])
        self.assertEqual(sum(c["total"] for c in b["columns"]), 30)
        self.assertTrue(all(len(c["issues"]) <= 2 for c in b["columns"]))

    def test_board_respects_kanban_setting(self):
        settings.save(kanban_status_ids=[5, 1])
        b = issues.board(self.client, {})
        self.assertEqual([c["status"]["id"] for c in b["columns"]], [5, 1])


class FallbackSearchTests(CoreCase):
    any_searchable = False

    def test_probe_detects_missing_filter_and_falls_back(self):
        self.assertFalse(issues.supports_any_searchable(self.client, force=True))
        r = issues.search(self.client, {"q": "keyword-in-note", "status": "*"})
        self.assertEqual([i["id"] for i in r["issues"]], [7])
        paths = [p for (_, p, _, _, _) in self.fake.requests]
        self.assertIn("/search.json", paths)

    def test_fallback_no_hits(self):
        r = issues.search(self.client, {"q": "nothing-matches-this"})
        self.assertEqual(r["total"], 0)


class WriteTests(CoreCase):
    def test_detail_and_allowed_statuses(self):
        d = issues.get_issue(self.client, 3)
        self.assertEqual(d["status"]["id"], 1)
        self.assertEqual([s["id"] for s in d["allowedStatuses"]], [1, 2])
        self.assertTrue(d["journals"])

    def test_add_comment(self):
        r = issues.add_comment(self.client, 3, "hello")
        self.assertTrue(r["ok"])
        self.assertEqual(self.fake.issues[3]["journals"][-1]["notes"], "hello")
        with self.assertRaises(ToolError):
            issues.add_comment(self.client, 3, "  ")

    def test_disallowed_transition_refused_before_put(self):
        with self.assertRaises(ToolError) as cm:
            issues.update_status(self.client, 3, 5)
        self.assertEqual(cm.exception.code, "transition_not_allowed")
        self.assertFalse(any(m == "PUT" for (m, *_rest) in self.fake.requests))

    def test_allowed_transition(self):
        r = issues.update_status(self.client, 3, 2)
        self.assertEqual(r["issue"]["status"]["id"], 2)

    def test_silently_ignored_transition_detected(self):
        # simulate a server whose allowed_statuses lies: workflow refuses at PUT
        import fake_redmine

        saved = dict(fake_redmine.WORKFLOW)
        try:
            orig = self.fake.handle

            def handle(h, method, path, q, body):
                if method == "PUT":
                    fake_redmine.WORKFLOW[1] = [1]
                return orig(h, method, path, q, body)

            self.fake.handle = handle
            with self.assertRaises(ToolError) as cm:
                issues.update_status(self.client, 3, 2)
            self.assertEqual(cm.exception.code, "transition_not_applied")
        finally:
            fake_redmine.WORKFLOW.clear()
            fake_redmine.WORKFLOW.update(saved)


if __name__ == "__main__":
    unittest.main()
