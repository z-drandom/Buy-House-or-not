/* 计算引擎对照测试：node tests/calc.test.js */
const calc = require('../src/calc.js');

let failed = 0;
function assertClose(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected} ±${tol}`);
}
function assertTrue(name, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  (' + detail + ')'}`);
}

// 1. 等额本息月供与银行公式对照：100 万 / 30 年 / 4.9% → 5307.27 元（公开对照值）
assertClose('等额本息 100万/30年/4.9%', calc.annuityPayment(1000000, 4.9, 30), 5307.27, 0.01);
// 100 万 / 30 年 / 3.6% → 4546.45 元（公式复算值）
assertClose('等额本息 100万/30年/3.6%', calc.annuityPayment(1000000, 3.6, 30), 4546.45, 0.05);
// 零利率退化为本金均摊
assertClose('等额本息 零利率', calc.annuityPayment(1200000, 0, 10), 10000, 1e-9);

// 2. 等额本金：100 万 / 30 年 / 4.9%，首月 = 2777.78 + 4083.33 = 6861.11，次月递减 11.34 元
{
  const s = calc.buildSchedule({ principal: 1000000, annualRatePct: 4.9, years: 30, method: 'linear' });
  assertClose('等额本金 首月月供', s.payments[0], 6861.11, 0.01);
  assertClose('等额本金 月递减额', s.payments[0] - s.payments[1], 1000000 / 360 * 0.049 / 12, 0.01);
  assertClose('等额本金 末期余额归零', s.balances[359], 0, 1e-6);
  // 总利息 = 本金 × 月利率 × (期数+1)/2
  assertClose('等额本金 总利息', s.totalInterest, 1000000 * (0.049 / 12) * 361 / 2, 1);
}

// 3. 等额本息摊还表自洽：本金部分合计 = 本金；末期余额归零
{
  const s = calc.buildSchedule({ principal: 2100000, annualRatePct: 3.6, years: 25, method: 'annuity' });
  const sumPrincipal = s.principals.reduce((a, b) => a + b, 0);
  assertClose('等额本息 归还本金合计', sumPrincipal, 2100000, 0.01);
  assertClose('等额本息 末期余额归零', s.balances[s.balances.length - 1], 0, 1e-6);
  // 月供 = 本金 + 利息 恒成立
  const ok = s.payments.every((pay, i) => Math.abs(pay - s.principals[i] - s.interests[i]) < 1e-6);
  assertTrue('等额本息 月供=本金+利息', ok, '拆分不自洽');
}

// 4. 组合贷拆分：300 万房 7 成贷 210 万，公积金上限 120 万 → 公积金 120 万 + 商贷 90 万
{
  const p = { ...calc.defaults(), loanMode: 'combo' };
  const loan = calc.buildLoan(p);
  assertClose('组合贷 本金', loan.principal, 2100000, 1e-6);
  assertClose('组合贷 公积金部分', loan.pfPart, 1200000, 1e-6);
  assertClose('组合贷 商贷部分', loan.commPart, 900000, 1e-6);
  // 合并首月月供 = 两部分等额本息月供之和
  const expect = calc.annuityPayment(1200000, 2.85, 30) + calc.annuityPayment(900000, 3.6, 30);
  assertClose('组合贷 首月月供', loan.firstPayment, expect, 0.01);
  // 纯公积金但超额度 → 溢出标记
  const loanPf = calc.buildLoan({ ...p, loanMode: 'pf' });
  assertTrue('纯公积金超额度溢出标记', loanPf.pfOverflow === true, 'pfOverflow 应为 true');
}

// 5. 全款买房（首付 100%）：无月供，仍能测算
{
  const r = calc.simulate({ ...calc.defaults(), downPct: 100 });
  assertClose('全款 首月月供', r.metrics.firstPayment, 0, 1e-9);
  assertTrue('全款 期末净资产为有限值', isFinite(r.metrics.finalDiff), String(r.metrics.finalDiff));
}

// 6. 期末净资产手工复算（简化参数消除次要项）：
//    100 万房、首付 100%、无税费中介、无持有成本、房价涨幅 0、卖出成本 0；
//    租金 3000 元/月零涨幅、押金 0、不换租；投资收益率 0。
//    → 买房：期末净资产 = 100 万；
//    → 租房：组合 = 100 万 - 累计租金差额；每月差额 = 0(买) - 3000(租) = -3000；
//      12 个月后组合 = 100 万 - 3.6 万 → 差额 = +3.6 万
{
  const p = {
    ...calc.defaults(),
    price: 1000000, downPct: 100, deedTaxPct: 0, buyAgentPct: 0, otherOneOff: 0,
    propertyFeeMonthly: 0, maintPctYearly: 0, homeGrowthPct: 0, sellCostPct: 0, holdYears: 1,
    monthlyRent: 3000, rentGrowthPct: 0, depositMonths: 0, moveCost: 0,
    investReturnPct: 0, inflationPct: 0,
  };
  const r = calc.simulate(p);
  assertClose('手工样例 买房期末净资产', r.metrics.buyNetWorthEnd, 1000000, 0.01);
  assertClose('手工样例 租房期末净资产', r.metrics.rentNetWorthEnd, 1000000 - 36000, 0.01);
  assertClose('手工样例 净资产差额', r.metrics.finalDiff, 36000, 0.01);
}

// 7. 机会成本方向性：投资收益率越高，租房相对越划算（差额单调递减）
{
  const base = calc.defaults();
  const d3 = calc.simulate({ ...base, investReturnPct: 3 }).metrics.finalDiff;
  const d6 = calc.simulate({ ...base, investReturnPct: 6 }).metrics.finalDiff;
  assertTrue('收益率越高租房越划算', d6 < d3, `d6=${d6} d3=${d3}`);
  const g0 = calc.simulate({ ...base, homeGrowthPct: 0 }).metrics.finalDiff;
  const g4 = calc.simulate({ ...base, homeGrowthPct: 4 }).metrics.finalDiff;
  assertTrue('房价涨幅越高买房越划算', g4 > g0, `g4=${g4} g0=${g0}`);
}

// 8. IRR 合理性：IRR 存在时，把投资收益率设为该 IRR，净资产差额应≈0
{
  const base = calc.defaults();
  const r = calc.simulate(base);
  if (r.metrics.irrBuy !== null) {
    const r2 = calc.simulate({ ...base, investReturnPct: r.metrics.irrBuy });
    // 相对于总盘子（数百万）应几乎为零
    assertTrue('IRR 自洽（差额≈0）', Math.abs(r2.metrics.finalDiff) < 5000, `diff=${r2.metrics.finalDiff}`);
  } else {
    assertTrue('IRR 存在', false, 'IRR 为 null');
  }
}

// 9. 敏感性网格与持有期扫描结构完整
{
  const cells = calc.sensitivityGrid(calc.defaults(), [-2, 0, 2], [2, 4]);
  assertTrue('敏感性网格尺寸', cells.length === 6, `len=${cells.length}`);
  const sweep = calc.holdYearSweep(calc.defaults(), 10);
  assertTrue('持有期扫描尺寸', sweep.length === 10, `len=${sweep.length}`);
}

console.log(failed === 0 ? '\n全部测试通过 ✔' : `\n${failed} 个测试失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
