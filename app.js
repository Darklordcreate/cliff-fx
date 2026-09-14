// ---------- State ----------
// (supa client comes from supabaseClient.js, loaded before this file)
let currentUser = null;
let accounts = [];
let currentAccount = null;
let currentSettings = null;
let currentTrades = [];
let equityChart = null;

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
  runSafely('settings form', renderSettingsForm);
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
  const balance = currentBalance();
  document.getElementById('stat-balance').textContent = formatMoney(balance);
  document.getElementById('topbar-balance-value').textContent = formatMoney(balance);

  const next = nextRisk();
  document.getElementById('stat-next-risk').textContent = `${next.riskPct.toFixed(2)}%`;

  const units = SizingEngine.computePositionUnits({
    balance,
    riskPct: next.riskPct,
    stopLossPips: currentSettings.default_stop_loss_pips,
    pipDecimal: parseFloat(currentSettings.pip_decimal || 0.0001),
  });
  document.getElementById('stat-next-units-hint').textContent = unitsHint(units, currentSettings.default_stop_loss_pips);

  const streakLabel = next.streakType
    ? `${next.streakCount} ${next.streakType}${next.streakCount > 1 ? 's' : ''} in a row`
    : 'No streak yet';
  document.getElementById('stat-streak').textContent = streakLabel;

  runSafely('realized stats', renderRealizedStats);
  runSafely('by setup', renderBySetup);
  runSafely('equity chart', renderEquityChart);
  runSafely('recent trades', renderRecentTrades);
}

/** Formats a units figure as a hint including the lot-size equivalent, since that's what you actually enter in a broker's order ticket. */
function unitsHint(units, stopLossPips) {
  const lots = SizingEngine.unitsToLots(units);
  let hint = `≈ ${units.toLocaleString()} units (${lots} lots) at a ${stopLossPips}-pip stop`;
  if (lots < 0.01) hint += ' — below most brokers\' 0.01 lot minimum';
  return hint;
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

function renderEquityChart() {
  if (typeof Chart === 'undefined') {
    console.error('Chart.js did not load — equity curve cannot render.');
    return; // runSafely's caller already isolates this from breaking anything else
  }
  const ctx = document.getElementById('equity-chart').getContext('2d');
  const points = [currentAccount.starting_balance, ...currentTrades.map((t) => t.balance_after)];
  const labels = points.map((_, i) => (i === 0 ? 'Start' : `#${i}`));

  if (equityChart) equityChart.destroy();
  equityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: points,
        borderColor: '#5B8DEF',
        backgroundColor: 'rgba(91,141,239,0.08)',
        fill: true,
        tension: 0.15,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#868D99', maxTicksLimit: 8 }, grid: { color: '#262B33' } },
        y: { ticks: { color: '#868D99' }, grid: { color: '#262B33' } },
      },
    },
  });
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

  const next = nextRisk();
  document.getElementById('trade-risk-mode').value = 'pct';
  document.getElementById('trade-risk-value-label').textContent = 'Risk % (this trade)';
  document.getElementById('trade-risk-value').value = next.riskPct.toFixed(2);
  document.getElementById('trade-sl-pips').value = currentSettings.default_stop_loss_pips;
  document.getElementById('trade-date').value = new Date().toISOString().slice(0, 10);
  updateRiskValueHint();
  updateSuggestedUnits();

  const streakNote = next.streakType
    ? `Suggested from ${next.streakCount} ${next.streakType}${next.streakCount > 1 ? 's' : ''} in a row.`
    : 'First trade on this account — using base risk.';
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
    <td><input type="date" class="qa-date" value="${new Date().toISOString().slice(0, 10)}" /></td>
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
      trade_date: tradeDate || new Date().toISOString().slice(0, 10),
      pair: pair || null,
      direction,
      result,
      risk_pct_used: riskPct,
      setup_tag: setupTag || null,
      checklist: checklistIsEmpty ? null : checklist,
      notes: notes || null,
    };

    if (instrumentType === 'forex') {
      const slPips = parseFloat(document.getElementById('trade-sl-pips').value);
      const pipsResult = parseFloat(document.getElementById('trade-pips-result').value);
      const pipDecimal = parseFloat(document.getElementById('trade-pip-decimal').value);

      if (!slPips || slPips <= 0) return showError('trade-form-error', 'Enter a stop loss in pips.');
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
      const pnl = parseFloat(document.getElementById('trade-pnl-direct').value);
      if (isNaN(pnl)) return showError('trade-form-error', 'Enter the $ P&L for this trade.');

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
  document.getElementById('trade-pips-result-wrap').classList.toggle('hidden', !isForex);
  document.getElementById('trade-pnl-direct-wrap').classList.toggle('hidden', isForex);
  updateSuggestedUnits();
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
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
