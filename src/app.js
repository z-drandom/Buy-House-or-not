/* ============ 界面逻辑：表单 ↔ 计算引擎 ↔ 图表 ============ */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);

  /* ---------- 数值格式化 ---------- */
  const fmtWan = (v, digits) => {
    if (!isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    const d = digits !== undefined ? digits : (abs >= 1e7 ? 0 : 1);
    return (v / 1e4).toFixed(d) + ' 万';
  };
  const fmtWanSigned = (v) => (v >= 0 ? '+' : '−') + fmtWan(Math.abs(v));
  const fmtYuan = (v) => Math.round(v).toLocaleString('zh-CN') + ' 元';
  const fmtAxisWan = (v) => {
    if (Math.abs(v) >= 1e8) return (v / 1e8).toLocaleString('zh-CN') + '亿';
    return Math.round(v / 1e4).toLocaleString('zh-CN') + '万';
  };

  /* ---------- 设计令牌（随浅色/深色主题变化） ---------- */
  function tokens() {
    const s = getComputedStyle(document.documentElement);
    const get = (n) => s.getPropertyValue(n).trim();
    return {
      surface: get('--surface'), ink: get('--ink'), ink2: get('--ink-2'),
      muted: get('--muted'), gridLine: get('--grid-line'), axis: get('--axis'),
      border: get('--border'), buy: get('--buy'), rent: get('--rent'),
      buyWeak: get('--buy-weak'), cat3: get('--cat-3'), cat4: get('--cat-4'),
      cat5: get('--cat-5'), neutralMid: get('--neutral-mid'),
    };
  }

  /* ---------- ECharts 公共配置 ---------- */
  function baseTooltip(t) {
    return {
      backgroundColor: t.surface, borderColor: t.gridLine, borderWidth: 1,
      textStyle: { color: t.ink, fontSize: 12.5 },
      confine: true,
    };
  }
  function valueXAxis(t, name) {
    return {
      type: 'value', name, nameTextStyle: { color: t.muted, fontSize: 11 },
      nameGap: 22, nameLocation: 'middle',
      axisLine: { show: true, lineStyle: { color: t.axis } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { show: false },
    };
  }
  function categoryXAxis(t, data, name) {
    return {
      type: 'category', data, name, nameTextStyle: { color: t.muted, fontSize: 11 },
      nameGap: 22, nameLocation: 'middle',
      axisLine: { show: true, lineStyle: { color: t.axis } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11 },
    };
  }
  function moneyYAxis(t) {
    return {
      type: 'value',
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, formatter: fmtAxisWan },
      splitLine: { show: true, lineStyle: { color: t.gridLine, width: 1 } },
    };
  }
  function legend(t) {
    return { top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { color: t.ink2, fontSize: 12 } };
  }
  const GRID = { left: 56, right: 18, top: 34, bottom: 44 };

  /* ---------- 图表实例管理（主题切换时整体重建） ---------- */
  const chartInstances = {};
  function renderChart(id, option) {
    const el = document.getElementById(id);
    if (!chartInstances[id]) chartInstances[id] = echarts.init(el, null, { renderer: 'canvas' });
    chartInstances[id].setOption(option, { notMerge: true });
  }
  function disposeAllCharts() {
    for (const id of Object.keys(chartInstances)) { chartInstances[id].dispose(); delete chartInstances[id]; }
  }

  /* ---------- 参数读取 ---------- */
  const WAN_FIELDS = new Set(['price', 'otherOneOff', 'pfCap']); // 界面按「万元」录入
  const FIELD_IDS = [
    'price', 'downPct', 'deedTaxPct', 'buyAgentPct', 'otherOneOff',
    'propertyFeeMonthly', 'maintPctYearly', 'homeGrowthPct', 'sellCostPct', 'holdYears',
    'loanMode', 'commRatePct', 'pfRatePct', 'pfCap', 'loanYears', 'repayMethod',
    'monthlyRent', 'rentGrowthPct', 'depositMonths', 'moveCost', 'moveEveryYears',
    'investReturnPct', 'inflationPct',
  ];
  function readParams() {
    const p = {};
    for (const id of FIELD_IDS) {
      const el = document.getElementById(id);
      if (id === 'loanMode' || id === 'repayMethod') { p[id] = el.value; continue; }
      let v = parseFloat(el.value);
      if (!isFinite(v)) v = 0;
      if (WAN_FIELDS.has(id)) v *= 10000;
      p[id] = v;
    }
    p.deedTaxPct = parseFloat($('#deedTaxPct').value);
    p.holdYears = Math.max(1, Math.min(50, Math.round(p.holdYears)));
    p.loanYears = Math.max(1, Math.min(30, Math.round(p.loanYears)));
    p.moveEveryYears = Math.max(1, Math.round(p.moveEveryYears));
    return p;
  }
  function writeParams(p) {
    for (const id of FIELD_IDS) {
      const el = document.getElementById(id);
      if (id === 'loanMode' || id === 'repayMethod' || id === 'deedTaxPct') { el.value = String(p[id]); continue; }
      el.value = WAN_FIELDS.has(id) ? p[id] / 10000 : p[id];
    }
  }

  /* ---------- 主流程 ---------- */
  const state = { result: null, sweep: null, heat: null };
  const GROWTH_LIST = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  const INVEST_LIST = [1, 2, 3, 4, 5, 6, 7, 8];
  const SWEEP_MAX = 30;

  function recalc() {
    const p = readParams();
    state.result = calc.simulate(p);
    state.sweep = calc.holdYearSweep(p, SWEEP_MAX);
    state.heat = calc.sensitivityGrid(p, GROWTH_LIST, INVEST_LIST);
    renderAll();
  }

  function renderAll() {
    const t = tokens();
    const r = state.result;
    renderNotices(r);
    renderLoanLive(r);
    renderBanner(r);
    renderTiles(r);
    renderNetWorthChart(t, r);
    renderCumOutChart(t, r);
    renderAnnualOutChart(t, r);
    renderPaymentChart(t, r);
    renderBalanceChart(t, r);
    renderCostChart(t, r);
    renderSweepChart(t, r);
    renderHeatChart(t, r);
    renderTable(r);
  }

  /* ---------- 提示与贷款速览 ---------- */
  function renderNotices(r) {
    const msgs = [];
    if (r.loan.pfOverflow) {
      msgs.push(`所需贷款 ${fmtWan(r.loan.principal)} 超过公积金额度上限，超出的 ${fmtWan(r.loan.commPart)} 已自动按商贷利率计算（等同于组合贷）。`);
    }
    if (r.params.holdYears < 5) msgs.push('持有期不足 5 年时，交易税费摊销极高，结论通常明显偏向租房。');
    const el = $('#notice');
    el.textContent = msgs.join(' ');
    el.classList.toggle('show', msgs.length > 0);
  }
  function renderLoanLive(r) {
    const { loan, metrics, params } = r;
    if (loan.principal <= 0) { $('#loanLive').innerHTML = '全款购房，无贷款。'; return; }
    const parts = [];
    if (loan.pfPart > 0) parts.push(`公积金 ${fmtWan(loan.pfPart)}`);
    if (loan.commPart > 0) parts.push(`商贷 ${fmtWan(loan.commPart)}`);
    const method = params.repayMethod === 'annuity' ? '等额本息' : '等额本金';
    $('#loanLive').innerHTML =
      `贷款总额 <strong>${fmtWan(loan.principal)}</strong>（${parts.join(' + ')}）<br>` +
      `${method}首月月供 <strong>${fmtYuan(loan.firstPayment)}</strong> · 全周期总利息 <strong>${fmtWan(loan.totalInterest)}</strong>`;
  }

  /* ---------- 结论横幅与指标卡 ---------- */
  function renderBanner(r) {
    const { finalDiff, breakEvenYears } = r.metrics;
    const y = r.params.holdYears;
    const threshold = r.params.price * 0.02; // 差额小于房价 2% 视为接近
    const banner = $('#banner');
    banner.classList.remove('rent-wins', 'close-call');
    let verdict, explain;
    if (finalDiff > threshold) {
      verdict = `持有 ${y} 年后：买房更划算`;
      explain = `期末买房净资产比租房高 ${fmtWan(finalDiff)}。`;
    } else if (finalDiff < -threshold) {
      verdict = `持有 ${y} 年后：租房 + 投资更划算`;
      banner.classList.add('rent-wins');
      explain = `期末租房（含投资组合）净资产比买房高 ${fmtWan(-finalDiff)}。`;
    } else {
      verdict = `持有 ${y} 年后：两者接近，差额在房价 2% 以内`;
      banner.classList.add('close-call');
      explain = `期末净资产差额仅 ${fmtWanSigned(finalDiff)}，结论对假设参数高度敏感。`;
    }
    explain += breakEvenYears !== null
      ? ` 买房净资产在第 ${breakEvenYears.toFixed(1)} 年追上租房路径。`
      : ` 在整个测算期内买房净资产未能追上租房路径。`;
    explain += ` 该结论取决于「房价年涨幅 ${r.params.homeGrowthPct}%、投资收益率 ${r.params.investReturnPct}%」两个关键假设，请结合图⑦⑧的敏感性分析综合判断。`;
    $('#verdict').textContent = verdict;
    $('#verdictExplain').textContent = explain;
  }
  function renderTiles(r) {
    const m = r.metrics;
    $('#tileBreakEven').textContent = m.breakEvenYears !== null ? `${m.breakEvenYears.toFixed(1)} 年` : '未出现';
    $('#tileBreakEvenSub').textContent = m.breakEvenYears !== null ? '买房净资产追上租房的时点' : `${r.params.holdYears} 年测算期内买房未追上`;
    $('#tileDiff').textContent = fmtWanSigned(m.finalDiff);
    $('#tileDiffSub').textContent = `买 ${fmtWan(m.buyNetWorthEnd)} vs 租 ${fmtWan(m.rentNetWorthEnd)}`;
    $('#tileInterest').textContent = fmtWan(m.totalInterest);
    $('#tileInterestSub').textContent = r.loan.principal > 0 ? `贷款 ${fmtWan(r.loan.principal)} · 首月月供 ${fmtYuan(m.firstPayment)}` : '全款购房，无贷款';
    $('#tileRatio').textContent = isFinite(m.rentRatio) ? `${m.rentRatio.toFixed(0)} 年` : '—';
    $('#tileRatioSub').textContent = isFinite(m.rentRatio) ? `售价 ÷ 年租金（国际参考区间 16–25 年）` : '未填写租金';
  }

  /* ---------- 图① 净资产对决 ---------- */
  function renderNetWorthChart(t, r) {
    const m = r.metrics;
    const buyData = r.yearly.years.map((y, i) => [y, r.yearly.buyNetWorth[i]]);
    const rentData = r.yearly.years.map((y, i) => [y, r.yearly.rentNetWorth[i]]);
    const markLine = m.breakEvenYears !== null ? {
      silent: true, symbol: 'none',
      lineStyle: { color: t.muted, width: 1, type: 'dashed' },
      label: { color: t.ink2, fontSize: 11, formatter: `盈亏平衡 ${m.breakEvenYears.toFixed(1)} 年` },
      data: [{ xAxis: m.breakEvenYears }],
    } : undefined;
    renderChart('chartNetWorth', {
      color: [t.buy, t.rent],
      legend: legend(t),
      grid: { ...GRID, right: 90 },
      tooltip: {
        ...baseTooltip(t), trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: t.axis }, label: { backgroundColor: t.surface, color: t.ink, borderColor: t.gridLine, formatter: (p) => p.axisDimension === 'y' ? fmtAxisWan(p.value) : `第 ${Number(p.value).toFixed(1)} 年` } },
        valueFormatter: (v) => fmtWan(v),
      },
      xAxis: { ...valueXAxis(t, '持有年数'), min: 0, max: r.params.holdYears },
      yAxis: moneyYAxis(t),
      series: [
        { name: '买房净资产', type: 'line', data: buyData, showSymbol: false, lineStyle: { width: 2 }, endLabel: { show: true, formatter: '买房', color: t.ink2, fontSize: 12, distance: 8 }, markLine },
        { name: '租房+投资净资产', type: 'line', data: rentData, showSymbol: false, lineStyle: { width: 2 }, endLabel: { show: true, formatter: '租房', color: t.ink2, fontSize: 12, distance: 8 } },
      ],
    });
    $('#tk1').textContent =
      (m.finalDiff >= 0
        ? `蓝线（买房）期末领先橙线（租房）${fmtWan(m.finalDiff)}`
        : `橙线（租房）期末领先蓝线（买房）${fmtWan(-m.finalDiff)}`) +
      (m.breakEvenYears !== null ? `；两线在第 ${m.breakEvenYears.toFixed(1)} 年交叉。` : '；测算期内两线未交叉。');
  }

  /* ---------- 图② 累计现金支出 ---------- */
  function renderCumOutChart(t, r) {
    const buyData = r.yearly.years.map((y, i) => [y, r.yearly.cumBuyOut[i]]);
    const rentData = r.yearly.years.map((y, i) => [y, r.yearly.cumRentOut[i]]);
    renderChart('chartCumOut', {
      color: [t.buy, t.rent],
      legend: legend(t),
      grid: GRID,
      tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } }, valueFormatter: (v) => fmtWan(v) },
      xAxis: { ...valueXAxis(t, '持有年数'), min: 0, max: r.params.holdYears },
      yAxis: moneyYAxis(t),
      series: [
        { name: '买房累计支出', type: 'line', data: buyData, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.1 } },
        { name: '租房累计支出', type: 'line', data: rentData, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.1 } },
      ],
    });
    const diff = r.yearly.cumBuyOut[r.yearly.cumBuyOut.length - 1] - r.yearly.cumRentOut[r.yearly.cumRentOut.length - 1];
    $('#tk2').textContent = `含期初投入，${r.params.holdYears} 年间买房累计现金支出比租房${diff >= 0 ? '多' : '少'} ${fmtWan(Math.abs(diff))}（买房支出的一部分转化为房产净值，见图①）。`;
  }

  /* ---------- 图③ 逐年现金支出 ---------- */
  function renderAnnualOutChart(t, r) {
    const years = r.yearly.years.slice(1).map(String);
    const buy = r.yearly.buyOutYear.slice(1);
    const rent = r.yearly.rentOutYear.slice(1);
    renderChart('chartAnnualOut', {
      color: [t.buy, t.rent],
      legend: legend(t),
      grid: GRID,
      tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => fmtWan(v) },
      xAxis: categoryXAxis(t, years, '第几年'),
      yAxis: moneyYAxis(t),
      series: [
        { name: '买房年支出（月供+持有成本）', type: 'bar', data: buy, barMaxWidth: 14, itemStyle: { borderRadius: [4, 4, 0, 0] } },
        { name: '租房年支出', type: 'bar', data: rent, barMaxWidth: 14, itemStyle: { borderRadius: [4, 4, 0, 0] } },
      ],
    });
    let crossYear = null;
    for (let i = 0; i < buy.length; i++) { if (rent[i] >= buy[i]) { crossYear = i + 1; break; } }
    $('#tk3').textContent = `首年买房支出约为租金的 ${(buy[0] / Math.max(1, rent[0])).toFixed(1)} 倍（不含期初投入）` +
      (crossYear !== null ? `；随租金上涨，第 ${crossYear} 年起租房年支出反超买房。` : '；测算期内租房年支出始终低于买房。');
  }

  /* ---------- 图④ 月供构成（本金 vs 利息） ---------- */
  function renderPaymentChart(t, r) {
    const n = r.loan.schedule.payments.length;
    if (n === 0) {
      renderChart('chartPayment', { title: { text: '全款购房，无月供', left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 14, fontWeight: 400 } } });
      $('#tk4').textContent = '首付比例为 100%，不存在月供的本息构成。';
      return;
    }
    const xs = [], prin = [], intr = [];
    for (let m = 0; m < n; m++) {
      xs.push(((m + 1) / 12));
      prin.push([xs[m], r.loan.schedule.principals[m]]);
      intr.push([xs[m], r.loan.schedule.interests[m]]);
    }
    const firstInterestShare = r.loan.schedule.interests[0] / r.loan.schedule.payments[0] * 100;
    renderChart('chartPayment', {
      color: [t.buy, t.buyWeak],
      legend: legend(t),
      grid: GRID,
      tooltip: {
        ...baseTooltip(t), trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.axis } },
        valueFormatter: (v) => fmtYuan(v),
        formatter: (ps) => {
          const y = Number(ps[0].value[0]);
          const rows = ps.map((p) => `${p.marker} ${p.seriesName}　${fmtYuan(p.value[1])}`).join('<br>');
          const total = ps.reduce((a, p) => a + p.value[1], 0);
          return `第 ${y.toFixed(1)} 年<br>${rows}<br>月供合计　${fmtYuan(total)}`;
        },
      },
      xAxis: { ...valueXAxis(t, '还款年数'), min: 0, max: r.params.loanYears },
      yAxis: { ...moneyYAxis(t), axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => (v / 1000) + 'k' } },
      series: [
        { name: '归还本金', type: 'line', stack: 'pay', data: prin, showSymbol: false, lineStyle: { width: 0 }, areaStyle: { opacity: 1 }, emphasis: { disabled: true } },
        { name: '利息', type: 'line', stack: 'pay', data: intr, showSymbol: false, lineStyle: { width: 0 }, areaStyle: { opacity: 1 }, emphasis: { disabled: true } },
      ],
    });
    $('#tk4').textContent = `首月月供 ${fmtYuan(r.loan.firstPayment)}，其中利息占 ${firstInterestShare.toFixed(0)}%；` +
      (r.params.repayMethod === 'annuity' ? '等额本息下月供恒定，本金占比逐月上升。' : '等额本金下月供逐月递减，本金归还速度恒定。');
  }

  /* ---------- 图⑤ 剩余本金走势 ---------- */
  function renderBalanceChart(t, r) {
    if (r.loan.principal <= 0) {
      renderChart('chartBalance', { title: { text: '全款购房，无贷款余额', left: 'center', top: 'middle', textStyle: { color: t.muted, fontSize: 14, fontWeight: 400 } } });
      $('#tk5').textContent = '无贷款。';
      return;
    }
    const data = r.loan.schedule.balances.map((b, m) => [(m + 1) / 12, b]);
    data.unshift([0, r.loan.principal]);
    const holdEndIdx = Math.min(r.months, r.loan.schedule.balances.length) - 1;
    const balAtHoldEnd = holdEndIdx >= 0 ? r.loan.schedule.balances[Math.min(holdEndIdx, r.loan.schedule.balances.length - 1)] : 0;
    const halfIdx = r.loan.schedule.balances.findIndex((b) => b <= r.loan.principal / 2);
    renderChart('chartBalance', {
      color: [t.buy],
      grid: GRID,
      tooltip: {
        ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } },
        formatter: (ps) => `第 ${Number(ps[0].value[0]).toFixed(1)} 年<br>剩余本金　${fmtWan(ps[0].value[1])}`,
      },
      xAxis: { ...valueXAxis(t, '还款年数'), min: 0, max: r.params.loanYears },
      yAxis: moneyYAxis(t),
      series: [{ name: '剩余本金', type: 'line', data, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.1 } }],
    });
    $('#tk5').textContent = `贷款 ${fmtWan(r.loan.principal)}，${(halfIdx / 12).toFixed(1)} 年后余额减半` +
      (r.params.holdYears < r.params.loanYears ? `；持有期末（第 ${r.params.holdYears} 年）卖房时需一次性偿还余额 ${fmtWan(balAtHoldEnd)}。` : `，第 ${r.params.loanYears} 年还清。`);
  }

  /* ---------- 图⑥ 买房总成本构成 ---------- */
  function renderCostChart(t, r) {
    const m = r.metrics;
    const oneOff = m.deedTax + m.buyAgentFee + r.params.otherOneOff;
    const slices = [
      { name: '贷款利息（持有期内）', value: Math.round(m.interestPaidInHold) },
      { name: '契税·中介·一次性费用', value: Math.round(oneOff) },
      { name: '物业费', value: Math.round(m.totalPropertyFee) },
      { name: '维修维护', value: Math.round(m.totalMaintenance) },
      { name: '卖出交易成本', value: Math.round(m.sellCost) },
    ].filter((s) => s.value > 0);
    const total = slices.reduce((a, s) => a + s.value, 0);
    renderChart('chartCost', {
      color: [t.buy, t.rent, t.cat3, t.cat4, t.cat5],
      tooltip: { ...baseTooltip(t), trigger: 'item', valueFormatter: (v) => fmtWan(v) },
      series: [{
        type: 'pie', radius: ['42%', '68%'], center: ['50%', '52%'],
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
        label: { color: t.ink2, fontSize: 11.5, formatter: '{b}\n{d}%' },
        labelLine: { lineStyle: { color: t.axis } },
        data: slices,
      }],
    });
    const interestShare = total > 0 ? (m.interestPaidInHold / total * 100).toFixed(0) : 0;
    $('#tk6').textContent = `持有期内除房价本身外的总成本为 ${fmtWan(total)}，其中贷款利息占 ${interestShare}%（不含首付与归还的本金——它们转化为房产净值，不是费用）。`;
  }

  /* ---------- 图⑦ 持有年限敏感性 ---------- */
  function renderSweepChart(t, r) {
    const years = state.sweep.map((s) => String(s.years));
    const data = state.sweep.map((s) => ({
      value: s.diff,
      itemStyle: { color: s.diff >= 0 ? t.buy : t.rent, borderRadius: s.diff >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] },
    }));
    const firstWin = state.sweep.find((s) => s.diff >= 0);
    renderChart('chartSweep', {
      legend: {
        ...legend(t), selectedMode: false,
        data: [{ name: '买房占优', itemStyle: { color: t.buy } }, { name: '租房占优', itemStyle: { color: t.rent } }],
      },
      grid: GRID,
      tooltip: {
        ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps) => `持有 ${ps[0].name} 年卖出<br>净资产差额（买−租）　${fmtWanSigned(ps[0].value)}`,
      },
      xAxis: categoryXAxis(t, years, '持有年数（第 N 年卖出）'),
      yAxis: moneyYAxis(t),
      series: [
        { name: '净资产差额', type: 'bar', data, barMaxWidth: 14, markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: t.muted, width: 1, type: 'dashed' },
          label: {
            color: t.ink2, fontSize: 11, formatter: '当前测算期',
            backgroundColor: t.surface, padding: [2, 4],
            // 标线贴近右缘时右对齐，避免文字被卡片裁切
            align: Math.min(r.params.holdYears, SWEEP_MAX) >= SWEEP_MAX - 3 ? 'right' : 'center',
          },
          data: [{ xAxis: String(Math.min(r.params.holdYears, SWEEP_MAX)) }],
        } },
        // 仅用于图例配色说明的空系列
        { name: '买房占优', type: 'bar', data: [], itemStyle: { color: t.buy } },
        { name: '租房占优', type: 'bar', data: [], itemStyle: { color: t.rent } },
      ],
    });
    $('#tk7').textContent = firstWin
      ? `按当前假设，持有满 ${firstWin.years} 年后卖出，买房开始优于租房；短持有期因交易税费摊销高而明显吃亏。`
      : `按当前假设，即使持有 ${SWEEP_MAX} 年，买房仍未优于租房。`;
  }

  /* ---------- 图⑧ 双因子敏感性热力图 ---------- */
  function renderHeatChart(t, r) {
    const xLabels = GROWTH_LIST.map((g) => g + '%');
    const yLabels = INVEST_LIST.map((v) => v + '%');
    const data = state.heat.map((c) => [c.xi, c.yi, Math.round(c.diff / 10000)]);
    const maxAbs = Math.max(1, ...state.heat.map((c) => Math.abs(c.diff / 10000)));
    const buyCells = state.heat.filter((c) => c.diff > 0).length;
    renderChart('chartHeat', {
      grid: { left: 56, right: 130, top: 30, bottom: 44 },
      tooltip: {
        ...baseTooltip(t),
        formatter: (p) => {
          const c = state.heat[p.dataIndex];
          return `房价年涨幅 ${c.growth}% · 投资收益率 ${c.invest}%<br>` +
            `净资产差额（买−租）　<b>${fmtWanSigned(c.diff)}</b><br>` +
            `盈亏平衡：${c.breakEvenYears !== null ? '第 ' + c.breakEvenYears.toFixed(1) + ' 年' : '测算期内未出现'}`;
        },
      },
      xAxis: { ...categoryXAxis(t, xLabels, '房价年均涨幅'), splitArea: { show: false } },
      yAxis: {
        type: 'category', data: yLabels, name: '投资年化收益率',
        nameTextStyle: { color: t.muted, fontSize: 11 }, nameGap: 40, nameLocation: 'middle',
        axisLine: { show: true, lineStyle: { color: t.axis } }, axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11 },
      },
      visualMap: {
        type: 'continuous', min: -maxAbs, max: maxAbs, precision: 0,
        right: 0, top: 'middle', orient: 'vertical', itemHeight: 160,
        text: ['买房划算', '租房划算'], textStyle: { color: t.ink2, fontSize: 11 },
        inRange: { color: [t.rent, t.neutralMid, t.buy] },
        formatter: (v) => Math.round(v) + '万',
      },
      series: [{
        type: 'heatmap', data,
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        label: {
          show: true, fontSize: 10, color: t.ink,
          formatter: (p) => {
            const v = p.value[2];
            return Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
          },
        },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
      }],
    });
    $('#tk8').textContent = `每格 = 一组「房价涨幅 × 投资收益率」假设下持有 ${r.params.holdYears} 年的净资产差额（万元，蓝=买房划算，橙=租房划算）。${GROWTH_LIST.length * INVEST_LIST.length} 组假设中 ${buyCells} 组买房占优；当前假设位于「${r.params.homeGrowthPct}% × ${r.params.investReturnPct}%」附近，悬停可看各格的盈亏平衡年。`;
  }

  /* ---------- 逐年明细表 ---------- */
  function renderTable(r) {
    const head = ['年份', '房产市值', '剩余贷款', '买房净资产', '租房净资产', '差额（买−租）', '当年买房支出', '当年租房支出'];
    const rows = r.yearly.years.map((y, i) => {
      const diff = r.yearly.buyNetWorth[i] - r.yearly.rentNetWorth[i];
      return `<tr><td>${y === 0 ? '期初' : '第 ' + y + ' 年'}</td>` +
        `<td>${fmtWan(r.yearly.homeValue[i])}</td>` +
        `<td>${fmtWan(r.yearly.balance[i])}</td>` +
        `<td>${fmtWan(r.yearly.buyNetWorth[i])}</td>` +
        `<td>${fmtWan(r.yearly.rentNetWorth[i])}</td>` +
        `<td>${fmtWanSigned(diff)}</td>` +
        `<td>${fmtWan(r.yearly.buyOutYear[i])}</td>` +
        `<td>${fmtWan(r.yearly.rentOutYear[i])}</td></tr>`;
    }).join('');
    $('#yearlyTable').innerHTML =
      `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>`;
  }

  /* ---------- 事件绑定 ---------- */
  let debounceTimer = null;
  function scheduleRecalc() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recalc, 250);
  }
  for (const id of FIELD_IDS) {
    document.getElementById(id).addEventListener('input', scheduleRecalc);
    document.getElementById(id).addEventListener('change', scheduleRecalc);
  }
  $('#btnCalc').addEventListener('click', recalc);
  $('#btnReset').addEventListener('click', () => { writeParams(calc.defaults()); recalc(); });

  window.addEventListener('resize', () => {
    for (const id of Object.keys(chartInstances)) chartInstances[id].resize();
  });
  // 深色/浅色主题切换：令牌颜色已烙进画布，需整体重绘
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    disposeAllCharts();
    if (state.result) renderAll();
  });

  /* ---------- 启动 ---------- */
  writeParams(calc.defaults());
  recalc();
})();
