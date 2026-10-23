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
- トリガーは GAS エディタで **`setupTriggers` を1回実行**すると、`runHourlyFollowPipeline`（毎時）・`checkBillingDaily`（毎日9時）・`runLicenseCheck`（毎日9時）の3本が無ければ作られる（あれば何もしない。重複は1本に減らす。**他のトリガーは削除しない**）。
- `runLicenseCheck` は active 全テナントの RMS ライセンス残り30日以内と失効済みを `ADMIN_EMAIL` に通知する（テナントごとに同じ日に2回は送らない＝`billing_events` の `license_notice_sent`。`ADMIN_EMAIL` 未設定の場合は送らず実行ログに出すだけ）。
- 通知の取りこぼしを避けるため、日次トリガーが動いているかを `auditOnboardingReadiness` で確認する。

## 4-2. 毎時実行の記録 `pipeline_log` の `_hourly` 行
`runHourlyFollowPipeline`（毎時）の実行全体は、マスターシートの `pipeline_log` タブに `tenant_id=_hourly` で残る（`detail` は `run=<実行ID>` 形式。テナント別の `hourly_done` / `hourly_error` / `billing_skip` は従来どおりテナントIDの行で、こちらにも `run=<実行ID>` が付く）。
- `hourly_start` — 実行の開始。
- `hourly_done` — 正常終了。`run=<ID> tenants=<対象数> ran=<実行数> billing_skipped=<課金ガードでskip> errors=<エラー数>`。`errors` はテナント単位の例外とレビューお礼メールの失敗の合計。
- `hourly_error` — 実行全体の例外（`stage=` が発生箇所: `listActiveTenants` など、`msg=` が内容）。終了マーカーを兼ねる。テナント別の `hourly_error` は他テナントの処理を止めない。
- `hourly_skip` — アクティブテナントが0件で何もしなかった（`reason=no_active_tenants`）。終了マーカーを兼ねる。課金ガードによる skip は理由つきの `billing_skip` が残り、`hourly_done` の `billing_skipped` に数えられる。
- `hourly_incomplete` — 開始時に「前回の `hourly_start` に対する終了マーカー（done / error / skip）が無い」ことを検知した（`prev=<前回のrun> prev_start=<時刻>`）。実行が途中で止まった（時間切れ・GAS側の強制停止など）可能性。
- `hourly_gap` — 前回の `hourly_start` から **90分超**空いて開始した（`gap_min=<分>`）。トリガーが発火しなかった・止まっていた可能性。毎時トリガーの揺らぎを見込んだ閾値（`HOURLY_GAP_THRESHOLD_MIN_`）。
- `hourly_alert` — `ADMIN_EMAIL` へ異常通知を送った記録。
- `hourly_health_alert` — 日次の外部チェックが「毎時処理が止まっている」通知を送った記録（下記）。
- `tenant_warn` — テナント単位の警告（`tenant_id` はそのテナント）。下記。

見方: 正常なら **`hourly_start` と `hourly_done`（または `hourly_skip` / `hourly_error`）が同じ run ID で対**になる。`incomplete` は「始まったのに終わっていない」（実行はされた）、`gap` は「そもそも始まっていない時間がある」（発火漏れ）で、別の異常。両方が同時に出ることもある。
- 通知条件: 今回の開始時に `incomplete` または `gap` を検知し、**かつ前回の実行の開始時にも検知されていた（2回連続）** ときだけ `ADMIN_EMAIL` に通知する。通知は **1日1回まで**（同日に `hourly_alert` があれば送らない）。`ADMIN_EMAIL` 未設定の場合は送らず実行ログに出すだけ（`hourly_alert` も残さない）。1回だけの異常は行が残るのみで通知しない。
- `pipeline_log` は **14日間・最大5,000行**で保持される（下記「保持期間」）。書き込みのたびに行を削除することはない。
- 記録の書き込み自体が失敗しても実行は止まらず、実行ログ（GAS の実行数・Cloud ログ）に `pipelineLog_ failed` が出る。前回状態を読めない場合はその回の検知を省略して続行する。

