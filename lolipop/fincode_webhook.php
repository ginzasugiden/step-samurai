<?php
/**
 * fincode_webhook.php — fincode Webhook 受信 → step-samurai GAS WebApp へ転送（ロリポップ用）
 *
 * 配置: smtp_bridge.php と同じディレクトリ。サーバへのアップロードは人間ゲート（リポジトリにはコミットのみ）。
 * fincode 審査完了までは配置しない（＝無効）。GAS 側も BRIDGE_TOKEN / FINCODE_WEBHOOK_SECRET 未設定の間は受信を拒否する。
 *
 * ■ fincode Webhook 仕様（確認元: https://docs.fincode.jp/develop_support/development_monitoring ,
 *                          https://docs.fincode.jp/api の「Webhook_通知仕様」）
 *  - POST / JSON。認証は HTTP ヘッダ `Fincode-Signature`。値は「Webhook 登録時に signature パラメータへセットした文字列」そのもの
 *    （HMAC ではなく固定の共有値の照合）。fincode からの通知か判定するのに使う。
 *  - イベント名は body の `event`（例: payments.card.capture / payments.card.exec / subscription.card.update / subscription.card.delete）。
 *    body に一意な event_id は無い → access_id / subscription_id / status / transaction_date 等から冪等キーを合成して GAS へ渡す。
 *  - 応答: HTTP 200 + Content-Type text/plain + ボディ "0" で正常受信。それ以外・3秒超過は最大5回（約20分間隔）リトライ。
 *    → 署名 OK なら転送前に即 "0" を返し、転送は応答後に行う（GAS の応答が3秒を超えうるため）。
 *
 * ■ config.php に必要なキー（config.example.php 参照。値はリポジトリに置かない）
 *    fincode_signature   … fincode 登録時の signature 値
 *    gas_webapp_url      … GAS WebApp の URL（既存デプロイの /exec）
 *    gas_bridge_token    … GAS Script Property BRIDGE_TOKEN と同じ値
 *    fincode_log_file    … 転送失敗・拒否のログ（任意。既定 __DIR__/fincode_webhook.log。*.log は .gitignore 済み）
 */

$config = @include __DIR__ . '/config.php';
$logFile = (is_array($config) && !empty($config['fincode_log_file'])) ? $config['fincode_log_file'] : __DIR__ . '/fincode_webhook.log';

function fw_log($logFile, $msg) {
    @file_put_contents($logFile, date('Y-m-d H:i:s') . ' ' . $msg . "\n", FILE_APPEND | LOCK_EX);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }

// fail-closed: 設定不足なら受信しない（5xx を返すので fincode 側はリトライする）
if (!is_array($config) || empty($config['fincode_signature']) || empty($config['gas_webapp_url']) || empty($config['gas_bridge_token'])) {
    fw_log($logFile, 'rejected: not_configured');
    http_response_code(503);
    exit;
}

// 署名検証（Fincode-Signature ヘッダ。定数時間比較）
$sig = isset($_SERVER['HTTP_FINCODE_SIGNATURE']) ? (string)$_SERVER['HTTP_FINCODE_SIGNATURE'] : '';
if ($sig === '' || !hash_equals((string)$config['fincode_signature'], $sig)) {
    fw_log($logFile, 'rejected: bad_signature');
    http_response_code(401);
    exit;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body) || empty($body['event'])) {
    fw_log($logFile, 'rejected: bad_body');
    http_response_code(400);
    exit;
}

// 一意キーの合成（fincode の通知に event_id は無い）。同一通知のリトライでは同じ値になる
$parts = [
    (string)$body['event'],
    (string)($body['access_id'] ?? ''),
    (string)($body['subscription_id'] ?? ''),
    (string)($body['customer_id'] ?? ''),
    (string)($body['status'] ?? ''),
    (string)($body['transaction_date'] ?? ''),
];
$eventId = hash('sha256', implode('|', $parts));

// 即 200 "0"（3秒制約）。接続を閉じてから転送する
ignore_user_abort(true);
header('Content-Type: text/plain');
header('Connection: close');
header('Content-Length: 1');
echo '0';
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    @ob_flush(); @flush();
}

$forward = json_encode([
    'action'  => 'fincode_webhook',
    'payload' => [
        'bridge_token'     => (string)$config['gas_bridge_token'],
        'fincode_event_id' => $eventId,
        'event_payload'    => $body,
    ],
], JSON_UNESCAPED_UNICODE);

// GAS WebApp は 302 でリダイレクトするため followlocation=true。リダイレクト後は POST→GET に変わるのが GAS の正しい挙動
// （POSTREDIR で POST を維持したり -X POST 相当を強制したりしない）。Content-Type は text/plain（webapp.gs 方針）
$ch = curl_init((string)$config['gas_webapp_url']);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $forward,
    CURLOPT_HTTPHEADER     => ['Content-Type: text/plain; charset=UTF-8'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT        => 30,
]);
$res  = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err  = curl_error($ch);
curl_close($ch);

$ok = false;
if ($res !== false) { $j = json_decode($res, true); $ok = is_array($j) && !empty($j['ok']); }
if (!$ok) {
    // 応答済みのため fincode のリトライは来ない。手動再送用に event_id と GAS の応答（秘密は含まれない）だけ残す
    fw_log($logFile, "forward_failed event={$body['event']} event_id={$eventId} http={$code} err={$err} res=" . substr((string)$res, 0, 200));
}
