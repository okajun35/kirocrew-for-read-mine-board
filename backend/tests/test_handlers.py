"""Backend handler tests. Needs aiohttp (the gateway venv):

    <KiroCrew repo>/.venv/bin/python -m unittest discover -s backend/tests
"""

import importlib
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

from aiohttp import streams, web
from aiohttp.test_utils import make_mocked_request

TEST_DIR = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(os.path.dirname(TEST_DIR))
sys.path.insert(0, os.path.join(APP_ROOT, "tests"))

from fake_redmine import API_KEY, FakeRedmine  # noqa: E402

SYNTH_ROOT = "_kirocrew_app_redmine-board"


def load(dotted):
    if SYNTH_ROOT not in sys.modules:
        root = types.ModuleType(SYNTH_ROOT)
        root.__path__ = [APP_ROOT]
        sys.modules[SYNTH_ROOT] = root
    return importlib.import_module(f"{SYNTH_ROOT}.{dotted}")


handlers = load("backend.handlers")
routes_mod = load("backend.routes")
settings = load("rb_core.settings")


def get_req(path, user="owner", app=""):
    req = make_mocked_request("GET", path)
    req["user"] = user
    req["app"] = app
    return req


def post_req(path, body, user="owner", app=""):
    payload = streams.StreamReader(protocol=mock.Mock(), limit=2**16)
    payload.feed_data(json.dumps(body).encode("utf-8"))
    payload.feed_eof()
    req = make_mocked_request("POST", path, headers={"Content-Type": "application/json"}, payload=payload)
    req["user"] = user
    req["app"] = app
    return req


class FakeCtx:
    sdk_level = 1

    def __init__(self, owner_response=None):
        self.owner_response = owner_response
        self.owner_calls = []
        self.logger = logging.getLogger("redmine-board-test")

    async def require_owner(self, request, op):
        self.owner_calls.append(op)
        return self.owner_response


async def call(handler, request, ctx):
    resp = await handler(request, ctx)
    return resp, (json.loads(resp.text) if resp.text else None)


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ["REDMINE_BOARD_DATA_DIR"] = self.tmp.name
        self.addCleanup(lambda: os.environ.pop("REDMINE_BOARD_DATA_DIR", None))
        self.fake = FakeRedmine().__enter__()
        self.addCleanup(self.fake.__exit__)
        self.ctx = FakeCtx()

    def configure(self):
        settings.save(base_url=self.fake.base, api_key=API_KEY)


class RouteTests(Base):
    def test_routes(self):
        routes = routes_mod.register_routes(self.ctx)
        self.assertEqual(len(routes), 10)
        for r in routes:
            self.assertTrue(r.path.startswith("/"))
            self.assertNotIn("{", r.path)

    def test_low_sdk_marks_degraded(self):
        msgs = []
        ctx = FakeCtx()
        ctx.sdk_level = 0
        ctx.health = types.SimpleNamespace(mark_degraded=msgs.append)
        routes_mod.register_routes(ctx)
        self.assertTrue(msgs)