### tenant_warn の見方
処理は止まらないが失敗した段階を、テナント単位で `pipeline_log` に残す（`event=tenant_warn`、`detail=run=<実行ID> stage=<段階> msg=<内容>`）。同じ回（run）・同じテナント・同じ `stage` は1行にまとめる。`stage` は次の3つ:
- `sendPendingReviewThanks` — レビューお礼メールの失敗（`hourly_done` の `errors` にも数えられ、従来どおり `ADMIN_EMAIL` にも通知）。
- `ensureAnalyticsColumns_` — 分析用列の追加失敗（受注取得は続行）。
- `syncCancelledOrders_` — キャンセル注文の同期失敗（受注取得・メール送信は続行）。
毎時の `hourly_done` が出ていても、テナント別の `tenant_warn` が出ていれば一部が失敗している。同じ `stage` が毎回出続けるテナントを優先して確認する。

### 日次の外部チェック（毎時処理の停止検知）
`checkBillingDaily`（毎日9時）の最後に、`_hourly` の最新の `hourly_start` を確認する。**3時間（180分）以上前**、または `hourly_start` が1件も無い場合は「停止」とみなし、`ADMIN_EMAIL` に「[step-samurai] 毎時処理が止まっています」を送る。本文は最終 `hourly_start` の時刻・直近の `hourly_error` の内容・`hourly_incomplete` / `hourly_gap` の件数（`pipeline_log` に残っている範囲）。
- 送信できたら `_hourly` / `hourly_health_alert` を記録し、**同じ日に2回は送らない**。3時間未満の正常時は何も送らず何も記録しない。
- `ADMIN_EMAIL` 未設定なら実行ログに出すだけ（記録もしない）。メール送信に失敗したら記録せず、翌日の実行で再判定する。
- このチェックが例外になっても `checkBillingDaily` 本体（trial 期限切れの記録・一覧メール）には影響しない。毎時処理側の検知（上記 `hourly_alert`）とは独立した外部の見張り。

### 保持期間と整理
- 保持は **14日間・最大5,000行**。整理は `checkBillingDaily` の中で**1日1回だけ**実行する（Script Properties `PIPELINE_LOG_PRUNED_DATE` に実行日(JST)を保存し、同日2回目は何もしない）。14日より前の古い行を消し、5,000行を超えた分は古い順に消す。ヘッダ行は消さない。`at` を解釈できない行は残す。
- 整理の前に、マスターシートにバックアップタブ **`pipeline_log_bak_20261016`** を作って `pipeline_log` を複製する（すでにあれば複製しない＝上書きしない）。複製に失敗した場合は何も削除しない。バックアップを新規作成した最初の回は、14日規則のみ適用し5,000行規則は適用しない。
- 整理の結果（削除件数・バックアップ有無）は実行ログ（`prunePipelineLog_:` で始まる行）のみに出て、`pipeline_log` には行を追加しない。
- **復元は人の作業**: 自動では戻さない。必要なら `pipeline_log_bak_20261016` から該当行を手作業で `pipeline_log` に戻す。バックアップタブは不要になったら人が削除する（コードは削除しない）。

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
- 削除: `tenant_secrets`・`tenant_auth`・`invites`・Script Properties（`REVIEW_INGEST_KEY__<id>` / `ANALYTICS_BACKFILL_CURSOR__<id>`）・マスター `tenants` 行（最後）。専用シートは `PURGED_<id>_<日時>` に改名するだけで消さない。**規約どおり、purge_tenant 実行後に運営が専用シート（`PURGED_`）と複製（`purge_backup_`）を解約日から30日以内に削除する**（人の作業）。`billing_events`（規約同意の記録を含む）と `pipeline_log` は残る。
- **期限管理**: 解約を受けたら、freee／カレンダーに「削除予定日（解約日+30日以内）」をメモしておく。
- `billing_events` に `purge_started` / `purge_tenant`（複製IDつき）を記録。途中で失敗した場合はマスター行が残るので、原因を直して同じ操作をやり直せる。
- 手作業で残るもの: `smtp_bridge` の `config.php`（旧方式の SMTP 設定）、複製の保管期限の判断、ECOS 側の転送設定。

