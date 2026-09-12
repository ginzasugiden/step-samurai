# ステップ侍 × ECOS：楽天レビュー自動取得 & 注文者突き合わせ — 作業レポート

作成日: 2026-09-12 / 実行: Claude Code（Fable=Orchestrator, Sonnet=Executor）

## STEP0 事前バックアップ（完了）

| 対象 | 内容 | 値 |
|---|---|---|
| ECOS | ブランチ | `feature/review-ingest`（`main` ed659e9 から作成） |
| ECOS | pg_dump（ecosresident の Postgres） | `X:\projects\ECDashboard\backups\pre-review-ingest-202609121314.sql`（15.1MB, 55 テーブル。orders=184, reviews=65, workspaces=1） |
| step-samurai | ブランチ | `feature/review-webhook`（`master` から作成） |
| step-samurai | ロールバック点 | `clasp pull -u ginzasugiden` の結果はローカル `gas/src` と完全一致（差分なし）→ **3d052f86aa274503965cdc4dc5d5f764334c719e** |
| テナントシート | 複製 | `step-samurai_backup_20260912` → ID **1USf3yiQ6asaMP5_yPg2omlSADzapMDYemQSIYIfcs7s** |

CC 独自判断:
- シート複製は GAS の `DriveApp.makeCopy` ではなく Google Drive コネクタ（tokyoflowerco.ltd@gmail.com）の copy で実施した。
  GAS 関数を無人で実行する手段（`clasp run`）が未設定（"Unable to run script function"）のため。複製の所有者は tokyoflowerco.ltd@gmail.com になる（元シートの所有者は ginzasugiden@gmail.com）。
- ecosresident スタックは直前のデモ準備で停止されていた（ed659e9 "ローカル常駐停止"）。pg_dump のため `up -d postgres` で Postgres のみ起動した（`down` は使っていない）。
- clasp は `clasp logout → login` ではなく、既に登録済みの名前付きユーザー `-u ginzasugiden`（`~/.clasprc.json` に存在）を明示して使う。挙動は同等で、tokyoflowerco.ltd での push/deploy にはならない。

## STEP1 現状調査（完了）

### 1-1 ECDashboard Chrome 拡張（Manifest V3 / TS / esbuild）

- 構成: `extension/src/background.ts`（service worker, 1,614 行）、`content.ts`（RMS ページ内 fetch）、`popup.ts`、`options.ts`、`lib/*.ts`（純粋ロジック・vitest 対象）。version 0.3.3。
- **スケジュール実行**: `chrome.alarms`（`ecos:dailyRun`, 既定 21:00 JST, `periodInMinutes: 1440`）→ `runIngest('scheduled')` → `claimRun` → `executeRun`。実行中は 20 秒周期の `chrome.runtime.getPlatformInfo()` で keepalive。
- **取得モジュールの共通インターフェース**: 「モジュール」ではなく **レシピ駆動**。`RMS_PAGES`（13 ページ, `lib/pages.ts`）× `recipes/rms-pages.json`（`page` / `navigateUrl` / `requests[]{key,urlTemplate,method,query,expect,period,rangeMode,...}`）。
  実行は `ensureRmsTab(navigateUrl)` → `sendCaptureMessage(tabId, page, resolved)`（`chrome.tabs.sendMessage` で content.js に `ecos:capture` を送り、content 側が `fetch(credentials:'include')`）→ `sendIngest()`。
  `lib/pages.ts` は `packages/modules/rms-ingest/src/pages.ts` の複製で同期義務あり（サーバ側 zod enum / `getLatestConfirmedDates` が全ページのキーを要求）。
