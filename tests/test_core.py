"""rb_core tests against the in-process fake Redmine. Run: python3 -m unittest discover -s tests"""

import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake_redmine import API_KEY, FakeRedmine  # noqa: E402
from rb_core import issues, query as qmod, settings  # noqa: E402
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


STAGE_STATUSES = [
    {"id": 1, "name": "New", "isClosed": False},
    {"id": 2, "name": "In Progress", "isClosed": False},
    {"id": 3, "name": "Review", "isClosed": False},
    {"id": 5, "name": "Closed", "isClosed": True},
]


class StageMappingTests(unittest.TestCase):
    """Statuses grouped into a few fixed stages (no Redmine needed)."""

    def ids(self, stages):
        return [s["statusIds"] for s in stages]

    def test_default_stages(self):
        st = issues.stage_columns(STAGE_STATUSES, {})
        self.assertEqual([s["key"] for s in st], ["todo", "doing", "review", "done"])
        self.assertEqual(self.ids(st), [[1], [2, 3], [], [5]])

    def test_mapping_moves_a_status(self):
        self.assertEqual(self.ids(issues.stage_columns(STAGE_STATUSES, {"3": "review"})), [[1], [2], [3], [5]])

    def test_explicit_todo_turns_first_open_into_doing(self):
        self.assertEqual(self.ids(issues.stage_columns(STAGE_STATUSES, {"2": "todo"})), [[2], [1, 3], [], [5]])

    def test_unknown_status_ids_in_mapping_are_ignored(self):
        self.assertEqual(self.ids(issues.stage_columns(STAGE_STATUSES, {"99": "review"})), [[1], [2, 3], [], [5]])


class StageSettingsTests(CoreCase):
    def test_round_trip(self):
        v = settings.save(kanban_stages={"3": "review", "1": "todo"})
        self.assertEqual(v["kanbanStages"], {"3": "review", "1": "todo"})
        self.assertEqual(settings.view()["kanbanStages"], {"3": "review", "1": "todo"})

    def test_rejects_bad_stage_or_status(self):
        with self.assertRaises(ToolError):
            settings.save(kanban_stages={"3": "later"})
        with self.assertRaises(ToolError):
            settings.save(kanban_stages={"x": "todo"})
        with self.assertRaises(ToolError):
            settings.save(kanban_stages=["todo"])


class BoardAxisTests(CoreCase):
    def expected(self, pred):
        return [i for i in self.fake.issues.values() if pred(i)]

    def board_requests(self):
        return [r for r in self.fake.requests if r[1] == "/issues.json"]

    def test_stage_axis_columns_and_totals(self):
        b = issues.board_expr(self.client, "", axis="stage")
        self.assertEqual([c["key"] for c in b["columns"]], ["todo", "doing", "review", "done"])
        self.assertEqual([c["statusIds"] for c in b["columns"]], [[1], [2], [], [5]])
        self.assertEqual([c["total"] for c in b["columns"]], [10, 10, 0, 10])

    def test_stage_axis_respects_settings(self):
        settings.save(kanban_stages={"2": "review"})
        b = issues.board_expr(self.client, "", axis="stage")
        self.assertEqual([c["total"] for c in b["columns"]], [10, 0, 10, 10])

    def test_stage_axis_in_f_mode_keeps_status_inside_f(self):
        # "-assignee:me" needs f[]; the stage's statuses must go into f[] too,
        # because Redmine ignores direct params once f[] is present (V-15)
        b = issues.board_expr(self.client, "-assignee:me", axis="stage")
        unassigned = self.expected(lambda i: not i["assigned_to"])
        want = [len([i for i in unassigned if i["status"]["id"] == sid]) for sid in (1, 2)]
        self.assertEqual([c["total"] for c in b["columns"]][:2], want)
        for _m, _p, one, _h, _b in self.board_requests():
            self.assertFalse("f[]" in one and "status_id" in one, one)

    def test_status_axis_is_still_the_default(self):
        b = issues.board_expr(self.client, "")
        self.assertEqual([c["status"]["id"] for c in b["columns"]], [1, 2, 5])

    def test_assignee_axis_groups_me_first_and_unassigned_last(self):
        b = issues.board_expr(self.client, "status:*", axis="assignee")
        keys = [c["key"] for c in b["columns"]]
        self.assertEqual(keys[0], "user:7")
        self.assertEqual(keys[-1], "none")
        self.assertEqual(b["columns"][0]["assigneeId"], 7)
        self.assertIsNone(b["columns"][-1]["assigneeId"])
        self.assertEqual(b["columns"][0]["total"], 7)
        self.assertEqual(b["columns"][-1]["total"], 23)
        self.assertFalse(b["truncated"])

    def test_assignee_axis_caps_issues_per_column(self):
        b = issues.board_expr(self.client, "status:*", axis="assignee", per_column=5)
        none = b["columns"][-1]
        self.assertEqual(len(none["issues"]), 5)
        self.assertEqual(none["total"], 23)

    def test_rejects_unknown_axis(self):
        with self.assertRaises(ToolError):
            issues.board_expr(self.client, "", axis="priority")


