"""Route handlers for the Redmine Board page.

Every Redmine call is blocking, so it runs through ``asyncio.to_thread``.
GETs need an authenticated subject; POSTs are owner-gated via
``ctx.require_owner`` (fail closed when the host lacks it) and refuse app
tokens. The API key is never part of a response.
"""

import asyncio
import json
import logging

from aiohttp import web

from ..rb_core import issues, query as qmod, settings
from ..rb_core.client import RedmineClient, from_settings
from ..rb_core.util import ToolError, int_arg, str_arg

MAX_BODY_BYTES = 256 * 1024

_STATUS_BY_CODE = {
    "bad_request": 400,
    "unauthorized": 401,
    "owner_only": 403,
    "app_token_forbidden": 403,
    "not_found": 404,
    "not_configured": 409,
    "transition_not_allowed": 409,
    "transition_not_applied": 409,
    "redmine_invalid": 422,
    "redmine_unauthorized": 502,
    "redmine_forbidden": 502,
    "redmine_unreachable": 502,
    "redmine_redirect": 502,
    "redmine_error": 502,
}


def _json(obj, status=200):
    return web.json_response(
        obj, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False, default=str)
    )


def _tool_error(err):
    code = getattr(err, "code", "bad_request")
    return _json({"error": str(err), "code": code}, status=_STATUS_BY_CODE.get(code, 400))


def _internal(err, ctx):
    logger = getattr(ctx, "logger", None) or logging.getLogger("redmine-board")
    logger.error("redmine-board handler failed: %s", type(err).__name__, exc_info=True)
    return _json({"error": "internal error", "code": "internal"}, status=500)


def _unauthenticated(request):
    if not str(request.get("user") or ""):
        return _json({"error": "authentication required", "code": "unauthorized"}, status=401)
    return None


async def _body(request):
    length = request.content_length
    if length is not None and int(length) > MAX_BODY_BYTES:
        raise ToolError(f"request body exceeds {MAX_BODY_BYTES} bytes")
    try:
        data = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ToolError("request body must be JSON")
    if not isinstance(data, dict):
        raise ToolError("request body must be a JSON object")
    return data


async def _guard(request, ctx, op):
    if request.get("app"):
        return _json(
            {"error": "app tokens cannot perform this operation", "code": "app_token_forbidden"},
            status=403,
        )
    gate = getattr(ctx, "require_owner", None)
    if gate is None:
        return _json({"error": "owner permission required", "code": "owner_only"}, status=403)
    return await gate(request, op)


def _reader(fn):
    """GET wrapper: authenticate, run ``fn(query)`` off the loop, map errors."""

    async def handler(request, ctx):
        denied = _unauthenticated(request)
        if denied is not None:
            return denied
        try:
            return _json(await asyncio.to_thread(fn, dict(request.query)))
        except ToolError as e:
            return _tool_error(e)
        except Exception as e:
            return _internal(e, ctx)

    handler.__kirocrew_authenticated__ = True
    handler.__kirocrew_owner_only__ = False
    return handler


def _writer(op):
    def wrap(fn):
        async def handler(request, ctx):
            denied = await _guard(request, ctx, op)
            if denied is not None:
                return denied
            try:
                body = await _body(request)
                return _json(await asyncio.to_thread(fn, body))
            except ToolError as e:
                return _tool_error(e)
            except Exception as e:
                return _internal(e, ctx)

        handler.__kirocrew_authenticated__ = True
        handler.__kirocrew_owner_only__ = True
        return handler

    return wrap


# ---------------------------------------------------------------------------
# health / settings
# ---------------------------------------------------------------------------

async def health(request, ctx):
    denied = _unauthenticated(request)
    if denied is not None:
        return denied
    v = await asyncio.to_thread(settings.view)
    return _json({
        "ok": True,
        "name": "redmine-board",
        "configured": bool(v["baseUrl"] and v["apiKeySet"]),
        "sdkLevel": getattr(ctx, "sdk_level", None),
    })


health.__kirocrew_authenticated__ = True
health.__kirocrew_owner_only__ = False


@_reader
def get_settings(query):
    return settings.view()


def _optional_str(body, name):
    v = body.get(name)
    if v is not None and not isinstance(v, str):
        raise ToolError(f"{name} must be a string")
    return v


