# ステップ侍 分析機能 導入手順書（2026-09-05 再生成版）

対象: `X:\projects\step-samurai` / GitHub `ginzasugiden/step-samurai`（master）
配布物: `gas/`（.gs 6本）`webui/`（3本）`existing_files.patch` `tests/run_tests.js` `ANALYTICS_DESIGN.md`

## 8/30版からの変更点
- 集計は表示時にオンザフライ（5分キャッシュ）。stats_hourly / stats_cohort シートと夜間トリガーは廃止
- キャンセル同期は毎時の fetchOrders に内包（新規トリガー不要）
- 遡及取得は backfillAutoTokyoflower が自分自身を一回限りトリガーで呼び直し、完了時に自動停止
- upsert はバッチ化（シート読み込み1回）。旧 Array(13) 固定長バグも解消

## 区分
| 区分 | 実行者 | 内容 |
|---|---|---|
| A | Claude Code | 配置・テスト・commit・clasp push・git push |
| B | 人間（GASエディタ） | probe → 遡及取得 → WebApp バージョン更新 |
| C | 人間（ブラウザ） | analytics.html で表示確認 |

## B（GASエディタ、push 後）
1. `probeAnalyticsTokyoflower` を実行 → ログの表を確認。p1 の analytics_columns がすべて true であること
   （false なら `ensureAnalyticsColumnsTokyoflower` を実行。通常は次の毎時パイプラインで自動追加される）
2. `backfillAutoTokyoflower` を1回実行 → 2分ごとに1ヶ月ずつ進み、13ヶ月で自動停止（約30分）。
   進捗は `showBackfillCursorTokyoflower`。途中で止まった場合は再度 `backfillAutoTokyoflower` を実行すると続きから
3. 完了後、再度 `probeAnalyticsTokyoflower` → p3_order_datetime_hasTimeRate が 90% 以上であること
4. デプロイ →「デプロイを管理」→ 既存の WebApp を鉛筆で編集 → バージョン「新バージョン」→ デプロイ
   **「新しいデプロイ」は作らない（URL が変わり管理画面が止まる）**

## C
`https://step-samurai.ginzasugiden.com/webui/analytics.html` を管理画面と同じ URL・トークンで開く。
- 「今年」で受注件数が RMS の件数と概ね一致（キャンセル除外分の差はある）
- 時間帯別が全て 0 なら order_datetime 未反映（B-2 未完了）
- 「不明」が太い場合は上部に警告が出る（マスクアドレス未取得注文）

## 停止条件
- probe が例外で落ちる / backfill ログに searchOrderNumbers_ error が連続 / orders 行数が減る / フォローメールが止まる・重複する

## ロールバック
| 対象 | 手順 |
|---|---|
| GAS | `git reset --hard backup/pre-analytics-20260905` → `clasp push -u ginzasugiden` |
| 追加した4列 | 残して無害（既存処理は列名参照）。消す場合はヘッダごと列削除 |
| 遡及で追加された過去注文 | 残して無害（GO_LIVE_DATE ガードで送信対象外）。消す場合は order_date < 稼働開始日 の行をフィルタして削除 |
| 遡及の一回限りトリガー | トリガー画面で handler=backfillAutoTokyoflower のものだけ削除 |
