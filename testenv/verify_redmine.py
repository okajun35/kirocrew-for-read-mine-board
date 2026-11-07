#!/usr/bin/env python3
"""Run Redmine-side verifications (V-01..V-05) against a seeded instance.

Usage: python3 verify_redmine.py <env_json>
Prints a report; keep output for VERIFICATION.md.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def api(base, key, method, path, body=None):
    req = urllib.request.Request(base + path, method=method)
    if key:
        req.add_header("X-Redmine-API-Key", key)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b"{}")
        except Exception:
            payload = {"raw": "<unparseable>"}
        return e.code, payload


def q(params):
    return urllib.parse.urlencode(params)


def main():
    env = json.load(open(sys.argv[1]))
    base, ak = env["base"], env["admin_key"]
    dev = env["users"]["dev_tanaka"]["api_key"]
    rep = env["users"]["rep_sato"]["api_key"]
    dev_id = env["users"]["dev_tanaka"]["id"]
    rep_id = env["users"]["rep_sato"]["id"]
    proj = env["projects"][0]["id"]
    fid = env["first_issue_id"]

    print(f"## base: {base}")

    # ---------- V-03 auth ----------
    print("\n### V-03 auth")
    st, b = api(base, ak, "GET", "/users/current.json")
    u = b.get("user", {})
    print(f"current.json -> {st} login={u.get('login')} admin={u.get('admin')} fields={sorted(u.keys())}")
    st, b = api(base, "invalidkey123", "GET", "/users/current.json")
    print(f"invalid key -> {st} {json.dumps(b)[:120]}")
    st, b = api(base, None, "GET", "/users/current.json")
    print(f"no key -> {st} {json.dumps(b)[:120]}")

    # ---------- V-04 pagination ----------
    print("\n### V-04 pagination")
    for lim in (25, 100, 200):
        st, b = api(base, ak, "GET", f"/issues.json?limit={lim}&offset=0")
        print(f"limit={lim} -> {st} returned={len(b.get('issues', []))} "
              f"total={b.get('total_count')} limit_hdr={b.get('limit')} offset_hdr={b.get('offset')}")
    st, b = api(base, ak, "GET", "/issues.json?limit=5&offset=160")
    print(f"offset=160 -> {st} returned={len(b.get('issues', []))} total={b.get('total_count')}")

    # ---------- V-01 search ----------
    print("\n### V-01 search")
    # pick a keyword that appears in a comment (journals) too
    kw = "対応中"   # seeded in notes
    st, b = api(base, ak, "GET", f"/search.json?{q({'q': kw, 'issues': 1})}")
    res = b.get("results", [])
    print(f"search.json q={kw!r} -> {st} total={b.get('total_count')} returned={len(res)} "
          f"types={sorted({r.get('type') for r in res}) if res else []}")
    if res:
        print(f"  result fields: {sorted(res[0].keys())}")
    st, b = api(base, ak, "GET", f"/issues.json?{q({'subject': '~対応中'})}")
    print(f"issues.json subject=~{kw!r} -> {st} total={b.get('total_count')}")
    for flt in ("any_searchable", "searchable"):
        st, b = api(base, ak, "GET", f"/issues.json?{q({flt: '~対応中'})}")
        print(f"issues.json {flt}=~ -> {st} total={b.get('total_count')} err={b.get('errors')}")
    # combine keyword-ish filter + status + assignee + project
    st, b = api(base, ak, "GET", "/issues.json?" + q({
        "subject": "~CSV", "project_id": proj, "status_id": 1, "assigned_to_id": dev_id}))
    print(f"combined subject+proj+status+assignee -> {st} total={b.get('total_count')}")
    # Japanese partial match
    st, b = api(base, ak, "GET", "/issues.json?" + q({"subject": "~文字化"}))
    print(f"ja partial '文字化' -> {st} total={b.get('total_count')}")
    st, b = api(base, ak, "GET", "/search.json?" + q({"q": "文字化", "issues": 1}))
    print(f"search.json '文字化' -> {st} total={b.get('total_count')}")
    # does search.json hit comments?
    st, b = api(base, ak, "GET", "/search.json?" + q({"q": "working on it", "issues": 1}))
    print(f"search.json comment phrase 'working on it' -> {st} total={b.get('total_count')}")

    # ---------- V-02 allowed statuses ----------
    print("\n### V-02 allowed statuses")
    st, b = api(base, ak, "GET", f"/issues/{fid}.json?include=allowed_statuses")
    iss = b.get("issue", {})
    print(f"issue {fid} (admin) -> {st} status={iss.get('status', {}).get('name')} "
          f"allowed={[s['name'] for s in iss.get('allowed_statuses', [])]}")
    for who, k in (("dev_tanaka", dev), ("rep_sato", rep)):
        st, b = api(base, k, "GET", f"/issues/{fid}.json?include=allowed_statuses")
        iss = b.get("issue", {})
        print(f"issue {fid} ({who}) -> {st} status={iss.get('status', {}).get('name')} "
              f"allowed={[s['name'] for s in iss.get('allowed_statuses', [])]}")
    # try a disallowed transition as reporter on an issue they can edit?
    # reporter can't edit others' issues; use dev on a status dev can't reach (e.g. Rejected)
    st, b = api(base, dev, "GET", f"/issues/{fid}.json")
    cur = b.get("issue", {}).get("status", {})
    print(f"dev current status: {cur}")
    st, b = api(base, dev, "PUT", f"/issues/{fid}.json",
                {"issue": {"status_id": 6, "notes": "try rejected"}})  # Rejected
    print(f"dev PUT status=Rejected -> {st} {json.dumps(b, ensure_ascii=False)[:200]}")
    st, b = api(base, dev, "GET", f"/issues/{fid}.json")
    print(f"after: status={b.get('issue', {}).get('status', {})}")

    # ---------- V-05 format & attachment ----------
    print("\n### V-05 format & attachment")
    st, b = api(base, ak, "GET", f"/issues/{fid+2}.json?include=journals")
    iss = b.get("issue", {})
    print(f"description raw (first 120): {iss.get('description', '')[:120]!r}")
    print(f"journals: {len(iss.get('journals', []))} first note: "
          f"{(iss.get('journals') or [{}])[0].get('notes', '')[:80]!r}")

    # upload a small png
    png = (b"\x89PNG\r\n\x1a\n" + bytes(64))
    req = urllib.request.Request(base + "/uploads.json?filename=test.png",
                                 method="POST", data=png)
    req.add_header("X-Redmine-API-Key", ak)
    req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req) as r:
            token = json.loads(r.read())["upload"]["token"]
        st, b = api(base, ak, "PUT", f"/issues/{fid}.json", {"issue": {
            "uploads": [{"token": token, "filename": "test.png",
                         "content_type": "image/png"}]}})
        st, b = api(base, ak, "GET", f"/issues/{fid}.json?include=attachments")
        att = (b.get("issue", {}).get("attachments") or [{}])[0]
        url = att.get("content_url", "")
        print(f"attachment content_url={url}")
        # unauthenticated fetch of content_url
        abs_url = url if url.startswith("http") else base + url
        req2 = urllib.request.Request(abs_url)
        try:
            with urllib.request.urlopen(req2) as r:
                print(f"no-auth fetch -> {r.status} bytes={len(r.read())}")
        except urllib.error.HTTPError as e:
            print(f"no-auth fetch -> {e.code}")
    except urllib.error.HTTPError as e:
        print(f"upload failed -> {e.code} {e.read()[:200]}")


if __name__ == "__main__":
    main()