@_writer("redmine-board.settings")
def save_settings(body):
    return settings.save(
        base_url=_optional_str(body, "baseUrl"),
        api_key=_optional_str(body, "apiKey"),
        kanban_status_ids=body.get("kanbanStatusIds"),
    )


def _probe(client):
    user = issues.current_user(client)
    any_searchable = issues.supports_any_searchable(client, force=True)
    return {"ok": True, "user": user, "capabilities": {"anySearchable": any_searchable}}


@_writer("redmine-board.settings.test")
def test_connection(body):
    """Test the saved settings, or an unsaved URL/key pair from the form."""
    base = _optional_str(body, "baseUrl")
    key = _optional_str(body, "apiKey")
    if base or key:
        saved_base, saved_key = "", ""
        try:
            saved_base, saved_key = settings.load_credentials()
        except ToolError:
            pass
        norm = settings.normalize_base_url(base or saved_base)
        # reuse the saved key only for the same server it was saved for
        use_key = key or (saved_key if norm == saved_base else "")
        if not use_key:
            raise ToolError("apiKey is required", code="not_configured")
        return _probe(RedmineClient(norm, use_key))
    return _probe(from_settings())


# ---------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------

@_reader
def meta(query):
    c = from_settings()
    return {
        "baseUrl": c.base_url,
        "user": issues.current_user(c),
        "projects": issues.list_projects(c),
        "myProjectIds": issues.my_project_ids(c),
        "statuses": issues.list_statuses(c),
        "trackers": issues.list_trackers(c),
        "priorities": issues.list_priorities(c),
        "queries": issues.list_queries(c),
        "fields": [
            {"key": k, "aliases": list(v[2]), "kind": v[1]}
            for k, v in sorted(qmod.FIELDS.items())
        ],
    }


@_reader
def members(query):
    # no project: members of the projects the current user belongs to
    return {"members": issues.members_for(from_settings(), query.get("project") or "")}


@_reader
def options(query):
    """Project-scoped metadata: members, versions, categories, custom fields."""
    c = from_settings()
    proj = query.get("project") or ""
    return {
        "members": issues.list_members(c, proj),
        "versions": issues.list_versions(c, proj),
        "categories": issues.list_categories(c, proj),
        "customFields": issues.list_custom_fields(c, proj),
    }


@_reader
def search_issues(query):
    q = query.get("query")
    if q is None:
        return issues.search(from_settings(), query)  # legacy callers
    return issues.search_expr(
        from_settings(), q,
        sort=query.get("sort") or "updated_on:desc",
        offset=int_arg(query, "offset", default=0, lo=0),
        limit=int_arg(query, "limit", default=25, lo=1, hi=100),
    )


@_reader
def board(query):
    q = query.get("query")
    if q is None:
        return issues.board(from_settings(), query)  # legacy callers
    status_id = query.get("statusId")
    return issues.board_expr(
        from_settings(), q,
        per_column=int_arg(query, "perColumn", default=30, lo=1, hi=100),
        status_id=int(status_id) if status_id else None,
        sort=query.get("sort") or "updated_on:desc",
    )


@_reader
def get_issue(query):
    return issues.get_issue(from_settings(), int_arg(query, "id", required=True, lo=1))


@_reader
def list_views(query):
    return {"views": settings.list_views()}


# ---------------------------------------------------------------------------
# writes (Should: kanban drag & drop)
# ---------------------------------------------------------------------------

@_writer("redmine-board.issue.status")
def update_status(body):
    return issues.update_status(
        from_settings(),
        int_arg(body, "id", required=True, lo=1),
        int_arg(body, "statusId", required=True, lo=1),
    )


@_writer("redmine-board.issue.comment")
def add_comment(body):
    return issues.add_comment(
        from_settings(),
        int_arg(body, "id", required=True, lo=1),
        str_arg(body, "body", required=True),
    )


@_writer("redmine-board.views")
def save_view(body):
    name = str_arg(body, "name", required=True)
    view = body.get("view")
    if not isinstance(view, dict):
        raise ToolError("view must be an object")
    return settings.save_view(name, view)


@_writer("redmine-board.views.delete")
def delete_view(body):
    return settings.delete_view(str_arg(body, "name", required=True))