- **ECOS への送信**: `POST {ecosUrl}/api/ingest/rms`、JSON body の `tenantApiKey`（ヘッダではなく body）。疎通確認 `GET /api/ingest/rms/ping` のみヘッダ `X-Ecos-Api-Key`。実行報告 `POST /api/ingest/rms/run`。サーバ側は `workspace_api_keys.token_hash`（sha256）で照合。
- **SJIS**: `lib/csv.ts decodeBufferToText`（UTF-8 fatal → `TextDecoder('shift_jis')` フォールバック）が既にある。
- **content script 通信失敗の原因候補（仮説）**:
  1. content.js の listener が存在しないタブに `sendMessage` している（拡張更新後の既存タブ、メモリセーバーで discarded、SSO リダイレクトで origin が変わったタブ）。再注入 `tryReinjectContentScript` は host_permissions 内のタブのみ。
  2. service worker が停止→再起動した際、`sendMessage` の応答待ち Promise が失われる（executeRun はモジュール変数に状態を持たないよう設計されているが、進行中の `sendMessage` は再開されない）。
  3. `executeScript`（関数注入）は listener の有無に依存せず結果を Promise で返せるため、通信失敗の主因（1）を構造的に回避できる。

### 1-2 ECOS の orders スキーマ

- `packages/db/src/schema.ts` `orders`: `external_order_id`（**注文番号**。例 `240364-20260830-0507801115`）, `workspace_id`, `store_id`, `ordered_at`, `status`(pending/confirmed/shipped/canceled), `subtotal/shipping/discount/tax/total`, `source`。**注文者名・メールの列は無い**（正規モデルに顧客情報を持たない）。
- **既に `reviews` テーブルと `rakuten-review` モジュール（`/m/rakuten-review`）が存在する**: `external_review_id`（=レビュー詳細URL）, `order_number`, `product_title_raw`, `kind`(product/shop/unknown), `rating`, `body`, `created_at`(投稿日として使用), `match_status`（注文番号経由の商品突合: matched_order / unmatched_order_missing / ...）。CSV 手動アップロード（`uploadReviewCsvAction`）→ `importReviewRows`（外部IDで重複スキップ）→ `rematchReviewProducts`（`reviews.order_number = orders.external_order_id` で結合済み）。
- ECOS ローカル DB（ecosresident）の受注は 184 件のみ（RMS API 取込 / CSV）。レビュー総数 7,712 件に対し結合率は低くなる見込み。

### 1-3 step-samurai の既存レビュー取込と sendPendingReviewThanks

- `reviews_import.gs importReviewsFromCsv_`: 列名ヒント（部分一致）で自動判定、`review_id` = レビュー詳細URL（無ければ `csv_<種別>_<注文番号>_<時刻>`）、`posted_at` を `yyyy-MM-dd HH:mm:ss` に正規化、`body` = `【タイトル】\n本文`、reviews タブへ `review_id` キーで upsert（ヘッダ基準で行構築）、その後 `linkOrdersReviews` が `orders.review_linked` を更新。Shift_JIS は GAS 側では扱わない（管理画面がテキストを貼る前提）。
- reviews タブの列: `review_id | order_number | buyer_key | item_code | rating | posted_at | body`。
- `review_thanks.gs sendPendingReviewThanks(tenantId)` → `collectPendingReviewThanks_` → `collectReviewsByOrder_`: **既に注文番号（order_number）ベース**で reviews を注文にまとめ、orders タブの `order_number` と突き合わせて `masked_email / buyer_name` を引いている。itemId ベースの参照は使っていない → 注文番号ベースへの寄せ替えは不要（**判断: 現行維持、matched 列の追加のみ**）。
- 送信条件は fail-closed（`review_thanks_since` 未設定なら全スキップ、`min_rating`、`go_live_date`、`sends` 重複、`dry_run`）。tokyoflower は `review_thanks_since=2026-09-07`, `min_rating=3` で 2026-09-07 稼働開始済み。
- 認証: WebApp `doPost` は `{token, action, payload}`。テナントトークンは `tenant_auth` タブに sha256 のみ保存、`ADMIN_TOKEN` は Script Properties に平文で保持し `hash_equals_` で定数時間比較。

### 1-4 review.rms.rakuten.co.jp の CSV（**実測**。Chrome のログイン済みセッションで読み取りのみ実施）

