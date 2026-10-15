# ステップ侍 外部店舗受入手順（運営者向け）

基本の搭載手順は `docs/ONBOARDING.md`。ここでは **課金（manual 運用）** と **受入前後の確認** を扱う。

## 1. 課金の仕組み
- マスターシート `tenants` タブ末尾の列: `plan / billing_provider / billing_status / trial_start / trial_end / fincode_customer_id / fincode_subscription_id / billing_updated_at / billing_note`
- グローバル設定（マスターシート `settings` タブ）: `plan_price_monthly=9800 / setup_fee=0 / trial_days=30（上限30） / fincode_payment_url`
- 稼働ガード `billingAllows_`: `active` か、`trial` かつ今日 <= `trial_end` のときだけ、毎時パイプライン・レビューお礼メール・クーポン発行が動く。`past_due / canceled / trial期限切れ / 未設定` は **skip（ログに `billing skip: <理由>`）**。
- 新規テナント（招待発行 → 作成）は `billing_status=trial` で作られるが、**期間（trial_start / trial_end）は空**で、このあいだは稼働不可（`billing skip: trial_not_started`）。**申込完了（店舗が onboard で RMS 接続テストに成功した時点）に今日〜今日+30日で起算**する。招待を発行しただけでは減らない。
  - 店舗のセルフ登録を経ず、運営が認証情報を入れた店舗は、admin.html の課金欄ではなく API `set_billing` に `start_trial: true` を渡して起算する（起算済みなら何もしない）。
  - 既存テナント（active・起算済みの trial）の値は変わらない。
- 既存の稼働店は明示セットが必要（未設定は止まる）。tokyoflower は `seedBillingTokyoflower()`（`manual / active`）。

## 2. 初回リリース時の順序（重要）
1. `clasp push` の **直後**（毎時トリガーが未設定の tokyoflower を skip する前に）、GAS エディタで **`seedBillingTokyoflower`** を実行（列・設定・billing_events も自動追加。冪等）。
2. `previewReviewIngestStatusTokyoflower` 等で tokyoflower が skip されていないことを確認（実行ログに `billing skip` が無い）。
3. その後 `clasp deploy -i <既存ID>`。

## 3. manual 運用（請求書払い）の日常手順
1. 申込み完了の通知メールを受ける → 管理画面でテナントの `billing_status=trial`・`trial_end` を確認
2. トライアル終了前に freee で請求書を発行・送付
3. 管理画面 → テナント →「操作」→「課金（manual 運用）」:
   - 送付時: `billing_note` に内容、「freeeで請求済」にチェック＋日付＋請求書番号（メモに残るだけ。freee 連携はなし）
   - 入金確認後: `billing_status=active` に変更
   - 未入金: `past_due`、解約: `canceled`（該当店の送信が止まる）
4. 変更は `billing_events` タブに手動記録される

## 4. 日次チェック `checkBillingDaily()`
`trial_end` を過ぎた `trial` に `billing_note` へ「trial期限切れ」を記録する（ステータスは自動変更しない）。あわせて **`ADMIN_EMAIL` 宛てに一覧メール**を1通送る: ① 期限7日前 ② 期限当日 ③ 期限切れ（今回初めて検知）。同じ日に2回は送らない（`billing_events` の `trial_digest_sent`）。`ADMIN_EMAIL` 未設定の場合は送らず実行ログに内容だけ出す。
- トリガーは GAS エディタで **`setupTriggers` を1回実行**すると、`runHourlyFollowPipeline`（毎時）と `checkBillingDaily`（毎日9時）が無ければ作られる（あれば何もしない。重複は1本に減らす。**他のトリガーは削除しない**）。
- 通知の取りこぼしを避けるため、日次トリガーが動いているかを `auditOnboardingReadiness` で確認する。

