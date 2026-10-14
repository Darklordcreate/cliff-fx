// ---------- State ----------
// (supa client comes from supabaseClient.js, loaded before this file)
let currentUser = null;
let accounts = [];
let currentAccount = null;
let currentSettings = null;
let currentTrades = [];
let equityChart = null;
let drawdownChart = null;
let currentPlanState = null;   // result of SizingEngine.evaluatePlan for the selected account
let planPaceChart = null;
let equityMode = 'balance';   // 'balance' | 'performance'
let equityRange = 'ALL';      // '1W' | '1M' | 'ALL'

// Sensible fallback if a settings row is ever missing/unreadable, so
// rendering never silently breaks — a save always overwrites these anyway.
const FALLBACK_SETTINGS = {
  assumed_win_rate: 0.4, reward_risk_ratio: 3, base_risk_pct: 2, max_risk_pct: 6,
  escalation_step_pct: 0.5, loss_cut_trigger: 1, default_stop_loss_pips: 20,
  pip_decimal: 0.0001, start_style: 'modest',
};

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireNav();
  wireAccountControls();
  wireSettingsForm();
  wireTradeForm();
  wireQuickAddGrid();
  wireXlsxImportPanel();
  wireChartControls();
  wirePlan();

  // This page (app.html) only ever renders authenticated content. If
  // there's no session — direct navigation, a stale bookmark, whatever —
  // bounce straight back to the auth-only page before anything else runs.
  const { data } = await supa.auth.getSession();
  if (!data.session) {
    window.location.replace('index.html');
    return;
  }
  currentUser = data.session.user;

  document.getElementById('app-shell').hidden = false;
  document.getElementById('app-shell').classList.remove('hidden');

  try {
    await enterApp();
  } catch (err) {
    console.error('Failed to load account data:', err);
    showToast('Something went wrong loading your account — try refreshing.', true);
  }

  document.getElementById('sign-out').addEventListener('click', async () => {
    await supa.auth.signOut();
    window.location.replace('index.html');
  });

  supa.auth.onAuthStateChange((_event, session) => {
    if (!session && currentUser) {
      currentUser = null;
      window.location.replace('index.html');
    }
  });
}

// ---------- Entering the app ----------
async function enterApp() {
  await loadAccounts();

  if (accounts.length === 0) {
    openNewAccountModal(true);
  } else {
    await selectAccount(accounts[0].id);
  }
}

async function loadAccounts() {
  const { data, error } = await supa
    .from('fx_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  accounts = data || [];
  renderAccountSelect();
}

function renderAccountSelect() {
  const select = document.getElementById('account-select');
  select.innerHTML = '';
  accounts.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    select.appendChild(opt);
  });
}

function wireAccountControls() {
  document.getElementById('account-select').addEventListener('change', (e) => {
    selectAccount(e.target.value);
  });
  document.getElementById('new-account-btn').addEventListener('click', () => openNewAccountModal(false));
  document.getElementById('new-account-cancel').addEventListener('click', closeNewAccountModal);
  document.getElementById('new-account-create').addEventListener('click', createAccount);
}

function openNewAccountModal(forced) {
  document.getElementById('new-account-modal').classList.remove('hidden');
  document.getElementById('new-account-cancel').classList.toggle('hidden', forced);
  hideError('new-account-error');
  document.getElementById('new-account-name').value = '';
  document.getElementById('new-account-balance').value = '';
}
function closeNewAccountModal() {
  document.getElementById('new-account-modal').classList.add('hidden');
}

async function createAccount() {
  const name = document.getElementById('new-account-name').value.trim();
  const balance = parseFloat(document.getElementById('new-account-balance').value);

  if (!name) return showError('new-account-error', 'Give the account a name.');
  if (!balance || balance <= 0) return showError('new-account-error', 'Enter a starting balance greater than 0.');

  const { data: account, error } = await supa
    .from('fx_accounts')
    .insert({ user_id: currentUser.id, name, starting_balance: balance })
    .select()
    .single();
  if (error) return showError('new-account-error', error.message);

  const { error: settingsError } = await supa
    .from('fx_model_settings')
    .insert({ account_id: account.id });
  if (settingsError) return showError('new-account-error', settingsError.message);

  await loadAccounts();
  closeNewAccountModal();
  await selectAccount(account.id);
}

async function selectAccount(accountId) {
  currentAccount = accounts.find((a) => a.id === accountId);
  if (!currentAccount) return;
  document.getElementById('account-select').value = accountId;

  const [{ data: settings }, { data: trades }] = await Promise.all([
    supa.from('fx_model_settings').select('*').eq('account_id', accountId).single(),
    supa.from('fx_trades').select('*').eq('account_id', accountId).order('trade_number', { ascending: true }),
  ]);

  // Fall back rather than leaving currentSettings null — a missing/failed
  // settings row should never silently break rendering for the rest of
  // the page. A real save always overwrites these anyway.
  currentSettings = settings || { ...FALLBACK_SETTINGS };
  currentTrades = trades || [];

  // Each section renders independently — a failure in one (e.g. a
  // blocked chart library) must never prevent the others from showing,
  // and especially must never hide that a trade actually did save.
  try { currentPlanState = computePlanState(); } catch (err) { console.error('Plan evaluation failed:', err); currentPlanState = null; }

  runSafely('settings form', renderSettingsForm);
  runSafely('plan', renderPlan);
  runSafely('dashboard', renderDashboard);
  runSafely('trade log', renderTradeLog);
}

/** Runs a render function, logging and toasting on failure without letting it block anything else. */
function runSafely(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`Failed to render ${label}:`, err);
    showToast(`Part of the page (${label}) failed to load — check the console. Your data is safe.`, true);
  }
}

// ---------- Balance / next-trade computation ----------
function currentBalance() {
  if (currentTrades.length === 0) return currentAccount.starting_balance;
  return currentTrades[currentTrades.length - 1].balance_after;
}

function nextRisk() {
  return SizingEngine.computeNextRisk(currentTrades, currentSettings);
}

// ---------- Dashboard ----------
function renderDashboard() {
  document.getElementById('topbar-balance-value').textContent = formatMoney(currentBalance());

  runSafely('next trade', renderHero);
  runSafely('performance cards', renderPerformanceKpis);
  runSafely('realized stats', renderRealizedStats);
  runSafely('by setup', renderBySetup);
  runSafely('equity chart', renderEquityChart);
  runSafely('recent trades', renderRecentTrades);
}

/** "1 win", "3 wins", "1 loss", "3 losses" — with correct plurals. */
function streakLabel(type, count) {
  const word = type === 'win' ? (count > 1 ? 'wins' : 'win') : (count > 1 ? 'losses' : 'loss');
  return `${count} ${word}`;
}

/** Hero card when a plan is running: the plan's risk, this week's meter, and the stop signal. */
function renderHeroFromPlan(plan, balance) {
  const t = plan.ticket;
  const w = plan.week;
  const riskEl = document.getElementById('hero-risk');
  const stopped = w.status !== 'open';

  riskEl.textContent = stopped ? 'STOP' : formatMoney(t.riskDollars);
  riskEl.style.color = stopped ? 'var(--loss)' : '';
  document.getElementById('hero-risk-hint').textContent = stopped
    ? (w.status === 'goal' ? 'Weekly goal reached — you are done until Monday'
      : w.status === 'cap' ? 'Weekly cap hit — protect the account until Monday'
      : `${w.maxTrades} trades taken — you are done until Monday`)
    : `Plan · ${plan.stage.label} · ${t.riskPct}% of ${formatMoney(balance)} · stop ${t.stopPips} / BE +${t.bePips} / target +${t.targetPips}`;

  document.getElementById('branch-win-name').textContent = 'This week so far →';
  document.getElementById('branch-win-value').textContent = `${fmtR(w.netR)} of +${w.goalR}R goal`;
  document.getElementById('branch-loss-name').textContent = 'Stop for the week at →';
  document.getElementById('branch-loss-value').textContent = `${w.capR}R (−${formatMoney(Math.abs(t.weeklyCapDollars))})`;

  document.getElementById('hero-streak').textContent = `${w.trades} of ${w.maxTrades} trades this week`;
}

