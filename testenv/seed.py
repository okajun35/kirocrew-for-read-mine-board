#!/usr/bin/env python3
"""Seed a Redmine test instance for redmine-board verification.

Usage: python3 seed.py <base_url> <admin_api_key> <output_env_json>

Creates: 2 projects, 2 users (developer/reporter) with API keys,
~160 issues across statuses/trackers/priorities, comments,
parent/child and relations. Stdlib only.
"""
import json
import random
import sys
import urllib.error
import urllib.request

random.seed(42)


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
        try:
            payload = json.loads(e.read() or b"{}")
        except Exception:
            payload = {"raw": "<unparseable>"}
        return e.code, payload


def must(status, body, what):
    if status >= 300:
        raise SystemExit(f"FAILED {what}: HTTP {status} {json.dumps(body, ensure_ascii=False)[:400]}")
    return body


def main():
    base, admin_key, out_path = sys.argv[1:4]

    statuses = api(base, admin_key, "GET", "/issue_statuses.json")[1]["issue_statuses"]
    trackers = api(base, admin_key, "GET", "/trackers.json")[1]["trackers"]
    prios = api(base, admin_key, "GET", "/enumerations/issue_priorities.json")[1]["issue_priorities"]
    roles = api(base, admin_key, "GET", "/roles.json")[1]["roles"]
    role_id = {r["name"]: r["id"] for r in roles}
    status_ids = [s["id"] for s in statuses]

    # --- projects ---
    projects = []
    for name, ident in [("Demo Alpha", "demo-alpha"), ("Demo Beta", "demo-beta")]:
        st, b = api(base, admin_key, "POST", "/projects.json", {"project": {
            "name": name, "identifier": ident, "is_public": True,
            "enabled_module_names": ["issue_tracking"],
        }})
        if st == 422:  # already exists
            st, b = api(base, admin_key, "GET", f"/projects/{ident}.json")
        projects.append(must(st, b, f"project {name}")["project"])

    # --- users ---
    users = {}
    for login, fn, ln in [("dev_tanaka", "Dev", "Tanaka"), ("rep_sato", "Rep", "Sato")]:
        st, b = api(base, admin_key, "POST", "/users.json", {"user": {
            "login": login, "firstname": fn, "lastname": ln,
            "mail": f"{login}@example.net", "password": "password123",
        }})
        if st == 422:
            st, b = api(base, admin_key, "GET", f"/users.json?name={login}")
            uid = must(st, b, f"find user {login}")["users"][0]["id"]
        else:
            uid = must(st, b, f"user {login}")["user"]["id"]
        st, b = api(base, admin_key, "GET", f"/users/{uid}.json?include=api_key")
        users[login] = {"id": uid, "api_key": must(st, b, f"key {login}")["user"]["api_key"]}

    # --- memberships ---
    for p in projects:
        for login, role in [("dev_tanaka", "Developer"), ("rep_sato", "Reporter"), ("admin", "Manager")]:
            uid = 1 if login == "admin" else users[login]["id"]
            st, b = api(base, admin_key, "POST", f"/projects/{p['id']}/memberships.json",
                        {"membership": {"user_id": uid, "role_ids": [role_id[role]]}})
            if st not in (200, 201, 204, 422):
                must(st, b, f"membership {login}@{p['identifier']}")

    # --- issues ---
    subj_ja = ["ログイン画面の表示崩れ", "検索結果が遅い", "通知メールが届かない",
               "CSVエクスポートの文字化け", "権限エラーの改善", "ダッシュボード刷新",
               "モバイル対応", "一括更新機能", "添付プレビュー", "権限管理の見直し"]
    subj_en = ["Fix login page layout", "Slow search results", "Missing notification mail",
               "CSV export mojibake", "Improve permission errors", "Dashboard redesign",
               "Mobile support", "Bulk update feature", "Attachment preview", "Review ACL admin"]
    descs = [
        "## 現象\n\n- 手順1: 画面を開く\n- 手順2: ボタンを押す\n\n**期待** と `実際` が違う。",
        "## Steps\n\n1. Open the page\n2. Click the button\n\nExpected differs from `actual`.",
        "h2. Textile style\n\n* item one\n* item two\n\n*bold* and _italic_ and @code@.",
        "Plain description. 関連: #1 を参照。再現環境は staging。",
        "",
    ]
    created = []
    open_ids = {p["id"]: [] for p in projects}
    n_issues = 170
    for i in range(n_issues):
        p = projects[i % 2]
        t = trackers[i % len(trackers)]
        ja = (i % 3 == 0)
        subj = (subj_ja if ja else subj_en)[i % 10] + f" (#{i+1})"
        body = {"issue": {
            "project_id": p["id"], "tracker_id": t["id"],
            "subject": subj, "description": descs[i % len(descs)],
            "priority_id": prios[i % len(prios)]["id"],
        }}
        if i % 4 == 0:
            body["issue"]["assigned_to_id"] = users["dev_tanaka"]["id"]
        elif i % 4 == 1:
            body["issue"]["assigned_to_id"] = users["rep_sato"]["id"]
        if i > 40 and i % 11 == 0 and open_ids[p["id"]]:
            body["issue"]["parent_issue_id"] = random.choice(open_ids[p["id"]])
        st, b = api(base, admin_key, "POST", "/issues.json", body)
        issue = must(st, b, f"issue {i}")["issue"]
        # move some to other statuses, add notes -> journals
        still_open = i % 5 == 0
        if not still_open:
            target = status_ids[i % len(status_ids)]
            notes = "進捗メモ: 対応中です。" if ja else "Progress note: working on it."
            st2, b2 = api(base, admin_key, "PUT", f"/issues/{issue['id']}.json",
                          {"issue": {"status_id": target, "notes": notes}})
            still_open = st2 >= 300  # rejected transitions keep it open
        if still_open:
            open_ids[p["id"]].append(issue["id"])
        created.append(issue)
        if (i + 1) % 25 == 0:
            print(f"  {i+1}/{n_issues} issues", flush=True)

    # --- relations ---
    for i in range(0, 30, 3):
        api(base, admin_key, "POST", f"/issues/{created[i]['id']}/relations.json",
            {"relation": {"issue_to_id": created[i + 1]["id"], "relation_type": "relates"}})

    env = {"base": base, "admin_key": admin_key,
           "users": users, "projects": [{"id": p["id"], "identifier": p["identifier"]} for p in projects],
           "statuses": statuses, "trackers": trackers,
           "issue_count": len(created), "first_issue_id": created[0]["id"]}
    with open(out_path, "w") as f:
        json.dump(env, f, ensure_ascii=False, indent=2)
    print(f"done: {len(created)} issues -> {out_path}")


if __name__ == "__main__":
    main()