- 画面: `https://review.rms.rakuten.co.jp/`（レビューチェックツール）。全 7,712 件（2003〜）。
- **CSV ダウンロード URL**: `GET https://review.rms.rakuten.co.jp/search/csv/?sy=2026&sm=8&sd=29&sh=0&si=0&ey=2026&em=9&ed=12&eh=23&ei=59&ev=0&tc=0&kw=&ao=A&st=1`
  - `sy/sm/sd/sh/si` = 開始 年/月/日/時/分、`ey/em/ed/eh/ei` = 終了、`ev` = 評価（0=全て, 1=★★★未満, 2..6=★1..5）、`tc` = 種別（0=商品・ショップ, 1=商品のみ, 2=ショップのみ）、`kw` キーワード、`ao` = A(AND)/O(OR)、`st` = 並び（1=新着順）。
  - 応答: HTTP 200, `Content-Type: application/octet-stream`, **Shift_JIS**（UTF-8 fatal デコード失敗）, BOM なし, CRLF, 全列ダブルクォート。ページ内 `fetch(credentials:'include')` で取得できることを確認（14 日分で 24 行 / 5.6KB）。
- **実 CSV の列（10 列・確定）**: `レビュータイプ, 商品名, レビュー詳細URL, 評価, 投稿時間, タイトル, レビュー本文, フラグ, 注文番号, 未対応フラグ`
  - 想定していた「商品管理番号 / ニックネーム / レビューID / 表示状態」は **存在しない**。レビューID は「レビュー詳細URL」で代替（`.../item/1/240364_10000409/ccl6-...`。`240364_10000409` の後半が楽天商品ID）。「フラグ」「未対応フラグ」は店舗が付けるチェック用フラグで表示状態ではない。
  - 例: `"商品レビュー","＼銀座から贈る上質なお花！／ ...","https://review.rakuten.co.jp/item/1/240364_10000409/...","5","2026/09/10 17:27:54","","写真の通り、…","0","240364-2026xxxx-xxxxxxxxxx",""`
- ECOS 側の `rakuten-review/src/csv.ts` と step-samurai の `reviews_import.gs` は既にこの列構成に対応している（列名ヒント）。

### 設計上の判断（STEP2〜4 の前提）

1. ECOS では新規 `reviews` テーブルを作らず、**既存 `reviews` を拡張**する（title / posted_at / rakuten_item_id / rms_flag / rms_unhandled_flag / source / first_seen_at / last_seen_at / deleted_at を追加）。既存の商品突合（`rematchReviewProducts`）と UI を活かす。注文突合は SQL ビュー `review_order_matches` を追加する（注文者名は ECOS の正規モデルに無いため **ビューには含めない**。GAS 側の orders タブが `buyer_name` を持つ）。
2. 拡張は `reviews` を 14 番目のページとして `RMS_PAGES` の末尾に追加（既存ジョブの後段で実行）。レシピには CSV URL と固定パラメータのみ持たせ、日付分割パラメータ（sy..ei）は background 側で組み立てる（初回 2003-01-01〜、以降 直近 14 日）。送信先は専用 `POST /api/ingest/reviews`（500 件バッチ）。
3. 取得経路を `chrome.scripting.executeScript`（関数注入・Promise で結果回収）に統一し、`sendMessage` は失敗時のフォールバックに格下げする。
4. GAS の `ingest_reviews` 認証は Script Properties `REVIEW_INGEST_KEY__<tenant_id>`（平文、`ADMIN_TOKEN` と同方式で `hash_equals_` 比較）。`review_ingest_enabled` は settings タブ（既定 false, fail-closed）。
5. ECOS → GAS 転送の URL とテナント ID は `workspaces.settings.reviewForward`、API キーは `workspace_credentials`（AES-256-GCM）に保存する。

（以降の STEP は実施後に追記）

## STEP4 step-samurai GAS：レビュー受信 Webhook（完了・人手ゲート②待ち）

