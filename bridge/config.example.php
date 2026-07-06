<?php
/**
 * config.example.php — smtp_bridge.php 用設定ファイルの雛形（キー名のみ・値はプレースホルダ）
 *
 * 実運用では、このファイルを config.php としてコピーし、実際の値を入れて
 * ロリポップ側（_wp/step-samurai/）に配置する。config.php 自体は .gitignore で
 * 除外されており、リポジトリには含まれない。
 *
 * 注意: bridge/ ディレクトリ（smtp_bridge.php / 実際の config.php）は
 * WinSCP経由でロリポップから取得する運用のため、このリポジトリ作成時点では
 * ローカルに実ファイルが存在しない。そのため以下のキー名は mailer.gs の
 * sendViaBridge_() が送信するリクエスト項目（tenant_id/to/from_email/from_name/
 * subject/body/html_body/reply_to/cc、および X-Bridge-Token ヘッダ）から
 * 推測したものであり、実際の smtp_bridge.php の実装と突き合わせて調整すること。
 */

return [
    // GAS側 Script Properties の BRIDGE_SECRET と同じ値にする（X-Bridge-Tokenヘッダで照合）
    'bridge_secret' => 'CHANGE_ME',

    // あんしんメルアド（お使いのSMTPサーバ）の接続情報
    'smtp_host'       => 'CHANGE_ME',
    'smtp_port'       => 587,
    'smtp_user'       => 'CHANGE_ME',
    'smtp_password'   => 'CHANGE_ME',
    'smtp_encryption' => 'tls', // 'tls' または 'ssl'

    // 送信ログの出力先（*.log は .gitignore で除外済み）
    'log_file' => __DIR__ . '/bridge.log',
];
