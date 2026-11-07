# Redmine Board — 実装前の検証計画

[SPEC.md](SPEC.md) の `【要検証 V-xx】` を確定させるための検証項目。**ここに書いた「予想」は記憶や推測であり、事実として扱わないこと。** 検証したら「結果」欄を埋め、SPEC.md の該当箇所を確定版に直す。

進め方: V-06（検証用の Redmine 環境）を最初に作り、Redmine 側（V-01〜V-05）と Kiro Crew 側（V-07〜V-10）を並行して進める。設計が一番ぶれるのは V-01 と V-02。

## 検証環境

- Redmine: 公式 Docker イメージ（`redmine:<版>`）。少なくとも **5.1 系**と **6.x 系**の2つ。余力があれば 4.2 系
- REST API を有効にする（管理 → 設定 → API →「RESTによるWebサービスを有効にする」）
- 投入データ: REST API で入れるスクリプトを作る（デモ用データと兼用）
  - プロジェクト2つ、トラッカー2つ、ステータス5つ程度、ワークフロー（遷移を一部制限する）
  - 権限の違うユーザー2人（例: 開発者と報告者）と、それぞれの API キー
  - チケット 150 件以上（ページネーション確認用）。日本語と英語の件名・本文、コメント付き、親子関係・関連あり
  - 書式の違う本文（Textile と Markdown/CommonMark）
- Kiro Crew: 手元のゲートウェイ。検証用のアプリ雛形は `kirocrew app init` で作る

## Redmine 側

### V-01 キーワード検索と絞り込みの組み合わせ

- **疑問**: 「キーワード + プロジェクト + ステータス + 担当者」を1回の API でできるか
- **予想（未確認）**:
  - `/search.json?q=...` は全文検索できるが、ステータスや担当者で絞れない
  - `/issues.json` は絞り込みに強いが、キーワードは件名の部分一致（`subject=~...`）程度。新しい版には件名・説明・コメントをまとめて検索するフィルター（`any_searchable` のような名前）があったと記憶している
- **確認方法**: 各版で次を試し、結果の件数と内容を比べる
  - `/search.json?q=<語>&issues=1&scope=...` の結果の形と、コメント内の語がヒットするか
  - `/issues.json?subject=~<語>&status_id=...&assigned_to_id=...`
  - `/issues.json?any_searchable=~<語>`（存在するか、どの版からか）
  - 日本語の語でのヒット（部分一致・分かち書きの影響）
- **決めること**: Search Adapter の方式（版ごとに使い分けるか、`search.json` の結果 ID を `issues.json?issue_id=1,2,3` で取り直して絞るか）
- **結果**

  （2026-11-07 検証済み: 5.1.12 / 6.1.6、各170件投入・testenv/verify_redmine.py）
  - `/issues.json?any_searchable=~<語>` は**両バージョンで存在**し、件名+説明+コメント(journals)を横断検索する（`search.json` と同じ45件ヒット）。status_id/assigned_to_id/project_id と**1リクエストで併用できる**
  - `subject=~` は件名のみ（コメント内の語は0件）
  - `search.json?q=<語>&issues=1` は全文検索。`projects[]=` でプロジェクトを絞れる（demo-beta 絞りで17件に一致）。status/担当者の絞り込みは不可
  - `issues.json?issue_id=1,2,3` で ID 指定の取り直しができる → search.json → issues.json の2段構成も可能
  - **存在しないフィルター名（例 `searchable=`）は黙って無視され全件返る** → Adapter は機能検出で経路を選ぶ必要がある
  - **`issues.json` はデフォルトでオープン状態のチケットのみ返す**（170件中126件）。`status_id=*` で全件
  - 日本語の部分一致は `~` で有効
  - **決定**: キーワードは `any_searchable=~` を主経路とし、他の絞り込みと同一リクエストで送る。`any_searchable` を受理しない版では `search.json` → `issue_id` 取り直しにフォールバック

### V-02 許可されたステータス遷移の取得

