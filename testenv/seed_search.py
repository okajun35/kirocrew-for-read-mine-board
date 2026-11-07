#!/usr/bin/env python3
"""Extra seed for V-15..V-19: versions, categories, watchers, custom field values.

Usage: python3 seed_search.py <env_json>   (after seed.py, and after the
custom field "Customer" was created with rails runner; see AGENTS.md)
"""
import json
import sys
import urllib.error
import urllib.request


def api(base, key, method, path, body=None):
    req = urllib.request.Request(base + path, method=method)
    req.add_header("X-Redmine-API-Key", key)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


env = json.load(open(sys.argv[1]))
base, ak = env["base"], env["admin_key"]
proj = "demo-alpha"

versions = []
for name in ("v1.0", "v2.0"):
    st, b = api(base, ak, "POST", f"/projects/{proj}/versions.json", {"version": {"name": name}})
    if st == 422:
        b = {"version": next(v for v in api(base, ak, "GET", f"/projects/{proj}/versions.json")[1]["versions"] if v["name"] == name)}
    versions.append(b["version"]["id"])
cats = []
for name in ("UI", "API"):
    st, b = api(base, ak, "POST", f"/projects/{proj}/issue_categories.json", {"issue_category": {"name": name}})
    if st == 422:
        b = {"issue_category": next(c for c in api(base, ak, "GET", f"/projects/{proj}/issue_categories.json")[1]["issue_categories"] if c["name"] == name)}
    cats.append(b["issue_category"]["id"])

cf = None
st, b = api(base, ak, "GET", "/custom_fields.json")
for f in b.get("custom_fields", []):
    if f["name"] == "Customer":
        cf = f["id"]

issues = api(base, ak, "GET", f"/issues.json?project_id={proj}&status_id=*&limit=100&sort=id")[1]["issues"]
dev = env["users"]["dev_tanaka"]["id"]
n = 0
for i, it in enumerate(issues):
    body = {"fixed_version_id": versions[i % 2], "category_id": cats[(i // 2) % 2]}
    if cf:
        body["custom_fields"] = [{"id": cf, "value": ["ACME", "Globex", "Initech"][i % 3]}]
    st, _ = api(base, ak, "PUT", f"/issues/{it['id']}.json", {"issue": body})
    n += st == 204
    if i % 5 == 0:
        api(base, ak, "POST", f"/issues/{it['id']}/watchers.json", {"user_id": dev})
print(json.dumps({"versions": versions, "categories": cats, "customField": cf, "updated": n, "of": len(issues)}))
