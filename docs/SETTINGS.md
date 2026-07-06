# step-samurai 設定台帳（2026-07-06 時点のコード読解に基づく）

## 0. 重要な注意（実値の取得について）

Script Properties の**実際の値**は Apps Script のプロパティストアに保存されており、コードの静的読解や `clasp pull` では取得できない（Apps Script APIに実行系エンドポイントは無く、コード実行かGASエディタのUIでしか読めない）。本ドキュメントは「コード上どのキーが参照され、それぞれ何に使われるか」を全て洗い出したものであり、**現在値の列は未確認（要確認）としている**。

実値を確認する場合は、GASエディタで対象プロジェクトを開き、左メニューの歯車アイコン「プロジェクトの設定」→「スクリプト プロパティ」を見る（**読み取り専用の操作で、コード変更・送信・pushとは無関係**）。

## 1. Script Properties 一覧

| キー | 意味 | 現在値 | 変えるとどうなるか | 本番推奨値 |
|---|---|---|---|---|
| `DRY_RUN`（main.gs:92） | `'true'`の間、クーポン発行(runPipeline経由)とフォローメール送信(sendFollowMail/sendCouponMail)を実行せずログ出力のみにする安全弁 | **要確認**（GASエディタで確認可） | `'true'`→実際の発行・送信が全て止まる。`'false'`または未設定→実送信が有効になる。ただし`testIssueOneCoupon`と`testPipelineTokyoflower`の**クーポン発行自体はこの値を見ないため無効化できない**点に注意 | 実送信テスト完了までは **`'true'`**。本番運用開始後にのみ `'false'` |
| `GO_LIVE_DATE`（main.gs:98） | この日付より前に発送された注文をフォローメール・クーポンの対象から除外する日付ガード。`YYYY-MM-DD`形式。未設定・不正値の場合は`null`が返り**該当テナントの対象が全件スキップ**されるfail-closed設計 | ユーザー申告値: `2026-06-30`（本セッション内での申告。GASエディタでの直接確認はしていない） | 過去日にするほど対象が増える（未処理の古い注文にも遡って送信される）。未設定にすると全スキップ（安全側） | 実際にサービス開始した日、またはそれ以降の日付 |
| `BRIDGE_URL`（mailer.gs:10） | メール送信を委譲する外部SMTPブリッジ（あんしんメルアドSMTPブリッジ、ロリポップ側 `smtp_bridge.php`）のURL | **要確認（秘匿情報ではないがURL自体は伏せる）** | 誤ったURLだと送信時に例外（`BRIDGE_URL/BRIDGE_SECRET未設定`または通信エラー）になりメール未送信のまま`sends`に`error:`記録 | 本番のロリポップ側エンドポイント |
| `BRIDGE_SECRET`（mailer.gs:11） | ブリッジへのリクエストに付与する認証トークン（`X-Bridge-Token`ヘッダ） | `****`（秘匿） | 値が不一致だとブリッジ側で拒否され送信失敗 | ロリポップ側`config.php`と一致する値 |
| `TEST_MAIL_TO`（mailer.gs:229） | 設定されている間、フォロー/クーポンメールの実際の宛先を**強制的にこのアドレスへ差し替える**（本番顧客には届かない） | **要確認** | 設定されていると、DRY_RUN=falseでも顧客には届かずこのアドレスにのみ届く。空/未設定で本来の顧客アドレスへ送信 | 本番運用時は**未設定または空**にする（設定されたままだと実際の顧客に届かない） |
| `ADMIN_EMAIL`（main.gs:84, report.gs:6） | パイプラインエラー通知・月次レポートの送信先 | **要確認** | 未設定だと月次レポートは送信されず、エラー通知も飛ばない | 運用担当者の実メールアドレス |
| `ADMIN_TOKEN`（auth.gs:22） | webapp.gsの`doPost`管理系アクション（テナント作成・トークン発行/失効）を許可する認証トークン | `****`（秘匿） | 漏洩するとWebアプリ経由で誰でもテナント作成等が可能になる | 十分に長いランダム文字列。定期的なローテーション推奨 |
| `TENANT_MASTER_SHEET_ID`（tenant.gs:21） | テナント一覧（`tenants`タブ: tenant_id/shop_name/spreadsheet_id/status/shop_email/cc_email）を持つマスター管理シートのID | **要確認** | 誤ると全テナント処理が失敗（`listActiveTenants`が空またはエラー） | 正しいマスターシートのID固定 |
| `API_KEY_SHEET_ID`（tenant.gs:77） | 楽天RMS認証情報（serviceSecret/licenseKey等）を持つ`api_key`シートのID | **要確認** | 誤るとRMS API呼び出し・クーポン発行が全て失敗 | 正しいシートID固定 |
| `SHOP_SIGNATURE__OVERRIDE`（tenant.gs:130） | 設定されていると、店舗署名を`sname`/`sid`から自動生成する代わりにこの文字列で置き換える | **要確認**（未設定の可能性あり＝自動生成が使われる） | 署名文言を一括で差し替えたい場合に使う任意項目 | 通常は未設定（自動生成に任せる） |
| `COUPON_RULES__<tenantId>`（coupon_engine.gs:44） | 指定テナントのクーポンルールをコード内`COUPON_RULES`定数の代わりにJSON文字列で上書きする拡張ポイント | **要確認**（tokyoflowerでは未設定の可能性が高く、コード内`COUPON_RULES`がそのまま使われていると推測） | 設定するとそのテナントだけ割引額・条件をコード変更なしで変えられる | 現状は店舗ごとの差別化不要のため未設定のままでよい |
| `TOKEN__<uuid>`（auth.gs:5, 7, 14, 18） | Webアプリ用のテナント別アクセストークン（動的に発行・失効されるランタイム状態であり、静的な「設定」ではない） | 発行状況は`issueTenantToken`/`revokeTenantToken`の呼び出し履歴に依存、コードからは不明 | — | — |

