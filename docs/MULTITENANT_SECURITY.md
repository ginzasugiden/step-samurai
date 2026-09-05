# マルチテナント分離とセキュリティ設計

## データ分離
| 層 | 方式 |
|---|---|
| 受注・レビュー・送信・クーポン・設定・文面 | **店舗ごとに別スプレッドシート**（物理分離）。マスター管理シートが tenant_id → spreadsheet_id を保持 |
| RMS 認証情報 | **店舗がブラウザから登録** → マスターシート `tenant_secrets` に **暗号化**（HMAC-SHA256 CTR + HMAC タグ、鍵は Script Properties `SECRETS_KEY`）。運営者の画面・シート・ログに平文は出ない。tokyoflower のみ旧 api_key シート（BASE64）を継続 |
| SMTP 認証情報 | 同上（`tenant_secrets` kind=smtp）。送信のたびに GAS が復号してブリッジへ HTTPS で渡す。tokyoflower のみ `config.php` |
| 店舗トークン | マスターシート `tenant_auth` に **SHA-256 ハッシュのみ**。平文は発行時に一度だけ返す |

## アクセス制御（GAS WebApp）
- 店舗用アクションは `verifyTenantToken_(token)` が返した tenant_id **だけ**を使う。payload の tenant_id は無視
- tenant_id → spreadsheet_id の解決は `getTenantSpreadsheet` の1経路。`disabled` は拒否
- 管理者用アクションは `ADMIN_TOKEN`（hash_equals による定数時間比較）。店舗トークンでは呼べない
- 応答に秘密情報を含めない: list_tenants は認証情報の有無と期限のみ、settings 応答に SMTP 情報は無い
- 例外はスタックトレースを返さない（`internal_error` と 200 文字以内の detail）
- CORS: WebApp は `text/plain` POST のみ。GitHub Pages（HTTPS）から呼ぶ

## 運用ガードのテナント分離（2026-09-05 変更）
旧: `GO_LIVE_DATE` / `DRY_RUN` / `EXCLUDE_ORDERS` / `SHOP_SIGNATURE__OVERRIDE` はスクリプト全体で1値。
新: すべて各店舗の `settings` タブ（`go_live_date` / `dry_run` / `exclude_orders` / `shop_signature_override`）。
- 未設定のテナントは **fail-closed**（go_live_date 無し＝送らない、dry_run 無し＝送らない）
- グローバル `DRY_RUN=true` は全テナント共通のキルスイッチとして残す
- `tokyoflower` のみ、settings に値が無い間は旧グローバル値へフォールバック（移行の保険）
- `TEST_MAIL_TO` はグローバルのまま（運営者のテスト用。本番では必ず空）

## テナントの状態遷移
`setup`（作成直後・対象外）→ `active`（毎時パイプライン対象）⇄ `paused`（対象外・ログイン可）→ `disabled`（アクセス拒否）
`active` への変更は前提チェック（認証情報・go_live_date・follow_days・follow_v1 文面）を通らないと拒否。

## 店舗が自分で変えられるもの / 変えられないもの
| 店舗（テナントトークン） | 運営者（ADMIN_TOKEN） |
|---|---|
| follow_days_after_ship / coupon_valid_days / shop_signature_override / 文面 / テスト送信 / レビューCSV取込 / 分析閲覧 | 上記＋ go_live_date / dry_run / exclude_orders / coupon_rules / 状態 / トークン発行・失効 / 遡及取得 |

## 暗号化保管の前提（正直に）
- GAS が RMS・SMTP を使うため、**システムは復号できる**。「誰にも復号できない」方式ではない
- 保証するのは「運営者が通常の操作で平文を目にしない」こと。鍵（SECRETS_KEY）はログ・レポート・チャットに出さない。鍵を失うと全店舗の再登録が必要
- 招待コード（`invites` タブ）・店舗トークン（`tenant_auth`）は SHA-256 ハッシュのみ保存。平文は発行時に一度だけ表示
- `onboard_check` / `onboard_submit` は認証なしで到達する公開アクション。招待コード検証を最初に行い、失敗時は同一エラー。保存は楽天接続テスト成功時のみ

## 破壊的操作を持たない
API にテナント削除・シート削除・トリガー削除は無い。`setupTriggers()` はパイプライン対象外の遺物で、実行禁止（既存トリガーを全削除する）。

## 既知の残課題
- 公開アクション（onboard_*）にレート制限が無い。招待コードは 40 文字の乱数でブルートフォースは非現実的だが、必要なら CacheService で試行回数制限を追加
- 集計はオンザフライ（5,000件で約12秒）。テナント数×データ量が増えたら事前集計へ