## 7. クーポン
クーポン経路の再有効化（`settings.coupon_enabled` ゲート・リクエスト修正・実発行テスト）は **未実施**（作業レポート参照）。現状は課金ガード（`runPipeline` 先頭）のみ適用され、`runHourlyFollowPipeline` はクーポンを呼ばない。LP のクーポン項目は「準備中」。

## 8. 1店舗目 当日チェックリスト
上から順に。各項目が OK になってから次へ進む（`- [ ]` に印を付ける）。「戻し方」は NG のときの対処。メール文面は `docs/ops/EMAIL_TEMPLATES.md`（②〜④）。
レビューお礼メールは**店舗によるCSV取込（月1回を目安）**で動く。ECOS の自動取込は tokyoflower 専用で、外部店舗は店舗の月1回CSV取込のみ。`review_thanks_since` 等の安全ゲート（未設定なら送らない）は運営が設定する（`docs/REVIEW_THANKS.md`、項目13）。

| 済 | 手順 | どこで確認するか | NG のときの戻し方 |
|---|---|---|---|
| - [ ] | 1. 招待発行 | admin.html「作成して招待コードを発行」→ 招待コード（有効7日・一回限り）を店舗へ送付（メール②） | 期限切れ・紛失は再発行。店舗IDの誤りは作成し直す（setup 状態のためパイプライン対象外） |
| - [ ] | 2. 登録通知 | 店舗が onboard で RMS 接続テストに成功すると申込完了の通知メールが届く。admin.html で `billing_status=trial`・`trial_end`（今日+30日）を確認（§1・§3） | 通知が無い・trial 期間が空: 登録失敗（接続テストNG）の可能性。店舗にキー・申請状況の再確認を依頼し、招待を再発行 |
| - [ ] | 3. 規約同意の記録 | admin.html のテナント詳細「規約同意：v1.0 / 日時」。裏付けは `billing_events` の `terms_agreed`。**「規約同意：記録なし」なら NG** | 稼働させない（active 化しない）。店舗に onboard で規約・プライバシーポリシーへ同意し直してもらう（同意なしでは登録できない仕様）。経緯は `billing_note` に記録 |
| - [ ] | 4. sid と署名 | テナント詳細の設定一覧で `sid`（RMS店舗ID・数字。店舗URL `https://www.rakuten.co.jp/○○/` に対応）と店舗署名（`sname`/`sid` から自動生成。`shop_signature_override` で上書き可）が正しいこと。「操作」→ RMS 接続チェックが 200 | `set_tenant_setting`（「設定」タブ）で sid / `shop_signature_override` を修正し、接続チェックをやり直す。キーが原因なら「操作」→ 認証情報で再登録 |
| - [ ] | 5. go_live_date（未来日） | 「設定」タブ `go_live_date` が**今日より後の日付**（店舗希望日と合意。ログ一覧の「稼働開始日」列にも出る）。この日以降に発送した注文だけが対象（§6-2） | 過去日だと active 化がブロックされる。`go_live_date` を未来日に直す。誤って過去に遡る設定にしない（過去の注文へ一斉送信になる） |
| - [ ] | 6. follow_days | 「設定」タブ `follow_days_after_ship`（既定5日。店舗と合意）が数値であること。空・不正だと安全のため全件スキップされる（`docs/MANUAL_DAILY.md`） | 数値を設定し直す。active 化は前提（認証情報・go_live_date・follow_days・follow_v1 文面）が揃わないと拒否される |
| - [ ] | 7. 文面のプレビュー | 管理画面にレンダリング済みプレビュー機能は無い。運営が当該テナントのテナントシート `templates` タブ（無ければ `docs/MAIL_TEMPLATES.md` の既定文面）の follow_v1 をメールで店舗へ送り、ご確認・修正希望を受ける（メール③の流れ）。店舗の「テスト送信」はフォローメール（follow_v1）のみ・宛先は店舗連絡先メール固定で、dry_run=true の間は送信されない | 修正希望は「文面」（`templates` タブ）で直して再送し、承認を得てから次へ。文面を直し損ねたら直前の版に戻す。テスト送信のために dry_run=false にした場合は、直ちに `dry_run=true` に戻す |
| - [ ] | 8. dry_run 1〜2日 | `dry_run=true` のまま 1〜2日運転。`pipeline_log` で当該テナントの `hourly_done` が出て、`sends` タブに実送信（result=sent）が**増えていない**こと。同期済みの注文数（`follow_days_after_ship` 経過済み）も確認（§6-2） | 想定外の対象件数・エラー（`tenant_warn`）: 原因を直すまで次へ進まない。`go_live_date` の見直し、必要なら除外注文に登録 |
| - [ ] | 9. active 化 | 直前に `go_live_date` と対象件数を再確認 → 「設定」で `dry_run=false`（確認ダイアログあり）→「操作」で状態を `active`。毎時トリガーは `setupTriggers` で登録済みであること（`docs/GO_LIVE.md` (6)） | 異常があれば `status=paused` ＋ `settings.dry_run=true` に戻す。自動送信は paused で止まるが、店舗の「テスト送信」は paused でも dry_run=false だと店舗連絡先宛に1通届くため、dry_run=true を併用する。完全停止は `disabled`＋トークン失効（revoke。既発行のトークン／セッションは disabled だけでは残る）。全体を止める場合は `docs/GO_LIVE.md` (7)（グローバル `DRY_RUN=true`・トリガー削除） |
| - [ ] | 10. pipeline_log の確認と初回送信 | マスターシート `pipeline_log` の `tenant_id=_hourly` で `hourly_start` と `hourly_done` が**同じ `run=` で並ぶ**こと（§4-2）。`hourly_incomplete` / `hourly_gap` が出ていないこと。続けて、テナントシート `sends` タブに `result=sent` が追加され、送信件数・エラーが想定内であること | `hourly_start` だけで終わる／`gap`: トリガー一覧（`runHourlyFollowPipeline` 毎時）を確認。想定件数と大きく違えば `dry_run=true` に戻して調査（`docs/GO_LIVE.md` (5)(7)） |
| - [ ] | 11. 稼働開始のお知らせ（メール④） | 初回送信日時・件数・確認結果を `sends` / `pipeline_log` から転記して送付 | 件数や結果に不明点があるうちは送らず、原因確認後に送る |
| - [ ] | 12. freee に取引先登録とトライアル終了日のメモ | freee に取引先を登録し、`trial_end` をメモ（⑤を送る日＝`trial_end` の7日前）。`checkBillingDaily` の一覧メール（期限7日前・当日・切れ）でも把握できる（§4）。管理画面の課金欄に `billing_note` を残す | 登録漏れに気づいたら、トライアル終了前に freee で請求書を発行・送付（§3）。入金確認後に `billing_status=active` |
| - [ ] | 13. 外部店舗のレビューお礼の安全ゲート | 運営が当該テナントの settings に `review_thanks_since`（未設定なら送らない）と `review_thanks_min_rating`（既定3。これ未満は自動送信しない）を設定。確認場所は admin.html のテナント詳細「設定」タブ（`set_tenant_setting`）。店舗のCSV取込（月1回目安）の前に設定する。ECOS の自動取込は tokyoflower 専用 | 想定外の対象が出たら `review_thanks_since` を空に戻す（未設定＝送らない）か `dry_run=true` にして調査 |