- **疑問**: あるチケットを、今のユーザーが**どのステータスへ変えられるか**を API で取れるか
- **予想（未確認）**: `/issues/<id>.json?include=allowed_statuses` が 5 系で追加されたと記憶している。それより古い版では取れない
- **確認方法**:
  - 各版で `include=allowed_statuses` の有無と、ワークフローや権限の違うユーザーで結果が変わるか
  - **許可されていない遷移で更新したとき**の応答（422 でエラーが返るのか、200 で黙って無視されるのか）。黙って無視される場合は、更新後に取り直して確認する必要がある
- **決めること**: D&D の実装方式と、対応版の下限（D-2, D-4）
- **結果**

  （2026-11-07 検証済み: 5.1.12 / 6.1.6）
  - `GET /issues/<id>.json?include=allowed_statuses` は**両バージョンで動作**。ユーザーごとに結果が変わる（admin/dev_tanaka: [New,In Progress,Resolved,Feedback]、rep_sato: [New] のみ。ワークフローと権限が効いている）
  - **許可されない遷移の PUT は 204 で黙って無視される**。取り直すと status は変わっていない。ただし同時に渡した `notes` は journal に**記録されてしまう**（副作用が残る）
  - **決定**: D&D は `allowed_statuses` ベースで実装可能（ドロップ先を遷移可ステータスに限定）。更新後は必ずチケットを取り直して確定を確認する。notes 付き更新は失敗時にコメントだけ残ることを UI で考慮

### V-03 認証と本人確認

- **確認方法**:
  - `X-Redmine-API-Key` ヘッダーでの認証（クエリの `key=` はログに残りやすいので使わない）
  - `/users/current.json` で返る項目（名前、ログイン名、管理者かどうか）
  - REST API が無効なときの応答（接続テストで分かりやすく表示するため）
  - 無効なキーのときの応答（401 か 403 か）
- **結果**

  （2026-11-07 検証済み: 5.1.12 / 6.1.6）
  - `X-Redmine-API-Key` ヘッダーで認証できる。`/users/current.json` は login, firstname, lastname, mail, admin, api_key などを返す
  - 無効なキー / キー無し → **401**
  - REST API 無効時 → 認証が要るエンドポイントは **403**（`rest_api_enabled=0` は API キー認証自体を無効にする。`application_controller.rb:128`）
  - 注意: REST 無効でも anonymous が読める public project の `issues.json` は 200 を返す → **接続テストは必ず `/users/current.json` を使う**

### V-04 ページネーションと上限

- **確認方法**: `limit` の上限（100 と記憶しているが未確認）、`offset`、`total_count` の返り方。上限を超える `limit` を渡したときの動き
- **決めること**: カンバンの列ごとの件数表示の方法（列ごとに `limit=1` で `total_count` を取るか）
- **結果**

  （2026-11-07 検証済み: 5.1.12 / 6.1.6）
  - `limit` の上限は **100**。超過を渡すとエラーなく 100 にクランプされる（limit=200 → 100件返却）
  - `offset` / `total_count` / `limit` はレスポンスに含まれる
  - **決定**: カンバンの列ごとの件数は `status_id=<id>&limit=1` の `total_count` で取得する

### V-05 本文の書式と添付

- **確認方法**:
  - API が本文を**生のテキスト**で返すこと（HTML ではない）と、サーバーの書式設定（Textile / Markdown / CommonMark）を API で知る方法があるか
  - Redmine 独自の記法（`#123` のチケットリンク、`r123` のリビジョンなど）をどう表示するか
  - 添付ファイルの `content_url` が認証なしで取れるか（取れなければ、バックエンド経由で中継するか、リンクだけにする）
