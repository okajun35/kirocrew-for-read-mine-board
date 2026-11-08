# Redmine Board for Kiro Crew（日本語版）

**非公式です。** Redmine プロジェクトとは関係なく、承認も受けていません。

Redmine のチケット検索・一覧・カンバンを [Kiro Crew](https://github.com/kirodotdev/KiroCrew) の中で使い、そのままチケットを Kiro のエージェントに渡せます。エージェントは MCP でチケットを読み、作業をして、結果をコメントとして Redmine に返します。書き込みは必ずあなたの承認を経ます。

**Human manages. AI executes. One board.**

- Redmine プラグイン不要。標準 REST API だけで動きます。
- あなた本人の Redmine API キーを使うため、Redmine の権限とワークフローがそのまま適用されます。
- Redmine **5.1.12** と **6.1.6** で動作確認済み。5.1 以降を推奨します。

## 機能

| | |
|---|---|
| 検索 | キーワード（件名・説明・コメントを対象）、`#123` でチケットを直接開く、プロジェクト / ステータス / 担当者での絞り込み。条件は保存されて次回も残ります。 |
| 一覧 | ソートとページネーションのあるテーブル。 |
| カンバン | ステータスごとの列と件数表示。ドラッグ＆ドロップは、Redmine であなたに許可されている遷移先だけに絞ります。 |
| 詳細 | サイドパネルに説明・コメント・履歴、添付ファイル、子チケット・関連チケット、元の Redmine へのリンク。 |
| Kiro に依頼 | 「調査して」「実装方針を考えて」「修正して」が、同梱エージェント `redmine-board-assistant` で**下書き**チャットを開きます。送信はあなたが押します。 |
| MCP ツール | `redmine_search`、`redmine_get_issue`、`redmine_list_statuses`、`redmine_list_projects`（読み取り専用・自動承認）。`redmine_add_comment`、`redmine_update_status`（毎回あなたの承認が必要）。 |
| 言語 | Kiro Crew の言語設定に合わせて日本語・英語を切り替えます。 |

## セットアップ

1. **Redmine の管理者:** 管理 → 設定 → API で「RESTによるWebサービスを有効にする」をオン。
2. **あなた:** Redmine の「個人設定」→「APIアクセスキー」→「表示」でキーをコピー。
3. **インストール**（App Store またはローカルから）:

   ```sh
   kirocrew app install /path/to/redmine-board
   ```

4. **信頼（trust）の付与。** バックエンドは Kiro Crew ゲートウェイ内で動くため、第三者アプリには信頼の付与が必要です。ダッシュボード → Apps → Redmine Board → *Trust*、または App Store からのインストール・有効化の際に出る確認で許可してください。
5. **有効化:** `kirocrew app enable redmine-board`（または Enable ボタン）。
6. サイドバーの **Redmine** → **設定** を開き、Redmine の URL と API キーを入れて「接続テスト」→「保存」。

## セキュリティ上の注意

- API キーはアプリのデータ領域（`~/.kiro/crew/apps/redmine-board/data/settings.json`、権限 0600）に保存されます。UI に返さず、ツールの結果やログにも出さず、Redmine へは `X-Redmine-API-Key` ヘッダーだけで送ります。
- 通信先は保存した base URL に限ります。UI とエージェントが指定できるのはパスとクエリだけで、ホストは変えられません。リダイレクトも追いません。ホストを変えると保存済みのキーは消えます。
- 設定の保存とボードからのステータス変更は所有者だけが行えます。アプリトークンからの呼び出しは拒否します。
- チケットの本文は信用できない入力です。MCP の結果では利用者が書いた文を `untrusted_content` に入れ、エージェントにはデータとして扱うよう指示し、書き込みツールは自動承認しません。
- 本文はホストのサニタイズ済み Markdown レンダラーで表示します。リンクは `http(s)` のみ開けます。

## 手元の Redmine で試す

```sh
docker run -d --name redmine6 -p 18082:3000 -e REDMINE_SECRET_KEY_BASE=change-me redmine:6
# REST API を有効にし、初期データ（ステータス・トラッカー・ロール）を投入
docker exec -e SECRET_KEY_BASE=change-me redmine6 rails runner \
  'Setting.rest_api_enabled = "1"; Redmine::DefaultData::Loader.load(language: "en"); puts User.find_by_login("admin").api_key'
# プロジェクト2件・ユーザー2人・チケット170件を投入（ユーザーのキーの出力先を表示）
python3 testenv/seed.py http://localhost:18082 <admin-api-key> /tmp/redmine-env.json
```

投入結果の出力は**アプリのディレクトリの外**に置いてください。`kirocrew app install` は作業ツリー全体をコピーするためです。

## 開発

```sh
python3 -m unittest discover -s tests                                  # コア + MCP（標準ライブラリのみ）
/path/to/KiroCrew/.venv/bin/python -m unittest discover -s backend/tests   # バックエンド（aiohttp が必要）
cd ui && npm install --legacy-peer-deps && npx tsc --noEmit -p . && npm run build
kirocrew app update redmine-board --source .
```

構成: `rb_core/`（Redmine クライアント・検索アダプター。標準ライブラリのみ・共有）、`backend/`（ダッシュボード用ルート）、`mcp/server.py`（stdio MCP サーバー）、`agents/` + `skills/`（同梱エージェント）、`ui/`（React。`ui/dist/index.mjs` はコミット済み）。設計と検証の記録は `docs/SPEC.md`、`docs/VERIFICATION.md`。

## ライセンス

MIT
