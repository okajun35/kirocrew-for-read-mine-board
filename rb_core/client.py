"""Redmine REST client pinned to the configured base URL.

SSRF guard (SPEC §7): callers pass only a path and query parameters. The
scheme, host and port always come from the saved base URL, and redirects are
never followed. The API key travels in the ``X-Redmine-API-Key`` header only
and is scrubbed from every message this module raises.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from .util import ToolError

TIMEOUT_SECS = 15
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_SAFE_PATH = re.compile(r"^/[A-Za-z0-9_\-./]*\.json$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def check_path(path):
    if not isinstance(path, str) or not _SAFE_PATH.match(path):
        raise ToolError(f"invalid Redmine API path: {path!r}")
    if "//" in path or "/../" in path or "/./" in path or path.endswith("/.."):
        raise ToolError(f"invalid Redmine API path: {path!r}")
    return path


def encode_params(params):
    pairs = []
    for k, v in (params or {}).items():
        if v is None or v == "":
            continue
        if isinstance(v, (list, tuple)):
            for item in v:
                pairs.append((k, str(item)))
        else:
            pairs.append((k, str(v)))
    return urllib.parse.urlencode(pairs)


class RedmineClient:
    def __init__(self, base_url, api_key, opener=None):
        self.base_url = base_url.rstrip("/")
        self._key = api_key
        self._opener = opener or _OPENER

    def scrub(self, text):
        text = str(text)
        return text.replace(self._key, "***") if self._key else text

    def url_for(self, path, params=None):
        check_path(path)
        q = encode_params(params)
        return f"{self.base_url}{path}" + (f"?{q}" if q else "")

    def web_url(self, kind, ident):
        return f"{self.base_url}/{kind}/{urllib.parse.quote(str(ident), safe='')}"

    def request(self, method, path, params=None, body=None):
        url = self.url_for(path, params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Redmine-API-Key", self._key)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(req, timeout=TIMEOUT_SECS) as resp:
                raw = resp.read(MAX_RESPONSE_BYTES + 1)
                status = resp.status
        except urllib.error.HTTPError as e:
            raise self._http_error(e) from None
        except urllib.error.URLError as e:
            raise ToolError(
                f"cannot reach Redmine at {self.base_url}: {self.scrub(e.reason)}",
                code="redmine_unreachable",
            ) from None
        except (TimeoutError, OSError) as e:
            raise ToolError(
                f"cannot reach Redmine at {self.base_url}: {self.scrub(e)}",
                code="redmine_unreachable",
            ) from None
        if status in (301, 302, 303, 307, 308):
            raise ToolError("Redmine answered with a redirect; check the base URL", code="redmine_redirect")
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ToolError("Redmine response is too large", code="redmine_error")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ToolError("Redmine did not return JSON; check the base URL", code="redmine_error") from None

    def _http_error(self, e):
        detail = ""
        try:
            payload = json.loads(e.read(65536) or b"{}")
            errs = payload.get("errors") if isinstance(payload, dict) else None
            if isinstance(errs, list):
                detail = "; ".join(self.scrub(x) for x in errs if isinstance(x, str))
        except Exception:
            pass
        if e.code in (301, 302, 303, 307, 308):
            return ToolError("Redmine answered with a redirect; check the base URL", code="redmine_redirect")
        if e.code == 401:
            return ToolError("Redmine rejected the API key (401)", code="redmine_unauthorized")
        if e.code == 403:
            return ToolError(
                "Redmine refused the request (403): the REST API may be disabled or you lack permission",
                code="redmine_forbidden",
            )
        if e.code == 404:
            return ToolError("not found in Redmine (404)", code="not_found")
        if e.code == 422:
            return ToolError(f"Redmine rejected the change: {detail or 'validation failed'}", code="redmine_invalid")
        return ToolError(f"Redmine error {e.code}{': ' + detail if detail else ''}", code="redmine_error")

    def get(self, path, params=None):
        return self.request("GET", path, params)

    def put(self, path, body):
        return self.request("PUT", path, body=body)


def from_settings():
    from . import settings

    base, key = settings.load_credentials()
    return RedmineClient(base, key)
