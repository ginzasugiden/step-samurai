# レビューお礼メール（review_thanks）

楽天 Coupon API 停止中でも「レビューを書いてくださったお客様」へお礼メールを自動送信する経路。
クーポン経路（`evaluateCoupons` → `issueCoupon` → `sendCouponMail`）とは独立し、`runHourlyFollowPipeline` /
`runPipeline` の末尾で `sendPendingReviewThanks(tenantId)` として毎時実行される。

## レビューの入口

RMS「レビューチェックツール」→ CSVダウンロード → 管理画面（store UI）「レビューCSVの取込」。
2026-09 時点の実CSVヘッダ:
`レビュータイプ, 商品名, レビュー詳細URL, 評価, 投稿時間, タイトル, レビュー本文, フラグ, 注文番号, 未対応フラグ`

- `review_id` = レビュー詳細URL（商品レビューとショップレビューが同一注文・同時刻で並ぶため、URL以外では衝突する）
- `posted_at` = 投稿時間（`yyyy-MM-dd HH:mm:ss` に正規化）
- `body` = `【タイトル】\n本文`（タイトルがある場合）
- 取込は冪等（同じCSVを何度取り込んでも重複しない）。取込後に `linkOrdersReviews` が `orders.review_linked` を更新

## 送信条件（すべて満たす注文にのみ・fail-closed）

| # | 条件 | 設定 |
|---|---|---|
| 1 | `settings.review_thanks_since` が設定済み | 未設定＝送らない（過去レビューへの一斉送信防止） |
| 2 | レビューの最新投稿日 ≧ `review_thanks_since` | |
| 3 | レビューの最低評価 ≧ `settings.review_thanks_min_rating`（既定3） | 低評価はログに出して個別対応 |
| 4 | `status ≠ cancelled`、`ship_date` あり、`ship_date ≧ go_live_date` | |
| 5 | `exclude_orders` に含まれない | |
| 6 | `sends` に `type='review_thanks'` の成功行が無い | |
| 7 | `dry_run` でない | |

文面は `templates` タブ `review_thanks_v1`（管理画面から編集可）。

## 検証（`test_review_flow.gs`）

`testReviewMailFlow()` は自分名義のテスト注文の `masked_email` にだけ送る。`TEST_MAIL_TO` は使わない
（設定中は毎時トリガーの実顧客宛メールが横取りされ `sends` に sent と記録されるため）。
`sends` への記録は `review_thanks_test` / `coupon_test`（本番の重複判定に影響しない）。後片付けは `cleanupTestReviewFlow()`。

## 運用メモ

- `follow_v1` の既定文面は「レビュー投稿でクーポンをお届け」と案内している。Coupon API 復旧まで文面を見直すか、
  復旧後に `runPipeline` 側を有効化するかは店舗判断（管理画面のテンプレ編集で変更可）。
- **週次運用**: RMS「レビューチェックツール」で CSV をダウンロード → 管理画面「レビューCSVの取込」で「内容を確認」→「取り込む」。
  取込後は毎時の `runHourlyFollowPipeline` が条件を満たす注文へ自動でお礼メールを送る（手動送信は不要）。
- **低評価の扱い**: 評価が `review_thanks_min_rating`（既定3）未満のレビューは自動送信せず、GAS の実行ログに
  「低評価(<N)のため自動送信しない注文」として注文番号が出る。店舗が内容を読んで個別に対応する。
- **稼働開始**: tokyoflower は `review_thanks_since=2026-09-07` で 2026-09-07 に稼働開始（`review_thanks_min_rating=3`）。
  それ以前に投稿されたレビューには送らない。
