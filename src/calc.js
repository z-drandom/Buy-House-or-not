/* ============================================================
 * calc — 买房 vs 租房测算引擎（纯函数，无 DOM 依赖，可在 node 中直接测试）
 *
 * 方法论：同额现金流对照法。
 * 两条路径投入完全相同的现金，比较持有期末的净资产：
 *   买房路径：期初付首付+税费中介，逐月还月供+持有成本；
 *             期末净资产 = 房产市值 - 卖出成本 - 剩余贷款本金
 *   租房路径：把买房者的期初支出（扣除押金）投入年化收益率 r 的组合，
 *             每月将两路径现金流差额继续投入（差额为负则从组合中支取）；
 *             期末净资产 = 投资组合终值 + 押金退回
 * ============================================================ */
const calc = (() => {

  /** 等额本息月供：P 本金，annualRatePct 年利率(%)，years 年限 */
  function annuityPayment(P, annualRatePct, years) {
    const n = Math.round(years * 12);
    if (P <= 0 || n <= 0) return 0;
    const i = annualRatePct / 100 / 12;
    if (i === 0) return P / n;
    const f = Math.pow(1 + i, n);
    return P * i * f / (f - 1);
  }

  /**
   * 单笔贷款摊还表。
   * method: 'annuity' 等额本息 | 'linear' 等额本金
   * 返回逐月数组：payments 月供、principals 当月归还本金、
   * interests 当月利息、balances 月末剩余本金
   */
  function buildSchedule({ principal, annualRatePct, years, method }) {
    const n = Math.round(years * 12);
    const i = annualRatePct / 100 / 12;
    const payments = [], principals = [], interests = [], balances = [];
    let bal = principal, totalInterest = 0;
    if (principal > 0 && n > 0) {
      const annuity = annuityPayment(principal, annualRatePct, years);
      const linearPrincipal = principal / n;
      for (let m = 1; m <= n; m++) {
        const interest = bal * i;
        let prin;
        if (method === 'linear') {
          prin = Math.min(linearPrincipal, bal);
        } else {
          prin = Math.min(annuity - interest, bal);
        }
        if (m === n) prin = bal; // 末期清零，吸收浮点误差
        bal -= prin;
        totalInterest += interest;
        payments.push(prin + interest);
        principals.push(prin);
        interests.push(interest);
        balances.push(bal);
      }
    }
    return { payments, principals, interests, balances, totalInterest };
  }

  /**
   * 贷款拆分与合并摊还表。
   * loanMode: 'comm' 纯商贷 | 'pf' 纯公积金 | 'combo' 组合贷
   * 公积金部分受额度上限约束，超出部分自动划入商贷（pfOverflow 标记）。
   */
  function buildLoan(p) {
    const principal = p.price * (1 - p.downPct / 100);
    let pfPart = 0, commPart = 0, pfOverflow = false;
    if (p.loanMode === 'comm') {
      commPart = principal;
    } else { // 'pf' 或 'combo'
      pfPart = Math.min(principal, p.pfCap);
      commPart = principal - pfPart;
      if (p.loanMode === 'pf' && commPart > 0) pfOverflow = true;
    }
    const sPf = buildSchedule({ principal: pfPart, annualRatePct: p.pfRatePct, years: p.loanYears, method: p.repayMethod });
    const sComm = buildSchedule({ principal: commPart, annualRatePct: p.commRatePct, years: p.loanYears, method: p.repayMethod });
    const n = Math.round(p.loanYears * 12);
    const merged = { payments: [], principals: [], interests: [], balances: [] };
    for (let m = 0; m < n; m++) {
      merged.payments.push((sPf.payments[m] || 0) + (sComm.payments[m] || 0));
      merged.principals.push((sPf.principals[m] || 0) + (sComm.principals[m] || 0));
      merged.interests.push((sPf.interests[m] || 0) + (sComm.interests[m] || 0));
      merged.balances.push((sPf.balances[m] || 0) + (sComm.balances[m] || 0));
    }
    return {
      principal, pfPart, commPart, pfOverflow,
      schedule: merged,
      totalInterest: sPf.totalInterest + sComm.totalInterest,
      firstPayment: merged.payments[0] || 0,
      lastPayment: merged.payments[n - 1] || 0,
    };
  }

  /** 增量现金流的内部收益率（月频，二分法），返回年化 %；无解返回 null */
  function irr(cashflows) {
    const npv = (r) => cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
    let lo = -0.08, hi = 0.08; // 月利率区间，对应年化约 -63% ~ +152%
    let fLo = npv(lo), fHi = npv(hi);
    if (isNaN(fLo) || isNaN(fHi) || fLo * fHi > 0) return null;
    for (let k = 0; k < 100; k++) {
      const mid = (lo + hi) / 2, fMid = npv(mid);
      if (fLo * fMid <= 0) { hi = mid; } else { lo = mid; fLo = fMid; }
    }
    const monthly = (lo + hi) / 2;
    return (Math.pow(1 + monthly, 12) - 1) * 100;
  }

  /**
   * 主测算。params 见 defaults()。
   * 所有金额单位：元；利率/比例单位：百分数。
   */
  function simulate(p) {
    const M = Math.round(p.holdYears * 12);
    const loan = buildLoan(p);

    // ---- 期初 ----
    const downPayment = p.price * p.downPct / 100;
    const deedTax = p.price * p.deedTaxPct / 100;
    const buyAgentFee = p.price * p.buyAgentPct / 100;
    const upfront = downPayment + deedTax + buyAgentFee + p.otherOneOff;
    const deposit = p.monthlyRent * p.depositMonths;

    const rm = Math.pow(1 + p.investReturnPct / 100, 1 / 12) - 1; // 月化收益率
    const g = p.homeGrowthPct / 100;
    const moveEveryMonths = Math.max(1, Math.round(p.moveEveryYears * 12));

    // ---- 逐月推进 ----
    let portfolio = upfront - deposit; // 租房者把同等期初现金（扣押金）投入组合
    const monthly = {
      buyOut: new Array(M), rentOut: new Array(M),
      rent: new Array(M), moveCost: new Array(M),
      propertyFee: new Array(M), maintenance: new Array(M),
      portfolio: new Array(M), balance: new Array(M),
      buyNetWorth: new Array(M), rentNetWorth: new Array(M),
      homeValue: new Array(M),
      mortgagePrincipal: new Array(M), mortgageInterest: new Array(M),
    };
    let cumBuyOut = upfront, cumRentOut = deposit;
    let totalPropertyFee = 0, totalMaintenance = 0, totalRentPaid = 0, totalMoveCost = 0;
    let interestPaidInHold = 0;
    const incrementalCf = [-(upfront - deposit)]; // 买房相对租房的增量现金流（IRR 用）

    for (let m = 1; m <= M; m++) {
      const yearIdx = Math.floor((m - 1) / 12); // 第 yearIdx+1 年
      const idx = m - 1;

      // 买房月支出
      const mortgage = idx < loan.schedule.payments.length ? loan.schedule.payments[idx] : 0;
      const homeValueYearStart = p.price * Math.pow(1 + g, yearIdx);
      const propertyFee = p.propertyFeeMonthly * Math.pow(1 + p.inflationPct / 100, yearIdx);
      const maintenance = homeValueYearStart * (p.maintPctYearly / 100) / 12;
      const buyOut = mortgage + propertyFee + maintenance;
      totalPropertyFee += propertyFee;
      totalMaintenance += maintenance;
      if (idx < loan.schedule.interests.length) interestPaidInHold += loan.schedule.interests[idx];

      // 租房月支出
      const rent = p.monthlyRent * Math.pow(1 + p.rentGrowthPct / 100, yearIdx);
      let rentOut = rent;
      totalRentPaid += rent;
      if (m > 1 && (m - 1) % moveEveryMonths === 0) { // 每 N 年换租一次
        rentOut += p.moveCost;
        totalMoveCost += p.moveCost;
      }

      // 租房者投资组合：先滚动收益，再投入当月现金流差额
      portfolio = portfolio * (1 + rm) + (buyOut - rentOut);

      // 逐月净资产（房价按月平滑复利，卖出成本按当期市值计）
      const homeValueNow = p.price * Math.pow(1 + g, m / 12);
      const balance = idx < loan.schedule.balances.length ? loan.schedule.balances[idx] : 0;
      monthly.buyOut[idx] = buyOut;
      monthly.rentOut[idx] = rentOut;
      monthly.rent[idx] = rent;
      monthly.moveCost[idx] = rentOut - rent;
      monthly.propertyFee[idx] = propertyFee;
      monthly.maintenance[idx] = maintenance;
      monthly.portfolio[idx] = portfolio;
      monthly.balance[idx] = balance;
      monthly.homeValue[idx] = homeValueNow;
      monthly.mortgagePrincipal[idx] = idx < loan.schedule.principals.length ? loan.schedule.principals[idx] : 0;
      monthly.mortgageInterest[idx] = idx < loan.schedule.interests.length ? loan.schedule.interests[idx] : 0;
      monthly.buyNetWorth[idx] = homeValueNow * (1 - p.sellCostPct / 100) - balance;
      monthly.rentNetWorth[idx] = portfolio + deposit;

      cumBuyOut += buyOut;
      cumRentOut += rentOut;
      incrementalCf.push(-(buyOut - rentOut));
    }

    // ---- 期末结算 ----
    const homeValueEnd = p.price * Math.pow(1 + g, p.holdYears);
    const sellCost = homeValueEnd * p.sellCostPct / 100;
    const balanceEnd = M - 1 < loan.schedule.balances.length ? loan.schedule.balances[M - 1] : 0;
    const buyNetWorthEnd = homeValueEnd - sellCost - balanceEnd;
    const rentNetWorthEnd = portfolio + deposit;
    const finalDiff = buyNetWorthEnd - rentNetWorthEnd;
    // 增量现金流终值：买房者卖房回款，租房者退押金
    incrementalCf[M] += (homeValueEnd - sellCost - balanceEnd) - deposit;

    // ---- 盈亏平衡点（首个买房净资产 ≥ 租房净资产的月份）----
    let breakEvenMonth = null;
    for (let m = 1; m <= M; m++) {
      if (monthly.buyNetWorth[m - 1] >= monthly.rentNetWorth[m - 1]) { breakEvenMonth = m; break; }
    }

    // ---- 年度汇总（图表用；含第 0 年起点）----
    const yearly = {
      years: [], buyNetWorth: [], rentNetWorth: [],
      cumBuyOut: [], cumRentOut: [], buyOutYear: [], rentOutYear: [],
      homeValue: [], balance: [],
    };
    yearly.years.push(0);
    yearly.buyNetWorth.push(p.price * (1 - p.sellCostPct / 100) - loan.principal);
    yearly.rentNetWorth.push(upfront);
    yearly.cumBuyOut.push(upfront);
    yearly.cumRentOut.push(deposit);
    yearly.buyOutYear.push(upfront);
    yearly.rentOutYear.push(deposit);
    yearly.homeValue.push(p.price);
    yearly.balance.push(loan.principal);
    let cb = upfront, cr = deposit;
    for (let y = 1; y <= p.holdYears; y++) {
      let by = 0, ry = 0;
      for (let m = (y - 1) * 12; m < y * 12; m++) { by += monthly.buyOut[m]; ry += monthly.rentOut[m]; }
      cb += by; cr += ry;
      const em = y * 12 - 1;
      yearly.years.push(y);
      yearly.buyNetWorth.push(monthly.buyNetWorth[em]);
      yearly.rentNetWorth.push(monthly.rentNetWorth[em]);
      yearly.cumBuyOut.push(cb);
      yearly.cumRentOut.push(cr);
      yearly.buyOutYear.push(by);
      yearly.rentOutYear.push(ry);
      yearly.homeValue.push(monthly.homeValue[em]);
      yearly.balance.push(monthly.balance[em]);
    }

    return {
      params: p, loan, monthly, yearly, months: M,
      metrics: {
        upfront, deposit, downPayment, deedTax, buyAgentFee,
        initialPortfolio: upfront - deposit,
        monthlyInvestRate: rm,
        breakEvenMonth,
        breakEvenYears: breakEvenMonth === null ? null : breakEvenMonth / 12,
        buyNetWorthEnd, rentNetWorthEnd, finalDiff,
        totalInterest: loan.totalInterest,
        interestPaidInHold,
        totalPropertyFee, totalMaintenance, totalRentPaid, totalMoveCost,
        sellCost, homeValueEnd,
        rentRatio: p.monthlyRent > 0 ? p.price / (p.monthlyRent * 12) : Infinity, // 静态租售比（年）
        irrBuy: irr(incrementalCf),
        firstPayment: loan.firstPayment,
      },
    };
  }

  /** 敏感性网格：房价年涨幅 × 投资年化收益率 → 期末净资产差额 */
  function sensitivityGrid(p, growthList, investList) {
    const cells = [];
    for (let i = 0; i < investList.length; i++) {
      for (let j = 0; j < growthList.length; j++) {
        const r = simulate({ ...p, homeGrowthPct: growthList[j], investReturnPct: investList[i] });
        cells.push({
          xi: j, yi: i,
          growth: growthList[j], invest: investList[i],
          diff: r.metrics.finalDiff,
          breakEvenYears: r.metrics.breakEvenYears,
        });
      }
    }
    return cells;
  }

  /** 持有年限扫描：1..maxYears 年，各持有期下的期末净资产差额 */
  function holdYearSweep(p, maxYears) {
    const out = [];
    for (let y = 1; y <= maxYears; y++) {
      const r = simulate({ ...p, holdYears: y });
      out.push({ years: y, diff: r.metrics.finalDiff });
    }
    return out;
  }

  /** 默认参数（中国大陆一二线城市的典型量级） */
  function defaults() {
    return {
      // 房产
      price: 3000000, downPct: 30, deedTaxPct: 1, buyAgentPct: 1, otherOneOff: 20000,
      propertyFeeMonthly: 350, maintPctYearly: 0.3, homeGrowthPct: 2, sellCostPct: 2, holdYears: 30,
      // 贷款
      loanMode: 'combo', commRatePct: 3.6, pfRatePct: 2.85, pfCap: 1200000,
      loanYears: 30, repayMethod: 'annuity',
      // 租房
      monthlyRent: 6000, rentGrowthPct: 2, depositMonths: 1, moveCost: 3000, moveEveryYears: 3,
      // 财务
      investReturnPct: 3, inflationPct: 2,
    };
  }

  return { annuityPayment, buildSchedule, buildLoan, simulate, sensitivityGrid, holdYearSweep, irr, defaults };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = calc;