class SettingsTests(Base):
    async def test_save_then_get_hides_key(self):
        resp, body = await call(handlers.save_settings, post_req("/settings", {"baseUrl": self.fake.base, "apiKey": API_KEY}), self.ctx)
        self.assertEqual(resp.status, 200)
        self.assertTrue(body["apiKeySet"])
        self.assertNotIn(API_KEY, resp.text)
        resp, body = await call(handlers.get_settings, get_req("/settings"), self.ctx)
        self.assertNotIn(API_KEY, resp.text)
        self.assertEqual(self.ctx.owner_calls, ["redmine-board.settings"])

    async def test_writes_refuse_app_token_and_non_owner(self):
        resp, body = await call(handlers.save_settings, post_req("/settings", {"baseUrl": "http://x"}, app="other"), self.ctx)
        self.assertEqual((resp.status, body["code"]), (403, "app_token_forbidden"))
        denied = FakeCtx(owner_response=web.json_response({"code": "owner_only"}, status=403))
        resp, _ = await call(handlers.save_settings, post_req("/settings", {"baseUrl": "http://x"}), denied)
        self.assertEqual(resp.status, 403)

    async def test_fail_closed_without_require_owner(self):
        ctx = types.SimpleNamespace(logger=logging.getLogger("t"))
        resp, body = await call(handlers.save_settings, post_req("/settings", {"baseUrl": "http://x"}), ctx)
        self.assertEqual((resp.status, body["code"]), (403, "owner_only"))

    async def test_reads_need_a_user(self):
        resp, _ = await call(handlers.get_settings, get_req("/settings", user=""), self.ctx)
        self.assertEqual(resp.status, 401)

    async def test_connection_test_with_unsaved_form(self):
        resp, body = await call(handlers.test_connection, post_req("/settings/test", {"baseUrl": self.fake.base, "apiKey": API_KEY}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(body["user"]["login"], "me")
        self.assertNotIn(API_KEY, resp.text)
        resp, body = await call(handlers.test_connection, post_req("/settings/test", {"baseUrl": self.fake.base, "apiKey": "bad"}), self.ctx)
        self.assertEqual(body["code"], "redmine_unauthorized")

    async def test_saved_key_not_sent_to_other_host(self):
        self.configure()
        resp, body = await call(handlers.test_connection, post_req("/settings/test", {"baseUrl": "http://127.0.0.2:1"}), self.ctx)
        self.assertEqual(body["code"], "not_configured")


class ReadTests(Base):
    async def test_not_configured(self):
        resp, body = await call(handlers.meta, get_req("/meta"), self.ctx)
        self.assertEqual((resp.status, body["code"]), (409, "not_configured"))

    async def test_meta_search_board_issue(self):
        self.configure()
        resp, body = await call(handlers.meta, get_req("/meta"), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(len(body["statuses"]), 3)
        self.assertNotIn(API_KEY, resp.text)
        resp, body = await call(handlers.search_issues, get_req("/issues?status=*&limit=5"), self.ctx)
        self.assertEqual((body["total"], len(body["issues"])), (30, 5))
        resp, body = await call(handlers.board, get_req("/board?project=alpha"), self.ctx)
        self.assertEqual(len(body["columns"]), 3)
        resp, body = await call(handlers.get_issue, get_req("/issue?id=3"), self.ctx)
        self.assertEqual(body["id"], 3)
        resp, body = await call(handlers.get_issue, get_req("/issue?id=999"), self.ctx)
        self.assertEqual(resp.status, 404)
        resp, body = await call(handlers.members, get_req("/members?project=alpha"), self.ctx)
        self.assertEqual(len(body["members"]), 2)

    async def test_bad_filter_is_400(self):
        self.configure()
        resp, _ = await call(handlers.search_issues, get_req("/issues?sort=x"), self.ctx)
        self.assertEqual(resp.status, 400)


class StatusWriteTests(Base):
    async def test_status_update(self):
        self.configure()
        resp, body = await call(handlers.update_status, post_req("/issue/status", {"id": 3, "statusId": 2}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        resp, body = await call(handlers.update_status, post_req("/issue/status", {"id": 3, "statusId": 5}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)  # 2 -> 5 allowed
        resp, body = await call(handlers.update_status, post_req("/issue/status", {"id": 3, "statusId": 1}), self.ctx)
        self.assertEqual((resp.status, body["code"]), (409, "transition_not_allowed"))


class KanbanHandlerTests(Base):
    async def test_board_axis(self):
        self.configure()
        resp, body = await call(handlers.board, get_req("/board?query=&axis=stage"), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual([c["key"] for c in body["columns"]], ["todo", "doing", "review", "done"])
        resp, body = await call(handlers.board, get_req("/board?query=status:*&axis=assignee"), self.ctx)
        self.assertEqual(body["columns"][-1]["key"], "none")
        resp, body = await call(handlers.board, get_req("/board?query=&axis=nope"), self.ctx)
        self.assertEqual(resp.status, 400)

    async def test_version_progress(self):
        self.configure()
        resp, body = await call(handlers.version, get_req("/version?id=1"), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual((body["name"], body["total"]), ("v1.0", 15))
        resp, body = await call(handlers.version, get_req("/version"), self.ctx)
        self.assertEqual(resp.status, 400)

    async def test_assignee_update_and_clear(self):
        self.configure()
        resp, body = await call(handlers.update_assignee, post_req("/issue/assignee", {"id": 1, "assigneeId": 8}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(body["issue"]["assignedTo"]["id"], 8)
        resp, body = await call(handlers.update_assignee, post_req("/issue/assignee", {"id": 1, "assigneeId": None}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertIsNone(body["issue"]["assignedTo"])

    async def test_assignee_update_refuses_app_tokens(self):
        self.configure()
        resp, body = await call(
            handlers.update_assignee, post_req("/issue/assignee", {"id": 1, "assigneeId": 8}, app="other"), self.ctx)
        self.assertEqual((resp.status, body["code"]), (403, "app_token_forbidden"))

    async def test_settings_save_stages(self):
        resp, body = await call(handlers.save_settings, post_req("/settings", {"kanbanStages": {"2": "review"}}), self.ctx)
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(body["kanbanStages"], {"2": "review"})


if __name__ == "__main__":
    unittest.main()