- 実装: `gas/src/reviews_ingest.gs`（新規）、`webapp.gs`（`action=ingest_reviews` 分岐）、`config.gs`（`review_ingest_enabled` 既定 false）、`review_thanks.gs`（`deleted_at` 有りのレビューを除外）。
- reviews タブ: 既存 7 列は不変。末尾に `review_type / product_title / rakuten_item_id / source / updated_at / deleted_at / matched` を初回受信時に追記（`ensureAnalyticsColumns_` と同方式）。`matched` が注文番号ベースの突合結果（4-3 は reviews シートへの列追加方式を採用）。
- 認証: Script Properties `REVIEW_INGEST_KEY__tokyoflower`（平文・`hash_equals_`）。未登録/不一致は区別せず `unauthorized`。`review_ingest_enabled !== 'true'` なら `review_ingest_disabled`。
- テスト: `node tests/review_ingest_tests.js` 11 pass、既存 5 本含め計 105 pass。
- コミット: `a3665a3`（feature/review-webhook）。`clasp push -u ginzasugiden -f` → `clasp deploy -u ginzasugiden -i AKfycbwYsGkYmSfstE4Ay_mrvlZa1qHv5ImZe1EUtC8oXGpFRwZ67vJSC8vL4BQySoomPqI_7w` → **@10**（appsscript.json の webapp セクション維持を確認）。
- 疎通: `curl -L <WebApp URL> -d '{"action":"ingest_reviews",...}'` → `{"ok":false,"error":"unauthorized"}`（キー未登録のため期待どおり fail-closed）。※ curl に `-X POST` を付けると 302 リダイレクト先で 411 になるので付けない。
- 成功判定「`{"ok":true,"upserted":N}` を返す／reviews シートに行が増える」は **人手ゲート②（Script Properties へのキー登録）と `review_ingest_enabled=true`（STEP5-1）後**に確認する。既存 follow/coupon/review_thanks の sends 記録形式（`recordSend_`）には変更なし。

## STEP2 Chrome 拡張：レビュー取得（完了・人手ゲート①待ち）

- 拡張 0.4.0（`extension/manifest.json`。`host_permissions` に `https://review.rms.rakuten.co.jp/*` を明示追加）。
- `RMS_PAGES` 末尾に `reviews`（拡張 `lib/pages.ts` とサーバ `rms-ingest/src/pages.ts` を同時更新、`getLatestConfirmedDates` に `reviews:null`）。レシピ（`rms-pages.json` / `page-mapping.json`）に `reviews` ページを追加し `recipes:generate` で再生成（既存 13 ページは無変更を diff で確認）。
- `lib/review-csv.ts`（純粋関数）: `parseReviewCsv`（RFC4180・セル内改行）、`normalizePostedAt`、`extractRakutenItemId`、`dedupeReviews`、`chunkReviews`（500 件）、`computeReviewsRange`（初回 2003-01-01〜today／以降 today-14）、`buildReviewCsvUrl`（sy..ei を付与）。
- `background.ts`: `captureViaExecuteScript`（`chrome.scripting.executeScript` の関数注入。fetch→UTF-8/Shift_JIS デコード→ログイン/HTML/CSV 判定を注入関数内で完結し Promise で回収）を全ページの第一経路にし、`sendMessage` は executeScript が例外を投げた場合のフォールバック。`ensureReadyOrThrow` は ping 失敗でも同一オリジン・host_permissions 内なら進行。`runReviewsPage` が CSV 取得→パース→`POST /api/ingest/reviews`（500 件バッチ、`final` フラグ、0 件でも 1 バッチ）→全バッチ成功時のみ `ecos:reviewsFetchedThrough` 更新。`console.info('[ECOS] reviews', {trigger, runId, startedAt, range, rowCount, batchCount, insertedTotal, updatedTotal, ecosOk})` を必ず出力（6-1 の要件）。
- popup: 「レビューのみ取得」ボタン（`ecos:runNow` に `pages:['reviews']`）。対象外ページは `skipped（手動実行の対象外）` で履歴に残す。
- テスト: `extension/tests` 13 ファイル 269 件 pass（新規 `review-csv.test.ts` 20 件: SJIS デコード／パース／正規化／dedupe／バッチ分割／範囲／URL）。`pnpm --filter extension typecheck` / `build` / `tsc -p tsconfig.packages.json` 成功。
- コミット: `3c1946c`（db 0014）, `fed2e89`（extension 0.4.0）。
- 人手ゲート①（拡張の再読み込み → RMS ログイン → 「レビューのみ取得」）は未実施。実 CSV の列は STEP1-4 で実測済みのため、パーサーはその列構成で確定している。

