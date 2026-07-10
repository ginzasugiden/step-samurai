# step-samurai メール文面台帳（2026-07-06 時点、mailer.gs より抽出）

> **⚠️ 注記（2026-07-10追記）**：本ドキュメントは2026-07-06時点のコードに基づいており、**2026-07-10時点のコードとは乖離があります**（例：メール文面はテンプレート文字列のハードコードではなく、テナントごとの`templates`シート管理に変更済み。クーポン割引額の「300円OFFハードコード」は`{{discount}}`プレースホルダ化され解消済み）。最新の実装状況は `docs/SYSTEM_REPORT_2026-07-10.md` を参照。本ドキュメントの全面更新は本番GO後に実施予定。

## 1. フォローメール（発送後5日後）

コード上の所在: `gas/src/mailer.gs`
- 呼び出し元: `sendFollowMail(tenantId, order)`（8〜73行目中の45〜73行目）
- 件名生成: 51行目
- 本文生成関数: `buildFollowMailBody_(order, creds)`（75〜106行目）
- template_id（sendsシート記録用、67行目）: `'follow_v1'`

### 件名（51行目）

```
【${creds.shop_name}】ご感想お願いします！◇次回使えるクーポンプレゼント中！◇
```

### 本文全文（77〜105行目）

```
${order.buyer_name || 'お客様'} 様

「${creds.shop_name}」へご注文いただきまして、誠にありがとうございます。

ご注文につきましては${shipDate}に発送いたしました。商品内容、配送状況はいかがでしたか？

当店では今後もお客様に気持ちよくショッピングを楽しんでいただくため、
また今後の新商品の企画やよりお買い物がしやすいお店作りの参考にさせていただきたいと思いますので、
是非お声をお聞かせいただきたく大変お願い申し上げます。

${order.buyer_name || 'お客様'}様の貴重なご意見が私たちスタッフへの「なにより」のモチベーションアップにつながります。
貴重なお時間頂きますがご協力いただけますと幸いです。

☆★レビューを書いて次回使えるクーポンをゲット★☆

レビューを投稿していただきましたら、次回注文で使えるお得なクーポンを発行させていただきます。

新商品の企画や、よりお買い物が楽しめるお店作りの参考にさせていただきたいと思います。
ぜひご協力ください！

＜レビューの書き方＞
【楽天ログイン】→【画面右上 購入履歴】→ 対象商品から【商品レビューを書く】→【投稿する】

■おすすめ度
☆印が5つ並んでいます。
（カーソルを評価に値する数の☆の上に置いてクリックしてください）

---
${creds.shop_signature}
```

### 差し込み変数一覧

| 変数 | 意味 | 由来 |
|---|---|---|
| `${creds.shop_name}` | 店舗名 | `api_key`シートの`sname`（tenant.gs:104, 118） |
| `${order.buyer_name}` | 購入者名（空なら「お客様」） | `orders`シートの`buyer_name`列 |
| `${shipDate}`（=`order.ship_date`） | 発送日 | `orders`シートの`ship_date`列。空文字の場合ありうる（コード上`order.ship_date \|\| ''`） |
| `${creds.shop_signature}` | 署名ブロック（店舗名＋問い合わせURL、またはScript Properties `SHOP_SIGNATURE__OVERRIDE`で丸ごと上書き） | `tenant.gs:buildSignature_`（129〜139行目） |

## 2. クーポンメール（レビュー投稿特典）

コード上の所在: `gas/src/mailer.gs`
- 呼び出し元: `sendCouponMail(tenantId, order, coupon)`（111〜139行目）
- 件名生成: 117行目
- 本文生成関数: `buildCouponMailBody_(order, coupon, creds)`（141〜162行目）
- template_id（sendsシート記録用、133行目）: `'coupon_v1'`

### 件名（117行目）

```
【${creds.shop_name}】レビュー投稿特典クーポンのご案内
```

### 本文全文（146〜161行目）

