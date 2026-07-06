/**
 * report.gs — 月次レポート
 */

function sendMonthlyReport(tenantId) {
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (!adminEmail) return;

  const ss      = getTenantSpreadsheet(tenantId);
  const orders  = ss.getSheetByName('orders').getDataRange().getValues();
  const reviews = ss.getSheetByName('reviews').getDataRange().getValues();
  const sends   = ss.getSheetByName('sends').getDataRange().getValues();
  const coupons = ss.getSheetByName('coupons').getDataRange().getValues();

  const now          = new Date();
  const lastMonth    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const monthStr     = Utilities.formatDate(lastMonth, 'Asia/Tokyo', 'yyyy年M月');

  const filterMonth = (rows, dateColIdx) => rows.slice(1).filter(r => {
    if (!r[0]) return false;
    const d = new Date(r[dateColIdx]);
    return d >= lastMonth && d <= lastMonthEnd;
  });

  const monthOrders  = filterMonth(orders, 1);   // order_date
  const monthReviews = filterMonth(reviews, 5);  // posted_at
  const monthSends   = filterMonth(sends, 4);    // sent_at
  const monthCoupons = filterMonth(coupons, 3);  // issued_at
  const totalSales   = monthOrders.reduce((s, r) => s + (Number(r[7]) || 0), 0);

  const shopName = listActiveTenants().find(t => t.tenant_id === tenantId)?.shop_name || tenantId;

  const body = `
【step-samurai 月次レポート】${shopName} / ${monthStr}

■ 受注
  件数：${monthOrders.length}件
  売上：¥${totalSales.toLocaleString()}

■ レビュー
  投稿数：${monthReviews.length}件

■ メール配信
  送信数：${monthSends.length}件

■ クーポン
  発行数：${monthCoupons.length}件

---
自動送信 by step-samurai
  `.trim();

  MailApp.sendEmail(adminEmail, `【step-samurai】${shopName} ${monthStr} 月次レポート`, body);
  Logger.log(`月次レポート送信: ${shopName} ${monthStr}`);
}
