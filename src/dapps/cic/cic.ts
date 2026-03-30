// CIC domain logic — calculation engine, chart, table, formula, overview,
// URL sharing, and report mode. All DOM queries scoped to container.
// Exported as window.CIC.init(container, isReport) → cleanup function.

(() => {
  // ── CSS STYLE CACHE (invalidated on theme change) ──
  let _cssCache = null;
  function chartStyles() {
    if (_cssCache) return _cssCache;
    const s = getComputedStyle(document.documentElement);
    _cssCache = {
      grid: s.getPropertyValue('--chart-grid').trim(),
      label: s.getPropertyValue('--chart-label').trim(),
      dotStroke: s.getPropertyValue('--chart-dot-stroke').trim(),
      intFill: s.getPropertyValue('--chart-interest-fill').trim(),
      conFill: s.getPropertyValue('--chart-contrib-fill').trim(),
      priFill: s.getPropertyValue('--chart-principal-fill').trim(),
      priLine: s.getPropertyValue('--chart-line-principal').trim(),
      conLine: s.getPropertyValue('--chart-line-contrib').trim(),
      totLine: s.getPropertyValue('--chart-line-total').trim(),
    };
    return _cssCache;
  }

  // ── UTILITY ──
  function parseNum(s) {
    if (!s) return 0;
    return parseFloat(s.replace(/[^0-9.-]/g, '')) || 0;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function fmtMoneyCore(n, decimals, includeK) {
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(decimals)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(decimals)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(decimals)}M`;
    if (includeK && abs >= 1e3) return `$${(n / 1e3).toFixed(decimals)}K`;
    return null;
  }

  function fmtMoney(n) {
    return (
      fmtMoneyCore(n, 2, false) ||
      `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    );
  }

  function fmtMoneyWhole(n) {
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(3)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(3)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(3)}M`;
    return `$${Math.round(n).toLocaleString('en-US')}`;
  }

  function fmtMoneyShort(n) {
    return fmtMoneyCore(n, 1, true) || `$${n.toFixed(0)}`;
  }

  function fmtInt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  const inputFormatters = {
    principal: (v) => fmtInt(v),
    contribution: (v) => fmtInt(v),
    rate: (v) => v.toFixed(3),
    'contrib-increase': (v) => Math.min(20, Math.max(0, v)).toFixed(1),
    years: (v) => {
      const c = Math.max(0.1, Math.min(100, v));
      return Number.isInteger(c) ? String(c) : c.toFixed(1);
    },
  };

  function formatInput(el) {
    const fmt = inputFormatters[el.id];
    if (!fmt) return;
    const raw = el.value.trim();
    if (raw === '' || !/\d/.test(raw)) return;
    el.value = fmt(parseNum(raw));
  }

  // ── CALCULATION ENGINE ──
  function calculate(state) {
    const {
      principal,
      rate,
      years,
      compoundFreq: n,
      contribution,
      contribFreq,
      contribTiming,
      contribIncrease,
      inflation,
    } = state;
    const ratePerPeriod = rate / n;

    const yearlyData = [
      {
        year: 0,
        yearLabel: 'Y0',
        deposits: 0,
        interest: 0,
        annualReturn: rate,
        cumulativeInterest: 0,
        balance: principal,
        realBalance: principal,
        principal: principal,
        totalContrib: 0,
      },
    ];
    let balance = principal,
      totalContrib = 0,
      totalInterest = 0;
    let yearContrib = 0,
      yearInterest = 0;
    const totalPeriods = Math.round(n * years);

    for (let p = 1; p <= totalPeriods; p++) {
      const currentYear = Math.ceil(p / n);
      const growthFactor = (1 + contribIncrease) ** (currentYear - 1);
      const currentContrib = contribution * growthFactor;
      const contribPerPeriod = contribFreq === 12 ? (currentContrib * 12) / n : currentContrib / n;

      if (contribTiming === 'start') {
        balance += contribPerPeriod;
        totalContrib += contribPerPeriod;
        yearContrib += contribPerPeriod;
      }
      const interest = balance * ratePerPeriod;
      balance += interest;
      totalInterest += interest;
      yearInterest += interest;
      if (contribTiming === 'end') {
        balance += contribPerPeriod;
        totalContrib += contribPerPeriod;
        yearContrib += contribPerPeriod;
      }

      if (p % n === 0 || p === totalPeriods) {
        const yr = p / n;
        const label = Number.isInteger(yr) ? `Y${yr}` : `Y${yr.toFixed(1)}`;
        yearlyData.push({
          year: yr,
          yearLabel: label,
          deposits: yearContrib,
          interest: yearInterest,
          annualReturn: rate,
          cumulativeInterest: totalInterest,
          balance: balance,
          realBalance: balance / (1 + inflation) ** yr,
          principal: principal,
          totalContrib: totalContrib,
        });
        yearContrib = 0;
        yearInterest = 0;
      }
    }

    return {
      futureValue: balance,
      realValue: balance / (1 + inflation) ** years,
      totalInterest,
      totalContrib,
      principal,
      yearlyData,
      hasInflation: inflation > 0,
    };
  }

  // ── CHART ──
  function drawChartOn(canvas, data) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width,
      H = rect.height;
    ctx.clearRect(0, 0, W, H);
    if (!data.yearlyData.length) return;

    const pad = { top: 20, right: 16, bottom: 36, left: 64 };
    const cw = W - pad.left - pad.right,
      ch = H - pad.top - pad.bottom;
    const years = data.yearlyData;
    let maxBal = -Infinity,
      minBal = 0;
    for (let i = 0; i < years.length; i++) {
      const b = years[i].balance;
      if (b > maxBal) maxBal = b;
      if (b < minBal) minBal = b;
    }
    const maxVal = maxBal * 1.15;
    const minVal = minBal;
    const range = maxVal - minVal || 1;

    const cs = chartStyles();

    // Grid
    ctx.strokeStyle = cs.grid;
    ctx.lineWidth = 1;
    ctx.font = '11px IBM Plex Mono, Courier New, monospace';
    ctx.fillStyle = cs.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const gl = 5;
    for (let i = 0; i <= gl; i++) {
      const y = pad.top + ch - (ch / gl) * i;
      const val = minVal + (range / gl) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillText(fmtMoneyShort(val), pad.left - 8, y);
    }

    // X labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(years.length / 10));
    const lastIdx = years.length - 1;
    for (let i = 0; i < years.length; i += step) {
      ctx.fillText(years[i].yearLabel, pad.left + (i / (lastIdx || 1)) * cw, H - pad.bottom + 10);
    }
    if (lastIdx % step !== 0) {
      ctx.fillText(years[lastIdx].yearLabel, pad.left + cw, H - pad.bottom + 10);
    }

    function gX(i) {
      return pad.left + (i / (lastIdx || 1)) * cw;
    }
    function gY(v) {
      return pad.top + ch - ((v - minVal) / range) * ch;
    }

    const pL = years.map((d) => d.principal);
    const cL = years.map((d) => d.principal + d.totalContrib);
    const tL = years.map((d) => d.balance);

    // Interest area
    ctx.beginPath();
    for (let i = 0; i < years.length; i++) ctx.lineTo(gX(i), gY(tL[i]));
    for (let i = years.length - 1; i >= 0; i--) ctx.lineTo(gX(i), gY(cL[i]));
    ctx.closePath();
    ctx.fillStyle = cs.intFill;
    ctx.fill();

    // Contribution area
    ctx.beginPath();
    for (let i = 0; i < years.length; i++) ctx.lineTo(gX(i), gY(cL[i]));
    for (let i = years.length - 1; i >= 0; i--) ctx.lineTo(gX(i), gY(pL[i]));
    ctx.closePath();
    ctx.fillStyle = cs.conFill;
    ctx.fill();

    // Principal area
    ctx.beginPath();
    for (let i = 0; i < years.length; i++) ctx.lineTo(gX(i), gY(pL[i]));
    ctx.lineTo(gX(years.length - 1), gY(minVal));
    ctx.lineTo(gX(0), gY(minVal));
    ctx.closePath();
    ctx.fillStyle = cs.priFill;
    ctx.fill();

    // Lines
    function drawLine(vals, color, w) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = w || 2;
      ctx.lineJoin = 'round';
      for (let i = 0; i < vals.length; i++) {
        const x = gX(i),
          y = gY(vals[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawLine(pL, cs.priLine, 2);
    drawLine(cL, cs.conLine, 2);
    drawLine(tL, cs.totLine, 2);

    // Endpoint dot
    ctx.beginPath();
    ctx.arc(gX(years.length - 1), gY(tL[years.length - 1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = cs.totLine;
    ctx.fill();
    ctx.strokeStyle = cs.dotStroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── OVERVIEW ──
  function renderOverview(container, state, result) {
    const el = container.querySelector('#overview-content');
    if (!el) return;
    const freqLabel = { 365: 'daily', 12: 'monthly', 4: 'quarterly', 1: 'annually' };
    const contribFreqLabel = state.contribFreq === 12 ? 'month' : 'year';
    const compLabel = freqLabel[state.compoundFreq] || `${state.compoundFreq}×/yr`;
    const timingLabel = state.contribTiming === 'start' ? 'beginning' : 'end';
    const yrs = state.years;
    const yrWord = yrs === 1 ? 'year' : 'years';

    const totalIn = result.principal + result.totalContrib;
    const growth = result.futureValue - totalIn;
    const growthPct = totalIn > 0 ? ((growth / totalIn) * 100).toFixed(1) : '0.0';
    const multiplier = totalIn > 0 ? (result.futureValue / totalIn).toFixed(2) : '1.00';

    const yd = result.yearlyData;
    const midIdx = Math.round((yd.length - 1) / 2);
    const midYear = yd[midIdx];
    const lastYear = yd[yd.length - 1];
    const firstFullYear = yd.length > 1 ? yd[1] : null;

    let contribLine = '';
    if (state.contribution > 0) {
      contribLine = `You're adding <code>${fmtMoney(state.contribution)}</code> per ${contribFreqLabel} at the <code>${timingLabel}</code> of each period`;
      if (state.contribIncrease > 0) {
        contribLine += `, increasing by <code>${(state.contribIncrease * 100).toFixed(1)}%</code> each year`;
        const finalContrib = state.contribution * (1 + state.contribIncrease) ** (yrs - 1);
        contribLine += ` — so by year ${yrs}, each ${contribFreqLabel}'s deposit will be about <code>${fmtMoney(finalContrib)}</code>`;
      }
      contribLine += '. ';
      contribLine += `Over the full ${yrs} ${yrWord}, you'll put in a total of <code>${fmtMoney(totalIn)}</code> (principal + contributions).`;
    } else {
      contribLine =
        'No recurring contributions are set up — growth comes entirely from compounding your initial deposit.';
    }

    let earnLine = '';
    if (firstFullYear && yd.length > 2) {
      earnLine = `In year 1, your money earns about <code>${fmtMoney(firstFullYear.interest)}</code> in interest. By year ${lastYear.year}, that jumps to <code>${fmtMoney(lastYear.interest)}</code> — that is the effect of interest compounding upon itself.`;
    } else if (firstFullYear) {
      earnLine = `Over this period, you earn about <code>${fmtMoney(firstFullYear.interest)}</code> in interest.`;
    }

    let midLine = '';
    if (midYear && midIdx > 0 && midIdx < yd.length - 1) {
      midLine = `At the halfway mark (year ${midYear.year}), your balance is around <code>${fmtMoney(midYear.balance)}</code> — the second half of the journey takes over the heavy lifting.`;
    }

    let inflLine = '';
    if (result.hasInflation) {
      inflLine = `After adjusting for <code>${(state.inflation * 100).toFixed(1)}%</code> annual inflation, your <code>${fmtMoney(result.futureValue)}</code> has a real purchasing power of about <code>${fmtMoney(result.realValue)}</code> in today's dollars. Still a solid outcome, but a reminder that inflation quietly chips away at nominal gains.`;
    }

    el.innerHTML = `
      <p>Starting with <code>${fmtMoney(state.principal)}</code> and earning <code>${(state.rate * 100).toFixed(3)}%</code> APY compounded <code>${compLabel}</code> over <code>${yrs} ${yrWord}</code>, your investment grows to <code>${fmtMoney(result.futureValue)}</code>.</p>
      <p style="margin-top:0.75rem">${contribLine}</p>
      <p style="margin-top:0.75rem">Of your final balance, <code>${fmtMoney(result.totalInterest)}</code> is pure interest — money that your money made <i>for</i> you. That means your total deposits of <code>${fmtMoney(totalIn)}</code> grew by <code>${growthPct}%</code>, a <code>${multiplier}×</code> multiple on what you put in.</p>
      ${earnLine ? `<p style="margin-top:0.75rem">${earnLine}</p>` : ''}
      ${midLine ? `<p style="margin-top:0.75rem">${midLine}</p>` : ''}
      ${inflLine ? `<p style="margin-top:0.75rem">${inflLine}</p>` : ''}
      <p style="margin-top:0.75rem;color:var(--text-muted);font-size:0.75rem">All figures assume a fixed <code>${(state.rate * 100).toFixed(3)}%</code> annual return${state.contribution > 0 ? ' and consistent contributions' : ''}. Actual market returns will vary.</p>
    `;
  }

  // ── FORMULA ──
  function renderFormula(container, state) {
    const f = container.querySelector('#formula-content');
    if (!f) return;
    let zeroNote = '';
    if (state.rate === 0) {
      zeroNote =
        '<p style="margin-top:0.75rem;color:var(--amber)">With a 0% rate, contributions grow linearly: A = P + C × n × t (no compounding).</p>';
    }
    f.innerHTML = `
      <p>Compound interest grows your principal by applying earned interest back onto itself each compounding period.</p>
      <div class="formula-block">A = P(1 + r/n)<sup>nt</sup> + C × [((1 + r/n)<sup>nt</sup> − 1) / (r/n)]</div>
      <p>Where <code>P</code> = principal, <code>r</code> = annual rate, <code>n</code> = compounds per year, <code>t</code> = years, and <code>C</code> = contribution per compounding period.</p>
      <p style="margin-top:0.75rem">When contributions are made at the <strong>start</strong> of each period (annuity due), the contribution portion is multiplied by an extra <code>(1 + r/n)</code> factor.</p>
      <p style="margin-top:0.75rem">If an annual contribution increase <code>g</code> is specified, each year's contribution becomes <code>C × (1 + g)<sup>year−1</sup></code>, escalating deposits over time.</p>
      <p style="margin-top:0.75rem">If an inflation rate <code>i</code> is specified, the real purchasing power is shown by dividing the nominal future value by <code>(1 + i)<sup>t</sup></code>.</p>
      ${zeroNote}
    `;
  }

  // ── TABLE ──
  function renderTable(container, data) {
    const tableBody = container.querySelector('#table-body');
    if (!tableBody) return;
    tableBody.innerHTML = data.yearlyData
      .map(
        (d) =>
          `<tr><td>${d.yearLabel}</td><td>${fmtMoneyWhole(d.deposits)}</td><td>${fmtMoneyWhole(d.interest)}</td><td>${fmtMoneyWhole(d.cumulativeInterest)}</td><td>${fmtMoneyWhole(d.balance)}</td></tr>`,
      )
      .join('');
  }

  function checkTableFade(container) {
    const tableScroll = container.querySelector('#table-scroll');
    const tableFade = container.querySelector('#table-fade');
    if (!tableScroll || !tableFade) return;
    const atBottom = tableScroll.scrollHeight - tableScroll.scrollTop - tableScroll.clientHeight < 8;
    const isScrollable = tableScroll.scrollHeight > tableScroll.clientHeight;
    tableFade.classList.toggle('hidden', !isScrollable || atBottom);
  }

  // ── URL PARAMS ──
  function buildShareURL(container, asReport) {
    const p = new URLSearchParams();
    p.set('p', parseNum(container.querySelector('#principal').value));
    p.set('r', parseNum(container.querySelector('#rate').value));
    p.set('y', parseNum(container.querySelector('#years').value));
    p.set('c', parseNum(container.querySelector('#contribution').value));
    p.set('ci', parseNum(container.querySelector('#contrib-increase').value));
    p.set('i', parseNum(container.querySelector('#inflation').value));
    p.set('cf', container.querySelector('#compound-freq .active').dataset.value);
    p.set('crf', container.querySelector('#contrib-freq .active').dataset.value);
    p.set('crt', container.querySelector('#contrib-timing .active').dataset.value);
    const base = window.location.origin + window.location.pathname;
    const route = asReport ? '#/tools/cic/report/' : '#/tools/cic/';
    return `${base + route}?${p.toString()}`;
  }

  function setButtonGroupValue(container, groupId, value) {
    const group = container.querySelector(`#${groupId}`);
    if (!group) return;
    const btn = group.querySelector(`button[data-value="${value}"]`);
    if (!btn) return;
    group.querySelectorAll('button').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-checked', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
  }

  function loadFromURL(container) {
    // Params live after the hash route: #/tools/cic/?p=10000&r=7...
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx) : '');
    if (!params.has('p')) return false;

    container.querySelector('#principal').value = fmtInt(Number(params.get('p')));
    if (params.has('r')) {
      container.querySelector('#rate').value = params.get('r');
      const v = Number(params.get('r'));
      if (v >= 1 && v <= 30) container.querySelector('#rate-slider').value = v;
    }
    if (params.has('y')) {
      container.querySelector('#years').value = params.get('y');
      const v = Number(params.get('y'));
      if (v >= 1 && v <= 30) container.querySelector('#years-slider').value = Math.round(v);
    }
    if (params.has('c')) {
      container.querySelector('#contribution').value = fmtInt(Number(params.get('c')));
    }
    if (params.has('ci')) {
      container.querySelector('#contrib-increase').value = params.get('ci');
      const v = Number(params.get('ci'));
      if (v >= 0 && v <= 20) container.querySelector('#contrib-increase-slider').value = v;
    }
    if (params.has('i')) container.querySelector('#inflation').value = params.get('i');
    if (params.has('cf')) setButtonGroupValue(container, 'compound-freq', params.get('cf'));
    if (params.has('crf')) setButtonGroupValue(container, 'contrib-freq', params.get('crf'));
    if (params.has('crt')) setButtonGroupValue(container, 'contrib-timing', params.get('crt'));

    return true;
  }

  // ── REPORT MODE ──
  function enterReportMode(container) {
    container.querySelector('.layout-tool').classList.add('report-mode');
    container.querySelectorAll('.dapp-nav-link').forEach((l) => l.classList.remove('active'));
    const reportLink = container.querySelector('.dapp-nav-link[data-view="report"]');
    if (reportLink) reportLink.classList.add('active');
  }

  function exitReportMode(container) {
    container.querySelector('.layout-tool')?.classList.remove('report-mode');
    container.querySelectorAll('.dapp-nav-link').forEach((l) => l.classList.remove('active'));
    const calcLink = container.querySelector('.dapp-nav-link[data-view="calculator"]');
    if (calcLink) calcLink.classList.add('active');
  }

  function updateReport(container, _state, result) {
    const el = container.querySelector('#report-overview-content');
    const srcEl = container.querySelector('#overview-content');
    if (srcEl && el) el.innerHTML = srcEl.innerHTML;

    const inflNote = container.querySelector('#report-inflation-note');
    if (inflNote) {
      if (result.hasInflation) {
        inflNote.classList.add('visible');
        inflNote.innerHTML = `Adjusted for inflation: <span>${fmtMoney(result.realValue)}</span> in today's purchasing power`;
      } else {
        inflNote.classList.remove('visible');
      }
    }

    const reportBody = container.querySelector('#report-table-body');
    if (reportBody) {
      reportBody.innerHTML = result.yearlyData
        .map(
          (d) =>
            `<tr><td>${d.yearLabel}</td><td>${fmtMoneyWhole(d.deposits)}</td><td>${fmtMoneyWhole(d.interest)}</td><td>${fmtMoneyWhole(d.cumulativeInterest)}</td><td>${fmtMoneyWhole(d.balance)}</td></tr>`,
        )
        .join('');
    }

    drawChartOn(container.querySelector('#report-chart-canvas'), result);
  }

  // ── INIT (called by dapp.js on mount) ──
  function init(container, isReport) {
    let lastResult = null;
    const listeners = [];

    function on(el, event, handler, opts) {
      el.addEventListener(event, handler, opts);
      listeners.push([el, event, handler, opts]);
    }

    // ── STATE ──
    function getState() {
      return {
        principal: parseNum(container.querySelector('#principal').value),
        rate: parseNum(container.querySelector('#rate').value) / 100,
        years: Math.max(0.1, parseNum(container.querySelector('#years').value)),
        compoundFreq: parseInt(container.querySelector('#compound-freq .active').dataset.value, 10),
        contribution: parseNum(container.querySelector('#contribution').value),
        contribFreq: parseInt(container.querySelector('#contrib-freq .active').dataset.value, 10),
        contribTiming: container.querySelector('#contrib-timing .active').dataset.value,
        contribIncrease: parseNum(container.querySelector('#contrib-increase').value) / 100,
        inflation: parseNum(container.querySelector('#inflation').value) / 100,
      };
    }

    // ── UPDATE ──
    function update() {
      const state = getState();
      const result = calculate(state);
      lastResult = result;

      container.querySelector('#result-total').textContent = fmtMoney(result.futureValue);
      container.querySelector('#result-interest').textContent = fmtMoney(result.totalInterest);
      container.querySelector('#result-contrib').textContent = fmtMoney(result.principal + result.totalContrib);

      const inflNote = container.querySelector('#inflation-note');
      if (inflNote) {
        if (result.hasInflation) {
          inflNote.classList.add('visible');
          inflNote.innerHTML = `Adjusted for inflation: <span>${fmtMoney(result.realValue)}</span> in today's purchasing power`;
        } else {
          inflNote.classList.remove('visible');
        }
      }

      renderFormula(container, state);
      renderOverview(container, state, result);
      drawChartOn(container.querySelector('#growth-chart'), result);
      renderTable(container, result);
      requestAnimationFrame(() => checkTableFade(container));

      if (isReport) updateReport(container, state, result);
    }

    const debouncedUpdate = debounce(update, 120);

    // ── ARIA HELPER ──
    function syncAriaChecked(group) {
      group.querySelectorAll('button[role="radio"]').forEach((b) => {
        b.setAttribute('aria-checked', b.classList.contains('active') ? 'true' : 'false');
      });
    }

    // ── BUTTON GROUPS ──
    container.querySelectorAll('#compound-freq, #contrib-freq, #contrib-timing').forEach((group) => {
      group.querySelectorAll('button').forEach((btn) => {
        on(btn, 'click', () => {
          group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          syncAriaChecked(group);
          if (group.id === 'contrib-freq') syncContribSlider();
          update();
        });
      });
    });

    // ── TABS ──
    container.querySelectorAll('#cic-tabs button').forEach((btn) => {
      on(btn, 'click', () => {
        const tab = btn.dataset.tab;
        container.querySelectorAll('#cic-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        container.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
        const tabEl = container.querySelector(`#tab-${tab}`);
        if (tabEl) tabEl.classList.add('active');
        if (tab === 'chart' && lastResult) drawChartOn(container.querySelector('#growth-chart'), lastResult);
        if (tab === 'table') requestAnimationFrame(() => checkTableFade(container));
      });
    });

    // ── TEXT INPUT HANDLERS ──
    const commaIntFields = new Set(['principal', 'contribution']);

    ['principal', 'rate', 'years', 'contribution', 'contrib-increase', 'inflation'].forEach((id) => {
      const el = container.querySelector(`#${id}`);
      if (!el) return;

      on(el, 'input', () => {
        const isCommaInt = commaIntFields.has(id);
        const digits = isCommaInt ? el.value.replace(/[^0-9]/g, '') : el.value.replace(/[^0-9.]/g, '');
        if (isCommaInt) {
          const cursorPos = el.selectionStart;
          const digitsBefore = el.value.slice(0, cursorPos).replace(/[^0-9]/g, '').length;
          const formatted = digits ? parseInt(digits, 10).toLocaleString('en-US') : '';
          el.value = formatted;
          let dCount = 0,
            newPos = 0;
          for (let i = 0; i < formatted.length; i++) {
            if (/\d/.test(formatted[i])) dCount++;
            if (dCount === digitsBefore) {
              newPos = i + 1;
              break;
            }
          }
          if (dCount < digitsBefore) newPos = formatted.length;
          el.setSelectionRange(newPos, newPos);
        } else {
          let raw = digits;
          const parts = raw.split('.');
          if (parts.length > 2) raw = `${parts[0]}.${parts.slice(1).join('')}`;
          if (parts.length === 2 && parts[1].length > 3) raw = `${parts[0]}.${parts[1].slice(0, 3)}`;
          if (raw !== el.value) {
            const pos = el.selectionStart;
            el.value = raw;
            el.setSelectionRange(pos, pos);
          }
        }
        debouncedUpdate();
      });

      on(el, 'blur', () => formatInput(el));
    });

    // ── SLIDER SYNC ──
    const rateSlider = container.querySelector('#rate-slider');
    const rateInput = container.querySelector('#rate');
    if (rateSlider && rateInput) {
      on(rateSlider, 'input', () => {
        rateInput.value = parseFloat(rateSlider.value).toFixed(3);
        debouncedUpdate();
      });
      on(rateInput, 'input', () => {
        const v = parseNum(rateInput.value);
        if (v >= 1 && v <= 30) rateSlider.value = v;
      });
    }

    const yearsSlider = container.querySelector('#years-slider');
    const yearsInput = container.querySelector('#years');
    if (yearsSlider && yearsInput) {
      on(yearsSlider, 'input', () => {
        yearsInput.value = yearsSlider.value;
        debouncedUpdate();
      });
      on(yearsInput, 'input', () => {
        const v = parseNum(yearsInput.value);
        if (v >= 1 && v <= 30) yearsSlider.value = Math.round(v);
      });
    }

    const contribSlider = container.querySelector('#contribution-slider');
    const contribInput = container.querySelector('#contribution');

    function syncContribSlider() {
      if (!contribSlider || !contribInput) return;
      const isMonthly = container.querySelector('#contrib-freq .active').dataset.value === '12';
      contribSlider.min = 0;
      contribSlider.max = isMonthly ? 10000 : 100000;
      contribSlider.step = 100;
      const v = parseNum(contribInput.value);
      const max = parseInt(contribSlider.max, 10);
      const step = parseInt(contribSlider.step, 10);
      if (v >= 0 && v <= max) contribSlider.value = Math.round(v / step) * step;
    }

    if (contribSlider && contribInput) {
      on(contribSlider, 'input', () => {
        contribInput.value = fmtInt(parseInt(contribSlider.value, 10));
        debouncedUpdate();
      });
      on(contribInput, 'input', () => {
        const v = parseNum(contribInput.value);
        const max = parseInt(contribSlider.max, 10);
        const step = parseInt(contribSlider.step, 10);
        if (v >= 0 && v <= max) contribSlider.value = Math.round(v / step) * step;
      });
    }

    const contribIncSlider = container.querySelector('#contrib-increase-slider');
    const contribIncInput = container.querySelector('#contrib-increase');
    if (contribIncSlider && contribIncInput) {
      on(contribIncSlider, 'input', () => {
        contribIncInput.value = parseFloat(contribIncSlider.value).toFixed(1);
        debouncedUpdate();
      });
      on(contribIncInput, 'input', () => {
        const v = parseNum(contribIncInput.value);
        if (v >= 0 && v <= 20) contribIncSlider.value = v;
      });
    }

    // ── TABLE SCROLL ──
    const tableScroll = container.querySelector('#table-scroll');
    if (tableScroll) {
      on(tableScroll, 'scroll', () => checkTableFade(container));
    }

    // ── COPY CSV ──
    const copyBtn = container.querySelector('#copy-table-btn');
    if (copyBtn) {
      on(copyBtn, 'click', function () {
        const data = lastResult || calculate(getState());
        let csv = 'Year,Deposits,Interest,Cumulative Interest,Balance\n';
        data.yearlyData.forEach((d) => {
          csv += `${d.yearLabel},${d.deposits.toFixed(2)},${d.interest.toFixed(2)},${d.cumulativeInterest.toFixed(2)},${d.balance.toFixed(2)}\n`;
        });
        navigator.clipboard.writeText(csv).then(() => {
          this.textContent = '✓ Copied!';
          setTimeout(() => {
            this.textContent = '⎘ Copy as CSV';
          }, 1500);
        });
      });
    }

    // ── RESIZE ──
    let resizeRAF = 0;
    function onResize() {
      if (!resizeRAF) {
        resizeRAF = requestAnimationFrame(() => {
          resizeRAF = 0;
          const tabChart = container.querySelector('#tab-chart');
          if (lastResult && tabChart?.classList.contains('active'))
            drawChartOn(container.querySelector('#growth-chart'), lastResult);
          if (lastResult && isReport) drawChartOn(container.querySelector('#report-chart-canvas'), lastResult);
        });
      }
    }
    on(window, 'resize', onResize);

    // ── THEME CHANGE ──
    const dx = window.__DXKIT__;
    let themeUnsub = null;
    if (dx) {
      const theme = dx.getPlugin('theme');
      if (theme) {
        const onThemeChange = () => {
          _cssCache = null;
          const tabChart = container.querySelector('#tab-chart');
          if (lastResult && tabChart?.classList.contains('active'))
            drawChartOn(container.querySelector('#growth-chart'), lastResult);
          if (lastResult && isReport) drawChartOn(container.querySelector('#report-chart-canvas'), lastResult);
        };
        themeUnsub = dx.events.on('dx:plugin:theme:changed', onThemeChange);
      }
    }

    // ── SHARE BUTTON OVERRIDE (capture phase) ──
    const shareBtn = document.getElementById('share-btn');
    function shareOverride(e) {
      e.stopPropagation();
      const layoutTool = container.querySelector('.layout-tool');
      const inReport = layoutTool?.classList.contains('report-mode');
      const url = buildShareURL(container, inReport);
      navigator.clipboard.writeText(url).then(() => {
        shareBtn.classList.add('copied');
        setTimeout(() => shareBtn.classList.remove('copied'), 1500);
      });
    }
    if (shareBtn) {
      shareBtn.addEventListener('click', shareOverride, true);
    }

    // ── DAPP NAV (Calculator / Report toggle) ──
    container.querySelectorAll('.dapp-nav-link').forEach((link) => {
      on(link, 'click', (e) => {
        e.preventDefault();
        const view = link.dataset.view;
        if (view === 'report') {
          dx.router.navigate('/tools/cic/report');
        } else {
          dx.router.navigate('/tools/cic');
        }
      });
    });

    // ── ROUTE CHANGE (sub-path toggle between calculator/report) ──
    let routeUnsub = null;
    if (dx) {
      routeUnsub = dx.events.on('dx:route:changed', (_detail) => {
        const currentPath = dx.router.getCurrentPath();
        const sub = currentPath.replace('/tools/cic', '').split('?')[0].replace(/^\//, '').replace(/\/$/, '');
        const shouldBeReport = sub === 'report';
        const layoutTool = container.querySelector('.layout-tool');
        const currentlyReport = layoutTool?.classList.contains('report-mode');

        if (shouldBeReport && !currentlyReport) {
          enterReportMode(container);
          if (lastResult) {
            // Wait for .app max-width transition to finish before drawing chart
            setTimeout(() => {
              updateReport(container, getState(), lastResult);
            }, 250);
          }
        } else if (!shouldBeReport && currentlyReport) {
          exitReportMode(container);
          if (lastResult) {
            // Wait for .app max-width transition to finish before drawing chart
            setTimeout(() => {
              drawChartOn(container.querySelector('#growth-chart'), lastResult);
            }, 250);
          }
        }
      });
    }

    // ── INIT ──
    loadFromURL(container);
    syncContribSlider();
    update();

    if (isReport) {
      enterReportMode(container);
      if (lastResult) updateReport(container, getState(), lastResult);
    }

    // ── CLEANUP (returned to dapp.js) ──
    return function cleanup() {
      // Remove all tracked listeners
      listeners.forEach(([el, event, handler, opts]) => el.removeEventListener(event, handler, opts));
      listeners.length = 0;

      // Remove share override
      if (shareBtn) shareBtn.removeEventListener('click', shareOverride, true);

      // Remove theme listener
      if (themeUnsub) themeUnsub.off();

      // Remove route listener
      if (routeUnsub) routeUnsub.off();

      // Cancel pending RAF
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
    };
  }

  // Export
  window.CIC = { init };
})();
