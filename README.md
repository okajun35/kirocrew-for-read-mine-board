# Redmine Board for Kiro Crew

**Unofficial.** Not affiliated with or endorsed by the Redmine project.

Search, list and kanban your Redmine issues inside [Kiro Crew](https://github.com/kirodotdev/KiroCrew), then hand an issue to a Kiro agent. The agent reads the issue over MCP, does the work, and posts the result back to Redmine as a comment — only after you approve the write.

**Human manages. AI executes. One board.**

- No Redmine plugin. Standard REST API only.
- Your own Redmine API key, so Redmine's permissions and workflow apply as-is.
- Tested against Redmine **5.1.12** and **6.1.6**. 5.1 or later is recommended.

## Features

| | |
|---|---|
| Search | Keyword (subject, description and comments), `#123` jumps to an issue, project / status / assignee filters. Filters persist across visits. |
| List | Sortable table with paging. |
| Kanban | One column per status, counts per column, drag & drop limited to the transitions Redmine allows you. |
| Detail | Side panel with description, comments and history, attachments, subtasks, relations, link to Redmine. |
| Ask Kiro | "Investigate" / "Plan the fix" / "Fix it" opens a **draft** chat with the bundled `redmine-assistant` agent. You press Send. |
| MCP tools | `redmine_search`, `redmine_get_issue`, `redmine_list_statuses`, `redmine_list_projects` (auto-approved, read-only); `redmine_add_comment`, `redmine_update_status` (need your approval every time). |
| Languages | Japanese and English, following the Kiro Crew language setting. |

## Setup

1. **Redmine admin:** Administration → Settings → API → enable *REST web service*.
2. **You:** in Redmine, *My account* → *API access key* → Show. Copy your key.
3. **Install** the app (from the App Store, or locally):

   ```sh
   kirocrew app install /path/to/redmine-board
   ```

4. **Trust** it. The backend runs inside the Kiro Crew gateway, so third-party apps need your trust: Dashboard → Apps → Redmine Board → *Trust*, or accept the trust prompt during install / enable from the App Store.
5. **Enable** it: `kirocrew app enable redmine-board` (or the Enable button).
6. Open **Redmine** in the sidebar → **Settings**. Enter the Redmine URL and your API key, press *Test connection*, then *Save*.

## Security notes

- The API key is stored in the app data directory (`~/.kiro/crew/apps/redmine-board/data/settings.json`, mode 0600). It is never sent to the UI, never appears in tool results or logs, and is sent to Redmine only in the `X-Redmine-API-Key` header.
- Requests go only to the saved base URL. The UI and the agent can pass paths and query parameters, not hosts. Redirects are not followed. Changing the host clears the saved key.
- Saving settings and changing a status from the board are owner-only. App tokens are refused.
- Issue text is untrusted input. MCP results put user-written text under `untrusted_content`, the agent is told to treat it as data, and write tools are never auto-approved.
- Issue bodies are rendered through the host's sanitizing Markdown renderer. Links open only for `http(s)`.

## Try it with a local Redmine

```sh
docker run -d --name redmine6 -p 18082:3000 -e REDMINE_SECRET_KEY_BASE=change-me redmine:6
# enable REST and load default data (statuses, trackers, roles)
docker exec -e SECRET_KEY_BASE=change-me redmine6 rails runner \
  'Setting.rest_api_enabled = "1"; Redmine::DefaultData::Loader.load(language: "en"); puts User.find_by_login("admin").api_key'
# seed 2 projects, 2 users and 170 issues (prints where it wrote the users' keys)
python3 testenv/seed.py http://localhost:18082 <admin-api-key> /tmp/redmine-env.json
```

Keep seed output **outside** the app directory: a local `kirocrew app install` copies the whole working tree.

## Development

```sh
python3 -m unittest discover -s tests                                  # core + MCP (stdlib only)
/path/to/KiroCrew/.venv/bin/python -m unittest discover -s backend/tests   # backend (needs aiohttp)
cd ui && npm install --legacy-peer-deps && npx tsc --noEmit -p . && npm run build
kirocrew app update redmine-board --source .
```

Layout: `rb_core/` (Redmine client, search adapter — stdlib only, shared), `backend/` (dashboard routes), `mcp/server.py` (stdio MCP server), `agents/` + `skills/` (bundled agent), `ui/` (React; `ui/dist/index.mjs` is committed). Design and verification notes: `docs/SPEC.md`, `docs/VERIFICATION.md`.

## License

MIT
