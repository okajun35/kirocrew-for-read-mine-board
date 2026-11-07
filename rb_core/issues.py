"""Issue search, kanban, detail and writes over the Redmine REST API.

Version differences are absorbed here (VERIFICATION.md V-01/V-02/V-06):

* keyword search uses ``issues.json?any_searchable=~`` when the server
  supports it; unknown filters are silently ignored by Redmine, so support
  is detected with a nonce probe and cached per base URL.
* otherwise ``search.json`` finds ids and ``issues.json?issue_id=`` re-applies
  the other filters (first ``SEARCH_FALLBACK_CAP`` hits only).
* ``issues.json`` lists only open issues by default; status is always sent.
* a disallowed status change returns 204 and changes nothing, so every status
  write is verified by re-reading the issue.
"""

import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

from . import settings
from .client import RedmineClient
from .util import ToolError, atomic_write_json, data_dir, int_arg, read_json, str_arg

MAX_LIMIT = 100
SEARCH_FALLBACK_CAP = 100
CAPS_TTL_SECS = 6 * 3600
SORT_KEYS = ("id", "subject", "status", "priority", "assigned_to", "updated_on", "created_on", "due_date", "tracker")
_IDENT = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
_DIRECT_ID = re.compile(r"^\s*#?(\d{1,9})\s*$")


# ---------------------------------------------------------------------------
# normalisation
# ---------------------------------------------------------------------------

def _ref(obj):
    if not isinstance(obj, dict):
        return None
    return {"id": obj.get("id"), "name": obj.get("name")}


def summary(client, it):
    status = it.get("status") or {}
    return {
        "id": it.get("id"),
        "subject": it.get("subject") or "",
        "project": _ref(it.get("project")),
        "tracker": _ref(it.get("tracker")),
        "status": {"id": status.get("id"), "name": status.get("name"), "isClosed": bool(status.get("is_closed"))},
        "priority": _ref(it.get("priority")),
        "assignedTo": _ref(it.get("assigned_to")),
        "author": _ref(it.get("author")),
        "parentId": (it.get("parent") or {}).get("id"),
        "doneRatio": it.get("done_ratio"),
        "dueDate": it.get("due_date"),
        "createdOn": it.get("created_on"),
        "updatedOn": it.get("updated_on"),
        "url": client.web_url("issues", it.get("id")),
    }


def detail(client, it):
    out = summary(client, it)
    out["description"] = it.get("description") or ""
    out["startDate"] = it.get("start_date")
    out["journals"] = [
        {
            "id": j.get("id"),
            "user": _ref(j.get("user")),
            "createdOn": j.get("created_on"),
            "notes": j.get("notes") or "",
            "private": bool(j.get("private_notes")),
            "details": [
                {
                    "property": d.get("property"),
                    "name": d.get("name"),
                    "oldValue": d.get("old_value"),
                    "newValue": d.get("new_value"),
                }
                for d in (j.get("details") or [])
            ],
        }
        for j in (it.get("journals") or [])
    ]
    out["attachments"] = [
        {
            "id": a.get("id"),
            "filename": a.get("filename"),
            "filesize": a.get("filesize"),
            "contentType": a.get("content_type"),
            "url": client.web_url("attachments", a.get("id")),
        }
        for a in (it.get("attachments") or [])
    ]
    out["relations"] = [
        {
            "id": r.get("id"),
            "type": r.get("relation_type"),
            "issueId": r.get("issue_id"),
            "issueToId": r.get("issue_to_id"),
        }
        for r in (it.get("relations") or [])
    ]
    out["children"] = [
        {"id": c.get("id"), "subject": c.get("subject"), "tracker": _ref(c.get("tracker"))}
        for c in (it.get("children") or [])
    ]
    allowed = it.get("allowed_statuses")
    out["allowedStatuses"] = (
        [{"id": s.get("id"), "name": s.get("name"), "isClosed": bool(s.get("is_closed"))} for s in allowed]
        if isinstance(allowed, list)
        else None
    )
    return out


# ---------------------------------------------------------------------------
# capability detection (V-01)
# ---------------------------------------------------------------------------

def _caps_path():
    return data_dir() / "capabilities.json"


