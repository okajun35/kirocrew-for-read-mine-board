---
name: kirocrew-app-dev
description: Know-how for building, installing, and publishing Kiro Crew external apps (App Kit) — app.json, Python backend hooks, stdio MCP servers, bundled agents/skills, React UI bundles, turning an app agent into a Bot, and App Store listing. Learned from building the for-takt app. Use when starting or changing any Kiro Crew app (e.g. redmine-board, for-takt).
---

# Kiro Crew アプリ開発の知見（for-takt から）

先行アプリ for-takt（`/home/hddwm390/tmp/KiroCrew-app/for-takt`）で実際に動かして確かめたこと。新しいアプリはこの構成をそのまま流用してよい。ここに書いていない仕様は推測せず、Kiro Crew のドキュメントを読むこと。

## 正本の場所

- App Kit のドキュメント: `/home/hddwm390/tmp/KiroCrew/docs/app-kit/`
  - `getting-started.md`、`manifest-reference.md`（app.json の全項目）、`api-reference.md`（UI SDK と backend の ctx）、`publishing-guide.md`（ストア掲載）
- エージェント spec の項目: `/home/hddwm390/tmp/KiroCrew/src/kiro_crew/docs/agent-spec-fields.md`
- **手元の Kiro Crew は upstream より古いことがある**（2026-11 時点で 202 コミット遅れていた）。仕様の判断や issue の提出の前に `git fetch` して `origin/main` のコードも確認する

## 構成（for-takt で動作確認済み）

```
app.json                  マニフェスト
agents/<agent>.json       同梱エージェント（<app>--<agent> として実体化される）
skills/<skill>/SKILL.md   同梱スキル（frontmatter 必須）
mcp/server.py             stdio MCP サーバー（標準ライブラリのみ）
<core>/                   backend と MCP で共有するロジック
backend/routes.py         register_routes(ctx)
backend/handlers.py       ルートの処理
ui/                       Vite + React + TS。ui/dist/index.mjs をコミット
assets/icon.png           ストア用アイコン（512x512・不透明）
```

参考になる app.json: `for-takt/app.json`。`permissions.api` は `["/api/apps/<name>"]` だけで足りた。

## backend（Python の `backend.hooks.routes`）

- `"backend": {"hooks": {"routes": "backend.routes:register_routes"}}`。アプリのディレクトリを根にした合成パッケージとして読み込まれるので、**import は相対 import だけ**（`from . import handlers`）
- `register_routes(ctx)` は `(method, path, handler)` のリストを返す。パスは `/api/apps/<name>/` の下になる。**パスパラメーターは使わず**、GET はクエリ、POST は JSON ボディで受ける
- `ctx.sdk_level` が足りなければ `ctx.health.mark_degraded(...)` で知らせる
- 書き込みルートは `ctx.require_owner` で所有者に限る。**`require_owner` が無い環境では 403 で拒否する（fail closed）**。アプリトークンからの呼び出しも拒否する（for-takt の `app_token_forbidden`）
- 日本語を返すので `json.dumps(..., ensure_ascii=False)`
- アプリの状態はアプリのデータ領域に置く（`ctx.data_dir` / `get_app_data_dir()`）
- **第三者アプリの backend hooks はゲートウェイの権限で動くため、利用者の trust 付与が必要。** 付与しないと `Refusing to load third-party app '<name>'` で読み込まれない。付与はダッシュボードの Trusted Apps か、`~/.kiro/crew/config.local.json` の `{"agent": {"apps_trusted": [...], "apps_trusted_local": [...]}}`
- backend はゲートウェイの venv で動くので `aiohttp` や `PyYAML` が使える。テストは `/home/hddwm390/tmp/KiroCrew/.venv/bin/python -m unittest discover -s backend/tests`

## MCP サーバー

- `"mcpServers": {"<server>": {"command": "python3", "args": ["mcp/server.py"]}}`
- **素の `python3` で動くため `mcp` パッケージも PyYAML も無い。** 改行区切りの JSON-RPC 2.0 を自前で実装し、標準ライブラリだけで書く。backend と共有するコアも、MCP から import される部分は標準ライブラリだけにする。確認方法: PyYAML を import できない状態で `mcp/server.py` を import するテストを置く
- ステートレスにする。要求をまたぐ状態（実行中プロセスの PID など）はデータ領域のファイルに書く
- エージェントからは `@<app>:<server>` で参照する。ツール単位は `@<app>:<server>/<tool>`
- **読み取りツールだけを `allowedTools`（自動承認）に入れる。** 書き込みは承認を通す
- 外部コマンドの出力を読むときは `Popen(..., encoding="utf-8", errors="replace")`

## 同梱エージェントとスキル

- `agents/<x>.json` の `name` は短い名前（例 `takt-manager`）。インストール後は `<app>--<x>`（例 `for-takt--takt-manager`）になる
- **スキルは `resources` に明示しないとエージェントから見えない。** 実際にここで詰まった:
  ```json
  "resources": ["skill://~/.kiro/crew/skills/<app>/<skill>/SKILL.md"]
  ```
- `tools` には `"@kirocrew-core"` と自分の MCP サーバーを入れる
- 例: `for-takt/agents/takt-manager.json`、`for-takt/skills/takt-goal-manager/SKILL.md`（定期起床時の振る舞いの書き方も参考になる）

## UI