## STEP3 ECOS：受信 API・DB・注文突き合わせ（完了）

- DB（Single Writer＝CC 本体が実施）: マイグレーション `0014_glorious_strong_guy.sql`（`reviews` に title / posted_at / rakuten_item_id / rms_flag / rms_unhandled_flag / source / first_seen_at / last_seen_at / deleted_at、`(workspace_id, external_review_id)` 一意インデックス、`review_forward_logs` テーブル、`review_order_matches` ビュー。既存行の `posted_at` は `created_at` からバックフィル）。`down/0014_down.sql` あり。開発 DB（5433）と常駐 DB（ecosresident）の両方に適用済み。
- API: `POST /api/ingest/reviews`（`apps/web/src/app/api/ingest/reviews/route.ts` → `packages/modules/rakuten-review/src/ingest.ts`）。zod 検証 → `workspace_api_keys` 照合（拡張の tenantApiKey と共用）→ レート制限（10 分 200 バッチ）→ `reviewUrl` キーで冪等 upsert → `final` バッチで「同期範囲内かつ今回観測されなかった行」に `deleted_at` を立て（物理削除しない）、`rematchReviewProducts` で商品突合を再計算 → バッチごとに GAS へ転送。
- 突合: `review_order_matches`（`reviews.order_number = orders.external_order_id`。matched / ordered_at / order_status / order_total / product_title / days_to_review）。**注文者名は ECOS の正規モデル（orders）に存在しないためビューに含めない**（GAS の orders タブ側に buyer_name がある）。
- 画面: `/m/rakuten-review?tab=orders`「注文突合」タブ（総数／結合／未結合／削除の StatCard、評価分布、一覧、転送ログ最新 20 件、転送設定フォーム＝`rakuten.manage` のみ）。
- 転送: `forward.ts`。設定は `workspaces.settings.reviewForward`（enabled / webAppUrl / tenantId）、キーは `workspace_credentials.STEP_SAMURAI_REVIEW_INGEST_KEY`（AES-256-GCM）。リトライ 3 回（1s→3s→9s）、`review_forward_logs` に記録。**CC が修正した点**: GAS の 302 リダイレクト先へ再 POST すると 405 になることをローカル検証で発見し、GET で追従する実装に修正（`2ffe43e`）。GAS が返す確定的エラー（unauthorized / review_ingest_disabled / invalid_payload）はリトライしない（`6096588`）。
- ゲート: `pnpm registry` / `validate:modules`（19 modules）/ `typecheck` / `lint` / `test`（97 ファイル 1,470 件）/ `build` すべて成功。
- 常駐スタック: `.next-prod` を事前ビルド → `docker compose -p ecosresident ... build web` → `run --rm web pnpm db:migrate` → `up -d` → `GET http://localhost/api/health` = 200（`{"web":"ok","db":"ok","worker":"ok"}`）。`down` は使っていない。
- ローカル実データ検証（人手ゲート①の代替として CC が合成データで実施）: 常駐 DB に検証用 API キーを新規発行（ローカル DB のみローテーション。平文はスクラッチ `ecos_local_api_key.txt` にのみ保存）し、実在する注文番号 `240364-20260912-0430804206` を持つ商品レビュー 1 件＋ショップレビュー 1 件を POST → `inserted:2`、同 body 再送で `updated:2`、不正キーで 401。`review_order_matches` で注文番号ありの行が **matched=true（days_to_review=0）**、ショップレビューは matched=false。次の同期範囲に含めなかったショップレビューは `deletedMarked:1`（`deleted_at` が立つ）。転送は GAS が `unauthorized`（キー未登録のため期待どおり）を返し `review_forward_logs` に failed として記録。検証後、検証用 2 行は削除済み（元の 65 件に戻した。うち注文結合 37 件）。
- コミット（feature/review-ingest）: `3c1946c`（db 0014）, `fed2e89`（extension 0.4.0）, `67393f0`（rakuten-review ingest/forward/画面）, `2ffe43e`, `6096588`。