def supports_any_searchable(client, force=False):
    caps = read_json(_caps_path(), default={})
    if not isinstance(caps, dict):
        caps = {}
    entry = caps.get(client.base_url)
    if not force and isinstance(entry, dict) and time.time() - entry.get("checkedAt", 0) < CAPS_TTL_SECS:
        return bool(entry.get("anySearchable"))
    nonce = "rbprobe" + secrets.token_hex(8)
    res = client.get("/issues.json", {"any_searchable": f"~{nonce}", "status_id": "*", "limit": 1})
    supported = int(res.get("total_count") or 0) == 0
    caps[client.base_url] = {"anySearchable": supported, "checkedAt": time.time()}
    try:
        atomic_write_json(_caps_path(), caps, mode=0o600)
    except OSError:
        pass
    return supported


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------

def parse_filters(args):
    """Validate UI/agent filters into Redmine ``issues.json`` parameters."""
    params = {}
    project = str_arg(args, "project")
    if project:
        if not _IDENT.match(project):
            raise ToolError("project must be a project id or identifier")
        params["project_id"] = project
    status = str_arg(args, "status", default="open")
    if status not in ("open", "closed", "*") and not status.isdigit():
        raise ToolError("status must be open, closed, * or a status id")
    params["status_id"] = status
    assignee = str_arg(args, "assignee")
    if assignee:
        if assignee == "none":
            params["assigned_to_id"] = "!*"
        elif assignee == "me" or assignee.isdigit():
            params["assigned_to_id"] = assignee
        else:
            raise ToolError("assignee must be me, none or a user id")
    tracker = str_arg(args, "tracker")
    if tracker:
        if not tracker.isdigit():
            raise ToolError("tracker must be a tracker id")
        params["tracker_id"] = tracker
    sort = str_arg(args, "sort", default="updated_on:desc")
    key, _, direction = sort.partition(":")
    if key not in SORT_KEYS or direction not in ("", "asc", "desc"):
        raise ToolError(f"sort must be one of {', '.join(SORT_KEYS)} with optional :asc/:desc")
    params["sort"] = f"{key}:{direction or 'asc'}"
    return params


def _keyword_ids(client, q, project):
    """Fallback keyword path: search.json ids (first SEARCH_FALLBACK_CAP)."""
    path = f"/projects/{project}/search.json" if project else "/search.json"
    res = client.get(path, {"q": q, "issues": 1, "titles_only": 0, "limit": SEARCH_FALLBACK_CAP})
    ids = [r.get("id") for r in res.get("results") or [] if r.get("type", "").startswith("issue")]
    return [i for i in ids if isinstance(i, int)], int(res.get("total_count") or 0)


def _apply_keyword(client, params, q):
    """Return (params, note) with the keyword folded in, or None when nothing can match."""
    if not q:
        return params, None
    if supports_any_searchable(client):
        return {**params, "any_searchable": f"~{q}"}, None
    ids, total = _keyword_ids(client, q, params.get("project_id"))
    if not ids:
        return None, None
    note = "partial" if total > len(ids) else None
    return {**params, "issue_id": ",".join(str(i) for i in ids)}, note


def direct_id(q):
    m = _DIRECT_ID.match(q or "")
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------

def search(client, args):
    params = parse_filters(args)
    q = (str_arg(args, "q") or "").strip()
    offset = int_arg(args, "offset", default=0, lo=0)
    limit = int_arg(args, "limit", default=25, lo=1, hi=MAX_LIMIT)
    did = direct_id(q)
    if did is not None:
        try:
            it = client.get(f"/issues/{did}.json").get("issue") or {}
            return {"issues": [summary(client, it)], "total": 1, "offset": 0, "limit": limit, "direct": did}
        except ToolError as e:
            if e.code != "not_found":
                raise
            return {"issues": [], "total": 0, "offset": 0, "limit": limit, "direct": did}
    params, note = _apply_keyword(client, params, q)
    if params is None:
        return {"issues": [], "total": 0, "offset": offset, "limit": limit}
    res = client.get("/issues.json", {**params, "offset": offset, "limit": limit})
    out = {
        "issues": [summary(client, it) for it in res.get("issues") or []],
        "total": int(res.get("total_count") or 0),
        "offset": offset,
        "limit": limit,
    }
    if note:
        out["note"] = note
    return out


def list_statuses(client):
    return [
        {"id": s.get("id"), "name": s.get("name"), "isClosed": bool(s.get("is_closed"))}
        for s in client.get("/issue_statuses.json").get("issue_statuses") or []
    ]


def list_projects(client, cap=500):
    out, offset = [], 0
    while offset < cap:
        res = client.get("/projects.json", {"offset": offset, "limit": MAX_LIMIT})
        batch = res.get("projects") or []
        out += [
            {
                "id": p.get("id"),
                "identifier": p.get("identifier"),
                "name": p.get("name"),
                "parentId": (p.get("parent") or {}).get("id"),
            }
            for p in batch
        ]
        offset += len(batch)
        if not batch or offset >= int(res.get("total_count") or 0):
            break
    return out


