# step-samurai（ステップ侍）— 開発・運用ルール（CLAUDE.md）

GAS（`gas/src/*.gs`, clasp）＋ 管理画面（`webui/`）＋ SMTP ブリッジ（`bridge/`）。テナントごとの Google スプレッドシートを DB として使う。

## コマンド
```bash
for f in tests/*.js; do node $f; done        # ユニットテスト（Node の vm で GAS をモック）
cd gas && clasp push -u ginzasugiden -f       # コード反映（GAS エディタ・時間トリガー分）
cd gas && clasp deploy -u ginzasugiden -i AKfycbwYsGkYmSfstE4Ay_mrvlZa1qHv5ImZe1EUtC8oXGpFRwZ67vJSC8vL4BQySoomPqI_7w -d "<説明>"   # 管理画面/WebApp へ反映（既存デプロイの新バージョン）
```
- `-i` 無しの `clasp deploy` は禁止（URL が変わり管理画面が壊れる）。`gas/src/appsscript.json` の `webapp` セクションを消さない。
- clasp は名前付きユーザー `-u ginzasugiden`（ginzasugiden@gmail.com）を明示する。git identity は `--local` で `ginzasugiden / 251701158+ginzasugiden@users.noreply.github.com`。
- 詳細なリリース手順・ロールバックは `docs/GO_LIVE.md` (9)。

## 安全設計（守ること）
- テナント用アクションは `verifyTenantToken_` で解決した tenant_id 以外に触れない。例外は `{ok:false,error:'...'}` の安全な文字列のみ返す。
- 送信系は fail-closed（`DRY_RUN` / `settings.dry_run` / `review_thanks_since` 未設定なら送らない）。本番テナント tokyoflower の settings を勝手に変えない。
- テナントシートの既存列は削除・並び替えしない。列追加は末尾に追記のみ（`ensureAnalyticsColumns_` / `ensureReviewIngestColumns_` のパターン）。行の構築はヘッダ名基準（`buildOrderRow_`）。
- 楽天への書き込み系 API は呼ばない。

## 運用メモ

### レビュー取得経路（2026-09-12〜）
1. **ECOS Chrome 拡張**（ECDashboard `extension/`, 0.4.0〜）が 21:00 JST の定期同期の最後に RMS「レビューチェックツール」の CSV
   （`https://review.rms.rakuten.co.jp/search/csv/?sy..ei&ev=0&tc=0&kw=&ao=A&st=1`, Shift_JIS）をログイン済みタブから取得し、
   ECOS `POST /api/ingest/reviews` へ 500 件バッチで送る（初回 2003〜全件、以降は直近 14 日）。
2. **ECOS** が `reviews` テーブルへ冪等 upsert し、`review_order_matches` ビューで受注と突合、バッチごとに本 GAS の WebApp へ転送する。
3. **GAS `doPost action=ingest_reviews`**（`gas/src/reviews_ingest.gs`）が reviews タブへ `review_id`（レビュー詳細URL）キーで冪等 upsert し、
   `matched` 列（orders タブとの注文番号突合）と `orders.review_linked` を更新する。以後は毎時の `runHourlyFollowPipeline` →
   `sendPendingReviewThanks` が従来どおり拾う（新規トリガー不要）。
4. 従来の管理画面「レビューCSVの取込」（`reviews_import.gs`）はそのまま併存（手動の補完経路）。

### API キーの置き場
- GAS 側: Script Properties `REVIEW_INGEST_KEY__<tenant_id>`（例 `REVIEW_INGEST_KEY__tokyoflower`）。平文を `hash_equals_` で照合（`ADMIN_TOKEN` と同方式）。
  シート・ログ・レポート・チャットに値を出さない。ローテーションは値を差し替えるだけ（ECOS 側も同時に更新）。
- ECOS 側: `workspace_credentials` の `STEP_SAMURAI_REVIEW_INGEST_KEY`（AES-256-GCM）、URL とテナント ID は `workspaces.settings.reviewForward`。
  管理画面 `/m/rakuten-review?tab=orders` の「転送設定」から登録する。
- 受信は `settings.review_ingest_enabled = 'true'` のテナントのみ（既定 false・fail-closed。`ensureReviewIngestSettingsTokyoflower()` で行を追加できる）。

### 削除フラグ運用
- 楽天側で消えたレビューは ECOS が同期範囲内で観測できなくなった時点で `deleted_at` を立て、GAS へ `deleted:true` で転送する。
  reviews タブでも `deleted_at` に日時が入るだけで**行は消さない**。`collectReviewsByOrder_` は `deleted_at` 有りを除外する（お礼メールを送らない）。
- 再度観測されたら `deleted:false` で上書きされ `deleted_at` が空に戻る（復活）。

### ロールバック手順（レビュー Webhook）
1. 受信停止だけなら `settings.review_ingest_enabled` を `false` に戻す（ECOS 側の転送は失敗ログとして残るのみ）。
2. コードを戻す: `git checkout 3d052f86aa274503965cdc4dc5d5f764334c719e -- gas/src` → `clasp push -u ginzasugiden -f` → 上記 `clasp deploy -i ...`（または同じ `-i` に旧バージョン番号 @9 を指定）。
3. シート: 複製 `step-samurai_backup_20260912`（ID `1USf3yiQ6asaMP5_yPg2omlSADzapMDYemQSIYIfcs7s`）から reviews タブを戻す。追加列（`review_type`〜`matched`）は残しても既存処理に影響しない。

### 確認用の GAS エディタ関数
- `previewReviewIngestStatusTokyoflower()` — 設定・キー登録有無・reviews 行数・matched/unmatched（読み取りのみ）
- `dryRunReviewThanksTokyoflower()` — お礼メールの対象一覧を送らずにログ出力
- `ensureReviewIngestSettingsTokyoflower()` — settings に不足キー（`review_ingest_enabled` 等）を追記