## 2. クーポンルール（`getCouponRules_`、coupon_engine.gs:17-50）

定義場所: `gas/src/coupon_engine.gs` 冒頭の `COUPON_RULES` 定数（17〜36行目）。

店舗別に上書きしたい場合は Script Properties の `COUPON_RULES__<tenantId>` にJSON文字列を設定すれば `getCouponRules_` がそちらを優先する（44〜48行目）。tokyoflowerについて、この上書きが現在設定されているかは実値未確認だが、設定されていなければ以下の共通ルールがそのまま使われる。

| rule_id | 説明 | purchase_count範囲 | レビュー必須 | クーポン名 | 割引額 |
|---|---|---|---|---|---|
| `first_purchase` | 初回購入特典 | 1〜1 | 必須 | 初回ご購入ありがとうクーポン | 300円OFF |
| `repeat_purchase` | リピート特典（2回目以降） | 2〜9999 | 必須 | リピーター感謝クーポン | 300円OFF |

`first_purchase`の全パラメータ（coupon_engine.gs:19-26）:
- `rule_id`: `'first_purchase'`
- `purchase_count_min`: 1
- `purchase_count_max`: 1
- `requires_review`: true
- `coupon_name`: `'初回ご購入ありがとうクーポン'`
- `discount`: 300（円、discountType=1固定＝定額値引きとしてrakuten_api.gs:213でAPIに渡される）

補足（楽天API側の固定パラメータ、rakuten_api.gs:203-222）: `issueCount=100`、有効開始=発行時刻+65分、有効期間=開始から30日間、`combineFlag=1`（他クーポン併用可）、`displayFlag=0`（非公開クーポン＝URL経由のみ取得可）。

## 3. フォローメール条件の所在（コード上の行番号）

判定ロジックは2箇所に**重複して実装**されている（同一条件だが別関数）:

1. `mailer.gs` の `sendPendingMails`（165〜203行目）— `runFollowMailsOnly`/`runPipeline`から呼ばれる実行系
   - status除外: 181行目 `if (row[idx('status')] === 'cancelled') return;`
   - 発送日必須: 182〜183行目
   - GO_LIVE_DATEガード: 184行目 `if (new Date(shipDate) < goLiveDate) return;`
   - 5日経過判定: 186〜187行目 `diffDays = Math.floor((now - new Date(shipDate)) / 86400000); if (diffDays < 5) return;`
   - 未送信チェック: `alreadySent_`関数（206〜211行目）、`sendFollowMail`内48行目で呼び出し

2. `coupon_engine.gs` の `evaluateCoupons`（84〜123行目）— クーポン判定用に同種の条件を再実装（101〜107行目）。フォローメールとは独立したロジックだが、GO_LIVE_DATE・5日経過の考え方は同じ

いずれも `getGoLiveDate_()`（main.gs:97-103）と `isDryRun_()`（main.gs:91-93）を共通で参照している。

## 4. まとめ表: どこで何を変えられるか

| 変更したいこと | 変更箇所 | pushの要否 |
|---|---|---|
| フォローメール送信を止める/再開する | Script Properties `DRY_RUN` | 不要（プロパティ変更のみ） |
| 対象期間の開始日を変える | Script Properties `GO_LIVE_DATE` | 不要 |
| 何日後にフォローメールを送るか（現在5日固定） | `mailer.gs:187`, `coupon_engine.gs:107` のマジックナンバー`5` | 必要（コード変更） |
| クーポン割引額・条件 | `coupon_engine.gs`の`COUPON_RULES`、または`COUPON_RULES__<tenantId>`プロパティ | 前者は必要、後者は不要 |