## 5. fincode（審査完了後に有効化）
- 仕様（確認元 https://docs.fincode.jp/develop_support/development_monitoring / https://docs.fincode.jp/api の Webhook_通知仕様）: 認証は `Fincode-Signature` ヘッダ（Webhook 登録時に設定した署名値と同一の固定文字列）、応答は HTTP200・text/plain・`0`。一意な event_id は無いため PHP が合成。
- 手順: ① fincode ダッシュボードで Webhook の signature 値と通知先 URL（`fincode_webhook.php`）を登録 ② `lolipop/fincode_webhook.php` を smtp_bridge.php と同階層へ配置（WinSCP・人手）③ config.php に `fincode_signature / gas_webapp_url / gas_bridge_token` を追記 ④ GAS Script Properties に `BRIDGE_TOKEN`（②と同値）と `FINCODE_WEBHOOK_SECRET` を登録（未設定の間は受信拒否）⑤ 各テナントの `fincode_customer_id / fincode_subscription_id` をマスターシートへ記入 ⑥ `fincode_payment_url` を設定
- 対応: `payments.card.exec/capture` の `CAPTURED` → active、`FAILED`/error_code → past_due、`subscription.*.delete` または `update` の `CANCELED` → canceled。重複は `billing_events.fincode_event_id` で無視。

## 6. E2E 確認（実機）
`tests/e2e_onboard_tests.js`（ローカル）で次を確認済み: 招待発行 → テナント/タブ自動生成 → trial（+30日）→ ダミーキーで接続失敗 → active 不可 → 招待再利用不可 → 他店データ非表示 → 片付け。
実 GAS で行う場合は tenant_id を `e2etest_<yyyyMMddHHmmss>` とし、完了後に `disabled` → 専用スプレッドシート・`tenants` 行・`tenant_secrets`・`billing_events`・`pipeline_log`・`tenant_auth`・`invites` の該当行を削除し、`e2etest` が全シートに残らないことを確認する。

## 6-2. 送信数の上限と稼働開始日
- `settings.max_sends_per_run`（テナントごと・運営のみ変更）: 1回（毎時）の実行で送るメールの上限。**空・不正なら既定50件**。フォロー・レビューお礼とも適用され、超えた分は次回以降に回る（`sends` で二重送信しない）。dry_run の間は数えない。
- `go_live_date`: 店舗が申込フォームで入れる希望日は **今日以降の日付のみ**受け付ける。active 化でも **過去日なら（送信実績が無い限り）ブロック**する。送信実績のある稼働店の再開（paused→active）は対象外。保存済みの既存値は検証しない。運営が `set_tenant_setting` で入れる値は形式のみ検証。
- 解除は dry_run を外す直前に **`go_live_date` と、同期済みの注文数（`follow_days_after_ship` 経過済みの件数）**を確認すること。

## 6-3. 解約済みテナントの削除（purge_tenant）
管理画面 →「操作」→「解約済みテナントの完全削除」（API `purge_tenant`）。**実行は運営の判断で行う。** 前提は ① status=`disabled` ② 店舗IDを再入力して一致 ③ 事前複製に成功。tokyoflower は常に拒否。
- 実行前に Drive へ `purge_backup_<id>_<日時>`（専用シートの複製）と `purge_backup_master_<id>_<日時>`（`tenants` 行・`billing_events`。暗号文・パスワードのハッシュは含めない）を作る。失敗したら何も消さない。
- 削除: `tenant_secrets`・`tenant_auth`・`invites`・Script Properties（`REVIEW_INGEST_KEY__<id>` / `ANALYTICS_BACKFILL_CURSOR__<id>`）・マスター `tenants` 行（最後）。専用シートは `PURGED_<id>_<日時>` に改名するだけで消さない（店舗への譲渡または削除は人が行う）。
- `billing_events` に `purge_started` / `purge_tenant`（複製IDつき）を記録。途中で失敗した場合はマスター行が残るので、原因を直して同じ操作をやり直せる。
- 手作業で残るもの: `smtp_bridge` の `config.php`（旧方式の SMTP 設定）、複製の保管期限の判断、ECOS 側の転送設定。

## 7. クーポン
クーポン経路の再有効化（`settings.coupon_enabled` ゲート・リクエスト修正・実発行テスト）は **未実施**（作業レポート参照）。現状は課金ガード（`runPipeline` 先頭）のみ適用され、`runHourlyFollowPipeline` はクーポンを呼ばない。LP のクーポン項目は「準備中」。
