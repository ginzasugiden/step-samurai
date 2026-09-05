# 新規テナント追加（要約）

詳細は `docs/ONBOARDING.md`。管理者画面 `webui/admin.html` から:
作成 → api_key シート登録（手動） → RMS 接続チェック → SMTPブリッジ config.php（手動） → go_live_date 設定 → 遡及取得 → トークン発行 → 店舗テスト送信 → dry_run=false → active
