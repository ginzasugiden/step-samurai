# step-samurai 処理フロー（2026-07-06 時点のコード読解に基づく）

このドキュメントは `gas/src/*.gs` の静的読解のみに基づく。Script Properties の実値やトリガーの実際の登録状況など、コードだけでは分からない「実行時の状態」は都度「要確認」と明記する。

## 0. 全体像

```
[楽天RMS API] --fetchOrders--> orders シート
                                   |
                 (review_fetcher.py: Selenium, 本リポジトリ外) --> reviews シート
                                   |
                          linkOrdersReviews (orders.review_linked を更新)
                                   |
                          evaluateCoupons (対象抽出のみ・書き込みなし)
                                   |
                  issueCoupon (楽天Coupon API) --> coupons シート
                                   |
                  sendCouponMail (SMTPブリッジ) --> sends シート
                                   |
                          sendPendingMails / sendFollowMail
                          (発送5日後フォローメール, coupon経路と独立)
                          --> sends シート
```

`runPipeline` が上から順に1テナントずつ実行する唯一のエントリで、`runFollowMailsOnly` はフォローメール部分だけを単独実行するショートカット。

## 1. ステップ別詳細

| # | ステップ / 関数 | 起動方法 | 読むシート・列 | 書くシート・列 | 判定条件 |
|---|---|---|---|---|---|
| 1 | 受注取得 `fetchOrders(tenantId)`（rakuten_api.gs:17） | `runPipeline`内から自動呼び出し。手動: `testFetchOrders()` | 楽天RMS API `order/searchOrder`・`order/getOrder`（過去7日分、進行ステータス100-700=キャンセル除く）。orders シートは既存行upsert判定のため全件読む | `orders`: order_number, order_date, buyer_key, masked_email, buyer_name, item_code, item_name, amount, purchase_count(固定1), prefecture, ship_date, status, review_linked（既存値維持） | API取得範囲は過去7日固定。order_numberが一致すれば上書き、なければ追加 |
| 2 | レビュー取得 `fetchReviews(tenantId)`（rakuten_api.gs:118） | `runPipeline`内、ただし**無効化済み**（本体コメントアウト） | なし（呼んでもログのみ） | なし | 2026-07-05に楽天レビューAPI(`/es/2.0/review/list/`)が404となり本体を無効化。実データは外部の **`review_fetcher.py`（Selenium・本リポジトリに含まれない）** が `reviews` シートへ直接書き込む運用に一本化 |
| 3 | 受注⇄レビュー紐づけ `linkOrdersReviews(tenantId)`（rakuten_api.gs:164） | `runPipeline`内。手動: `testLinkOrdersReviews()` | `reviews`: order_number(2列目)。`orders`: order_number, review_linked | `orders.review_linked` を `'true'` に更新 | reviewsシートに同一order_numberの行が1件でもあれば紐づけ済みとする |
| 4 | クーポン判定 `evaluateCoupons(tenantId)`（coupon_engine.gs:55） | `runPipeline`内。手動: `testEvaluateCoupons()`（発行はしない） | `orders`: status, review_linked, buyer_key, order_number, purchase_count, ship_date。`coupons`: buyer_key(2列目), rule_id(3列目), api_result(6列目、issuedSet構築用) | なし（対象リストを返すのみ） | ①status≠cancelled ②ship_date存在 ③ship_date≧GO_LIVE_DATE ④now−ship_date≧5日 ⑤ルールのpurchase_count範囲内 ⑥requires_review=trueなら review_linked=true必須 ⑦(buyer_key, rule_id)がcoupons側で未発行（ERROR行は無視＝再挑戦可） |
| 5 | クーポン発行 `issueCoupon(tenantId, target)`（rakuten_api.gs:189） | `runPipeline`内（`isDryRun_()`がtrueならスキップしてログのみ）。手動: `testIssueOneCoupon(orderNumber, ruleId)` **注: DRY_RUNの状態に関わらず常に実発行**、`testPipelineTokyoflower()` **こちらもDRY_RUNチェックなしで常に実発行** | `coupons`シートへの追記のみ（読み取りは無し） | `coupons`: coupon_id, buyer_key, rule_id, issued_at, valid_until, api_result（失敗時 `ERROR:` 接頭辞） | 楽天Coupon API `POST /es/1.0/coupon/issue`（XML）へ実際にリクエストする外部副作用。開始日時は現在+65分固定 |
| 6 | クーポンメール送信 `sendCouponMail(tenantId, order, coupon)`（mailer.gs:111） | issueCoupon成功直後に呼び出し | `sends`: order_number(2列目), type(4列目) で重複チェック。`tenant.gs`経由でapi_key/masterシートから差出人情報取得 | `sends`: send_id, order_number, buyer_key, type='coupon', sent_at, template_id='coupon_v1', result | `isDryRun_()`がtrueなら送信せずログのみ。同一order_numberでtype='coupon'かつresultが'error'以外の行が既にあれば送信スキップ |
| 7 | フォローメール送信 `sendPendingMails(tenantId)` → `sendFollowMail`（mailer.gs:165, 45） | `runPipeline`の最後に自動呼び出し。**独立実行**: `runFollowMailsOnly()`（fetchOrders/fetchReviews/linkOrdersReviews/evaluateCouponsは一切呼ばず、現時点のordersシートの状態のみを見る） | `orders`: order_number, status, ship_date, masked_email, buyer_name, buyer_key。`sends`: order_number, type='follow'重複チェック | `sends`: send_id, order_number, buyer_key, type='follow', sent_at, template_id='follow_v1', result（'sent'または'error: ...'） | ①status≠cancelled ②ship_date存在 ③ship_date≧GO_LIVE_DATE ④now−ship_date≧5日 ⑤sendsに未送信（'follow'型でresultが'error'始まりでない行が無い）。`isDryRun_()`がtrueなら送信せずログのみ |
| 8 | 月次レポート `sendMonthlyReport(tenantId)`（report.gs:5） | `runMonthlyReport()`（トリガー: 毎月1日8時 ※`setupTriggers()`実行時のみ登録） | `orders`/`reviews`/`sends`/`coupons`（前月分のみ集計） | なし（管理者へメール送信のみ） | **DRY_RUNのチェックが無い＝DRY_RUN=trueでも送信される**。ADMIN_EMAIL未設定なら何もしない |
| 9 | ライセンス失効チェック `checkLicenseExpiry()`（tenant.gs:188） | `runLicenseCheck()`（トリガー: 毎日9時 ※同上） | `api_key`シートのexpiry列（テナントごと） | なし（管理者へメール送信のみ） | **DRY_RUNのチェックが無い**。失効まで0〜30日、または失効済みなら通知 |
| 10 | Webアプリ `doGet`/`doPost`（webapp.gs） | Webアプリとしてデプロイされている場合のみ、外部HTTPリクエストで起動（パイプラインのトリガーとは無関係） | token→tenant解決、各シートの件数集計（PIIは返さない） | `create_tenant`アクションで新規テナント作成（tenant.gs:createTenant）、`issue_token`/`revoke_token`でトークン操作 | `doPost`の管理系アクションは`ADMIN_TOKEN`による認証必須（auth.gs:requireAdmin_） |

