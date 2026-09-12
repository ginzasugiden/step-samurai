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

## ECOS Webhook 経由の取込（ingest_reviews）

RMS「レビューチェックツール」CSVの手動取込とは別に、ECOS が定期取得した楽天レビューを
`doPost` の `action=ingest_reviews` へ送信することで reviews タブへ自動 upsert できる
（テナントのログイントークンは使わない。ECOS 専用のキーで認証する）。

### 認証

- Script Properties に `REVIEW_INGEST_KEY__<tenant_id>`（平文キー。`ADMIN_TOKEN` と同方式）を登録する。
  例: `REVIEW_INGEST_KEY__tokyoflower`
- リクエストの `payload.api_key` をこの値と `hash_equals_`（定数時間比較）で照合する。
- 未登録テナント・キー不一致のどちらも理由を区別せず `{ok:false, error:'unauthorized'}` を返す
  （キーの存在有無を外部から推測されないようにするため）。

### 有効化フラグ

- `settings.review_ingest_enabled` が文字列 `'true'` の間だけ受け付ける（既定 `'false'`。未設定＝拒否のfail-closed）。
- 無効時は認証キーが正しくても `{ok:false, error:'review_ingest_disabled'}` を返す。
- 有効化するには管理者権限で `setTenantSettingValueAdmin_(tenantId, 'review_ingest_enabled', 'true')` を実行するか、
  管理画面の設定編集（editable_by_tenant=FALSE のため運営者のみ）で切り替える。

### リクエスト形式

```
curl -s -X POST 'https://script.google.com/macros/s/XXXXX/exec' \
  -H 'Content-Type: text/plain' \
  -d '{
    "action": "ingest_reviews",
    "payload": {
      "tenant_id": "tokyoflower",
      "api_key": "<REVIEW_INGEST_KEY__tokyoflower の平文>",
      "sync_id": "run-0001",
      "reviews": [
        {
          "review_id": "https://review.rakuten.co.jp/item/1/240364_10000409/ccl6-.../",
          "order_number": "240364-20260901-0566501349",
          "review_type": "商品レビュー",
          "rating": 5,
          "title": "",
          "body": "写真の通り…",
          "posted_at": "2026-09-10 17:27:54",
          "product_title": "＼銀座から贈る…",
          "rakuten_item_id": "10000409",
          "deleted": false
        }
      ]
    }
  }'
```

1リクエスト最大500件（超過は `{ok:false, error:'invalid_payload'}`）。成功時のレスポンスは
`{ok:true, upserted, inserted, updated, matched, unmatched, sync_id}`。

### reviews タブの追加列

既存列（`review_id | order_number | buyer_key | item_code | rating | posted_at | body`）は削除・並び替えせず、
末尾に以下を追記する（`ensureReviewIngestColumns_`。CSV取込では使わない列）:

| 列 | 内容 |
|---|---|
| `review_type` | 商品レビュー／ショップレビュー |
| `product_title` | 商品名 |
| `rakuten_item_id` | 楽天商品ID |
| `source` | 常に `ecos_webhook`（CSV取込行と区別するため） |
| `updated_at` | 直近の取込日時 |
| `deleted_at` | 削除フラグが立った日時（空なら未削除） |
| `matched` | `orders.order_number` と一致するか（`TRUE`/`FALSE`） |

`buyer_key` / `item_code`（既存列）は Webhook 取込では書き込まない＝CSV取込済みの値を消さない。

### 削除フラグの運用

ECOS 側でレビューが削除された（非表示化された）場合は `deleted: true` で同じ `review_id` を再送する。
行そのものは削除せず `deleted_at` に取込時刻を立てるだけ（監査のため）。`deleted: false` で再送すると
`deleted_at` は空文字にクリアされる（＝復活）。`deleted_at` が入っている行は
`collectReviewsByOrder_`（レビューお礼メールの対象抽出）から除外され、削除済みレビューへのお礼メールは送らない。

### GASエディタ用ヘルパー（読み取り専用・tokyoflower）

- `previewReviewIngestStatusTokyoflower()`: 設定値・キー登録有無（値は出さない）・reviews行数・matched/unmatched件数をログ出力
- `ensureReviewIngestSettingsTokyoflower()`: `review_ingest_enabled` 等の未追加キーを settings タブへ投入（冪等）
- `dryRunReviewThanksTokyoflower()`: `previewPendingReviewThanksTokyoflower()` のラッパー（送らずに対象一覧を確認）

## 運用メモ

- `follow_v1` の既定文面は「レビュー投稿でクーポンをお届け」と案内している。Coupon API 復旧まで文面を見直すか、
  復旧後に `runPipeline` 側を有効化するかは店舗判断（管理画面のテンプレ編集で変更可）。
- **週次運用**: RMS「レビューチェックツール」で CSV をダウンロード → 管理画面「レビューCSVの取込」で「内容を確認」→「取り込む」。
  取込後は毎時の `runHourlyFollowPipeline` が条件を満たす注文へ自動でお礼メールを送る（手動送信は不要）。
- **低評価の扱い**: 評価が `review_thanks_min_rating`（既定3）未満のレビューは自動送信せず、GAS の実行ログに
  「低評価(<N)のため自動送信しない注文」として注文番号が出る。店舗が内容を読んで個別に対応する。
- **稼働開始**: tokyoflower は `review_thanks_since=2026-09-07` で 2026-09-07 に稼働開始（`review_thanks_min_rating=3`）。
  それ以前に投稿されたレビューには送らない。
