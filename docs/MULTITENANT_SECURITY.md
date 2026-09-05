# マルチテナント分離とセキュリティ設計

## データ分離
| 層 | 方式 |
|---|---|
| 受注・レビュー・送信・クーポン・設定・文面 | **店舗ごとに別スプレッドシート**（物理分離）。マスター管理シートが tenant_id → spreadsheet_id を保持 |
| RMS 認証情報 | 共有 api_key シート（運営者アカウントのみ閲覧可）。BASE64 接頭辞で保存、`decodeApiValue_` で復号 |
| SMTP 認証情報 | Lolipop 上の `config.php`（リポジトリ外・非公開）。テナントごとに SMTP ID/パスワード・差出人を保持 |
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

## 破壊的操作を持たない
API にテナント削除・シート削除・トリガー削除は無い。`setupTriggers()` はパイプライン対象外の遺物で、実行禁止（既存トリガーを全削除する）。

## 既知の残課題
- SMTPブリッジの config.php 更新は手動（WinSCP）。テナント数が増えたら管理画面からの登録経路を検討
- api_key シートへの登録は手動。誤登録防止に管理画面の RMS 接続チェックを必ず通す
- 集計はオンザフライ（5,000件で約12秒）。テナント数×データ量が増えたら事前集計へ