```
${order.buyer_name || 'お客様'} 様

この度はレビューをご投稿いただきありがとうございます。

特典として次回ご注文で使えるクーポンをご用意しました。

━━━━━━━━━━━━━━━━━━
　クーポンコード：${coupon.coupon_id}
　割引金額：300円OFF
　有効期限：${coupon.valid_until}
━━━━━━━━━━━━━━━━━━
${getUrlLine}
またのご利用を心よりお待ちしております。

---
${creds.shop_signature}
```

`${getUrlLine}`（142〜144行目）は `coupon.get_url` が存在する場合のみ以下の行に展開される（無ければ空文字）:
```

クーポン獲得はこちら：
${coupon.get_url}

```

### 差し込み変数一覧

| 変数 | 意味 | 由来 |
|---|---|---|
| `${creds.shop_name}` | 店舗名 | 同上 |
| `${order.buyer_name}` | 購入者名 | 同上 |
| `${coupon.coupon_id}` | 楽天Coupon APIが発行したクーポンコード | `issueCoupon`のレスポンス（rakuten_api.gs:235） |
| `${coupon.valid_until}` | クーポン有効期限（発行時刻+65分を開始として+30日後、`yyyy/MM/dd`表示） | `issueCoupon`（rakuten_api.gs:237） |
| `${coupon.get_url}` | クーポン取得用URL（`displayFlag=0`の非公開クーポンのため、このURL経由でのみ取得可能） | `issueCoupon`のレスポンス`pcGetUrl`（rakuten_api.gs:236） |
| `割引金額：300円OFF` | **注意: ハードコードされた固定文言**。`coupon_engine.gs`の`COUPON_RULES[].discount`を変更しても、このメール文面の「300円OFF」表記は自動連動しない | mailer.gs:154 |
| `${creds.shop_signature}` | 署名ブロック | 同上 |

## 3. 差出人・CCの設定

いずれのメールも `sendViaBridge_`（mailer.gs:8-40）経由でSMTPブリッジへPOSTされる。差出人情報は `getRmsCredentials(tenantId)`（tenant.gs:99-127）が以下から合成する:

| 項目 | 値の由来 |
|---|---|
| 差出人アドレス（`from_email`） | マスター管理シート`tenants`タブの`shop_email`列（必須。未設定だとエラーで送信自体が失敗） |
| 差出人名（`from_name`） | `api_key`シートの`sname`列 |
| Reply-To（`reply_to`） | `from_email`と同一（固定） |
| CC（`cc_email`） | マスター管理シート`tenants`タブの`cc_email`列（任意・カンマ区切り可、空なら無し） |
| 問い合わせURL（署名内） | `https://inquiry.my.rakuten.co.jp/shop/${sid}`（`sid`は`api_key`シート） |

ブリッジ側の宛先解決: `resolveRecipient_(maskedEmail)`（mailer.gs:228-235）が Script Properties `TEST_MAIL_TO` を見て、設定されていれば実際の宛先をテスト用アドレスへ強制差し替える（[[SETTINGS]]参照）。

## 4. 文面を編集したい場合の選択肢

1. **コードを直接編集して push**（現実的・最短）
   `mailer.gs`の`buildFollowMailBody_`/`buildCouponMailBody_`のテンプレート文字列、および`sendFollowMail`/`sendCouponMail`内の件名行を直接書き換えて`clasp push`する。
   - 長所: すぐ反映、Gitで差分管理できる
   - 短所: 開発者（コード編集ができる人）でないと安全に直せない。誤って変数名を壊すとメール送信自体がエラーになるリスクがある

2. **シート管理化する**（非エンジニアでも編集できるようにする場合）
   マスター管理シートか新規`templates`タブに件名・本文・割引額表記などを列として持たせ、`buildFollowMailBody_`等がそこを読みに行くようにコードを変更する。
   - 長所: 文面担当者がスプレッドシート上で直接編集でき、push不要になる
   - 短所: **これ自体がコード変更であり、今回の対応範囲外**（本ドキュメント作成時点ではpush・コード変更は行っていない）。実装工数がかかる。差し込み変数（`${order.buyer_name}`等）の扱いをテンプレートエンジン的に処理する設計が別途必要

現状は文面の変更頻度が低ければ選択肢1、頻繁に文言調整が必要なら選択肢2への移行を将来検討、という整理が妥当。
