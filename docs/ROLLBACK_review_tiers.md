# ロールバック手順（★段階別レビューお礼・メール設定画面・拡張 v1.1.0）

バックアップ: タグ `backup/pre-review-tiers-20261108`（反映前のコード）。スプレッドシートの複製は GAS エディタで `backupBeforeReviewTiers()` を実行（人間ゲートH1）。実行ログの複製IDを控える。

## 1. コード（GAS・webui）
```bash
git checkout backup/pre-review-tiers-20261108 -- gas/src webui terms.html guide.html tests
cd gas && clasp push -u ginzasugiden -f
cd gas && clasp deploy -u ginzasugiden -i AKfycbwYsGkYmSfstE4Ay_mrvlZa1qHv5ImZe1EUtC8oXGpFRwZ67vJSC8vL4BQySoomPqI_7w -d "rollback review tiers"
# または既存IDに旧バージョン番号（@28）を指定: clasp deploy -u ginzasugiden -i <ID> -V 28
git commit -am "rollback: review tiers" && git push
```
`-i` なしの deploy は禁止。`appsscript.json` の webapp セクションを消さない。

## 2. 設定（settings_history から書き戻し）
GAS エディタで `restoreSettingsFromHistory(tenantId, historyRowId)` を実行する。`historyRowId` は店舗シートの `settings_history` タブの `id` 列。その行の `before_json`（保存前の値）が settings / フォロー文面へ書き戻され、書き戻しも新しい履歴（kind=restore）として残る。
- tokyoflower の移行（`migrateTokyoflowerTiers`）を戻すときは kind=`migrate` の行の id を指定する。段階設定が空に戻っても、tokyoflower は従来の `review_thanks_min_rating` 方式で動く（暫定の例外）。
- 追加した設定キー（`tier*` など）は残しても既存処理に影響しない。

## 3. シート
複製したマスター／tokyoflower から必要なタブを戻す。`sends` の追加列（`tier_no`, `rating`）・`sync_alerts` タブは残しても影響しない。

## 4. 拡張機能（Chrome ウェブストア）
1. ストアのデベロッパーダッシュボード → 「ステップ侍 レビュー取込」（ID: nhokckohpjajdnijfodpaimecfghlfch）→ パッケージ。
2. 問題があれば、公開前なら審査中の v1.1.0 を取り下げる。公開済みなら `dist/step-samurai-review-ext-1.0.0.zip`（v1.0.0 と同一内容）を **version を 1.1.1 以上に上げた manifest で** 再アップロードする（ストアは version の巻き戻しを受け付けない）。具体的には `extension/` を `git checkout backup/pre-review-tiers-20261108 -- extension` で戻し、`manifest.json` の version だけ上げて `node tools/build-extension.js`。
3. GAS 側は v1.0.0 の拡張とも互換（状態報告 `ext_report_status` を送らない拡張は従来どおり動く）。

## 5. 例外コードの削除予定
- 対象: `gas/src/review_tiers.gs` の `LEGACY_REVIEW_THANKS_TENANTS_`（tokyoflower の暫定例外）、`isLegacyReviewThanksTenant_`、`gas/src/review_thanks.gs` の `mode = 'legacy'` 分岐。
- 時期: `migrateTokyoflowerTiers()` を実行した日の **7日後**（H2 の実行日を控えて、その7日後）。それまでは消さない。
- 例外は「段階設定が未保存の時だけ」効く（段階設定が保存済みなら必ず段階方式。テストで固定済み）。
- 削除後は、段階設定が未保存の店舗はすべて fail-closed（送信しない）になる。
