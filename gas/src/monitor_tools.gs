/**
 * モニター店舗（plan=monitor・無料60日）まわりの確認用関数。GAS エディタから人が実行する。
 */

/** 純粋関数のみ（実テナントへは書き込まない）。ログに OK / NG を出し、NG があれば例外 */
function testMonitorTrialDays_() {
  const cases = [
    ['getTrialDaysForPlan_(monitor) === 60', getTrialDaysForPlan_('monitor') === 60],
    ['getTrialDaysForPlan_(standard) === 30', getTrialDaysForPlan_('standard') === 30],
    ["getTrialDaysForPlan_('') === 30", getTrialDaysForPlan_('') === 30],
    ["addDaysStr_('2026-11-24', 60) === '2027-01-23'", addDaysStr_('2026-11-24', 60) === '2027-01-23']
  ];
  let ng = 0;
  cases.forEach(c => { Logger.log(`${c[1] ? 'OK' : 'NG'}  ${c[0]}`); if (!c[1]) ng++; });
  Logger.log(ng ? `NG ${ng}件` : '全項目 OK');
  if (ng) throw new Error(`testMonitorTrialDays_: NG ${ng}件`);
}
