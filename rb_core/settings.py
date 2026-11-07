"""Connection settings (base URL + the user's own API key), stored 0600.

The API key is never returned by ``view()``: callers only learn whether one
is set. Only ``load_credentials()`` hands it out, and only to the client.
"""

import urllib.parse

from .util import ToolError, atomic_write_json, data_dir, read_json

KANBAN_KEYS = ("kanbanStatusIds",)


def _path():
    return data_dir() / "settings.json"


def _load():
    raw = read_json(_path(), default={})
    return raw if isinstance(raw, dict) else {}


def normalize_base_url(url):
    """Scheme + host + port + optional path prefix, no query/fragment/userinfo."""
    if not isinstance(url, str) or not url.strip():
        raise ToolError("baseUrl is required")
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise ToolError("baseUrl must start with http:// or https://")
    if not parts.hostname:
        raise ToolError("baseUrl must include a host")
    if parts.username or parts.password:
        raise ToolError("baseUrl must not contain credentials")
    if parts.query or parts.fragment:
        raise ToolError("baseUrl must not contain a query or fragment")
    path = parts.path.rstrip("/")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc.lower(), path, "", ""))


def view():
    s = _load()
    base = s.get("baseUrl") or ""
    return {
        "baseUrl": base,
        "apiKeySet": bool(s.get("apiKey")),
        "insecure": base.startswith("http://"),
        "kanbanStatusIds": s.get("kanbanStatusIds") or [],
    }


def load_credentials():
    s = _load()
    base, key = s.get("baseUrl"), s.get("apiKey")
    if not base or not key:
        raise ToolError(
            "Redmine is not configured: set the URL and API key in the Redmine Board settings",
            code="not_configured",
        )
    return base, key


def save(base_url=None, api_key=None, kanban_status_ids=None):
    s = _load()
    if base_url is not None:
        new_base = normalize_base_url(base_url)
        if new_base != s.get("baseUrl") and api_key is None:
            # A key belongs to one server; never send it to a new host.
            s.pop("apiKey", None)
        s["baseUrl"] = new_base
    if api_key is not None:
        key = api_key.strip()
        if key and (len(key) > 256 or not key.isprintable() or " " in key):
            raise ToolError("apiKey looks invalid")
        if key:
            s["apiKey"] = key
        else:
            s.pop("apiKey", None)
    if kanban_status_ids is not None:
        if not isinstance(kanban_status_ids, list) or not all(
            isinstance(x, int) and not isinstance(x, bool) for x in kanban_status_ids
        ):
            raise ToolError("kanbanStatusIds must be an array of integers")
        s["kanbanStatusIds"] = kanban_status_ids[:30]
    atomic_write_json(_path(), s, mode=0o600)
    return view()