/** Next-trade card: dollar risk first, what happens after a win vs a loss, and the recent R strip. */
function renderHero() {
  const balance = currentBalance();
  const plan = currentPlanState && currentPlanState.started ? currentPlanState : null;

  if (plan) {
    renderHeroFromPlan(plan, balance);
  } else {
    const preview = SizingEngine.previewNextRisk(currentTrades, currentSettings, balance);
    const cur = preview.current;
    document.getElementById('hero-risk').textContent = cur.dollars !== null ? formatMoney(cur.dollars) : `${cur.riskPct.toFixed(2)}%`;
    document.getElementById('hero-risk').style.color = '';
    document.getElementById('hero-risk-hint').textContent =
      `${cur.riskPct.toFixed(2)}% of ${formatMoney(balance)} — what you lose if the stop is hit`;

    const branchText = (b) => (b.dollars !== null ? `${formatMoney(b.dollars)} · ${b.riskPct.toFixed(2)}%` : `${b.riskPct.toFixed(2)}%`);
    document.getElementById('branch-win-name').textContent = 'If it wins, next risk →';
    document.getElementById('branch-loss-name').textContent = 'If it loses, next risk →';
    document.getElementById('branch-win-value').textContent = branchText(preview.ifWin);
    document.getElementById('branch-loss-value').textContent = branchText(preview.ifLoss);

    document.getElementById('hero-streak').textContent = cur.streakType
      ? `Current run: ${streakLabel(cur.streakType, cur.streakCount)} in a row`
      : 'No run yet';
  }

  // Recent results as R-multiples (deposits/credits aren't trades).
  const rs = SizingEngine.computeRMultiples(currentTrades, currentAccount.starting_balance);
  const recent = currentTrades
    .map((t, i) => ({ t, r: rs[i].r }))
    .filter((x) => !SizingEngine.isLedgerRow(x.t))
    .slice(-8);

  const strip = document.getElementById('streak-strip');
  strip.innerHTML = '';
  recent.forEach(({ t, r }) => {
    const chip = document.createElement('div');
    chip.className = `chip-r ${t.result === 'win' ? 'chip-win' : t.result === 'loss' ? 'chip-loss' : 'chip-be'}`;
    chip.textContent = t.result === 'win' ? 'W' : t.result === 'loss' ? 'L' : 'BE';
    const small = document.createElement('small');
    small.textContent = r === null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(1)}R`;
    chip.appendChild(small);
    strip.appendChild(chip);
  });
  const next = document.createElement('div');
  next.className = 'chip-r chip-next';
  next.textContent = 'NEXT';
  strip.appendChild(next);
}

/** Balance + deposit-neutral drawdown cards. */
function renderPerformanceKpis() {
  const balance = currentBalance();
  const start = Number(currentAccount.starting_balance);
  const series = SizingEngine.computeEquitySeries(currentTrades, start);

  const peakBalance = Math.max(start, ...series.map((p) => p.balance));
  document.getElementById('kpi-balance').textContent = formatMoney(balance);
  document.getElementById('kpi-balance-hint').textContent = `Peak balance ${formatMoney(peakBalance)}`;

  const dd = SizingEngine.computeDrawdownSeries([100, ...series.map((p) => p.index)]);
  const ddEl = document.getElementById('kpi-dd');
  ddEl.textContent = dd.currentDrawdownPct > 0 ? `-${dd.currentDrawdownPct.toFixed(1)}%` : '0.0%';
  ddEl.classList.toggle('loss-text', dd.currentDrawdownPct > 0);
  document.getElementById('kpi-dd-hint').textContent = `worst ${dd.maxDrawdownPct.toFixed(1)}% · deposits don't count as recovery`;
}

function renderRealizedStats() {
  const stats = SizingEngine.computeRealizedStats(currentTrades);

  if (stats.decided === 0) {
    document.getElementById('stat-win-rate').textContent = '—';
    document.getElementById('stat-win-rate-hint').textContent = 'No decided trades yet';
    document.getElementById('stat-rr').textContent = '—';
    document.getElementById('stat-rr-hint').textContent = '';
    document.getElementById('stat-expectancy').textContent = '—';
    document.getElementById('stat-expectancy').classList.remove('win-text', 'loss-text');
    document.getElementById('stat-expectancy-hint').textContent = '';
    document.getElementById('dashboard-band-callout').classList.add('hidden');
    return stats;
  }

  const pct = stats.winRate * 100;
  document.getElementById('stat-win-rate').textContent = `${pct.toFixed(1)}%`;
  document.getElementById('stat-win-rate-hint').textContent = `${stats.wins}W / ${stats.losses}L (${stats.decided} trades)`;

  if (stats.rewardRiskRatio !== null) {
    document.getElementById('stat-rr').textContent = `${stats.rewardRiskRatio}:1`;
    document.getElementById('stat-rr-hint').textContent = `avg win ${formatMoney(stats.avgWin)} / avg loss ${formatMoney(stats.avgLoss)}`;
  } else {
    document.getElementById('stat-rr').textContent = '—';
    document.getElementById('stat-rr-hint').textContent = 'need at least one loss logged';
  }

  const expectancyEl = document.getElementById('stat-expectancy');
  expectancyEl.textContent = formatMoney(stats.expectancy, true);
  expectancyEl.classList.toggle('win-text', stats.expectancy > 0);
  expectancyEl.classList.toggle('loss-text', stats.expectancy < 0);
  document.getElementById('stat-expectancy-hint').textContent =
    stats.expectancy >= 0 ? 'positive — this edge should compound over time' : 'negative — this loses money on average, even before variance';

  const bandCallout = document.getElementById('dashboard-band-callout');
  if (stats.decided >= 5) {
    const band = SizingEngine.classifyWinRateBand(stats.winRate);
    bandCallout.classList.remove('hidden');
    document.getElementById('dashboard-band-label').textContent = `Your realized win rate puts you in: ${band.label}`;
    document.getElementById('dashboard-band-note').textContent = band.note;
  } else {
    bandCallout.classList.add('hidden');
  }

  return stats;
}

function renderBySetup() {
  const rows = SizingEngine.computeStatsBySetup(currentTrades);
  const tbody = document.querySelector('#by-setup-table tbody');
  tbody.innerHTML = '';

  const hasTaggedRows = rows.some((r) => r.setup !== 'Untagged');
  document.getElementById('by-setup-empty').classList.toggle('hidden', hasTaggedRows);
  if (!hasTaggedRows) return;

  rows.forEach((r) => {
    const tr = document.createElement('tr');

    const winRateCell = document.createElement('td');
    winRateCell.textContent = r.winRate !== null ? `${(r.winRate * 100).toFixed(1)}%` : '—';

    const expectancyCell = document.createElement('td');
    if (r.expectancy !== null) {
      expectancyCell.textContent = formatMoney(r.expectancy, true);
      expectancyCell.classList.add(r.expectancy > 0 ? 'win-text' : r.expectancy < 0 ? 'loss-text' : '');
    } else {
      expectancyCell.textContent = '—';
    }

    const setupCell = document.createElement('td');
    setupCell.className = 'txt';
    setupCell.textContent = r.setup;

    const countCell = document.createElement('td');
    countCell.textContent = r.count;

    tr.append(setupCell, countCell, winRateCell, expectancyCell);
    tbody.appendChild(tr);
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderEquityChart() {
  if (typeof Chart === 'undefined') {
    console.error('Chart.js did not load — equity curve cannot render.');
    return; // runSafely's caller already isolates this from breaking anything else
  }

  const start = Number(currentAccount.starting_balance);
  const all = SizingEngine.computeEquitySeries(currentTrades, start);
  const today = todayLocalISO();
  const points = SizingEngine.sliceByRange(all, equityRange, today);
  const hasData = points.length > 0;

  document.getElementById('equity-wrap').classList.toggle('hidden', !hasData);
  document.getElementById('dd-block').classList.toggle('hidden', !hasData);
  document.getElementById('equity-empty').classList.toggle('hidden', hasData);
  if (equityChart) { equityChart.destroy(); equityChart = null; }
  if (drawdownChart) { drawdownChart.destroy(); drawdownChart = null; }
  if (!hasData) { document.getElementById('equity-note').textContent = ''; return; }

  // What the window starts from: the point just before it (or the account start).
  const firstIdx = all.indexOf(points[0]);
  const baseBalance = firstIdx > 0 ? all[firstIdx - 1].balance : start;
  const baseIndex = firstIdx > 0 ? all[firstIdx - 1].index : 100;

  const labels = ['Start', ...points.map((p) => `#${p.trade_number}`)];
  const perf = equityMode === 'performance';
  const values = perf
    ? [0, ...points.map((p) => Math.round((p.index / baseIndex - 1) * 10000) / 100)]
    : [baseBalance, ...points.map((p) => p.balance)];

  let peak = -Infinity;
  const hwm = values.map((v) => { peak = Math.max(peak, v); return peak; });

  const accent = cssVar('--accent');
  const loss = cssVar('--loss');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--border');
  const tick = (v) => (perf ? `${v}%` : `$${v}`);

  const ledgerFlags = [false, ...points.map((p) => p.ledger)];

  equityChart = new Chart(document.getElementById('equity-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: perf ? 'Performance %' : 'Balance',
          data: values,
          borderColor: accent,
          backgroundColor: 'rgba(31, 227, 196, 0.07)',
          fill: true,
          tension: 0.15,
          borderWidth: 2,
          pointRadius: ledgerFlags.map((l) => (l ? 4 : 0)),
          pointBackgroundColor: accent,
          pointBorderColor: accent,
        },
        {
          label: 'High-water mark',
          data: hwm,
          borderColor: muted,
          borderDash: [5, 5],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 8 }, grid: { color: grid } },
        y: { ticks: { color: muted, callback: tick }, grid: { color: grid } },
      },
    },
  });

  // Drawdown strip — always deposit-neutral (built from the performance index).
  const dd = SizingEngine.computeDrawdownSeries([baseIndex, ...points.map((p) => p.index)]);
  drawdownChart = new Chart(document.getElementById('drawdown-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: dd.drawdowns,
        borderColor: loss,
        backgroundColor: 'rgba(212, 119, 93, 0.15)',
        fill: 'origin',
        tension: 0.15,
        borderWidth: 1.5,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { max: 0, ticks: { color: muted, maxTicksLimit: 3, callback: (v) => `${v}%` }, grid: { color: grid } },
      },
    },
  });

  const hasLedger = points.some((p) => p.ledger);
  document.getElementById('equity-note').textContent = perf
    ? 'Performance % compounds trade returns only — money you add is ignored. Drawdown below uses the same basis.'
    : `Balance includes money you add${hasLedger ? ' (teal dots mark deposits and credits)' : ''}. The drawdown strip below ignores deposits, so adding money never looks like recovery.`;
}