class VersionTests(CoreCase):
    def test_list_versions_has_due_date(self):
        v = issues.list_versions(self.client, "alpha")
        self.assertEqual(v[0]["dueDate"], "2026-12-20")
        self.assertIsNone(v[1]["dueDate"])

    def test_progress_counts_all_and_closed(self):
        p = issues.version_progress(self.client, 1)
        evens = [i for i in self.fake.issues.values() if i["id"] % 2 == 0]
        self.assertEqual(p["total"], len(evens))
        self.assertEqual(p["closed"], len([i for i in evens if i["status"]["is_closed"]]))
        self.assertEqual((p["id"], p["name"], p["dueDate"], p["status"]), (1, "v1.0", "2026-12-20", "open"))

    def test_progress_unknown_version(self):
        with self.assertRaises(ToolError):
            issues.version_progress(self.client, 99)


class AssigneeUpdateTests(CoreCase):
    def test_assign(self):
        r = issues.update_assignee(self.client, 1, 8)
        self.assertTrue(r["ok"])
        self.assertEqual(r["issue"]["assignedTo"]["id"], 8)
        self.assertEqual(self.fake.issues[1]["assigned_to"]["id"], 8)

    def test_unassign(self):
        r = issues.update_assignee(self.client, 4, None)
        self.assertIsNone(r["issue"]["assignedTo"])
        self.assertIsNone(self.fake.issues[4]["assigned_to"])

    def test_accepted_but_not_applied_is_an_error(self):
        self.fake.locked_assignee.add(1)
        with self.assertRaises(ToolError) as cm:
            issues.update_assignee(self.client, 1, 8)
        self.assertEqual(cm.exception.code, "assignee_not_applied")

    def test_not_assignable_user(self):
        with self.assertRaises(ToolError) as cm:
            issues.update_assignee(self.client, 1, 99)
        self.assertEqual(cm.exception.code, "redmine_invalid")


class QueryParseTests(unittest.TestCase):
    """Parser unit tests: no Redmine needed."""

    def test_fields_and_keywords(self):
        p = qmod.parse('assignee:me status:"In Progress",New ログイン -CSV')
        self.assertEqual([(t.text, t.negated) for t in p.terms], [("ログイン", False), ("CSV", True)])
        fields = {f.field: (f.op, f.values) for f in p.filters}
        self.assertEqual(fields["assignee"], ("=", ["me"]))
        self.assertEqual(fields["status"], ("=", ["In Progress", "New"]))

    def test_negation_and_ja_aliases(self):
        p = qmod.parse("-状態:完了 担当:自分 更新:<7d")
        f = {f.field: f for f in p.filters}
        self.assertEqual(f["status"].op, "o")          # -closed => open
        self.assertEqual(f["assignee"].values, ["自分"])
        self.assertEqual(f["updated"].values, ["<7d"])

    def test_unknown_field_is_error_and_term(self):
        p = qmod.parse("statsu:open foo")
        self.assertTrue(any(e["code"] == "unknown_field" for e in p.errors))
        self.assertIn("foo", [t.text for t in p.terms])

    def test_special_values(self):
        p = qmod.parse("status:open 担当:なし 期日:overdue done:>=50")
        f = {f.field: f for f in p.filters}
        self.assertEqual(f["status"].op, "o")
        self.assertEqual(f["assignee"].op, "!*")
        self.assertEqual(f["due"].values, ["overdue"])

    def test_build_params_multi_value_uses_f(self):
        p = qmod.parse("status:New,Closed 更新:<7d")
        meta = qmod.Meta()
        meta.statuses = [{"id": 1, "name": "New"}, {"id": 5, "name": "Closed"}]
        plan = qmod.build_params(p, meta)
        self.assertFalse(plan.errors)
        self.assertEqual(plan.mode, "f")
        self.assertEqual(plan.params["v[status_id][]"], ["1", "5"])
        self.assertEqual(plan.dates, {"updated_on": ">t-7"})
        self.assertNotIn("updated_on", plan.params["f[]"])

    def test_build_params_direct_when_simple(self):
        p = qmod.parse("status:New 担当:me 更新:<7d")
        meta = qmod.Meta()
        meta.statuses = [{"id": 1, "name": "New"}]
        plan = qmod.build_params(p, meta)
        self.assertEqual(plan.mode, "direct")
        self.assertEqual(plan.params["status_id"], "1")
        self.assertEqual(plan.params["assigned_to_id"], "me")
        self.assertEqual(plan.params["updated_on"], ">t-7")

    def test_default_status(self):
        plan = qmod.build_params(qmod.parse(""), qmod.Meta())
        self.assertEqual(plan.mode, "direct")
        self.assertEqual(plan.params["status_id"], "o")

    def test_priority_ge_expands_by_position(self):
        meta = qmod.Meta()
        meta.priorities = [{"id": 1, "name": "Low"}, {"id": 2, "name": "Normal"}, {"id": 3, "name": "High"}]
        plan = qmod.build_params(qmod.parse("priority:>=Normal"), meta)
        self.assertFalse(plan.errors)
        self.assertEqual(plan.mode, "f")  # expansion yields multiple ids
        self.assertEqual(plan.params["v[priority_id][]"], ["2", "3"])
        plan = qmod.build_params(qmod.parse("priority:>=High"), meta)
        self.assertEqual(plan.mode, "direct")
        self.assertEqual(plan.params["priority_id"], "3")

    def test_unknown_value_is_error(self):
        p = qmod.parse("status:NoSuchStatus")
        meta = qmod.Meta()
        meta.statuses = [{"id": 1, "name": "New"}]
        plan = qmod.build_params(p, meta)
        self.assertTrue(any(e["code"] == "unknown_value" for e in plan.errors))


