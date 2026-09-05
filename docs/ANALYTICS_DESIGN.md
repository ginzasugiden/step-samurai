# ステップ侍 店舗分析 設計（再生成版 2026-09-05）

## 構成（2層）
- 生データ: テナントシートの orders / reviews / sends / coupons（既存）
- 集計: `get_analytics` API が呼ばれた時にシートを読み、`computeAnalytics_`（純粋関数）で集計。5分キャッシュ

## orders 追加列
order_datetime（JST 秒まで）/ units / coupon_shop_price / coupon_codes。`buildOrderRow_` がヘッダ基準で埋めるため、列の有無・順序に依存しない。

## 指標定義
| # | 指標 | 定義 |
|---|---|---|
| 1 | 受注件数 | 受注日が期間内 かつ status≠cancelled |
| 2 | 売上 | totalPrice の合計（顧客請求総額） |
| 3 | 客単価 | 売上 / 受注件数 |
| 4 | 新規/リピート/不明 | masked_email 無し→不明、purchase_count≤1→新規、他→リピート |
| 5 | 時間帯別受注 | order_datetime の時（JST）。時刻無し行は除外し警告 |
| 6 | 曜日別受注 | order_date の曜日 |
| 7 | 日別・月別推移 | 受注・売上・顧客区分・レビュー・フォロー送信 |
| 8 | フォロー送信率 | sends(type=follow,result=sent) の注文 / 発送済み母集団 |
| 9 | レビュー率 | reviews に紐づく注文（review_linked=true 含む） / 母集団 |
| 10 | 星分布・平均 | 紐づいたレビューの rating |
| 11 | レビュー投稿リードタイム | posted_at − ship_date（日）を6区分 |
| 12 | 時間帯別レビュー | posted_at に時刻がある割合が50%以上のときのみ表示 |
| 13 | クーポン発行・利用率 | coupons 発行（ERROR除く） / 発行コードが後続注文の coupon_codes に出現 |
| 14 | 商品別・都道府県別 上位10 | item_name / prefecture |

## キャンセル検知
`fetchOrders` 末尾で直近60日を orderProgress 800/900 で検索し、該当行を cancelled に更新（try/catch で本線を保護）。

## 遡及取得
月単位で searchOrder（全ステータス・ページング）→ getOrder 100件チャンク → バッチ upsert。カーソルを Script Properties に保存し、
`backfillAutoTokyoflower` が一回限りトリガーで自分を呼び直す。完了時に purchase_count を全行再計算。

## 安全性
- 読み取り API は個人情報を返さない（集計値のみ）
- 過去注文の流入は GO_LIVE_DATE ガードでメール対象外。クーポン経路は毎時パイプライン外
- 既存トリガーには一切触れない（setupTriggers は使わない）