// ---------- Plan screen ----------
function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtR(v) {
  const n = Number(v) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}R`;
}

function fmtDay(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function computePlanState() {
  const saved = currentSettings && currentSettings.plan ? currentSettings.plan : null;
  return SizingEngine.evaluatePlan(currentTrades, Number(currentAccount.starting_balance), saved, todayLocalISO());
}

function renderPlan() {
  const st = currentPlanState;
  const view = document.getElementById('view-plan');
  const cfg = document.getElementById('plan-config');
  const body = document.getElementById('plan-body');
  const started = !!(st && st.started);

  fillPlanConfigForm(started ? st.plan : null);
  setPlanConfigMode(started ? 'edit' : 'start');
  // Not started: the form leads the page. Started: it moves to the bottom as settings.
  if (started) view.appendChild(cfg); else view.insertBefore(cfg, body);
  body.classList.toggle('hidden', !started);
  if (!started) return;

  runSafely('plan signal', () => renderPlanSignal(st));
  runSafely('plan ticket', () => renderPlanTicket(st));
  runSafely('plan week', () => renderPlanWeek(st));
  runSafely('plan road', () => renderPlanRoad(st));
  runSafely('plan gate', () => renderPlanGate(st));
  runSafely('plan pace', () => renderPlanPace(st));
  runSafely('plan audit', () => renderPlanAudit(st));
}

function fillPlanConfigForm(plan) {
  const d = SizingEngine.DEFAULT_PLAN;
  document.getElementById('plan-start-date').value = (plan && plan.start_date) || todayLocalISO();
  document.getElementById('plan-start-equity').value = (plan && plan.start_equity) || round2(currentBalance());
  document.getElementById('plan-target').value = (plan && plan.target) || d.target;
  document.getElementById('plan-months').value = (plan && plan.months) || d.months;
  document.getElementById('plan-split').value = plan ? (plan.split_at || '') : d.split_at;
}

function setPlanConfigMode(mode) {
  const edit = mode === 'edit';
  document.getElementById('plan-config-title').textContent = edit ? 'Plan settings' : 'Start your plan';
  document.getElementById('plan-config-intro').classList.toggle('hidden', edit);
  document.getElementById('plan-save-btn').textContent = edit ? 'Save settings' : 'Start plan';
  document.getElementById('plan-restart-btn').classList.toggle('hidden', !edit);
}

async function savePlanConfig(restart) {
  hideError('plan-error');
  const startDate = document.getElementById('plan-start-date').value;
  const startEquity = parseFloat(document.getElementById('plan-start-equity').value);
  const target = parseFloat(document.getElementById('plan-target').value);
  const months = parseInt(document.getElementById('plan-months').value, 10);
  const split = parseFloat(document.getElementById('plan-split').value);

  if (!restart && !startDate) return showError('plan-error', 'Choose a start date.');
  if (!restart && (!startEquity || startEquity <= 0)) return showError('plan-error', 'Enter the starting equity.');
  if (!target || target <= 0) return showError('plan-error', 'Enter a target.');
  if (!months || months < 1 || months > 60) return showError('plan-error', 'Months to target must be between 1 and 60.');
  if (restart && !confirm('Restart the plan from today? The step count and weekly meter start over; your logged trades are kept.')) return;

  const base = restart ? round2(currentBalance()) : startEquity;
  if (target <= base) return showError('plan-error', 'The target must be above the starting equity.');

  const existing = (currentSettings && currentSettings.plan) || {};
  const plan = {
    ...existing,
    start_date: restart ? todayLocalISO() : startDate,
    start_equity: base,
    target, months,
    split_at: isNaN(split) || split <= 0 ? null : split,
  };
  const { error } = await supa.from('fx_model_settings').update({ plan }).eq('account_id', currentAccount.id);
  if (error) return showError('plan-error', error.message);

  await selectAccount(currentAccount.id);
  showToast(restart ? 'Plan restarted from today.' : 'Plan saved.');
}

function renderPlanSignal(st) {
  const w = st.week;
  const t = st.ticket;
  const el = document.getElementById('plan-signal');
  let cls, head, sub;
  if (w.status === 'goal') {
    cls = 'signal-ok'; head = 'Weekly goal reached — stop for the week';
    sub = `You banked ${fmtR(w.netR)} (goal +${w.goalR}R). The next trade is Monday.`;
  } else if (w.status === 'cap') {
    cls = 'signal-stop'; head = 'Weekly cap hit — stop for the week';
    sub = `${fmtR(w.netR)} (cap ${w.capR}R). Protect the account; the next trade is Monday.`;
  } else if (w.status === 'limit') {
    cls = 'signal-warn'; head = `${w.maxTrades} trades taken — stop for the week`;
    sub = `You're at ${fmtR(w.netR)} for the week. The next trade is Monday.`;
  } else {
    cls = 'signal-go'; head = 'You can take a trade';
    const left = w.maxTrades - w.trades;
    sub = `${st.stage.label} · risk ${formatMoney(t.riskDollars)} · ${left} trade${left === 1 ? '' : 's'} left this week · ${fmtR(w.netR)} of +${w.goalR}R goal`;
  }
  el.className = `signal ${cls}`;
  el.innerHTML = '';
  const h = document.createElement('div'); h.className = 'signal-head'; h.textContent = head;
  const p = document.createElement('div'); p.className = 'signal-sub'; p.textContent = sub;
  el.append(h, p);
}

function planPipValue() {
  const input = document.getElementById('plan-pip-value');
  const v = parseFloat(input.value);
  return v > 0 ? v : 10;
}

function renderPlanTicket(st) {
  const t = st.ticket;
  const equity = st.equityNow;
  const set = (id, txt) => { document.getElementById(id).textContent = txt; };

  set('ticket-stage', `${st.stage.label}${st.stage.kind === 'tier' ? ' · risk follows equity' : ''}`);
  set('ticket-risk', formatMoney(t.riskDollars));
  set('ticket-risk-hint', `${t.riskPct}% of ${formatMoney(equity)}`);

  const lots = SizingEngine.lotsForRisk({ riskDollars: t.riskDollars, stopPips: t.stopPips, pipValuePerLot: planPipValue(), runner: t.runner });
  set('ticket-lots', lots.total.toFixed(2));
  let lotsHint = `real risk ${formatMoney(lots.riskActual)}`;
  if (lots.riskActual > t.riskDollars * 1.001) lotsHint = `0.01 is the minimum lot — risk is ${formatMoney(lots.riskActual)}, above the plan`;
  else if (t.runner && lots.legB > 0) lotsHint = `A ${lots.legA.toFixed(2)} → +${t.targetPips} · B ${lots.legB.toFixed(2)} → +${t.runnerTargetPips} · risk ${formatMoney(lots.riskActual)}`;
  set('ticket-lots-hint', lotsHint);

  set('ticket-stop', `${t.stopPips} pips`);
  set('ticket-stop-hint', `skip the setup if structure needs > ${st.plan.trade.maxStopPips}`);
  set('ticket-be', `+${t.bePips} pips`);
  set('ticket-target', `+${t.targetPips} pips`);
  set('ticket-target-hint', t.runner && t.runnerTargetPips ? `${(t.targetPips / t.stopPips).toFixed(0)}R · runner leg +${t.runnerTargetPips}` : `${(t.targetPips / t.stopPips).toFixed(0)}R`);
  set('ticket-pl', `+${formatMoney(t.winDollars)} / −${formatMoney(t.riskDollars)}`);
}