## STEP5 ドライラン & 実データ検証（**未完了・人手ゲート①②待ち**）

CC が無人で実行できない操作（GAS プロジェクトへのアクセス手段が無い。`clasp run` 未設定、Chrome のログイン済み Google アカウントも GAS プロジェクトを開けない）に依存するため、以下を **ユーザー操作**として残す。必要な値はすべて準備済み。

1. 【人手ゲート②】GAS エディタ「プロジェクトの設定」→ スクリプト プロパティに `REVIEW_INGEST_KEY__tokyoflower` を追加。値は `C:\Users\joseph\AppData\Local\Temp\claude\X--projects-step-samurai\3146ab06-be56-4a06-b346-3500d074971d\scratchpad\review_ingest_key.txt`（64 桁 hex。**同じ値をローカル常駐 DB の転送設定に登録済み**。本番 VPS の ECOS に入れる場合は `/m/rakuten-review?tab=orders` の転送設定フォームから同じ値を登録する）。
2. GAS エディタで `ensureReviewIngestSettingsTokyoflower()` を実行（settings タブに `review_ingest_enabled=false` の行を追加。既存行は触らない）。
3. 【STEP5-1】settings タブの `review_ingest_enabled` を `true` にする（**唯一の本番設定変更**。review_thanks 系の値は変更しない）。
4. 疎通: `curl -s -L '<WebApp URL>' -H 'Content-Type: text/plain' -d '{"action":"ingest_reviews","payload":{"tenant_id":"tokyoflower","api_key":"<キー>","sync_id":"probe","reviews":[]}}'` → `{"ok":true,"upserted":0,...}` になれば STEP4 の成功判定が満たされる（`-X POST` は付けない）。
5. 【人手ゲート①】`chrome://extensions` で ECOS 拡張を再読み込み（0.4.0。`extension/dist`）→ RMS にログイン → ポップアップ「レビューのみ取得」。
   - 拡張の送信先は既定で本番 VPS（`https://ecos.ginzasugiden.com`）。**VPS には本ブランチをまだデプロイしていない**（`_docs/VPS_RUNBOOK.md` の bundle→scp→build→migrate→up -d が必要。外向きの本番変更のためユーザー判断に委ねる）。先にローカルで通す場合は拡張のオプションで ECOS URL を `http://localhost`、API キーをスクラッチ `ecos_local_api_key.txt` の値に変更する。
   - 初回は 2003 年〜全件（約 7,700 件 → 16 バッチ）。`console.info('[ECOS] reviews', {...})` に実行時刻・件数が出る。
6. 【STEP5-2/5-3】ECOS `/m/rakuten-review?tab=orders` の総数／結合／未結合と、GAS `previewReviewIngestStatusTokyoflower()` の `reviews行数 / matched / unmatched` が一致することを確認。ECOS 側の受注は 184 件（ローカル）のため未結合の主因は「注文番号が受注データに無い（13 ヶ月より古い注文・取込期間外）」になる見込み。GAS 側は orders タブの保持範囲で結合する。
7. 【STEP5-4】GAS エディタで `dryRunReviewThanksTokyoflower()`（＝既存 `previewPendingReviewThanksTokyoflower`）を実行し、対象件数と `review_thanks_since`（2026-09-07）より前のレビューが含まれないことを確認。実送信はしない。

## STEP6 定期実行 & 仕上げ（完了。push は step-samurai のみ）