- Vite のライブラリビルドで `dist/index.mjs` を1ファイル出力する。設定は `for-takt/ui/vite.config.ts` をそのまま使う。`react`、`react-dom`、`react/jsx-runtime`、`@kirocrew/app-sdk`、`@kirocrew/app-sdk/ui`、`lucide-react`、`@tanstack/react-query` は external にする（ホストが提供する）
- **`@kirocrew/app-sdk` は npm に無い**ので `npm install --legacy-peer-deps`。ビルド結果の `ui/dist/` はコミットする（`.gitignore` で除外しない）
- API 呼び出しは `useAppApi()`、部品は `@kirocrew/app-sdk/ui`、取得と更新は React Query
- 文言は1ファイル（for-takt は `ui/src/strings.ts`）にまとめる。**ストアに出すなら最初から ja/en の両方を用意する**（for-takt は日本語だけで作ってしまい、後から直す必要が出た）
- ポーリングはページが非表示のあいだ止める。書き込みには `expectedRevision` を付け、409 なら取り直して再試行を促す

## インストールと更新

```
kirocrew app install <dir>
kirocrew app enable <name>            # trust 付与のあと
kirocrew app update <name> --source <dir>
```

- **`app install` / `app update` は作業ツリーを丸ごとコピーする。`.gitignore` は見ない**（除外は `node_modules`・`.git`・`__pycache__`・`.venv` だけ）。テスト用の鍵や `.env` をアプリのディレクトリに置くと、インストール先にも入る（redmine-board で実際に起きた）。秘密はアプリの外に置く
- **ホストの Tailwind はホスト自身のソースしか走査しない**（`website/src/index.css` の `@source`）。アプリだけが使うクラス（`text-[13px]` など）は効かないことがある。レイアウトに効くものは `style` と CSS 変数（`var(--card)`、`var(--border)`、`var(--muted)`、`var(--accent)`、`var(--bg-hover)`）で書く
- `@kirocrew/app-sdk/ui` の `MarkdownRenderer`（サニタイズ込み）や、`@kirocrew/app-sdk` の `activeLocale` / `fmtDateTime` / `useLanguageGeneration` が使える。古いホストで無い名前を名前付き import すると bundle ごと読めなくなるので、`import * as sdk` で読んで無ければ代替する
- **インストールされたコピーは `~/.kiro/crew/apps/<name>/` にあり、実行時のデータもそこに書かれる。** リポジトリ側の `data/` を見ても実データは無い（ここで一度見間違えた）
- エージェントやスキルを変えたら `app update` を忘れない

## アプリのエージェントを Bot（常設メンバー）にする

- 「新しい Bot」ダイアログは組み込みの worker テンプレートでしか作れない（意図された仕様）
- 作った後、Bot のエディタの **「Built from」で `<app>--<agent>` に切り替える**。API なら `PUT /api/agents/<bot>` に `{"kiro_agent": "<app>--<agent>", "expected_kiro_agent": "<今の値>"}`。今の値が違うと `stale_binding` になる（作成直後は Bot 専用 spec の名前になっている）。メソッドは POST ではなく PUT
- Bot の名前はテンプレート名と同じにできない（`template_name_in_use`）
- テンプレート一覧の「Enroll」は、2026-11 時点ではどのテンプレートでも失敗する（upstream issue kirodotdev/KiroCrew#32346）
- 自動で任せてもらうには、Bot の「トリガー」に任せたい仕事を書く
- 定期起床: `kirocrew cron add <job> "<prompt>" --every 1800 --agent <bot>`
- チャネル（Slack など）では会話内で `/agent <bot>`
- API を手で叩くときのトークンは `kirocrew token`。**期限が切れる**ので、長い作業の途中で 401 になったら取り直す

## テストと検証の教訓

- **テスト用のデータは実物の形に合わせる。** for-takt では TAKT の `tasks.yaml` を配列だと思ってテストを書いたが、実物は `{"tasks": [...]}` だった
- **単体テストが通っても、本物で一周通すまで完了としない。** for-takt では実際に一周回したときに初めて、「タスクのブランチ名は実行時に決まるので、投入時の記録では空」という前提違いが見つかった
- 外部の CLI を探すときは `環境変数 → PATH → nvm の最新` の順に探す（nvm 経由の Node ツールは PATH に無いことがある）
- 切り離して起動したプロセスの生存確認では、ゾンビプロセスを「死んでいる」と判定する
- 画面のスクリーンショットは Kiro Crew の `website/` に入っている Playwright と Chromium で撮れる。アプリのページはポーリングし続けるので `networkidle` ではなく `domcontentloaded` で待ち、アプリの要素が出るまで待つ

## ストア掲載（公式カタログ）

- 掲載先は `kirodotdev/KiroCrewApps` だが、外部の作者は PR を出せない。`kirodotdev/KiroCrew` の issue テンプレート `app-store-listing.yml`（App Store listing request）で依頼する
- 個人の第三者アプリも掲載されている（2026-11 時点で32件中、約10件）。ただし処理は遅く、2か月以上 OPEN の申請がある
- 要件は `publishing-guide.md` §14: アイコン 512x512・不透明（`kirocrew app init` が生成する仮アイコンは差し替える）、スクリーンショットとヒーロー画像（16:9、例 1200x675）を `app.json` に宣言、`ui/dist/index.mjs` のコミット、README など
- 他者のツールやサービスと連携するアプリは、README と説明文に「非公式」と書く

## このユーザーの環境

- Kiro Crew 本体: `/home/hddwm390/tmp/KiroCrew`
- アプリ: `/home/hddwm390/tmp/KiroCrew-app/`（`for-takt`、`redmine-board`、参考用の `kirocrew-app-aidlc`）
- 会話は日本語。説明はわかりやすい日本語で、確認していないことは推測だと明記する