function renderPlanWeek(st) {
  const w = st.week;
  const t = st.ticket;
  document.getElementById('week-label').textContent = `Week of ${fmtDay(w.start)}`;
  const net = document.getElementById('week-net');
  net.textContent = `${fmtR(w.netR)}  ≈ ${w.netR >= 0 ? '+' : '−'}${formatMoney(Math.abs(w.netR * t.riskDollars))}`;
  net.classList.toggle('win-text', w.netR > 0);
  net.classList.toggle('loss-text', w.netR < 0);

  const span = w.goalR - w.capR;                       // e.g. 4 - (-2) = 6
  const zeroPct = ((0 - w.capR) / span) * 100;         // where 0R sits on the bar
  const netPct = (Math.max(w.capR, Math.min(w.goalR, w.netR)) / span) * 100;
  const fill = document.getElementById('week-meter-fill');
  fill.classList.toggle('neg', w.netR < 0);
  fill.style.left = `${netPct >= 0 ? zeroPct : zeroPct + netPct}%`;
  fill.style.width = `${Math.abs(netPct)}%`;
  document.getElementById('week-meter-zero').style.left = `${zeroPct}%`;
  document.getElementById('week-cap-label').textContent = `cap ${w.capR}R (−${formatMoney(Math.abs(t.weeklyCapDollars))})`;
  document.getElementById('week-goal-label').textContent = `goal +${w.goalR}R (+${formatMoney(t.weeklyGoalDollars)})`;
  document.getElementById('week-detail').textContent = `${w.trades} of ${w.maxTrades} trades taken this week`;
}

function renderPlanRoad(st) {
  const el = document.getElementById('road');
  el.innerHTML = '';
  st.road.forEach((r) => {
    const item = document.createElement('div');
    item.className = `road-item ${r.status} ${r.kind === 'milestone' || r.kind === 'goal' ? r.kind : ''}`;

    const title = document.createElement('div');
    title.className = 'road-title';
    const name = document.createElement('span'); name.textContent = r.label;
    title.appendChild(name);
    const range = document.createElement('span');
    range.className = 'road-range';
    range.textContent = r.kind === 'step' || r.kind === 'tier' ? `${r.from === 0 ? 'up to' : formatMoney(r.from, false).replace('.00', '') + ' –'} ${formatMoney(r.to).replace('.00', '')}` : r.rule;
    title.appendChild(range);
    if (r.status === 'current') { const b = document.createElement('span'); b.className = 'road-badge'; b.textContent = 'you are here'; title.appendChild(b); }
    item.appendChild(title);

    if (r.kind === 'step' || r.kind === 'tier') {
      const rule = document.createElement('div'); rule.className = 'road-rule'; rule.textContent = r.rule; item.appendChild(rule);
      if (r.detail) { const d = document.createElement('div'); d.className = 'road-detail'; d.textContent = r.detail; item.appendChild(d); }
      if (r.status === 'current' && st.gate && st.gate.equityReady && !st.gate.isLast) {
        const n = document.createElement('div'); n.className = 'road-detail';
        n.textContent = 'Equity already qualifies for the next step — earn it with clean trades.'; item.appendChild(n);
      }
      if (r.status !== 'upcoming') {
        const bar = document.createElement('div'); bar.className = 'road-bar';
        const fillEl = document.createElement('div'); fillEl.style.width = `${Math.round((r.status === 'done' ? 1 : r.progress) * 100)}%`;
        bar.appendChild(fillEl); item.appendChild(bar);
      }
    }
    el.appendChild(item);
  });
}

function renderPlanGate(st) {
  const title = document.getElementById('gate-title');
  const note = document.getElementById('gate-note');
  const slots = document.getElementById('gate-slots');
  const reqs = document.getElementById('gate-reqs');
  slots.innerHTML = ''; reqs.innerHTML = '';

  if (!st.gate) {
    const tiers = st.plan.tiers;
    const idx = tiers.findIndex((t) => t.id === st.stage.id);
    const next = tiers[idx + 1];
    title.textContent = `${st.stage.label} — risk follows equity`;
    note.textContent = next ? `next tier at ${formatMoney(next.equityFrom).replace('.00', '')}` : 'top tier';
    const li = document.createElement('li');
    li.innerHTML = '';
    li.textContent = `Risk is ${st.stage.riskPct}% of equity — ${formatMoney(st.ticket.riskDollars)} on the next trade. No step count here; the weekly goal and cap still apply.`;
    reqs.appendChild(li);
    return;
  }

  const g = st.gate;
  title.textContent = `${g.from} → ${g.to}`;
  note.textContent = g.isLast ? '' : `${fmtR(g.netR)} over the last ${st.plan.stepGate.trades}`;

  if (!g.isLast) {
    g.slots.forEach((s) => {
      const chip = document.createElement('div');
      if (!s) { chip.className = 'chip-r chip-empty'; chip.textContent = '·'; }
      else {
        chip.className = `chip-r ${s.r > 0 ? 'chip-win' : s.r < 0 ? 'chip-loss' : 'chip-be'}`;
        chip.textContent = s.r > 0 ? 'W' : s.r < 0 ? 'L' : 'BE';
        const small = document.createElement('small'); small.textContent = fmtR(s.r); chip.appendChild(small);
        if (!s.clean) chip.title = 'rule break on this trade';
      }
      slots.appendChild(chip);
    });
  }
  g.requirements.forEach((r) => {
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'no';
    const tick = document.createElement('span'); tick.className = 'tick'; tick.textContent = r.ok ? '✓' : '✗';
    const label = document.createElement('span'); label.textContent = r.label;
    const detail = document.createElement('span'); detail.className = 'detail'; detail.textContent = r.detail;
    li.append(tick, label, detail);
    reqs.appendChild(li);
  });
}

function renderPlanPace(st) {
  const p = st.pace;
  const statusEl = document.getElementById('pace-status');
  const goalDate = p.path[p.path.length - 1].date;
  document.getElementById('pace-note').textContent = `${formatMoney(st.plan.target).replace('.00', '')} by ${fmtDay(goalDate)} ${goalDate.slice(0, 4)} · needs ${p.monthlyGrowthPct}% a month`;

  const eq = `equity ex-deposits ${formatMoney(p.adjustedEquity)} vs path ${formatMoney(p.expectedEquity)}`;
  let cls, msg;
  if (p.elapsedMonths < 0.25 && p.status !== 'far') { cls = 'pace-on'; msg = `Just started — ${eq}.`; }
  else if (p.status === 'on') { cls = 'pace-on'; msg = `On pace — ${eq}.`; }
  else if (p.status === 'behind') { cls = 'pace-behind'; msg = `Behind the path by ${Math.abs(p.monthsAhead).toFixed(1)} months — ${eq}. Extend the date; don't raise the risk.`; }
  else { cls = 'pace-far'; msg = `Well behind the path — ${eq}. Extend the date; don't raise the risk to catch up.`; }
  statusEl.className = `pace-status ${cls}`;
  statusEl.textContent = msg;

  if (typeof Chart === 'undefined') return;
  if (planPaceChart) { planPaceChart.destroy(); planPaceChart = null; }
  const accent = cssVar('--accent');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--border');
  planPaceChart = new Chart(document.getElementById('plan-pace-chart').getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Path', data: p.path.map((x) => ({ x: x.month, y: x.equity })), borderColor: muted, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 2, fill: false },
        { label: 'You (ex-deposits)', data: p.actual.map((x) => ({ x: x.x, y: Math.max(1, x.y) })), borderColor: accent, backgroundColor: 'rgba(31, 227, 196, 0.07)', borderWidth: 2, pointRadius: 2, tension: 0.1, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { color: muted } } },
      scales: {
        x: { type: 'linear', min: 0, max: st.plan.months, ticks: { color: muted, stepSize: 1, callback: (v) => `M${v}` }, grid: { color: grid } },
        y: { type: 'logarithmic', ticks: { color: muted, callback: (v) => `$${v}` }, grid: { color: grid } },
      },
    },
  });
}

function renderPlanAudit(st) {
  const a = st.audit;
  document.getElementById('audit-note').textContent = a.planTrades === 0
    ? 'no trades since the start date'
    : `${a.planTrades} plan trades · ${a.clean} clean · ${a.flagged} flagged · ${a.unverified} without a checklist`;

  const strip = document.getElementById('week-strip');
  strip.innerHTML = '';
  if (st.weeks.length === 0) {
    const none = document.createElement('div'); none.className = 'kpi-hint'; none.textContent = 'No weeks logged yet.'; strip.appendChild(none);
  }
  st.weeks.forEach((wk) => {
    const chip = document.createElement('div');
    chip.className = `chip-r ${wk.netR > 0 ? 'chip-win' : wk.netR < 0 ? 'chip-loss' : 'chip-be'}`;
    chip.textContent = fmtR(wk.netR);
    const small = document.createElement('small'); small.textContent = fmtDay(wk.weekStart); chip.appendChild(small);
    chip.title = `${wk.trades} trades · ${wk.outcome === 'goal' ? 'goal reached' : wk.outcome === 'cap' ? 'cap hit' : wk.outcome === 'limit' ? 'trade limit' : 'open'}`;
    strip.appendChild(chip);
  });

  const list = document.getElementById('audit-list');
  list.innerHTML = '';
  if (a.planTrades > 0 && a.flags.length === 0) {
    const li = document.createElement('li'); li.textContent = 'No rule breaks logged.'; list.appendChild(li);
  }
  a.flags.slice(-8).reverse().forEach((f) => {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'audit-num'; n.textContent = `#${f.trade_number}${f.pair ? ' ' + f.pair : ''}`;
    li.append(n, document.createTextNode(f.reasons.join(' · ')));
    list.appendChild(li);
  });
  if (a.noR > 0) {
    const li = document.createElement('li');
    li.textContent = `${a.noR} trade${a.noR === 1 ? ' has' : 's have'} no R-multiple (no stop or risk recorded), so they don't count toward the weekly meter or the step.`;
    list.appendChild(li);
  }
}