## 2. 主要エントリ関数の役割整理

| 関数 | 役割 | 副作用の強さ |
|---|---|---|
| `runPipeline()`（main.gs:6） | 全アクティブテナントに対しfetchOrders→linkOrdersReviews→evaluateCoupons→(DRY_RUN分岐)issueCoupon+sendCouponMail→sendPendingMailsをフルで実行 | 最も強い。DRY_RUN=trueならクーポン発行/フォローメールとも送信は止まるが、fetchOrders・linkOrdersReviewsは常に実行され、ordersシートは書き換わる |
| `runFollowMailsOnly()`（main.gs:168） | フォローメール送信のみ。クーポン経路（evaluateCoupons/issueCoupon）もfetchOrders等も一切呼ばず、現在のordersシートのスナップショットに対して判定 | DRY_RUN=trueなら送信されず安全にログのみ |
| `testIssueOneCoupon(orderNumber, ruleId)`（main.gs:136） | 指定注文1件だけクーポンを**強制本発行**しメール送信するテスト用 | **DRY_RUNを無視して常に実発行**（コード内コメントに明記）。sendCouponMail呼び出し自体はisDryRun_チェックあり |
| `testPipelineTokyoflower()`（main.gs:175） | tokyoflower限定でパイプライン全体を手動実行 | **issueCoupon呼び出しにDRY_RUN分岐が無い**＝実行するとDRY_RUNの値に関わらず対象注文全件に実際のクーポンが発行される。sendCouponMail/sendPendingMailsの送信自体はisDryRun_で止まる |
| `review_fetcher.py`（本リポジトリに存在しない・楽天レビューページをSeleniumでスクレイピングし`reviews`シートへ直接書き込む外部スクリプトとの想定。main.gsやrakuten_api.gsのコメントにのみ言及あり） | レビュー取得の実運用ルート | 本ドキュメントのコード読解の範囲では実体を確認できていない |

## 3. トリガー登録状況

`setupTriggers()`（main.gs:67）が実行された場合に登録される内容:

| トリガー | 頻度 |
|---|---|
| `runPipeline` | 1時間ごと |
| `runLicenseCheck` | 毎日9時 |
| `runMonthlyReport` | 毎月1日8時 |

**注意**: `setupTriggers()`は冒頭で`ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))`を実行し、既存の全トリガーを削除してから再登録する。他の目的で個別に追加したトリガーがあれば消える。

**現在実際に登録されているトリガーの実体**は、Script Properties同様コードだけからは分からない（`ScriptApp.getProjectTriggers()`を実行しないと分からない実行時状態）。GASエディタ左メニューの「トリガー」（時計アイコン）から確認可能（読み取り専用操作・変更なし）。
