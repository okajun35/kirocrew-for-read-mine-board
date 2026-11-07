"""Search-expression parsing and compilation (SPEC-search-board §3/§4).

One expression drives the list, the board and (later) the facet panel:

    assignee:me status:"In Progress",Feedback updated:<7d login -CSV

The parser is pure and offline: it produces terms, filters and errors with
the raw token of each so chips can be removed/edited by token text. The
compiler turns filters into ``issues.json`` parameters, honouring what
VERIFICATION.md measured:

* list / number / text / custom fields go through ``f[]``/``op[]``/``v[]``
* date fields are silently ignored under ``f[]``: they use direct params
* any ``f[]`` disables the implicit open-issues filter: status is explicit
* unknown field names are silently ignored server-side: validated here
"""

import re
import shlex
from dataclasses import dataclass, field as dc_field

from .util import ToolError

# canonical field -> (Redmine filter name, kind, aliases)
FIELDS = {
    "project": ("project_id", "project", ("project", "プロジェクト")),
    "status": ("status_id", "status", ("status", "状態", "ステータス")),
    "tracker": ("tracker_id", "list", ("tracker", "トラッカー", "種類")),
    "priority": ("priority_id", "list", ("priority", "優先度", "優先")),
    "assignee": ("assigned_to_id", "user", ("assignee", "担当", "担当者")),
    "author": ("author_id", "user", ("author", "作成者")),
    "version": ("fixed_version_id", "list", ("version", "バージョン", "対象バージョン")),
    "category": ("category_id", "list", ("category", "カテゴリ")),
    "parent": ("parent_id", "list", ("parent", "親", "親チケット")),
    "done": ("done_ratio", "number", ("done", "progress", "進捗")),
    "created": ("created_on", "date", ("created", "作成")),
    "updated": ("updated_on", "date", ("updated", "更新")),
    "due": ("due_date", "date", ("due", "期日", "期限")),
    "start": ("start_date", "date", ("start", "開始", "開始日")),
    "closed": ("closed_on", "date", ("closed", "完了日", "クローズ")),
}
ALIASES = {a: k for k, (_r, _t, names) in FIELDS.items() for a in names}
CF_PREFIX = "cf."
CF_PREFIX_JA = "cf."

ME = ("me", "自分", "わたし")
NONE = ("none", "なし", "未設定")
ANY = ("*", "all", "すべて", "全て")
STATUS_OPEN = ("open", "o", "未完了", "オープン")
STATUS_CLOSED = ("closed", "c", "完了", "クローズ")

# date keyword -> Redmine direct-param value
DATE_WORDS = {
    "today": "t", "今日": "t",
    "yesterday": "ld", "昨日": "ld",
    "this-week": "w", "今週": "w",
    "last-week": "lw", "先週": "lw",
    "this-month": "m", "今月": "m",
    "last-month": "lm", "先月": "lm",
    "this-year": "y", "今年": "y",
}
OVERDUE = ("overdue", "期限切れ")

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_REL_DAYS = re.compile(r"^([<>])(\d{1,4})d$")
_RANGE = re.compile(r"^(.+?)\.\.(.+)$")
_OP_PREFIX = re.compile(r"^(>=|<=|>|<)(.*)$")
_IDENT_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,100}$")
_FIELD_TOKEN = re.compile(r"^(-?)([^\s:]+):(.*)$", re.S)


@dataclass
class Term:
    text: str
    negated: bool
    raw: str


@dataclass
class Filter:
    field: str          # canonical key or "cf.<id>"
    op: str             # "=", "!", "*", "!*", "o", "c", or a direct date value
    values: list = dc_field(default_factory=list)
    raw: str = ""


@dataclass
class Parsed:
    terms: list = dc_field(default_factory=list)
    filters: list = dc_field(default_factory=list)
    errors: list = dc_field(default_factory=list)   # {token, code}
    raw: str = ""

    def chips(self):
        out = []
        for f in self.filters:
            out.append({"kind": "filter", "field": f.field, "op": f.op,
                        "values": f.values, "raw": f.raw})
        for t in self.terms:
            out.append({"kind": "text", "text": t.text, "negated": t.negated, "raw": t.raw})
        return out


