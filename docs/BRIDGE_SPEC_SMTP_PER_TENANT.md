# SMTPブリッジ変更仕様（店舗登録 SMTP 認証の受け渡し）

対象: Lolipop `ginzasugiden.com/_wp/step-samurai/smtp_bridge.php`（ローカル `X:\projects\step-samurai-bridge\`）

## 変更点
GAS からの POST JSON に `smtp_user` / `smtp_pass` が含まれる場合、**config.php のテナント設定より優先**してその認証で送信する。含まれない場合は従来どおり config.php の `tenants[tenant_id]` を使う（tokyoflower 互換）。

## 受信 JSON（追加分）
```json
{ "tenant_id": "hanaya", "to": "...", "from_email": "...", "from_name": "...", "subject": "...", "body": "...",
  "reply_to": "...", "cc": "", "smtp_user": "<<店舗のSMTP ID>>", "smtp_pass": "<<店舗のSMTPパスワード>>" }
```

## 制約（維持・追加）
- 既存: `X-Bridge-Token` の hash_equals 照合、受信者ドメイン制限（`@*.fw.rakuten.ne.jp`）は**変更しない**
- 追加: 受信者制限の許可リストに `from_email`（店舗メール）を**動的に**加える（テスト送信が店舗メール宛のため）。ただし `from_email` は `@` を含む妥当な形式、かつ `tenant_id` が `[a-z0-9_-]{3,30}` に一致する場合のみ
- 追加: `smtp_user` / `smtp_pass` を **bridge.log に書かない**（既存ログの構造化出力からも除外）
- 追加: SMTP 認証失敗は `{"ok":false,"error":"smtp_auth_failed"}` を 200 以外で返し、詳細は bridge.log のみ
- SMTP ホスト・ポートは固定（`sub.fw.rakuten.ne.jp:587` STARTTLS）。payload からは変更不可

## テスト
1. `tenant_id=tokyoflower`・smtp_* なし → 従来どおり送信（回帰）
2. `smtp_user/pass` あり・正しい → 送信成功
3. `smtp_user/pass` あり・誤り → `smtp_auth_failed`、ログに資格情報が無いこと
4. 受信者が許可外ドメイン → 552 相当で拒否（従来どおり）

## ロールバック
アップロード前に `smtp_bridge.php` と `config.php` を `_backup/YYYYMMDD/` に退避。問題時は退避版を再アップロード。