def list_trackers(client):
    return [_ref(t) for t in client.get("/trackers.json").get("trackers") or []]


def current_user(client):
    u = client.get("/users/current.json").get("user") or {}
    # never forward the api_key field Redmine includes here
    return {
        "id": u.get("id"),
        "login": u.get("login"),
        "name": " ".join(x for x in (u.get("firstname"), u.get("lastname")) if x),
        "admin": bool(u.get("admin")),
    }


def list_members(client, project):
    if not project or not _IDENT.match(project):
        raise ToolError("project must be a project id or identifier")
    try:
        res = client.get(f"/projects/{project}/memberships.json", {"limit": MAX_LIMIT})
    except ToolError as e:
        if e.code in ("redmine_forbidden", "not_found"):
            return []
        raise
    seen, out = set(), []
    for m in res.get("memberships") or []:
        who = m.get("user") or m.get("group")
        if isinstance(who, dict) and who.get("id") not in seen:
            seen.add(who.get("id"))
            out.append({"id": who.get("id"), "name": who.get("name"), "group": "group" in m})
    return sorted(out, key=lambda x: (x["group"], x["name"] or ""))


def board(client, args):
    """Kanban: one issues.json query per status column, run concurrently."""
    statuses = list_statuses(client)
    chosen = settings.view().get("kanbanStatusIds") or []
    by_id = {s["id"]: s for s in statuses}
    columns = [by_id[i] for i in chosen if i in by_id] or statuses
    per_column = int_arg(args, "perColumn", default=25, lo=1, hi=MAX_LIMIT)
    base = parse_filters({**args, "status": "*"})
    base.pop("status_id", None)
    q = (str_arg(args, "q") or "").strip()
    params, note = _apply_keyword(client, base, q)

    def fetch(col):
        if params is None:
            return {"status": col, "issues": [], "total": 0}
        res = client.get("/issues.json", {**params, "status_id": col["id"], "limit": per_column})
        return {
            "status": col,
            "issues": [summary(client, it) for it in res.get("issues") or []],
            "total": int(res.get("total_count") or 0),
        }

    with ThreadPoolExecutor(max_workers=min(6, max(1, len(columns)))) as pool:
        cols = list(pool.map(fetch, columns))
    out = {"columns": cols, "perColumn": per_column}
    if note:
        out["note"] = note
    return out


def get_issue(client, issue_id):
    res = client.get(
        f"/issues/{int(issue_id)}.json",
        {"include": "journals,attachments,relations,children,allowed_statuses"},
    )
    return detail(client, res.get("issue") or {})


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------

def add_comment(client, issue_id, notes):
    if not isinstance(notes, str) or not notes.strip():
        raise ToolError("notes must be a non-empty string")
    client.put(f"/issues/{int(issue_id)}.json", {"issue": {"notes": notes}})
    it = get_issue(client, issue_id)
    return {"ok": True, "issue": {"id": it["id"], "subject": it["subject"], "url": it["url"]},
            "journalCount": len(it["journals"])}


def update_status(client, issue_id, status_id, notes=None):
    issue_id, status_id = int(issue_id), int(status_id)
    before = get_issue(client, issue_id)
    allowed = before.get("allowedStatuses")
    if allowed is not None and status_id not in {s["id"] for s in allowed}:
        raise ToolError(
            "this status change is not allowed for you by the Redmine workflow",
            code="transition_not_allowed",
        )
    body = {"status_id": status_id}
    if notes:
        body["notes"] = notes
    client.put(f"/issues/{issue_id}.json", {"issue": body})
    after = get_issue(client, issue_id)
    if after["status"]["id"] != status_id:
        raise ToolError(
            "Redmine accepted the request but did not change the status (workflow); "
            "any note was still recorded",
            code="transition_not_applied",
        )
    return {"ok": True, "issue": summary_from_detail(after)}


def summary_from_detail(d):
    keys = ("id", "subject", "project", "tracker", "status", "priority", "assignedTo", "updatedOn", "url")
    return {k: d.get(k) for k in keys}


def client_or_error():
    from .client import from_settings

    return from_settings()


__all__ = [
    "RedmineClient",
    "add_comment",
    "board",
    "client_or_error",
    "current_user",
    "get_issue",
    "list_members",
    "list_projects",
    "list_statuses",
    "list_trackers",
    "search",
    "supports_any_searchable",
    "update_status",
]