def tokenize(expr):
    """Split respecting double quotes. Returns list of raw tokens."""
    lex = shlex.shlex(expr, posix=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        words = list(lex)
    except ValueError:  # unbalanced quote: treat rest as one word
        words = []
    # shlex strips quotes; re-derive raw tokens with them intact
    raw, cur, in_q = [], "", False
    for ch in expr:
        if ch == '"':
            in_q = not in_q
            cur += ch
        elif ch.isspace() and not in_q:
            if cur:
                raw.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        raw.append(cur)
    return raw, words


def _suggest(name):
    import difflib
    close = difflib.get_close_matches(name.lower(), ALIASES.keys(), n=1, cutoff=0.5)
    return close[0] if close else None


def parse(expr):
    """Parse an expression into terms/filters/errors. Never raises."""
    p = Parsed(raw=expr or "")
    if not (expr or "").strip():
        return p
    raw_tokens, words = tokenize(expr)
    if len(raw_tokens) != len(words):
        words = [t.strip('"') for t in raw_tokens]  # unbalanced quote fallback
    for raw, word in zip(raw_tokens, words):
        m = _FIELD_TOKEN.match(raw)
        if not m or not word:
            _add_term(p, raw, word)
            continue
        neg, keypart, valpart = m.groups()
        key = ALIASES.get(keypart.lower())
        if key is None and keypart.lower().startswith(CF_PREFIX):
            key = "cf." + keypart[len(CF_PREFIX):]
        if key is None:
            # unknown `foo:` — is it a keyword containing a colon, or a typo?
            if _suggest(keypart) or re.match(r"^[A-Za-z\u3000-\u9fff]+$", keypart):
                p.errors.append({"token": raw, "code": "unknown_field",
                                 "suggestion": _suggest(keypart)})
                _add_term(p, raw, word)
            else:
                _add_term(p, raw, word)
            continue
        values = [v.strip('"') for v in valpart.split(",")] if valpart else [""]
        p.filters.append(_make_filter(key, values, raw, neg, p))
    return p


def _add_term(p, raw, word):
    negated = raw.startswith("-")
    text = word.lstrip("-") if negated else word
    if text:
        p.terms.append(Term(text=text, negated=negated, raw=raw))


def _make_filter(field_key, values, raw, negated, p):
    fname, kind = FIELDS.get(field_key, (field_key, "list"))[:2] if field_key in FIELDS else (field_key, "list")
    if field_key.startswith("cf."):
        fname, kind = field_key, "list"
    values = [v for v in values if v != ""]
    f = Filter(field=field_key, op="!", values=values, raw=raw) if negated else Filter(field=field_key, op="=", values=values, raw=raw)

    if kind == "status":
        if not values:
            p.errors.append({"token": raw, "code": "bad_value"})
            return f
        if len(values) == 1:
            lv = values[0].lower()
            if lv in STATUS_OPEN:
                f.op = "c" if negated else "o"; f.values = []
                return f
            if lv in STATUS_CLOSED:
                f.op = "o" if negated else "c"; f.values = []
                return f
            if lv in ANY:
                f.op = "!" if negated else "*"; f.values = []
                return f
        f.values = values
        return f

    if kind == "date":
        f.op = "!" if negated else "="
        f.values = values
        return f

    if kind == "number" or kind == "list" or kind == "project" or kind == "user":
        out = []
        for v in values:
            lv = v.lower()
            if lv in NONE:
                f.op = "!*"; f.values = []
                return f
            if lv in ANY:
                f.op = "*" if not negated else "!"; f.values = []
                return f
            out.append(v)
        f.values = out
        return f

    return f


# ---------------------------------------------------------------------------
# compilation
# ---------------------------------------------------------------------------

class Meta:
    """Name -> id lookups. The backend fills the lists it needs."""

    def __init__(self):
        self.projects = []       # {id, identifier, name}
        self.statuses = []       # {id, name, isClosed}
        self.trackers = []       # {id, name}
        self.priorities = []     # {id, name} in position order
        self.users = []          # {id, name, login}
        self.versions = []       # {id, name}
        self.categories = []     # {id, name}
        self.custom_fields = []  # {id, name}

    def _find(self, items, value, extra_keys=()):
        v = value.strip().lower()
        hits = [i for i in items
                if str(i.get("id")) == value.strip()
                or str(i.get("name") or "").lower() == v
                or any(str(i.get(k) or "").lower() == v for k in extra_keys)]
        return hits


def _resolve_list(meta, field_key, values, errors, raw):
    fname, kind = FIELDS[field_key][:2]
    out = []
    for v in values:
        if field_key in ("assignee", "author") and v.lower() in ME:
            out.append("me")
            continue
        if v.lstrip("#").isdigit():
            out.append(v.lstrip("#"))
            continue
        items = {
            "status": meta.statuses, "tracker": meta.trackers,
            "priority": meta.priorities, "version": meta.versions,
            "category": meta.categories, "parent": [],
        }.get(field_key)
        if field_key in ("assignee", "author"):
            items = meta.users
        if field_key == "parent":
            errors.append({"token": raw, "code": "bad_value"})
            return None
        hits = meta._find(items or [], v, extra_keys=("login", "identifier"))
        if len(hits) == 1:
            out.append(str(hits[0]["id"]))
        elif not hits:
            errors.append({"token": raw, "code": "unknown_value", "value": v})
            return None
        else:
            errors.append({"token": raw, "code": "ambiguous_value", "value": v})
            return None
    return out


def _resolve_priority(meta, op_prefix, value, errors, raw):
    hits = meta._find(meta.priorities, value.lstrip("<>="))
    if not hits:
        errors.append({"token": raw, "code": "unknown_value", "value": value})
        return None
    pos = [i["id"] for i in meta.priorities].index(hits[0]["id"])
    ids = [str(p["id"]) for p in meta.priorities]
    if op_prefix == ">=":
        return ids[pos:]
    if op_prefix == "<=":
        return ids[:pos + 1]
    if op_prefix == ">":
        return ids[pos + 1:] or ["0"]
    if op_prefix == "<":
        return ids[:pos] or ["0"]
    return [str(hits[0]["id"])]


def _date_value(field_key, values, errors, raw):
    """Map date tokens to a direct-param value (f[] dates are ignored)."""
    fname = FIELDS[field_key][0]
    if len(values) != 1:
        errors.append({"token": raw, "code": "bad_value"})
        return fname, None
    v = values[0].strip()
    lv = v.lower()
    if lv in DATE_WORDS:
        return fname, DATE_WORDS[lv]
    if lv in OVERDUE:
        if field_key != "due":
            errors.append({"token": raw, "code": "bad_value"})
            return fname, None
        return fname, "<t+0"
    m = _REL_DAYS.match(lv)
    if m:
        return fname, (">t-" if m.group(1) == "<" else "<t-") + m.group(2)
    if _DATE.match(v):
        return fname, "=" + v
    m = _RANGE.match(v)
    if m and all(_DATE.match(x.strip()) for x in m.groups()):
        return fname, "><%s|%s" % (m.group(1).strip(), m.group(2).strip())
    m = _OP_PREFIX.match(v)
    if m and _DATE.match(m.group(2).strip()):
        return fname, m.group(1) + m.group(2).strip()
    errors.append({"token": raw, "code": "bad_value"})
    return fname, None


@dataclass
class Plan:
    """How to ask Redmine for a parsed query.

    ``f[]`` mode is required when any filter needs it (multi-value, !, *,
    !*, o, c). Direct params are IGNORED once f[] is present, so in f mode
    every expressible filter goes into f[] and created/updated/start/closed
    dates (which f[] silently drops) are deferred to a second direct-param
    request whose ids are intersected via ``f[]=issue_id``.
    """
    mode: str = "direct"        # 'direct' | 'f'
    params: dict = dc_field(default_factory=dict)
    dates: dict = dc_field(default_factory=dict)   # deferred date params (f mode)
    errors: list = dc_field(default_factory=list)

    def with_text(self, term, negated):
        """Params for one any_searchable request in this plan's mode."""
        p = dict(self.params)
        if self.mode == "f":
            flist = list(p.get("f[]") or []) + ["any_searchable"]
            p["f[]"] = flist
            p["op[any_searchable]"] = "!~" if negated else "~"
            p["v[any_searchable][]"] = [term]
        else:
            p["any_searchable"] = ("!~" if negated else "~") + term
        return p

    def with_issue_ids(self, ids):
        p = dict(self.params)
        joined = ",".join(str(i) for i in ids)
        if self.mode == "f":
            flist = list(p.get("f[]") or []) + ["issue_id"]
            p["f[]"] = flist
            p["op[issue_id]"] = "="
            p["v[issue_id][]"] = [joined]
        else:
            p["issue_id"] = joined
        return p


_F_ONLY_OPS = ("!", "*", "!*", "o", "c")

# date ops that take no value vs. those that do
_DATE_NULLARY = ("t", "ld", "w", "lw", "l2w", "m", "lm", "y")
_DATE_OPS = ("><", ">t-", "<t-", ">t+", "<t+", "t+", "t-", ">=", "<=", "=")


def _date_f_op(val):
    """Split a direct date value like '><2026-01-01|2026-02-01' or '<t+0'
    into (op, [values]) for f[] form."""
    if val in _DATE_NULLARY:
        return val, []
    for op in _DATE_OPS:
        if val.startswith(op):
            rest = val[len(op):]
            return op, (rest.split("|") if op == "><" else [rest])
    return "=", [val]


def build_params(parsed, meta):
    """Compile parsed filters into a Plan. Text terms are NOT included."""
    plan = Plan(errors=list(parsed.errors))
    fonly = []    # entries needing f[]
    either = []   # entries expressible both ways: (fname, op, values, direct_value)
    dates = {}    # fname -> direct value

    def add(fname, op, values, direct=None, f_only=False):
        (fonly if f_only else either).append((fname, op, values, direct))

    has_status = False
    for f in parsed.filters:
        if f.field.startswith("cf."):
            name = f.field[len("cf."):]
            hits = meta._find(meta.custom_fields, name)
            if len(hits) != 1:
                plan.errors.append({"token": f.raw, "code": "unknown_value", "value": name})
                continue
            fname = "cf_%d" % hits[0]["id"]
            vals = [_resolve_scalar(v) for v in f.values]
            direct = {fname: vals[0]} if f.op == "=" and len(vals) == 1 else None
            add(fname, f.op, vals, direct, f_only=direct is None)
            continue
        fname, kind = FIELDS[f.field][:2]
        if kind == "date":
            key, val = _date_value(f.field, f.values, plan.errors, f.raw)
            if val is not None:
                if f.op == "!":
                    plan.errors.append({"token": f.raw, "code": "bad_value"})
                elif fname == "due_date":
                    # due_date works via f[] too (verified); others are ignored
                    op, vals = _date_f_op(val)
                    add(fname, op, vals, {fname: val}, f_only=False)
                else:
                    dates[fname] = val
            continue
        if kind == "project":
            if len(f.values) != 1:
                plan.errors.append({"token": f.raw, "code": "bad_value"})
                continue
            v = f.values[0]
            hits = meta._find(meta.projects, v, extra_keys=("identifier",)) if not v.isdigit() else []
            pid = v if v.isdigit() else (str(hits[0]["id"]) if len(hits) == 1 else None)
            if pid is None:
                plan.errors.append({"token": f.raw, "code": "unknown_value", "value": v})
            elif f.op == "=":
                add("project_id", "=", [pid], {"project_id": pid})
            else:
                plan.errors.append({"token": f.raw, "code": "bad_value"})
            continue
        if kind == "status":
            has_status = True
            if f.op in ("=", "!") and f.values:
                ids = _resolve_list(meta, "status", f.values, plan.errors, f.raw)
                if ids is None:
                    continue
                f.resolved = ids
            else:
                ids = []
            direct = {"status_id": f.op} if f.op in ("o", "c", "*") else (
                {"status_id": ids[0]} if f.op == "=" and len(ids) == 1 else None)
            add(fname, f.op, ids, direct, f_only=direct is None)
            continue
        if kind == "number":
            if len(f.values) != 1:
                plan.errors.append({"token": f.raw, "code": "bad_value"})
                continue
            v = f.values[0]
            m = _RANGE.match(v)
            if m and all(x.strip().isdigit() for x in m.groups()):
                op, vals = "><", [m.group(1).strip(), m.group(2).strip()]
            else:
                m = _OP_PREFIX.match(v)
                if m and m.group(2).strip().isdigit():
                    op, vals = m.group(1), [m.group(2).strip()]
                elif v.isdigit():
                    op, vals = "=", [v]
                else:
                    plan.errors.append({"token": f.raw, "code": "bad_value"})
                    continue
            add(fname, op, vals, {fname: (op if op == "=" else op) + vals[0] if op in ("=", ">=", "<=") else None},
                f_only=op == "><")
            continue
        # list / user kinds
        if field_key_priority(f):
            ids = _resolve_priority_values(f, meta, plan.errors)
        else:
            ids = _resolve_list(meta, f.field, f.values, plan.errors, f.raw)
        if ids is None:
            continue
        f.resolved = ids
        direct = {fname: ids[0]} if f.op == "=" and len(ids) == 1 else None
        if f.op == "!*":
            direct = {fname: "!*"}  # direct !* works too
        add(fname, f.op, ids, direct, f_only=direct is None)

    if fonly:
        plan.mode = "f"
    else:
        plan.mode = "direct"
    entries = fonly + either
    if plan.mode == "f":
        if not has_status:
            entries.append(("status_id", "o", [], None))
        plan.params["f[]"] = [e[0] for e in entries]
        for fname, op, vals, _d in entries:
            plan.params[f"op[{fname}]"] = op
            plan.params[f"v[{fname}][]"] = vals
        plan.dates = dates
    else:
        for fname, op, vals, direct in entries:
            if direct:
                plan.params.update(direct)
        if not has_status:
            plan.params["status_id"] = "o"
        plan.params.update(dates)
    return plan


def _resolve_scalar(v):
    return v.lstrip("#") if v.startswith("#") else v


def field_key_priority(f):
    if f.field != "priority":
        return False
    return any(_OP_PREFIX.match(v) for v in f.values)


def _resolve_priority_values(f, meta, errors):
    # priority:>=High expands to the id set at/above that position
    out = []
    for v in f.values:
        m = _OP_PREFIX.match(v)
        prefix = m.group(1) if m else "="
        name = m.group(2).strip() if m else v
        ids = _resolve_priority(meta, prefix, name, errors, f.raw)
        if ids is None:
            return None
        out += ids
    return sorted(set(out), key=int)


SORT_FIELDS = {
    "id", "subject", "status", "priority", "assigned_to", "author",
    "updated_on", "created_on", "due_date", "start_date", "tracker",
    "project", "done_ratio", "fixed_version", "category",
}


def sort_param(raw):
    key, _, direction = (raw or "updated_on:desc").partition(":")
    if key not in SORT_FIELDS or direction not in ("", "asc", "desc"):
        raise ToolError(f"sort must be one of {', '.join(sorted(SORT_FIELDS))} with optional :asc/:desc",
                        code="bad_request")
    return f"{key}:{direction or 'asc'}"