- **決めること**: 使うレンダラー（Textile をサポートするか、Markdown だけにするか）とサニタイズの方法
- **結果**

  （2026-11-07 検証済み: 5.1.12 / 6.1.6）
  - description は**生テキスト**で返る（CRLF 改行）。サーバーの書式設定（`text_formatting`）を API から読む方法は無い。検証環境は両方 common_mark
  - 5.1.12 の format_names: `[textile, markdown, common_mark]`、6.1.6: `[textile, common_mark]`（textile は RedCloth 同梱時のみ有効）
  - 添付の `content_url` は絶対URL `/attachments/download/<id>/<name>`。**public project では認証なしで取得できた**（anonymous で 200）。private project ではキーが必要と想定される
  - **決定**: レンダラーは CommonMark 優先 + サニタイズ。古いサーバー由来の Textile 本文は生テキスト表示に留める。添付画像は MVP ではリンクのみ（認証が要る場合に備え、将来は backend 経由で中継）

### V-06 対応版の決定

- **確認方法**: V-01〜V-05 を 5.1 系と 6.x 系で実施し、差分を表にする。4.2 系は余力があれば
- **決めること**: 対応版の下限と、版判定の方法（API で版が取れない場合は、機能の有無で判定する）
- **結果**

  （2026-11-07 検証済み）
  - 実機検証した版: **5.1.12.stable**（Docker `redmine:5.1`）、**6.1.6.stable**（`redmine:6`）。V-01〜V-05 の差分は実質ゼロ
  - API からバージョンを取得する方法は無い → **機能検出**で分岐する（`allowed_statuses`・`any_searchable` の有無で判定）
  - **決定**: 対応版の下限は Redmine 5.1 系を推奨とし、機能検出でフォールバック/非対応表示にする。4.2 系は未検証・非対応とする

## Kiro Crew 側

### V-07 チャットへの引き渡し（F-06）

- **根拠**: `docs/app-kit/getting-started.md` に `openChat({ message, autoSend: false })`、`api-reference.md` に `useChatLauncher().openChat(options)` の記載がある
- **確認方法**:
  - アプリのページから呼べるか、必要な `permissions` は何か
  - 新しいチャットのエージェントを指定できるか（同梱エージェントで開きたい）
  - 長い本文を渡したときの上限
- **結果**

  （2026-11-07 コード確認: website/src/app-sdk/index.ts）
  - `ChatLaunchOptions = { agent?, message?, slotKey?, autoSend?, memoryMode?, sessionFolder? }`。`openChat({agent, message, autoSend:false})` で**新規ドラフト**が開き、送信は人が行う。**`agent` でエージェントを指定できる**
  - `autoSend:false` または `memoryMode`/`sessionFolder` 指定で新規ドラフトセッションになる（intent は `window.__mc_chat_launch` に10秒間保持）
  - メッセージ長の上限は記述なし → 仕様どおり長文は渡さず MCP ツールで取得させる設計で問題ない
  - 権限: UI SDK 経由で特別な permission の記述なし（実機で最終確認）

### V-08 Bot への実行依頼と状態取得（F-07）

- **根拠**: `api-reference.md` の Agent Runtime に `dispatchAgent` / `dispatchAgentAsync(agent, prompt)` / `getTaskResult(taskId)` がある。別途 `permissions.spawn`（`ctx.spawn`）もある
- **確認方法**:
  - `agent` に渡せるのはテンプレート名か Bot（メンバー）名か。Bot のメモリやワークスペースが使われるか
  - 必要な `permissions` と、所有者の承認が要るか
  - `TaskResult` の状態の種類と、結果の取り出し方。ゲートウェイ再起動後もタスク ID で取れるか
  - 実行中のツール承認がどこに出るか（承認待ちで止まるか）