function wirePlan() {
  document.getElementById('plan-save-btn').addEventListener('click', () => savePlanConfig(false));
  document.getElementById('plan-restart-btn').addEventListener('click', () => savePlanConfig(true));

  const pip = document.getElementById('plan-pip-value');
  try { const saved = localStorage.getItem('cliffPipValue'); if (saved) pip.value = saved; } catch (_) { /* storage unavailable */ }
  pip.addEventListener('input', () => {
    try { localStorage.setItem('cliffPipValue', pip.value); } catch (_) { /* storage unavailable */ }
    if (currentPlanState && currentPlanState.started) runSafely('plan ticket', () => renderPlanTicket(currentPlanState));
  });
}

function wireChartControls() {
  const bind = (containerId, attr, setter) => {
    document.querySelectorAll(`#${containerId} button`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${containerId} button`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        setter(btn.dataset[attr]);
        runSafely('equity chart', renderEquityChart);
      });
    });
  };
  bind('equity-mode', 'mode', (v) => { equityMode = v; });
  bind('equity-range', 'range', (v) => { equityRange = v; });
}

function renderRecentTrades() {
  const tbody = document.querySelector('#recent-trades-table tbody');
  tbody.innerHTML = '';
  const recent = currentTrades.slice(-8).reverse();
  document.getElementById('recent-trades-empty').classList.toggle('hidden', recent.length > 0);

  recent.forEach((t) => {
    tbody.appendChild(tradeRow(t, false));
  });
}

// ---------- Trade log view ----------
function renderTradeLog() {
  document.querySelector('#all-trades-table tbody').innerHTML = '';
  const tbody = document.querySelector('#all-trades-table tbody');
  document.getElementById('all-trades-empty').classList.toggle('hidden', currentTrades.length > 0);
  [...currentTrades].reverse().forEach((t) => tbody.appendChild(tradeRow(t, true)));

  const plan = currentPlanState && currentPlanState.started ? currentPlanState : null;
  const next = nextRisk();
  const suggestedDollars = plan ? plan.ticket.riskDollars : SizingEngine.riskPctToAmount(next.riskPct, currentBalance());
  if (suggestedDollars !== null) {
    document.getElementById('trade-risk-mode').value = 'dollar';
    document.getElementById('trade-risk-value-label').textContent = 'Risk $ amount (this trade)';
    document.getElementById('trade-risk-value').value = suggestedDollars.toFixed(2);
  } else {
    document.getElementById('trade-risk-mode').value = 'pct';
    document.getElementById('trade-risk-value-label').textContent = 'Risk % (this trade)';
    document.getElementById('trade-risk-value').value = next.riskPct.toFixed(2);
  }
  // Left blank on purpose (placeholder only): a pre-filled default would get recorded as if it were the real stop.
  document.getElementById('trade-sl-pips').value = '';
  document.getElementById('trade-sl-pips').placeholder = String(plan ? plan.ticket.stopPips : currentSettings.default_stop_loss_pips);
  document.getElementById('trade-date').value = todayLocalISO();
  updateRiskValueHint();
  updateSuggestedUnits();

  let streakNote = next.streakType
    ? `Suggested from ${streakLabel(next.streakType, next.streakCount)} in a row.`
    : 'First trade on this account — using base risk.';
  if (plan) {
    streakNote = plan.week.status === 'open'
      ? `Plan: ${plan.stage.label} — risk ${formatMoney(plan.ticket.riskDollars)}, stop ${plan.ticket.stopPips} pips.`
      : 'Plan says: stop for the week (goal, cap or trade limit reached).';
  }
  document.getElementById('suggested-risk-note').textContent = streakNote;

  document.getElementById('trade-instrument-type').value = 'forex';
  document.getElementById('trade-pip-decimal').value = String(currentSettings.pip_decimal || 0.0001);
  applyInstrumentType('forex');

  resetQuickAddGrid();
  resetXlsxPreview();
  document.getElementById('xlsx-import-file').value = '';
}

// ---------- Quick add (manual, no pip math) ----------
function wireQuickAddGrid() {
  document.getElementById('quick-add-row-btn').addEventListener('click', () => addQuickAddRow());
  document.getElementById('quick-add-save-btn').addEventListener('click', saveQuickAddRows);
}

function addQuickAddRow() {
  const tbody = document.querySelector('#quick-add-table tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="date" class="qa-date" value="${todayLocalISO()}" /></td>
    <td><input type="text" class="qa-pair" placeholder="GOLD" /></td>
    <td>
      <select class="qa-direction">
        <option value="long">Long</option>
        <option value="short">Short</option>
      </select>
    </td>
    <td>
      <select class="qa-risk-mode">
        <option value="pct">%</option>
        <option value="dollar">$</option>
      </select>
    </td>
    <td><input type="number" class="qa-risk-value" step="0.01" min="0" placeholder="2" /></td>
    <td>
      <select class="qa-result">
        <option value="win">Win</option>
        <option value="loss">Loss</option>
        <option value="breakeven">Breakeven</option>
      </select>
    </td>
    <td><input type="number" class="qa-pnl" step="0.01" placeholder="-2.85" /></td>
    <td><input type="text" class="qa-setup" list="setup-tag-options" placeholder="Order Block" /></td>
    <td><button type="button" class="remove-row-btn">✕</button></td>
  `;
  tr.querySelector('.remove-row-btn').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

function resetQuickAddGrid() {
  document.querySelector('#quick-add-table tbody').innerHTML = '';
  hideError('quick-add-error');
  document.getElementById('quick-add-note').classList.add('hidden');
  addQuickAddRow();
}

// ---------- MT5 .xlsx report import ----------
let parsedXlsxTrades = [];

function wireXlsxImportPanel() {
  document.getElementById('xlsx-parse-btn').addEventListener('click', async () => {
    hideError('xlsx-error');
    resetXlsxPreview();

    const fileInput = document.getElementById('xlsx-import-file');
    const file = fileInput.files[0];
    if (!file) return showError('xlsx-error', 'Choose a file first.');

    let positionRows, adjustmentRows, closingDeals;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
      positionRows = SizingEngine.extractMt5PositionsRows(sheetRows);
      adjustmentRows = SizingEngine.extractMt5DealsAdjustments(sheetRows);
      closingDeals = SizingEngine.extractMt5ClosingDeals(sheetRows);
    } catch (err) {
      return showError('xlsx-error', `Couldn't read that file: ${err.message}`);
    }

    if (positionRows.length === 0 && adjustmentRows.length === 0) {
      return showError('xlsx-error', 'No closed positions or deposits found — check this is an MT5 "Save as Report" export.');
    }

    const existingExternalIds = new Set(currentTrades.map((t) => t.external_id).filter(Boolean));
    const startTradeNumber = currentTrades.length > 0 ? currentTrades[currentTrades.length - 1].trade_number + 1 : 1;
    const startingBalance = currentBalance();

    const { trades, duplicateCount, totalParsed, reconciliation, balancesTrustworthy } = SizingEngine.buildTradesFromMt5Report({
      positionRows, closingDeals, adjustmentRows, startTradeNumber, startingBalance, existingExternalIds,
    });

    parsedXlsxTrades = trades;
    renderXlsxPreview(trades, duplicateCount, totalParsed, reconciliation, balancesTrustworthy);
  });

  document.getElementById('xlsx-confirm-btn').addEventListener('click', async () => {
    if (parsedXlsxTrades.length === 0) return;
    hideError('xlsx-error');

    const rows = parsedXlsxTrades.map((t) => ({ ...t, account_id: currentAccount.id }));
    // ignoreDuplicates as a DB-level safety net — the app already filtered
    // out known duplicates above, this just guards against a race (e.g.
    // double-click) hitting the unique (account_id, external_id) index.
    const { error } = await supa.from('fx_trades').upsert(rows, { onConflict: 'account_id,external_id', ignoreDuplicates: true });
    if (error) return showError('xlsx-error', error.message);

    const count = parsedXlsxTrades.length;
    document.getElementById('xlsx-import-file').value = '';
    resetXlsxPreview();
    await selectAccount(currentAccount.id);
    showToast(`Imported ${count} new trade(s) from the report.`);
  });
}

function renderXlsxPreview(trades, duplicateCount, totalParsed, reconciliation, balancesTrustworthy) {
  document.getElementById('xlsx-preview').classList.remove('hidden');
  document.getElementById('xlsx-confirm-btn').classList.toggle('hidden', trades.length === 0);

  const reconcileNote = document.getElementById('xlsx-reconcile-note');
  if (reconciliation) {
    reconcileNote.textContent = `Heads up: this report's own numbers imply your balance right before these new events was `
      + `${formatMoney(reconciliation.impliedPriorBalance)}, but the account currently shows ${formatMoney(reconciliation.accountBalance)}. `
      + `Using MT5's own balance figures for the imported rows below (not accumulating on top of the account's current balance), `
      + `so they're correct regardless of that mismatch — but it's worth understanding where the difference came from `
      + `(e.g. the account's starting balance was set manually before this history was imported).`;
    reconcileNote.classList.remove('hidden');
  } else if (!balancesTrustworthy && trades.some((t) => t.pair !== 'DEPOSIT' && t.pair !== 'CREDIT')) {
    reconcileNote.textContent = `Couldn't verify these trades' balances against the report's own ledger (row counts didn't line up) — `
      + `falling back to computing from the account's current balance. Double-check the ending balance below against your MT5 report.`;
    reconcileNote.classList.remove('hidden');
  } else {
    reconcileNote.classList.add('hidden');
  }

  const newTradeCount = trades.filter((t) => t.pair !== 'DEPOSIT' && t.pair !== 'CREDIT').length;
  const newAdjustmentCount = trades.length - newTradeCount;

  let summary = `${totalParsed} closed position(s)/ledger event(s) found — ${duplicateCount} already imported (skipped), ${newTradeCount} new trade(s)`;
  if (newAdjustmentCount > 0) summary += ` and ${newAdjustmentCount} new deposit/credit entr${newAdjustmentCount === 1 ? 'y' : 'ies'}`;
  summary += '.';
  if (trades.length > 0) {
    summary += ` Ending balance after import: ${formatMoney(trades[trades.length - 1].balance_after)}.`;
  }
  document.getElementById('xlsx-summary').textContent = summary;

  const tbody = document.querySelector('#xlsx-preview-table tbody');
  tbody.innerHTML = '';
  trades.forEach((t) => {
    const tr = document.createElement('tr');
    const isAdjustment = t.pair === 'DEPOSIT' || t.pair === 'CREDIT';
    const resultClass = isAdjustment ? '' : t.result === 'win' ? 'win-text' : t.result === 'loss' ? 'loss-text' : '';
    const cells = [
      t.trade_date, t.pair, t.direction || '—',
      isAdjustment ? '—' : span(t.result, resultClass),
      t.pips_result ?? '—', t.risk_pct_used !== null ? `${t.risk_pct_used}%` : '—',
      formatMoney(t.pnl_amount, true), formatMoney(t.balance_after),
    ];
    cells.forEach((c) => {
      const td = document.createElement('td');
      if (c instanceof HTMLElement) td.appendChild(c); else td.textContent = c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function resetXlsxPreview() {
  parsedXlsxTrades = [];
  document.getElementById('xlsx-preview').classList.add('hidden');
  document.getElementById('xlsx-confirm-btn').classList.add('hidden');
  document.getElementById('xlsx-reconcile-note').classList.add('hidden');
}

async function saveQuickAddRows() {
  hideError('quick-add-error');
  document.getElementById('quick-add-note').classList.add('hidden');

  const rowEls = document.querySelectorAll('#quick-add-table tbody tr');
  if (rowEls.length === 0) return showError('quick-add-error', 'Add at least one row.');

  const rows = [];
  for (const tr of rowEls) {
    const date = tr.querySelector('.qa-date').value;
    const pair = tr.querySelector('.qa-pair').value.trim();
    const direction = tr.querySelector('.qa-direction').value;
    const riskMode = tr.querySelector('.qa-risk-mode').value;
    const riskValue = parseFloat(tr.querySelector('.qa-risk-value').value);
    const result = tr.querySelector('.qa-result').value;
    const pnl = parseFloat(tr.querySelector('.qa-pnl').value);
    const setupTag = tr.querySelector('.qa-setup').value.trim();

    if (isNaN(pnl)) return showError('quick-add-error', `Row for ${pair || date || '(unnamed)'}: enter a P&L amount.`);
    if (isNaN(riskValue)) return showError('quick-add-error', `Row for ${pair || date || '(unnamed)'}: enter a risk value.`);

    rows.push({ date, pair, direction, riskMode, riskValue, result, pnl, setupTag: setupTag || null, notes: null });
  }

  const startTradeNumber = currentTrades.length > 0 ? currentTrades[currentTrades.length - 1].trade_number + 1 : 1;
  const startingBalance = currentBalance();
  const built = SizingEngine.buildTradesFromManualRows(rows, { startTradeNumber, startingBalance });

  const { error } = await supa.from('fx_trades').insert(built.map((t) => ({ ...t, account_id: currentAccount.id })));
  if (error) return showError('quick-add-error', error.message);

  const savedCount = built.length;
  const endingBalance = built[built.length - 1].balance_after;

  await selectAccount(currentAccount.id); // re-renders and resets the grid via renderTradeLog

  const note = document.getElementById('quick-add-note');
  note.textContent = `Saved ${savedCount} trade(s). Ending balance: ${formatMoney(endingBalance)}.`;
  note.classList.remove('hidden');
}

function tradeRow(t, full) {
  const tr = document.createElement('tr');
  const resultClass = t.result === 'win' ? 'win-text' : t.result === 'loss' ? 'loss-text' : '';
  const dash = (v) => (v === null || v === undefined ? '—' : v);
  const pctOrDash = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const cells = full
    ? [
        t.trade_number, t.trade_date, t.pair || '—', t.direction || '—', dash(t.stop_loss_pips),
        span(t.result, resultClass), dash(t.pips_result), pctOrDash(t.risk_pct_used),
        t.position_units?.toLocaleString() || '—', formatMoney(t.pnl_amount, true), formatMoney(t.balance_after),
        checklistScoreCell(t.checklist),
      ]
    : [
        t.trade_number, t.trade_date, t.pair || '—', t.direction || '—',
        span(t.result, resultClass), dash(t.pips_result), pctOrDash(t.risk_pct_used),
        formatMoney(t.pnl_amount, true), formatMoney(t.balance_after),
      ];

  cells.forEach((c) => {
    const td = document.createElement('td');
    if (c instanceof HTMLElement) td.appendChild(c);
    else td.textContent = c;
    tr.appendChild(td);
  });

  if (full) {
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = 'Delete';
    btn.className = 'delete-trade-btn';
    btn.addEventListener('click', () => deleteTrade(t.id));
    td.appendChild(btn);
    tr.appendChild(td);
  }
  return tr;
}

function span(text, cls) {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
}

/** Renders a trade's checklist score as a small colored "x/9" element for the All trades table. */
function checklistScoreCell(checklist) {
  const score = SizingEngine.computeChecklistScore(checklist);
  if (!score) return span('—');
  const cls = score.pct >= 75 ? 'rules-score-good' : score.pct >= 50 ? 'rules-score-mid' : 'rules-score-bad';
  const el = span(`${score.followed}/${score.total}`, cls);
  if (checklist.scenario) {
    const scenarioLabel = SizingEngine.SCENARIO_OPTIONS.find((o) => o.value === checklist.scenario)?.label;
    if (scenarioLabel) el.title = scenarioLabel;
  }
  return el;
}

async function deleteTrade(tradeId) {
  if (!confirm('Delete this trade? Later trades will keep their recorded balances as-is — you may want to re-check the sequence after.')) return;
  const { error } = await supa.from('fx_trades').delete().eq('id', tradeId);
  if (error) { alert(error.message); return; }
  await selectAccount(currentAccount.id);
}

// ---------- Trade form ----------
function wireTradeForm() {
  initChecklistUI();

  ['trade-risk-value', 'trade-risk-mode', 'trade-sl-pips', 'trade-pip-decimal'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => { updateRiskValueHint(); updateSuggestedUnits(); });
  });

  document.getElementById('trade-risk-mode').addEventListener('change', (e) => {
    const label = document.getElementById('trade-risk-value-label');
    label.textContent = e.target.value === 'dollar' ? 'Risk $ amount (this trade)' : 'Risk % (this trade)';
    document.getElementById('trade-risk-value').step = e.target.value === 'dollar' ? '0.01' : '0.01';
    updateRiskValueHint();
    updateSuggestedUnits();
  });

  document.getElementById('trade-pair').addEventListener('input', (e) => {
    const detected = SizingEngine.detectPipDecimal(e.target.value);
    if (detected) {
      document.getElementById('trade-instrument-type').value = 'forex';
      document.getElementById('trade-pip-decimal').value = String(detected);
      applyInstrumentType('forex');
    }
  });

  document.getElementById('trade-instrument-type').addEventListener('change', (e) => {
    applyInstrumentType(e.target.value);
  });

  document.getElementById('trade-result-mode').addEventListener('change', applyResultMode);

  document.getElementById('trade-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('trade-form-error');

    const pair = document.getElementById('trade-pair').value.trim();
    const direction = document.getElementById('trade-direction').value;
    const instrumentType = document.getElementById('trade-instrument-type').value;
    const result = document.getElementById('trade-result').value;
    const tradeDate = document.getElementById('trade-date').value;
    const notes = document.getElementById('trade-notes').value.trim();

    const riskPct = currentRiskPct();
    if (!riskPct || riskPct <= 0) {
      const mode = document.getElementById('trade-risk-mode').value;
      return showError('trade-form-error', mode === 'dollar' ? 'Enter a risk $ amount for this trade.' : 'Enter a risk % for this trade.');
    }

    const balanceBefore = currentBalance();
    const setupTag = document.getElementById('trade-setup').value.trim();
    const checklist = readChecklistFromForm();
    const checklistIsEmpty = !checklist.scenario && SizingEngine.CHECKLIST_RULES.every((r) => !checklist[r.key]);
    let payload = {
      account_id: currentAccount.id,
      trade_date: tradeDate || todayLocalISO(),
      pair: pair || null,
      direction,
      result,
      risk_pct_used: riskPct,
      setup_tag: setupTag || null,
      checklist: checklistIsEmpty ? null : checklist,
      notes: notes || null,
    };

    if (instrumentType === 'forex') {
      const resultMode = document.getElementById('trade-result-mode').value;
      const slPips = parseFloat(document.getElementById('trade-sl-pips').value);
      const pipDecimal = parseFloat(document.getElementById('trade-pip-decimal').value);
      const hasStop = !!slPips && slPips > 0;

      if (resultMode === 'pips') {
        const pipsResult = parseFloat(document.getElementById('trade-pips-result').value);
        if (!hasStop) return showError('trade-form-error', 'Enter a stop loss in pips.');
        if (isNaN(pipsResult)) return showError('trade-form-error', 'Enter the actual pip result (negative for a loss).');

        const units = SizingEngine.computePositionUnits({ balance: balanceBefore, riskPct, stopLossPips: slPips, pipDecimal });
        const pnl = SizingEngine.computePnl({ units, pipsResult, pipDecimal });

        payload = {
          ...payload,
          stop_loss_pips: slPips,
          pips_result: pipsResult,
          position_units: units,
          pnl_amount: pnl,
          balance_after: round2(balanceBefore + pnl),
        };
      } else {
        // $ result entry: the amount you typed is the source of truth. A stop
        // distance is optional here — if given, units are recorded and the
        // pip result is back-derived for the table; if not, they stay blank.
        const pnl = parseFloat(document.getElementById('trade-pnl-direct').value);
        if (isNaN(pnl)) return showError('trade-form-error', 'Enter the $ P&L for this trade (negative for a loss).');
        if (resultContradictsPnl(result, pnl)) return showError('trade-form-error', `Result says "${result}" but the P&L is ${formatMoney(pnl, true)} — fix one of them.`);

        let units = null;
        let pipsResult = null;
        if (hasStop) {
          units = SizingEngine.computePositionUnits({ balance: balanceBefore, riskPct, stopLossPips: slPips, pipDecimal });
          if (units > 0) pipsResult = round2(pnl / (units * pipDecimal));
        }

        payload = {
          ...payload,
          stop_loss_pips: hasStop ? slPips : null,
          pips_result: pipsResult,
          position_units: units,
          pnl_amount: round2(pnl),
          balance_after: round2(balanceBefore + pnl),
        };
      }
    } else {
      const pnl = parseFloat(document.getElementById('trade-pnl-direct').value);
      if (isNaN(pnl)) return showError('trade-form-error', 'Enter the $ P&L for this trade.');
      if (resultContradictsPnl(result, pnl)) return showError('trade-form-error', `Result says "${result}" but the P&L is ${formatMoney(pnl, true)} — fix one of them.`);

      payload = {
        ...payload,
        stop_loss_pips: null,
        pips_result: null,
        position_units: null,
        pnl_amount: round2(pnl),
        balance_after: round2(balanceBefore + pnl),
      };
    }

    const nextNum = currentTrades.length > 0 ? currentTrades[currentTrades.length - 1].trade_number + 1 : 1;
    const { error } = await supa.from('fx_trades').insert({ ...payload, trade_number: nextNum });

    if (error) return showError('trade-form-error', error.message);

    document.getElementById('trade-pair').value = '';
    document.getElementById('trade-pips-result').value = '';
    document.getElementById('trade-pnl-direct').value = '';
    document.getElementById('trade-notes').value = '';
    resetChecklistForm();
    await selectAccount(currentAccount.id);
    showToast(`Trade #${nextNum} logged — ${payload.result} — new balance ${formatMoney(payload.balance_after)}.`);
  });
}

// ---------- Pre-trade checklist ----------
function initChecklistUI() {
  const scenarioSelect = document.getElementById('checklist-scenario');
  SizingEngine.SCENARIO_OPTIONS.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    scenarioSelect.appendChild(el);
  });

  const rulesContainer = document.getElementById('checklist-rules');
  SizingEngine.CHECKLIST_RULES.forEach((rule) => {
    const label = document.createElement('label');
    label.className = 'checklist-rule';
    label.innerHTML = `<input type="checkbox" class="checklist-rule-input" data-key="${rule.key}" /> <span>${rule.label}</span>`;
    label.querySelector('input').addEventListener('change', updateChecklistScoreDisplay);
    rulesContainer.appendChild(label);
  });

  updateChecklistScoreDisplay();
}

function readChecklistFromForm() {
  const checklist = { scenario: document.getElementById('checklist-scenario').value || null };
  document.querySelectorAll('.checklist-rule-input').forEach((input) => {
    checklist[input.dataset.key] = input.checked;
  });
  return checklist;
}

function updateChecklistScoreDisplay() {
  const score = SizingEngine.computeChecklistScore(readChecklistFromForm());
  const el = document.getElementById('checklist-score');
  if (!score || score.followed === 0) { el.textContent = ''; return; }
  el.textContent = `${score.followed}/${score.total} rules`;
  el.classList.remove('rules-score-good', 'rules-score-mid', 'rules-score-bad');
  el.classList.add(score.pct >= 75 ? 'rules-score-good' : score.pct >= 50 ? 'rules-score-mid' : 'rules-score-bad');
}

function resetChecklistForm() {
  document.getElementById('checklist-scenario').value = '';
  document.querySelectorAll('.checklist-rule-input').forEach((input) => { input.checked = false; });
  updateChecklistScoreDisplay();
}

/** Win/loss must agree with the sign of a directly-typed P&L, otherwise win rate and expectancy get quietly corrupted. */
function resultContradictsPnl(result, pnl) {
  return (result === 'win' && pnl < 0) || (result === 'loss' && pnl > 0);
}

/** Resolves the current trade form's risk value into a risk %, regardless of entry mode. */
function currentRiskPct() {
  const mode = document.getElementById('trade-risk-mode').value;
  const value = parseFloat(document.getElementById('trade-risk-value').value);
  if (isNaN(value)) return null;
  if (mode === 'dollar') return SizingEngine.riskAmountToPct(value, currentBalance());
  return round2(value);
}

function updateRiskValueHint() {
  const mode = document.getElementById('trade-risk-mode').value;
  const hint = document.getElementById('trade-risk-value-hint');
  if (mode !== 'dollar') { hint.textContent = ''; return; }
  const pct = currentRiskPct();
  hint.textContent = pct !== null ? `≈ ${pct}% of current balance` : '';
}

function applyInstrumentType(type) {
  const isForex = type === 'forex';
  document.getElementById('trade-pip-decimal-wrap').classList.toggle('hidden', !isForex);
  document.getElementById('trade-sl-pips-wrap').classList.toggle('hidden', !isForex);
  document.getElementById('trade-units-wrap').classList.toggle('hidden', !isForex);
  document.getElementById('trade-result-mode-wrap').classList.toggle('hidden', !isForex);
  applyResultMode();
  updateSuggestedUnits();
}

/** Pips vs $ result entry. Non-forex instruments always enter $ directly. */
function applyResultMode() {
  const isForex = document.getElementById('trade-instrument-type').value === 'forex';
  const byPips = isForex && document.getElementById('trade-result-mode').value === 'pips';
  document.getElementById('trade-pips-result-wrap').classList.toggle('hidden', !byPips);
  document.getElementById('trade-pnl-direct-wrap').classList.toggle('hidden', byPips);
}

function updateSuggestedUnits() {
  if (document.getElementById('trade-instrument-type').value !== 'forex') return;
  const balance = currentBalance();
  const riskPct = currentRiskPct() || 0;
  const slPips = parseFloat(document.getElementById('trade-sl-pips').value) || 0;
  if (!riskPct || !slPips) { document.getElementById('trade-units').value = ''; return; }
  const pipDecimal = parseFloat(document.getElementById('trade-pip-decimal').value || 0.0001);
  const units = SizingEngine.computePositionUnits({ balance, riskPct, stopLossPips: slPips, pipDecimal });
  const lots = SizingEngine.unitsToLots(units);
  document.getElementById('trade-units').value = `${lots} lots (${units.toLocaleString()} units)`;
}

// ---------- Settings ----------
function wireSettingsForm() {
  ['settings-base-risk', 'settings-escalation-step', 'settings-max-risk'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateSettingsDollarHints);
  });

  document.getElementById('suggest-defaults-btn').addEventListener('click', () => {
    const winRate = parseFloat(document.getElementById('settings-win-rate').value) / 100;
    const rr = parseFloat(document.getElementById('settings-rr').value);
    const baseRisk = parseFloat(document.getElementById('settings-base-risk').value);
    const startStyle = document.querySelector('input[name="start-style"]:checked').value;

    if (!winRate || winRate <= 0 || winRate >= 1) return showError('settings-error', 'Enter a win rate between 1 and 99.');
    if (!rr || rr <= 0) return showError('settings-error', 'Enter a reward:risk ratio.');
    if (!baseRisk || baseRisk <= 0) return showError('settings-error', 'Enter a base risk %.');
    hideError('settings-error');

    const suggested = SizingEngine.suggestModelDefaults({ winRate, rewardRisk: rr, baseRiskPct: baseRisk, startStyle });
    document.getElementById('settings-base-risk').value = suggested.suggestedBaseRiskPct;
    document.getElementById('settings-loss-trigger').value = suggested.lossCutTrigger;
    document.getElementById('settings-escalation-step').value = suggested.escalationStepPct;
    document.getElementById('settings-max-risk').value = suggested.maxRiskPct;
    updateSettingsDollarHints();
  });

  document.getElementById('use-realized-stats-btn').addEventListener('click', () => {
    const stats = SizingEngine.computeRealizedStats(currentTrades);
    if (stats.winRate !== null) document.getElementById('settings-win-rate').value = Math.round(stats.winRate * 100);
    if (stats.rewardRiskRatio !== null) document.getElementById('settings-rr').value = stats.rewardRiskRatio;
  });

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    hideError('settings-error');
    const name = document.getElementById('settings-account-name').value.trim();
    const startingBalance = parseFloat(document.getElementById('settings-starting-balance').value);
    const baseRisk = parseFloat(document.getElementById('settings-base-risk').value);
    const maxRisk = parseFloat(document.getElementById('settings-max-risk').value);
    const step = parseFloat(document.getElementById('settings-escalation-step').value);
    const trigger = parseInt(document.getElementById('settings-loss-trigger').value, 10);
    const winRatePct = parseFloat(document.getElementById('settings-win-rate').value);
    const rr = parseFloat(document.getElementById('settings-rr').value);
    const pipDecimal = document.getElementById('settings-pip-decimal').value;
    const startStyle = document.querySelector('input[name="start-style"]:checked').value;

    if (!name) return showError('settings-error', 'Give the account a name.');
    if (!startingBalance || startingBalance <= 0) return showError('settings-error', 'Starting balance must be greater than 0.');
    if (!baseRisk || !maxRisk || maxRisk < baseRisk) return showError('settings-error', 'Max risk % must be at or above base risk %.');
    if (!trigger || trigger < 1) return showError('settings-error', 'Loss-cut trigger must be at least 1.');

    const balanceChanged = round2(startingBalance) !== round2(Number(currentAccount.starting_balance));

    const { error: nameErr } = await supa.from('fx_accounts')
      .update({ name, starting_balance: startingBalance })
      .eq('id', currentAccount.id);
    if (nameErr) return showError('settings-error', nameErr.message);

    if (balanceChanged && currentTrades.length > 0) {
      const updates = SizingEngine.recomputeBalances(currentTrades, startingBalance);
      const results = await Promise.all(
        updates.map((u) => supa.from('fx_trades').update({ balance_after: u.balance_after }).eq('id', u.id))
      );
      const failed = results.find((r) => r.error);
      if (failed) return showError('settings-error', `Saved settings, but couldn't fully recalculate trade balances: ${failed.error.message}`);
    }

    const { error } = await supa.from('fx_model_settings').update({
      assumed_win_rate: winRatePct / 100,
      reward_risk_ratio: rr,
      base_risk_pct: baseRisk,
      max_risk_pct: maxRisk,
      escalation_step_pct: step,
      loss_cut_trigger: trigger,
      pip_decimal: pipDecimal,
      start_style: startStyle,
      updated_at: new Date().toISOString(),
    }).eq('account_id', currentAccount.id);

    if (error) return showError('settings-error', error.message);

    await loadAccounts();
    await selectAccount(currentAccount.id);
    showToast(balanceChanged ? 'Settings saved — trade balances recalculated.' : 'Settings saved.');
  });
}