- 6-1: `RMS_PAGES` の末尾に `reviews` を置いたため、21:00 JST の定期同期（`chrome.alarms` → `executeRun`）で既存 13 ページの後段に自動で組み込まれる（`orderedRunnablePages` は `RMS_PAGES` 順、既定トグル true）。実行ログ `[ECOS] reviews {trigger, runId, startedAt, range, rowCount, batchCount, insertedTotal, updatedTotal, ecosOk}` を出力。
- 6-2: GAS 側は新規トリガー不要（`runHourlyFollowPipeline` → `sendPendingReviewThanks` がそのまま拾う）。
- 6-3: ECOS `CLAUDE.md` の運用メモに「楽天レビュー自動取得」節、step-samurai に `CLAUDE.md`（新規。運用メモ: 取得経路／API キーの置き場／削除フラグ運用／ロールバック手順）を追加。ECOS `docs/DECISIONS.md` D-059、`docs/INTEGRATIONS.md` ほか更新。
- 6-4: step-samurai は `feature/review-webhook` → `master` へマージして push。**ECOS は `git remote` が未設定（VPS へは git bundle で配布する運用）のため push 不可**。コミットは `feature/review-ingest` にローカルで保持。

## 最終レポート（サマリ）

| STEP | 成功判定 | 結果 |
|---|---|---|
| 0 | バックアップ | 完了（pg_dump / clasp pull 一致 / シート複製 ID 1USf3yiQ6asaMP5_yPg2omlSADzapMDYemQSIYIfcs7s） |
| 1 | REPORT.md に 4 点の事実 | 完了（CSV URL・列構成は実測） |
| 2 | build 成功・ユニット緑 | 完了（269 件）。人手ゲート①は未実施 |
| 3 | test 緑・health 200・reviews>0・matched≧1 | 完了（1,470 件・200・ローカル合成データで matched=true を確認） |
| 4 | push/deploy 成功・curl ok:true・行が増える | push/deploy 完了（@10）。curl は `unauthorized`（fail-closed、キー登録待ち） |
| 5 | 件数一致・未結合理由・ドライラン | **未完了**（人手ゲート①②・設定変更がユーザー操作） |
| 6 | push 成功・ログ出力 | step-samurai push 完了。ECOS は remote 無し。ログ出力は実装済み |

- ロールバック点: step-samurai `3d052f86aa274503965cdc4dc5d5f764334c719e`（WebApp は同じ `-i` で @9 を指定）、ECOS `main` ed659e9 ＋ `backups/pre-review-ingest-202609121314.sql`（または `down/0014_down.sql`）。
- 突き合わせ結果（現時点・ローカル常駐 DB、実 CSV 取込前）: 総レビュー 65 ／ 注文結合 37 ／ 未結合 28（ショップレビュー・受注未取込）／ 削除 0。実 CSV 全件（7,712 件）の結合状況は人手ゲート①後に `/m/rakuten-review?tab=orders` で確認する。
- 実 CSV の列構造: `レビュータイプ, 商品名, レビュー詳細URL, 評価, 投稿時間, タイトル, レビュー本文, フラグ, 注文番号, 未対応フラグ`（Shift_JIS・CRLF・全列クォート。商品管理番号／ニックネーム／レビューID／表示状態は無い）。
- 残課題:
  1. 人手ゲート①②と `review_ingest_enabled=true`（STEP5）。
  2. ECOS 本番 VPS への配布（bundle → scp → build → `db:migrate`（0014）→ `up -d`）と、VPS 側の転送設定登録。拡張の既定送信先は VPS なので、配布まで定期同期の reviews はサーバ側で 400（`page` enum に `reviews` が無い旧サーバでは実行報告が弾かれる可能性あり。ingest 自体は `/api/ingest/reviews` が 404）。
  3. 初回全件（約 7,700 件）の `final` バッチで `rematchReviewProducts` が全件再計算するため、Next の 1 リクエストが長くなる可能性（ローカルでは問題なし。VPS で遅い場合は再突合を非同期ジョブ化）。
  4. GAS 側の初回 500 件 × 16 バッチは 1 バッチずつ `setValues` するため数十秒かかるが 6 分制限内の見込み。
  5. creds.sid 空問題との関係: 本作業の経路（拡張の Cookie セッション／API キー）は RMS ライセンスキー・sid に依存しないため無関係。GAS の `getRmsCredentials` は転送受信側では呼ばれない。
