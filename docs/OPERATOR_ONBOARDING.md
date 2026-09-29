# ステップ侍 外部店舗受入手順（運営者向け）

基本の搭載手順は `docs/ONBOARDING.md`。ここでは **課金（manual 運用）** と **受入前後の確認** を扱う。

## 1. 課金の仕組み
- マスターシート `tenants` タブ末尾の列: `plan / billing_provider / billing_status / trial_start / trial_end / fincode_customer_id / fincode_subscription_id / billing_updated_at / billing_note`
- グローバル設定（マスターシート `settings` タブ）: `plan_price_monthly=9800 / setup_fee=0 / trial_days=30（上限30） / fincode_payment_url`
- 稼働ガード `billingAllows_`: `active` か、`trial` かつ今日 <= `trial_end` のときだけ、毎時パイプライン・レビューお礼メール・クーポン発行が動く。`past_due / canceled / trial期限切れ / 未設定` は **skip（ログに `billing skip: <理由>`）**。
- 新規テナント（招待発行 → 作成）は自動で `trial`（作成日〜作成日+30日）。
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
`trial_end` を過ぎた `trial` に `billing_note` へ「trial期限切れ」を記録する（ステータスは自動変更しない）。**トリガー登録は人手**: GAS エディタ → トリガー → `checkBillingDaily` を時間主導・毎日で追加。

## 5. fincode（審査完了後に有効化）
- 仕様（確認元 https://docs.fincode.jp/develop_support/development_monitoring / https://docs.fincode.jp/api の Webhook_通知仕様）: 認証は `Fincode-Signature` ヘッダ（Webhook 登録時に設定した署名値と同一の固定文字列）、応答は HTTP200・text/plain・`0`。一意な event_id は無いため PHP が合成。
- 手順: ① fincode ダッシュボードで Webhook の signature 値と通知先 URL（`fincode_webhook.php`）を登録 ② `lolipop/fincode_webhook.php` を smtp_bridge.php と同階層へ配置（WinSCP・人手）③ config.php に `fincode_signature / gas_webapp_url / gas_bridge_token` を追記 ④ GAS Script Properties に `BRIDGE_TOKEN`（②と同値）と `FINCODE_WEBHOOK_SECRET` を登録（未設定の間は受信拒否）⑤ 各テナントの `fincode_customer_id / fincode_subscription_id` をマスターシートへ記入 ⑥ `fincode_payment_url` を設定
- 対応: `payments.card.exec/capture` の `CAPTURED` → active、`FAILED`/error_code → past_due、`subscription.*.delete` または `update` の `CANCELED` → canceled。重複は `billing_events.fincode_event_id` で無視。

## 6. E2E 確認（実機）
`tests/e2e_onboard_tests.js`（ローカル）で次を確認済み: 招待発行 → テナント/タブ自動生成 → trial（+30日）→ ダミーキーで接続失敗 → active 不可 → 招待再利用不可 → 他店データ非表示 → 片付け。
実 GAS で行う場合は tenant_id を `e2etest_<yyyyMMddHHmmss>` とし、完了後に `disabled` → 専用スプレッドシート・`tenants` 行・`tenant_secrets`・`billing_events`・`pipeline_log`・`tenant_auth`・`invites` の該当行を削除し、`e2etest` が全シートに残らないことを確認する。

## 7. クーポン
クーポン経路の再有効化（`settings.coupon_enabled` ゲート・リクエスト修正・実発行テスト）は **未実施**（作業レポート参照）。現状は課金ガード（`runPipeline` 先頭）のみ適用され、`runHourlyFollowPipeline` はクーポンを呼ばない。LP のクーポン項目は「準備中」。