- **決めること**: F-07 を MVP に入れられるか
- **結果**

  （2026-11-07 コード確認: packages/kirocrew-client-py, src/kiro_crew/apps/spawn_sdk.py）
  - `dispatchAgentAsync(agent, prompt)` = `POST /api/spawn {task, agent}` → spawn id。`getTaskResult(taskId)` = `GET /api/spawn/{id}`
  - `ctx.spawn`（`permissions.spawn` 必須）経由では **agent 名は必須で、アプリ自身のエージェント**に限る。空名や他アプリのエージェントは拒否される
  - **重要**: 無人 spawn は `approval_mode="auto"` で、承認プロンプトは出ない。書き込みツールもエージェントの tools にあれば自動承認される → バックグラウンド実行するエージェントの tool 面で制御する設計が必要（F-07 の「承認つき」はこの枠組みでは人の画面操作を挟めない）
  - `ctx.spawn.is_done(spawn_id)` で完了判定可
  - 未確認（実装時に実機で）: `GET /api/spawn/{id}` の状態語彙、再起動後の永続性

### V-09 API キーの保管場所

- **根拠**: `manifest-reference.md` によると、`secret://` の値はアプリのサーバーにはまだ解決されない（扱いが未決）。`api-reference.md` に `get_app_data_dir()` がある
- **確認方法**:
  - アプリのデータ領域（`~/.kiro/crew/apps/<name>/data/` 相当）に 0600 で置いたファイルを、backend と MCP サーバーの**両方**から読めるか
  - アプリの更新（`kirocrew app update`）で消えないか
  - サンドボックスの設定によって MCP サーバーから読めなくなる場合があるか