class ExprSearchTests(CoreCase):
    def test_expr_status_and_keyword(self):
        r = issues.search_expr(self.client, "status:New ログイン")
        self.assertTrue(r["issues"])
        self.assertTrue(all(i["status"]["name"] == "New" for i in r["issues"]))
        self.assertTrue(r["chips"])

    def test_expr_multi_term_intersection(self):
        # 'Issue' matches all, 'ログイン' matches i%5==0 -> intersection = ログイン hits
        r = issues.search_expr(self.client, "Issue ログイン status:*")
        self.assertTrue(r["issues"])
        self.assertTrue(all("ログイン" in i["subject"] for i in r["issues"]))

    def test_expr_negated_term(self):
        r = issues.search_expr(self.client, "-ログイン status:*")
        self.assertTrue(r["issues"])
        self.assertTrue(all("ログイン" not in i["subject"] for i in r["issues"]))

    def test_expr_assignee_me(self):
        r = issues.search_expr(self.client, "assignee:me status:*")
        self.assertTrue(r["issues"])
        self.assertTrue(all(i["assignedTo"] and i["assignedTo"]["id"] == 7 for i in r["issues"]))

    def test_expr_direct_id(self):
        r = issues.search_expr(self.client, "#3")
        self.assertEqual(r["direct"], 3)

    def test_board_expr_columns_follow_status_filter(self):
        b = issues.board_expr(self.client, "status:New")
        self.assertEqual([c["status"]["id"] for c in b["columns"]], [1])
        self.assertTrue(b["columns"][0]["issues"])

    def test_board_expr_default_columns(self):
        b = issues.board_expr(self.client, "")
        self.assertEqual(len(b["columns"]), 3)


class ViewsTests(CoreCase):
    def test_save_list_delete(self):
        settings.save_view("mine", {"expr": "assignee:me", "tab": "board"})
        views = settings.list_views()
        self.assertEqual(views[0]["name"], "mine")
        self.assertEqual(views[0]["expr"], "assignee:me")
        mode = stat.S_IMODE(os.stat(os.path.join(self.tmp.name, "views.json")).st_mode)
        self.assertEqual(mode, 0o600)
        settings.delete_view("mine")
        self.assertEqual(settings.list_views(), [])
        with self.assertRaises(ToolError):
            settings.delete_view("mine")


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

            def handle(h, method, path, q, body, fqs=None):
                if method == "PUT":
                    fake_redmine.WORKFLOW[1] = [1]
                return orig(h, method, path, q, body, fqs=fqs)

            self.fake.handle = handle
            with self.assertRaises(ToolError) as cm:
                issues.update_status(self.client, 3, 2)
            self.assertEqual(cm.exception.code, "transition_not_applied")
        finally:
            fake_redmine.WORKFLOW.clear()
            fake_redmine.WORKFLOW.update(saved)


if __name__ == "__main__":
    unittest.main()
