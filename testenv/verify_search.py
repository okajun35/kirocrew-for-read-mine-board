#!/usr/bin/env python3
"""V-15..V-19 checks: generic f[]/op[]/v[] filters, custom fields, saved
queries, facet-count speed, and field updates. Run:

  python3 verify_search.py ../redmine-board-testenv/env-51.json
  python3 verify_search.py ../redmine-board-testenv/env-6.json
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def api(base, key, method, path):
    if not path.startswith("/"):
        path = "/" + path
    req = urllib.request.Request(base + path, method=method)
    req.add_header("X-Redmine-API-Key", key)
    req.add_header("Content-Type", "application/json")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}, time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), time.monotonic() - t0


env = json.load(open(sys.argv[1]))
B, AK = env["base"], env["admin_key"]
DK = env["users"]["dev_tanaka"]["api_key"]
RK = env["users"]["rep_sato"]["api_key"]
DEV = env["users"]["dev_tanaka"]["id"]
REP = env["users"]["rep_sato"]["id"]
ISS = "issues.json?"
results = {}


def count(params, key=AK):
    st, b, _ = api(B, key, "GET", ISS + params + "&limit=1")
    return b.get("total_count") if st == 200 else f"HTTP {st}"


# ---------- V-15: f[] / op[] / v[] ----------
v15 = {}
pairs = [
    ("status=2 (op=)", "f[]=status_id&op[status_id]==&v[status_id][]=2", "status_id=2"),
    ("status!=1,2 (op=!)", "f[]=status_id&op[status_id]=!&v[status_id][]=1&v[status_id][]=2", "status_id=!1,2"),
    ("status open (op=o)", "f[]=status_id&op[status_id]=o&v[status_id][]=", "status_id=o"),
    ("status any (op=*)", "f[]=status_id&op[status_id]=*&v[status_id][]=", "status_id=*"),
    ("done>=50", "f[]=done_ratio&op[done_ratio]=>=&v[done_ratio][]=50", "done_ratio=>=50"),
    ("done><30-80", "f[]=done_ratio&op[done_ratio]=><&v[done_ratio][]=30&v[done_ratio][]=80", "done_ratio=>=30%3C%3E80"),
    ("created >t- 14", "f[]=created_on&op[created_on]=>t-&v[created_on][]=14", "created_on=>t-14"),
    ("created <t- 1", "f[]=created_on&op[created_on]=<t-&v[created_on][]=1", "created_on=<t-1"),
    ("created w", "f[]=created_on&op[created_on]=w&v[created_on][]=", "created_on=w"),
    ("created lw", "f[]=created_on&op[created_on]=lw&v[created_on][]=", "created_on=lw"),
    ("created t", "f[]=created_on&op[created_on]=t&v[created_on][]=", "created_on=t"),
    ("created ><dates", "f[]=created_on&op[created_on]=><&v[created_on][]=2026-11-01&v[created_on][]=2026-11-30", "created_on=>=2026-11-01%3C%3E2026-11-30"),
    ("due !* (none)", "f[]=due_date&op[due_date]=!*&v[due_date][]=", "due_date=!*"),
    ("due date <=2026-12-31", "f[]=due_date&op[due_date]=<=&v[due_date][]=2026-12-31", "due_date=<=2026-12-31"),
    ("assignee=dev (f[])", "f[]=assigned_to_id&op[assigned_to_id]==&v[assigned_to_id][]=%d" % DEV, "assigned_to_id=%d" % DEV),
    ("assignee none", "f[]=assigned_to_id&op[assigned_to_id]=!*&v[assigned_to_id][]=", "assigned_to_id=!*"),
    ("version=1", "f[]=fixed_version_id&op[fixed_version_id]==&v[fixed_version_id][]=1", "fixed_version_id=1"),
    ("parent=1", "f[]=parent_id&op[parent_id]==&v[parent_id][]=1", "parent_id=1"),
    ("tracker=1,2", "f[]=tracker_id&op[tracker_id]==&v[tracker_id][]=1&v[tracker_id][]=2", "tracker_id=1,2"),
    ("unknown field", "f[]=no_such_field&op[no_such_field]==&v[no_such_field][]=1", "status_id=*"),
    ("unknown op", "f[]=status_id&op[status_id]=bogus&v[status_id][]=1", "status_id=*"),
]
for name, f, ref in pairs:
    c1, c2 = count(f), count(ref)
    v15[name] = {"f[]": c1, "ref": c2, "ok": c1 == c2}

# AND across fields: status open + tracker 2 should be intersection
v15["AND across fields"] = {
    "combined": count("f[]=status_id&op[status_id]=o&v[status_id][]=&f[]=tracker_id&op[tracker_id]==&v[tracker_id][]=2"),
    "open": count("status_id=o"), "tracker2": count("status_id=*&tracker_id=2"),
}

# any_searchable multi-word and !~
v15["text 'login'"] = count("any_searchable=~login&status_id=*")
v15["text 'login error'"] = count("any_searchable=~" + urllib.parse.quote("login error") + "&status_id=*")
v15["text 'login' AND 'error'"] = count("any_searchable=~login&any_searchable=~error&status_id=*")
v15["text not-login (!~)"] = count("any_searchable=" + urllib.parse.quote("!~login") + "&status_id=*")
v15["all"] = count("status_id=*")

# ---------- V-16: custom fields ----------
v16 = {}
v16["cf_1=ACME (direct)"] = count("cf_1=ACME&status_id=*")
v16["cf_1=*"] = count("cf_1=*&status_id=*")
v16["cf via f[]"] = count("f[]=cf_1&op[cf_1]==&v[cf_1][]=ACME&status_id=*")
st, b, _ = api(B, RK, "GET", "/custom_fields.json")
v16["non-admin /custom_fields.json"] = st
st, b, _ = api(B, RK, "GET", "/projects/demo-alpha.json?include=issue_custom_fields")
v16["project include=issue_custom_fields"] = {"status": st, "custom": [c["name"] for c in b.get("project", {}).get("issue_custom_fields", [])]}
st, b, _ = api(B, RK, "GET", "/issues.json?project_id=demo-alpha&limit=1")
v16["issue shows cf"] = b["issues"][0].get("custom_fields") if st == 200 else st

# ---------- V-17: saved queries ----------
v17 = {}
st, b, _ = api(B, AK, "GET", "/queries.json")
v17["admin /queries.json"] = {"status": st, "queries": [{"id": q["id"], "name": q["name"], "public": q.get("is_public"), "user": q.get("user", {}).get("name"), "project": q.get("project", {}).get("id")} for q in b.get("queries", [])]}
st, b, _ = api(B, DK, "GET", "/queries.json")
v17["dev sees"] = [q["name"] for q in b.get("queries", [])] if st == 200 else st
v17["issues?query_id=8"] = count("query_id=8")
v17["ref: dev's open"] = count("status_id=o&assigned_to_id=%d" % DEV)
v17["query_id + status_id=c"] = count("query_id=8&status_id=c")
v17["query_id + assignee=rep"] = count("query_id=8&assigned_to_id=%d" % REP)
v17["admin private q9 as dev"] = count("query_id=9", key=DK)

# ---------- V-18: facet speed (20 x limit=1, 6 parallel) ----------
fields = list(range(1, 9)) * 3
def facet(i):
    return api(B, AK, "GET", f"issues.json?status_id=*&tracker_id={i % 4 + 1}&limit=1")[2]
t0 = time.monotonic()
with ThreadPoolExecutor(6) as ex:
    times = list(ex.map(facet, fields))
v18 = {"20 parallel(6) sec": round(time.monotonic() - t0, 2), "per-req avg": round(sum(times) / len(times), 3)}

# ---------- V-19: field updates ----------
v19 = {}
st, b, _ = api(B, AK, "GET", "/issues/1.json")
i1 = b["issue"]
tgt = i1["project"]["id"]
# as dev: assign to reporter (member), then to admin (maybe not member)
for who, uid, name in [(DK, REP, "dev->assign rep"), (DK, 1, "dev->assign admin")]:
    st, b, _ = api(B, who, "PUT", "/issues/1.json"); 
    req = urllib.request.Request(B + "/issues/1.json", method="PUT", data=json.dumps({"issue": {"assigned_to_id": uid}}).encode())
    req.add_header("X-Redmine-API-Key", who); req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            code, body = r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        code, body = e.code, json.loads(e.read() or b"{}")
    check = api(B, AK, "GET", "/issues/1.json")[1]["issue"]["assigned_to"]["id"]
    v19[name] = {"put": code, "effective": check == uid}
req = urllib.request.Request(B + "/issues/1.json", method="PUT", data=json.dumps({"issue": {"fixed_version_id": 2, "priority_id": 4, "assigned_to_id": DEV}}).encode())
req.add_header("X-Redmine-API-Key", DK); req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req) as r:
        v19["dev->version+priority"] = r.status
except urllib.error.HTTPError as e:
    v19["dev->version+priority"] = e.code
i1b = api(B, AK, "GET", "/issues/1.json")[1]["issue"]
v19["effective version/priority"] = [i1b.get("fixed_version", {}).get("id"), i1b["priority"]["id"]]
req = urllib.request.Request(B + "/issues/1.json", method="PUT", data=json.dumps({"issue": {"assigned_to_id": 9999}}).encode())
req.add_header("X-Redmine-API-Key", DK); req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req) as r:
        v19["invalid assignee 9999"] = r.status
except urllib.error.HTTPError as e:
    v19["invalid assignee 9999"] = e.code
i1c = api(B, AK, "GET", "/issues/1.json")[1]["issue"]
v19["assignee after invalid"] = i1c["assigned_to"]["id"]
st, b, _ = api(B, DK, "GET", "/projects/demo-alpha/memberships.json")
v19["dev GET memberships"] = {"status": st, "count": len(b.get("memberships", []))}
req = urllib.request.Request(B + "/issues/1.json", method="PUT", data=json.dumps({"issue": {"assigned_to_id": REP}}).encode())
req.add_header("X-Redmine-API-Key", RK); req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req) as r:
        v19["reporter->assign"] = r.status
except urllib.error.HTTPError as e:
    v19["reporter->assign"] = e.code
st, b, _ = api(B, DK, "GET", "/issues/1.json?include=allowed_statuses")
v19["allowed_statuses count"] = len(b["issue"]["allowed_statuses"])
st, b, _ = api(B, DK, "GET", "/projects/demo-alpha.json?include=versions,issue_categories,trackers")
v19["project includes"] = {"status": st, "versions": len(b["project"].get("versions", [])), "categories": len(b["project"].get("issue_categories", []))}
st, b, _ = api(B, DK, "GET", "/enumerations/issue_priorities.json")
v19["priorities non-admin"] = st

# restore issue 1
req = urllib.request.Request(B + "/issues/1.json", method="PUT", data=json.dumps({"issue": {"assigned_to_id": DEV, "fixed_version_id": None}}).encode())
req.add_header("X-Redmine-API-Key", AK); req.add_header("Content-Type", "application/json")
try:
    urllib.request.urlopen(req)
except urllib.error.HTTPError:
    pass

out = {"env": env["base"], "version": env.get("version"), "V-15": v15, "V-16": v16, "V-17": v17, "V-18": v18, "V-19": v19}
print(json.dumps(out, ensure_ascii=False, indent=1))