- **結果**

  （2026-11-07 for-takt 実績で確認）
  - backend・MCP ともに `Path(__file__).resolve().parent.parent / "data"`（= `~/.kiro/crew/apps/<name>/data`）で**同一ファイルを読める**。for-takt で稼働実績あり（data/goals/*.json が backend/MCP の両方から書かれている）
  - `kirocrew app update`（22:31 実施）後も data/ のファイルは残ることを実測確認
  - 0600 はアプリ側で chmod する
  - 残確認: サンドボックスモードで MCP サーバーから読めなくなるか（V-10 と一緒に実機で）

### V-10 MCP サーバーから社内ネットワークへの通信

- **確認方法**:
  - 同梱 MCP サーバー（stdio）から、手元の Docker の Redmine（`localhost` やプライベート IP）に通信できるか
  - サンドボックスのモードによってネットワークが制限されるか
  - 書き込みツールを `allowedTools` に入れない場合に、承認がどう表示されるか
- **結果**

  （2026-11-07 ドキュメント・コード確認の範囲では禁止規定なし）
  - sandbox はエージェントのコマンド実行向けの仕組み（src/kiro_crew/sandbox_*.py）。MCP stdio サーバーはエージェントプロセスの子として起動し、ソース上 sandbox 適用の記述は見当たらないが、ランタイム依存の可能性が残る
  - **実機確認は F-09 実装時のスモークテストで行う**（MCP ツールから localhost:18081 の Redmine に接続）
  - **2026-11-08 実機で確認済み**（Kiro Crew 0.13.0、acp_backend=devin 3000.12.17、Redmine 6.1.6 on localhost:18082）: 「Kiro に依頼」→ 同梱エージェントのチャットから `redmine_get_issue` / `redmine_search`（`any_searchable=~…&status_id=*`）が届き、`redmine_add_comment` で #1 に journal が付いた（15:34:44Z、Dev Tanaka 名義）。localhost への通信は問題なし
  - 途中の失敗: ①`openChat({agent})` にインストール後のファイル名 `redmine-board--…` を渡すと「Bot '…' is unavailable」。宣言された `name` を渡す必要がある ②一時的に devin の「permission bridge failed closed」で接続が切れた（Kiro Crew 側。利用者が手元で解消）

### V-11 同梱エージェントとスキルの読み込み

- for-takt で確認済みの点を流用する（`.devin/skills/kirocrew-app-dev/SKILL.md` 参照）。新しく確認するのは、エージェントが `openChat` で開いたチャットから使えるかだけ
- **結果**

  （2026-11-07 確認）for-takt の知見（SKILL.md）を流用可能。`openChat` の `agent` オプションで同梱エージェントを指定できることを V-07 で確認

### V-12 trust と backend の読み込み

- for-takt と同じく、Python の `backend.hooks` は所有者の trust 付与が必要。ストア経由でインストールした場合の trust の流れ（利用者に何をしてもらうか）を確認し、README に書く
- **結果**

  （2026-11-07 確認）for-takt と同じ構成を使う。ストア経由インストール時の流れ: インストール → owner が Trusted Apps で trust 付与 → `kirocrew app enable`。README にこの手順を書く

## 検索とボードの再設計（[SPEC-search-board.md](SPEC-search-board.md)）

確認時点: 2026-11-08。検証用データを追加（バージョン2件・カテゴリ2件・カスタムフィールド「Customer」・公開クエリ・非公開クエリ・ウォッチ）。スクリプト: `testenv/seed_search.py`、`testenv/verify_search.py`。結論は 5.1.12 / 6.1.6 で**同じ**。

### V-15 REST での汎用フィルタ（`f[]` / `op[]` / `v[]`）

- **疑問**: 画面のフィルタと同じ `f[]=status_id&op[status_id]==&v[status_id][]=2` の形が `issues.json` で通るか
- **結果**: **通る。ただし効く項目と効かない項目がある**

| 項目 | `f[]`/`op[]`/`v[]` | 直接パラメーター | 備考 |
|---|---|---|---|
| `status_id`, `tracker_id`, `assigned_to_id`, `fixed_version_id`, `parent_id`, `done_ratio`, `subject`, `cf_N` | ○ | △ | 複数値・否定（`!`）は `f[]` 側しかできない（直接側は `status_id=!1,2` や `tracker_id=1,2` が効かない） |
| 日付（`created_on` など） | **✕ 黙って無視** | ○ | `t`・`w`・`lw`・`>t-`・`<t-`・`><`・`<=` どの書き方でも 170 件全部。直接側 `created_on=t`・`created_on=><a\|b`・`created_on=>t-14` は効く |
| `watcher_id` | **✕** | **✕** | `watcher_id=me` も黙って無視（5.1/6.1 とも） |

その他の確かめた動き:

- `f[]` を1つでも付けると、既定の「未完了だけ」が**効かなくなる**。状態は必ず自分で送る
- 存在しない項目名 → **黙って無視**（170件全部）。項目名はアプリ側で検証する
- 存在しない演算子 → **404**（URL エンコード漏れだと 400）。演算子もアプリ側で検証する
- 項目どうしは AND（未完了∩トラッカー2 = 35 < 125, 57）
- `any_searchable` の複数語 `~a b` は**句として探して 0 件**。`any_searchable` を2回送ると**後のものだけが効く**。つまり AND な複数キーワードは 1 回の REST では書けない → backend がキーワードごとに投げて issue id の積集合を取る
- `!~語`（否定）は効く（170 − 11 = 159）

### V-16 カスタムフィールド

- **結果**: ○

| 確認 | 5.1 / 6.1 |
|---|---|
| `cf_1=ACME`（直接） | ○ 29件 |
| `f[]=cf_1&op[cf_1]==&v[cf_1][]=ACME` | ○ 同じ 29件 |
| `cf_1=*`（値あり） | ○ 85件 |
| 一般利用者 `/custom_fields.json` | **403** |
| 一般利用者 `/projects/<id>.json?include=issue_custom_fields` | **○**「Customer」が取れた → メタデータはここから |
| チケット JSON の `custom_fields` | id と名前の両方入る |

### V-17 Redmine の保存クエリ

- **結果**: ○ ただし併用不可

| 確認 | 結果 |
|---|---|
| `/queries.json` | 200。自分のクエリ + 公開クエリが返る（他人の非公開は返らない） |
| `issues.json?query_id=8` | ○ 32件、同等の手動フィルタと一致 |
| `query_id` + `status_id` 等の追加条件 | **追加条件は黙って無視**（件数変わらず） → S-3 確定: 保存クエリ利用中はチップ編集を無効化 |
| 他人の非公開クエリ | 403 |

### V-18 件数パネルの速さ

- **結果**: 20 値 × `limit=1` を 6 並列で **0.39 秒（5.1）/ 0.50 秒（6.1）**、1本あたり約 0.1 秒（ローカル、170件）
- 実用可能。リモート環境ではレイテンシが効くので上限 20 値・5分キャッシュはそのまま

### V-19 担当者・バージョン・優先度の書き換え

- **結果**: ○

| 確認 | 結果 |
|---|---|
| 開発者ロールで `assigned_to_id` 変更 | 204、反映される |
| `fixed_version_id`・`priority_id` 変更 | 204、反映される |
| 存在しない user id | **422**（黙って無視ではない。ただし取り直して確かめる設計は維持） |
| 一般利用者 `/projects/<id>/memberships.json` | ○ 担当できるメンバーはここから取れる |
| 一般利用者 `/enumerations/issue_priorities.json` | ○ |
| バージョン一覧 | `project.json?include=versions` では取れない。**`/projects/<id>/versions.json` を使う** |
| `allowed_statuses` | ○（V-04 と同じ） |

### V-21 `/queries/<id>.json` の `filters`

- **確認方法**: 保存クエリの条件（項目・演算子・値）が REST で読めるか。読めれば「条件をコピーして自分のビューにする」が作れる
- **結果**: （未確認）

### V-20 `ctx.spawn` で検索式を作らせる

- **確認方法**: `permissions.spawn` を付けたときの所有者の承認の流れ、`ctx.spawn.run()` の id から結果の文字列を取る方法、所要時間、失敗時の扱い
- **結果**: （未確認。実装時に試す）

## 応募・公開

### V-13 Kiroween 2026 の応募要件

- 締め切り、提出物（動画・README・リポジトリ）、Kiro の利用が必須か、ライセンスの条件、審査基準
- **結果**

  （2026-11-07 kiroween.devpost.com 確認）
  - 提出期間: **2026-10-30 〜 2026-12-04 14:00 PT**（延長なし）。審査 12/16〜、発表 2027-02-03 頃
  - 要件: ①期間内に新規で作ったプロジェクト ②**公開 GitHub リポジトリ**（ルートに `/.kiro` ディレクトリ必須・.gitignore 不可・ライセンス検出） ③working application URL ④機能説明文 ⑤**3分未満の公開 YouTube デモ動画** ⑥Kiro をどう使ったかの記述 ⑦第三者商標・著作物の権利処理
  - 「Redmine」の名称・ロゴは第三者商標に該当 → D-5 で非公式表記＋権利処理を要検討
  - "working application URL" がローカルアプリにどう適用されるかは不明 → Devpost の提出フォーム詳細を要確認

### V-14 ストア掲載の要件

- `docs/app-kit/publishing-guide.md` の §14 チェックリスト（アイコン 512×512・不透明、スクリーンショットとヒーロー画像、`ui/dist` のコミット、README など）
- listing request は `kirodotdev/KiroCrew` の issue テンプレート `app-store-listing.yml` から出す。処理は遅い（2026-11 時点で、2か月以上 OPEN の申請がある）ので、締め切りに掲載を間に合わせる前提にしない
- 名前に "Redmine" を使う場合の扱い（「非公式」の明記）
- **結果**

  （2026-11-07 publishing-guide.md §14 確認）
  - チェックリスト: app.json 検証（kebab-case/semver）、パスに `..`/絶対パスなし、最小 permissions、アイコン 512x512・不透明、スクリーンショット+ヒーロー画像、tags 小文字、`ui/dist/index.mjs` コミット、agent/skill の JSON・frontmatter 妥当、install スクリプト非対話・冪等・300s 以内、onUninstall、README、ローカルからの install/enable がクリーン
  - listing request: `kirodotdev/KiroCrew` の issue テンプレート `app-store-listing.yml`。処理は遅い（2か月超 OPEN あり）→ **Kiroween 締め切りに掲載を間に合わせる前提にしない**