/** Shows each risk percentage in Settings as a dollar amount at today's balance. */
function updateSettingsDollarHints() {
  if (!currentAccount) return;
  const balance = currentBalance();
  const hint = (inputId, hintId, suffix) => {
    const pct = parseFloat(document.getElementById(inputId).value);
    const dollars = SizingEngine.riskPctToAmount(pct, balance);
    document.getElementById(hintId).textContent = dollars === null ? '' : `≈ ${formatMoney(dollars)}${suffix}`;
  };
  hint('settings-base-risk', 'hint-base-risk', ' at today\'s balance');
  hint('settings-escalation-step', 'hint-escalation-step', ' more per confirmed win');
  hint('settings-max-risk', 'hint-max-risk', ' at today\'s balance');
}

function renderSettingsForm() {
  document.getElementById('settings-account-name').value = currentAccount.name;
  document.getElementById('settings-starting-balance').value = currentAccount.starting_balance;
  document.getElementById('settings-win-rate').value = Math.round(currentSettings.assumed_win_rate * 100);
  document.getElementById('settings-rr').value = currentSettings.reward_risk_ratio;
  document.getElementById('settings-base-risk').value = currentSettings.base_risk_pct;
  document.getElementById('settings-loss-trigger').value = currentSettings.loss_cut_trigger;
  document.getElementById('settings-escalation-step').value = currentSettings.escalation_step_pct;
  document.getElementById('settings-max-risk').value = currentSettings.max_risk_pct;
  document.getElementById('settings-pip-decimal').value = currentSettings.pip_decimal || '0.0001';

  const style = currentSettings.start_style || 'modest';
  const radio = document.querySelector(`input[name="start-style"][value="${style}"]`);
  if (radio) radio.checked = true;

  const stats = SizingEngine.computeRealizedStats(currentTrades);
  const callout = document.getElementById('realized-stats-callout');
  const empty = document.getElementById('realized-stats-empty');
  if (stats.decided >= 5) {
    callout.classList.remove('hidden');
    empty.classList.add('hidden');
    const rrText = stats.rewardRiskRatio !== null ? `${stats.rewardRiskRatio}:1` : 'n/a (no losses yet)';
    document.getElementById('realized-stats-summary').textContent =
      `From your ${stats.decided} logged trades: realized win rate ${(stats.winRate * 100).toFixed(1)}%, realized R:R ${rrText}.`;
    const band = SizingEngine.classifyWinRateBand(stats.winRate);
    document.getElementById('realized-stats-band-note').textContent = `${band.label} — ${band.note}`;
  } else {
    callout.classList.add('hidden');
    empty.classList.remove('hidden');
  }

  updateSettingsDollarHints();
}

// ---------- Nav ----------
function wireNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
      document.getElementById(`view-${btn.dataset.view}`).classList.remove('hidden');
    });
  });
}

// ---------- Helpers ----------
function formatMoney(n, signed) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : (signed && v > 0 ? '+' : '');
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function round2(n) { return Math.round(n * 100) / 100; }
function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.remove('hidden'); }
function hideError(id) { document.getElementById(id).classList.add('hidden'); }

let toastTimer = null;
function showToast(message, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.toggle('toast-error', !!isError);
  el.classList.remove('hidden');
  el.hidden = false;
  // Force a reflow so the transition re-triggers on rapid repeat toasts.
  void el.offsetWidth;
  el.classList.add('toast-visible');
  toastTimer = setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => { el.classList.add('hidden'); el.hidden = true; }, 250);
  }, 3200);
}
