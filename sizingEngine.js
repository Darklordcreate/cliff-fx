/**
 * sizingEngine.js
 *
 * Implements the "cut-on-loss / scale-on-win" position-sizing model,
 * parametrized by assumed win rate and reward:risk ratio, per the thesis:
 *
 *  - Lower win rate  -> losing streaks are statistically normal -> cut size
 *    sooner (lower loss-cut trigger).
 *  - Higher R:R      -> a single win recovers more losses -> escalation
 *    steps can be larger without extra risk.
 *  - Lower win rate  -> win streaks are rarer/more meaningful -> require
 *    more confirmed wins before reaching max size (slower ramp).
 *
 * All functions are pure and framework-agnostic so they can be unit tested
 * or reused outside the app.
 */

/**
 * Suggests model defaults from a trader's assumed win rate and R:R.
 * These are *starting points* — editable in Settings, not hardcoded truth.
 *
 * @param {Object} p
 * @param {number} p.winRate       assumed win rate as a fraction, e.g. 0.4
 * @param {number} p.rewardRisk    reward:risk ratio, e.g. 3 for 3:1
 * @param {number} p.baseRiskPct   base risk % per trade, e.g. 2
 * @param {'modest'|'aggressive'} [p.startStyle='modest']
 * @returns {{lossCutTrigger:number, escalationStepPct:number, maxRiskPct:number, winsToMax:number, suggestedBaseRiskPct:number}}
 */
function suggestModelDefaults({ winRate, rewardRisk, baseRiskPct, startStyle = 'modest' }) {
  if (winRate <= 0 || winRate >= 1) throw new Error('winRate must be between 0 and 1 (exclusive)');
  if (rewardRisk <= 0) throw new Error('rewardRisk must be positive');
  if (baseRiskPct <= 0) throw new Error('baseRiskPct must be positive');

  const band = classifyWinRateBand(winRate);
  let lossCutTrigger = band.lossCutTrigger;
  let suggestedBaseRiskPct = baseRiskPct;
  let winsToMaxMultiplier = 1;
  let stepMultiplier = 1;

  if (startStyle === 'aggressive') {
    // Aggressive: tolerates more of a losing streak before cutting, starts
    // from a higher base risk, and ramps to max size faster. Higher
    // variance, bigger swings — matches the ICT "aggressive start" case.
    lossCutTrigger = lossCutTrigger + 1;
    suggestedBaseRiskPct = round2(baseRiskPct * 1.5);
    winsToMaxMultiplier = 0.7;
    stepMultiplier = 1.5;
  }
  // Modest: cuts on the very first loss within its band, starts small,
  // ramps to max size more slowly. Smoother equity curve, matches the
  // ICT reference "best" case. This is the function's default behavior.

  const baseStep = suggestedBaseRiskPct * 0.25;
  const escalationStepPct = round2(baseStep * (rewardRisk / 3) * stepMultiplier);

  const winsToMax = clamp(Math.round(5 * (0.4 / winRate) * winsToMaxMultiplier), 2, 10);

  const maxRiskPct = round2(suggestedBaseRiskPct + escalationStepPct * winsToMax);

  return { lossCutTrigger, escalationStepPct, maxRiskPct, winsToMax, suggestedBaseRiskPct };
}

/**
 * Classifies a win rate into a band with a loss-cut trigger and a plain
 * explanation of what to expect at that win rate (streak behavior).
 * @param {number} winRate fraction, e.g. 0.4
 */
function classifyWinRateBand(winRate) {
  if (winRate <= 0.40) {
    return {
      label: 'Low win rate (≤40%)',
      lossCutTrigger: 1,
      note: 'Losing streaks of 4–5+ trades are statistically normal at this win rate. Cut size after the very first loss so an ordinary streak never turns into a deep drawdown.',
    };
  }
  if (winRate <= 0.55) {
    return {
      label: 'Moderate win rate (41–55%)',
      lossCutTrigger: 2,
      note: '2–3 loss streaks happen regularly here. Cutting after 2 consecutive losses balances protection against a real streak with not overreacting to one bad trade.',
    };
  }
  if (winRate <= 0.70) {
    return {
      label: 'High win rate (56–70%)',
      lossCutTrigger: 3,
      note: 'Losses rarely chain more than 2–3 in a row. Cutting after 3 avoids treating normal noise as a signal something is wrong.',
    };
  }
  return {
    label: 'Very high win rate (>70%)',
    lossCutTrigger: 4,
    note: 'Single losses are mostly noise at this win rate — a streak of 4+ is genuinely rare and worth reacting to. Cutting any sooner wastes edge capture.',
  };
}

/**
 * Converts a dollar risk amount into a % of the given balance.
 * @param {number} amount dollar amount risked
 * @param {number} balance account balance to measure against
 * @returns {number|null}
 */
function riskAmountToPct(amount, balance) {
  if (!balance || balance <= 0 || amount === null || amount === undefined || isNaN(amount)) return null;
  return round2((amount / balance) * 100);
}

/**
 * Converts a risk % into a dollar amount of the given balance — the
 * inverse of riskAmountToPct. The next-trade recommendation is shown in
 * dollars because that's the number you can act on directly, without
 * going through a lot-size calculation.
 * @param {number} pct risk as a percent of balance, e.g. 3
 * @param {number} balance
 * @returns {number|null}
 */
function riskPctToAmount(pct, balance) {
  if (balance === null || balance === undefined || isNaN(balance) || balance <= 0 || pct === null || pct === undefined || isNaN(pct)) return null;
  return round2((pct / 100) * balance);
}

/**
 * Computes realized win rate and reward:risk from actual logged trades.
 * Uses each trade's real $ P&L, so partial closes and breakevens are
 * naturally reflected (no assumption of a "full" win or loss).
 * @param {Array<{result:string, pnl_amount:number}>} trades
 */
function computeRealizedStats(trades) {
  const wins = trades.filter((t) => t.result === 'win');
  const losses = trades.filter((t) => t.result === 'loss');
  const breakevens = trades.filter((t) => t.result === 'breakeven');
  const decided = wins.length + losses.length;

  const winRate = decided > 0 ? wins.length / decided : null;
  const avgWin = wins.length > 0 ? round2(wins.reduce((s, t) => s + Number(t.pnl_amount), 0) / wins.length) : null;
  const avgLoss = losses.length > 0 ? round2(Math.abs(losses.reduce((s, t) => s + Number(t.pnl_amount), 0) / losses.length)) : null;
  const rewardRiskRatio = (avgWin !== null && avgLoss !== null && avgLoss > 0) ? round2(avgWin / avgLoss) : null;

  // Expectancy: average $ result per decided trade, accounting for both
  // win rate AND payoff size together — the number that actually answers
  // "is this profitable", since win rate or R:R alone can look fine while
  // the combination isn't.
  let expectancy = null;
  if (decided > 0) {
    const winRatePart = winRate * (avgWin ?? 0);
    const lossRate = 1 - winRate;
    const lossRatePart = lossRate * (avgLoss ?? 0);
    expectancy = round2(winRatePart - lossRatePart);
  }

  return {
    totalTrades: trades.length,
    decided, wins: wins.length, losses: losses.length, breakevens: breakevens.length,
    winRate, avgWin, avgLoss, rewardRiskRatio, expectancy,
  };
}

/**
 * Breaks down realized stats per setup tag (e.g. "Order Block", "FVG"),
 * so you can see which parts of your process actually have edge rather
 * than only an aggregate. Untagged trades (setup_tag null) and ledger
 * entries (DEPOSIT/CREDIT rows) are grouped separately / excluded.
 * @param {Array} trades
 * @returns {Array<{setup:string, count:number, winRate:number|null, expectancy:number|null}>}
 *   sorted by expectancy descending (best-performing setups first),
 *   untagged trades always last regardless of their number.
 */
function computeStatsBySetup(trades) {
  const realTrades = trades.filter((t) => t.pair !== 'DEPOSIT' && t.pair !== 'CREDIT');
  const groups = new Map();

  for (const t of realTrades) {
    const key = t.setup_tag && t.setup_tag.trim() ? t.setup_tag.trim() : 'Untagged';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const rows = [];
  for (const [setup, groupTrades] of groups.entries()) {
    const stats = computeRealizedStats(groupTrades);
    rows.push({ setup, count: groupTrades.length, winRate: stats.winRate, expectancy: stats.expectancy });
  }

  rows.sort((a, b) => {
    if (a.setup === 'Untagged') return 1;
    if (b.setup === 'Untagged') return -1;
    if (a.expectancy === null) return 1;
    if (b.expectancy === null) return -1;
    return b.expectancy - a.expectancy;
  });

  return rows;
}

/**
 * Builds insertable trade rows from manually-entered "quick add" rows —
 * for backfilling history you can't copy/paste (e.g. transcribing from a
 * screenshot). No pip math: each row supplies its P&L directly, and risk
 * can be entered as either a % of balance or a $ amount.
 *
 * @param {Array<{date:string, pair:string, direction:string, riskMode:'pct'|'dollar', riskValue:number, result:string, pnl:number, setupTag:string, notes:string}>} rows
 * @param {Object} p
 * @param {number} p.startTradeNumber
 * @param {number} p.startingBalance
 */
function buildTradesFromManualRows(rows, { startTradeNumber, startingBalance }) {
  const sorted = [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let balance = startingBalance;
  let num = startTradeNumber;
  const trades = [];

  for (const r of sorted) {
    const pnl = round2(r.pnl);
    const riskPct = r.riskMode === 'dollar' ? riskAmountToPct(r.riskValue, balance) : (r.riskValue !== null && r.riskValue !== undefined && !isNaN(r.riskValue) ? round2(r.riskValue) : null);
    balance = round2(balance + pnl);

    trades.push({
      trade_number: num++,
      trade_date: r.date || null,
      pair: r.pair ? r.pair.toUpperCase() : null,
      direction: r.direction || null,
      stop_loss_pips: null,
      result: r.result,
      pips_result: null,
      risk_pct_used: riskPct,
      position_units: null,
      pnl_amount: pnl,
      balance_after: balance,
      setup_tag: r.setupTag || null,
      notes: r.notes || null,
    });
  }
  return trades;
}



/**
 * Given the trade history (ordered oldest -> newest) and the account's
 * model settings, determines the risk % to use on the NEXT trade, plus
 * the current streak info (for display).
 *
 * @param {Array<{result: 'win'|'loss'|'breakeven', risk_pct_used: number}>} trades
 * @param {Object} settings
 * @param {number} settings.base_risk_pct
 * @param {number} settings.max_risk_pct
 * @param {number} settings.escalation_step_pct
 * @param {number} settings.loss_cut_trigger
 * @returns {{riskPct:number, streakType:'win'|'loss'|null, streakCount:number}}
 */
function computeNextRisk(trades, settings) {
  const base_risk_pct = Number(settings.base_risk_pct);
  const max_risk_pct = Number(settings.max_risk_pct);
  const escalation_step_pct = Number(settings.escalation_step_pct);
  const loss_cut_trigger = Number(settings.loss_cut_trigger);

  if (!trades || trades.length === 0) {
    return { riskPct: base_risk_pct, streakType: null, streakCount: 0 };
  }

  // Walk backward, skipping breakevens, to find the current streak.
  let streakType = null;
  let streakCount = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    const r = trades[i].result;
    if (r === 'breakeven') continue;
    if (streakType === null) {
      streakType = r;
      streakCount = 1;
    } else if (r === streakType) {
      streakCount++;
    } else {
      break;
    }
  }

  if (streakType === null) {
    // Only breakevens so far.
    return { riskPct: base_risk_pct, streakType: null, streakCount: 0 };
  }

  if (streakType === 'loss') {
    const shouldReset = streakCount >= loss_cut_trigger;
    const lastRisk = lastNonBreakevenRisk(trades);
    const riskPct = shouldReset ? base_risk_pct : (lastRisk !== null && lastRisk !== undefined ? Number(lastRisk) : base_risk_pct);
    return { riskPct, streakType, streakCount };
  }

  // Winning streak: escalate from base, capped at max.
  const riskPct = Math.min(base_risk_pct + escalation_step_pct * streakCount, max_risk_pct);
  return { riskPct: round2(riskPct), streakType, streakCount };
}

/** Finds the risk % used on the most recent non-breakeven trade. */
function lastNonBreakevenRisk(trades) {
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].result !== 'breakeven') return trades[i].risk_pct_used;
  }
  return null;
}

/**
 * Converts a risk % of balance into a position size in units, given a
 * stop distance in pips and the pip decimal for the pair (0.0001 for most
 * pairs, 0.01 for JPY pairs).
 *
 * @param {Object} p
 * @param {number} p.balance
 * @param {number} p.riskPct
 * @param {number} p.stopLossPips
 * @param {number} [p.pipDecimal=0.0001]
 * @returns {number} position size in units
 */
function computePositionUnits({ balance, riskPct, stopLossPips, pipDecimal = 0.0001 }) {
  if (stopLossPips <= 0) throw new Error('stopLossPips must be positive');
  const riskAmount = balance * (riskPct / 100);
  return Math.round(riskAmount / (stopLossPips * pipDecimal));
}

/**
 * Computes the $ P&L of a trade from its actual pip result.
 * @param {Object} p
 * @param {number} p.units
 * @param {number} p.pipsResult   signed: positive for profit, negative for loss
 * @param {number} [p.pipDecimal=0.0001]
 */
function computePnl({ units, pipsResult, pipDecimal = 0.0001 }) {
  return round2(units * pipsResult * pipDecimal);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/**
 * Detects the pip decimal for a symbol from its name.
 * Returns null when the instrument isn't a standard 6-letter forex pair
 * (e.g. GOLD, SILVER, US30, US100, USDX) — pip math doesn't cleanly
 * apply to those, and callers should treat pip-based fields as unknown.
 *
 * @param {string} symbol e.g. 'EURUSD', 'gbpjpy'
 * @returns {number|null}
 */
function detectPipDecimal(symbol) {
  if (!symbol) return null;
  const s = symbol.trim().toLowerCase();
  if (!/^[a-z]{6}$/.test(s)) return null;
  return s.includes('jpy') ? 0.01 : 0.0001;
}

/**
 * Recomputes each trade's running balance_after from a (possibly new)
 * starting balance, walking trades in order and accumulating pnl_amount.
 * Used when a user edits an account's starting balance after trades
 * already exist, so history stays internally consistent.
 * @param {Array<{id:string, pnl_amount:number}>} trades ordered by trade_number
 * @param {number} startingBalance
 * @returns {Array<{id:string, balance_after:number}>}
 */
function recomputeBalances(trades, startingBalance) {
  let balance = startingBalance;
  return trades.map((t) => {
    balance = round2(balance + t.pnl_amount);
    return { id: t.id, balance_after: balance };
  });
}

/**
 * Converts a units figure into standard lots (1 lot = 100,000 units) —
 * the number you actually type into a broker's order ticket "Volume"
 * field. Rounded to 3 decimals (0.001 lot = 100 units), which covers
 * micro-lot brokers; most brokers won't accept below 0.01 anyway.
 * @param {number} units
 */
function unitsToLots(units) {
  return Math.round((units / 100000) * 1000) / 1000;
}

/**
 * Extracts the "Positions" table (closed trades) from a raw MT5 report
 * grid — the sheet has several stacked tables (Positions, Orders,
 * Deals, Open Positions, Working Orders, Results) with no separator
 * other than a marker row naming the next section.
 *
 * @param {Array<Array<any>>} sheetRows raw grid, e.g. from
 *   XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
 * @returns {Array<{timeOpen, positionId, symbol, direction, volume, priceOpen, sl, tp, timeClose, priceClose, commission, swap, profit}>}
 */
function extractMt5PositionsRows(sheetRows) {
  const startIdx = sheetRows.findIndex((r) => String(r[0] || '').trim() === 'Positions');
  if (startIdx === -1) return [];

  const rows = [];
  // Data starts two rows below the "Positions" marker (marker, then header).
  for (let i = startIdx + 2; i < sheetRows.length; i++) {
    const r = sheetRows[i];
    const first = r[0];
    if (first === null || first === undefined || first === '') break; // blank row ends the table
    if (typeof first === 'string' && !/^\d{4}\./.test(first.trim())) break; // next section's marker row

    const positionId = r[1];
    const symbol = r[2];
    const type = String(r[3] || '').toLowerCase();
    const volume = parseFloat(r[4]);
    const priceOpen = parseFloat(r[5]);
    const sl = parseFloat(r[6]);
    const priceClose = parseFloat(r[9]);
    const commission = parseFloat(r[10]) || 0;
    const swap = parseFloat(r[11]) || 0;
    const profit = parseFloat(r[12]);

    if (!symbol || isNaN(volume) || isNaN(priceOpen) || isNaN(priceClose) || isNaN(profit)) continue;
    if (!type.includes('buy') && !type.includes('sell')) continue;

    rows.push({
      timeOpen: String(r[0]), positionId: String(positionId), symbol: String(symbol),
      direction: type.includes('buy') ? 'long' : 'short',
      volume, priceOpen, sl: isNaN(sl) ? null : sl, priceClose,
      commission, swap, profit, timeClose: String(r[8]),
    });
  }
  return rows;
}

/**
 * Risk % of the balance at entry, from the stop distance. A pip is worth
 * units x pipSize dollars only when USD is the quote currency (EURUSD,
 * GBPUSD...). For other pairs (USDCAD, GBPAUD, JPY crosses) the pip value
 * is derived from the trade itself (|profit| / pips moved), which needs
 * |pips| >= 3 to be reliable; otherwise the risk is left unknown (null)
 * rather than shown wrong.
 */
function estimateRiskPct({ symbol, units, stopLossPips, pipDecimal, profit, pipsResult, balanceBefore }) {
  if (!balanceBefore || balanceBefore <= 0 || !stopLossPips) return null;
  let usdPerPip = null;
  if (String(symbol).toLowerCase().endsWith('usd')) usdPerPip = units * pipDecimal;
  else if (Math.abs(pipsResult) >= 3 && profit) usdPerPip = Math.abs(profit / pipsResult);
  if (usdPerPip === null || !isFinite(usdPerPip) || usdPerPip <= 0) return null;
  return round2((stopLossPips * usdPerPip / balanceBefore) * 100);
}

/**
 * Builds insertable trade rows from extracted MT5 Positions rows plus
 * balance-ledger rows (deposits/withdrawals/credits from the Deals
 * section), merged into one chronologically correct sequence.
 *
 * Balance is taken directly from MT5's own running "Balance" column
 * (via closingDeals/adjustmentRows) rather than accumulated from the
 * account's currently-stored balance — MT5's report already has an
 * authoritative balance after every event, so re-deriving it risks
 * double-counting whatever the account's stored balance already
 * represents (e.g. if it includes deposits this same report also
 * lists). Using MT5's own numbers directly makes that class of bug
 * impossible rather than something to get right by coincidence.
 *
 * Skips anything whose external_id is already present on the account,
 * so re-uploading a growing full-history report never creates
 * duplicates. Continues the trade_number sequence from what's already
 * saved.
 *
 * @param {Object} p
 * @param {Array} p.positionRows from extractMt5PositionsRows
 * @param {Array} p.closingDeals from extractMt5ClosingDeals — same
 *   trades as positionRows, in the same chronological order, carrying
 *   MT5's own post-trade balance. Must be the same length as
 *   positionRows; if not, the function falls back to accumulating from
 *   startingBalance for trades (adjustments still use their own
 *   ground-truth balance) and flags the mismatch in the result.
 * @param {Array} p.adjustmentRows from extractMt5DealsAdjustments
 * @param {number} p.startTradeNumber
 * @param {number} p.startingBalance current account balance — used
 *   only as a fallback and for the reconciliation check, not as the
 *   base for MT5-sourced balances.
 * @param {Set<string>} p.existingExternalIds already-saved external_ids on this account
 */
function buildTradesFromMt5Report({ positionRows, closingDeals, adjustmentRows, startTradeNumber, startingBalance, existingExternalIds }) {
  const seen = existingExternalIds || new Set();

  // Pair each position with MT5's own post-trade balance by chronological
  // order (verified reliable: both lists represent the same closes, in
  // the same close-time order, since Positions is itself derived from
  // pairing the Deals section's in/out fills).
  const sortedPositions = [...positionRows].sort((a, b) => a.timeClose.localeCompare(b.timeClose));
  const balancesTrustworthy = closingDeals && closingDeals.length === sortedPositions.length;
  const tradeEvents = sortedPositions.map((r, i) => ({
    kind: 'trade', sortTime: r.timeClose, externalId: `position-${r.positionId}`,
    data: r, mt5Balance: balancesTrustworthy ? closingDeals[i].mt5Balance : null,
  }));

  const adjustmentEvents = (adjustmentRows || []).map((r) => ({
    kind: 'adjustment', sortTime: r.time, externalId: `deal-${r.dealId}`,
    data: r, mt5Balance: r.mt5Balance,
  }));

  const allEvents = [...tradeEvents, ...adjustmentEvents].filter((e) => !seen.has(e.externalId));
  const duplicateCount = (positionRows.length + (adjustmentRows || []).length) - allEvents.length;
  allEvents.sort((a, b) => a.sortTime.localeCompare(b.sortTime));

  // Reconciliation check: what balance would MT5's own ledger imply
  // existed right before the first new event? Compared against the
  // account's actual current balance so a mismatch is surfaced rather
  // than silently producing a wrong number either way.
  let reconciliation = null;
  if (allEvents.length > 0 && allEvents[0].mt5Balance !== null) {
    const first = allEvents[0];
    const firstDelta = first.kind === 'adjustment' ? first.data.amount : round2(first.data.profit + first.data.commission + first.data.swap);
    const impliedPriorBalance = round2(first.mt5Balance - firstDelta);
    if (Math.abs(impliedPriorBalance - round2(startingBalance)) > 0.01) {
      reconciliation = { impliedPriorBalance, accountBalance: round2(startingBalance) };
    }
  }

  let balance = startingBalance;
  let num = startTradeNumber;
  const trades = [];

  for (const e of allEvents) {
    if (e.kind === 'adjustment') {
      const r = e.data;
      const amount = round2(r.amount);
      balance = e.mt5Balance !== null && !isNaN(e.mt5Balance) ? e.mt5Balance : round2(balance + amount);
      trades.push({
        trade_number: num++,
        trade_date: r.time.split(' ')[0].replace(/\./g, '-'),
        pair: r.type === 'credit' ? 'CREDIT' : 'DEPOSIT',
        direction: null,
        stop_loss_pips: null,
        result: 'breakeven',
        pips_result: null,
        risk_pct_used: null,
        position_units: null,
        pnl_amount: amount,
        balance_after: balance,
        external_id: e.externalId,
        notes: `${r.type === 'credit' ? 'Credit' : 'Deposit/withdrawal'} from MT5 report — ${r.comment}`,
      });
      continue;
    }

    const r = e.data;
    const pipDecimal = detectPipDecimal(r.symbol);
    const totalPnl = round2(r.profit + r.commission + r.swap);
    const units = pipDecimal ? Math.round(r.volume * 100000) : null;
    const balanceBeforeThisTrade = balance; // for risk % back-derivation, below

    let stopLossPips = null;
    let pipsResult = null;
    let riskPctUsed = null;

    if (pipDecimal) {
      pipsResult = round2(r.direction === 'long'
        ? (r.priceClose - r.priceOpen) / pipDecimal
        : (r.priceOpen - r.priceClose) / pipDecimal);

      // The report only has the FINAL stop. If it sits at/past the entry (on
      // the profit side) the stop was moved to breakeven or trailed, so the
      // original risk is unknown — leave stop/risk blank instead of guessing.
      const stopMoved = r.sl && r.sl > 0 && (r.direction === 'long' ? r.sl >= r.priceOpen : r.sl <= r.priceOpen);
      if (r.sl && r.sl > 0 && !stopMoved) {
        stopLossPips = round2(Math.abs(r.priceOpen - r.sl) / pipDecimal);
        riskPctUsed = estimateRiskPct({
          symbol: r.symbol, units, stopLossPips, pipDecimal,
          profit: r.profit, pipsResult, balanceBefore: balanceBeforeThisTrade,
        });
      }
    }

    const result = totalPnl > 0.001 ? 'win' : totalPnl < -0.001 ? 'loss' : 'breakeven';
    balance = e.mt5Balance !== null && !isNaN(e.mt5Balance) ? e.mt5Balance : round2(balance + totalPnl);

    trades.push({
      trade_number: num++,
      trade_date: r.timeClose.split(' ')[0].replace(/\./g, '-'),
      pair: r.symbol.toUpperCase(),
      direction: r.direction,
      stop_loss_pips: stopLossPips,
      result,
      pips_result: pipsResult,
      risk_pct_used: riskPctUsed,
      position_units: units,
      pnl_amount: totalPnl,
      balance_after: balance,
      external_id: e.externalId,
      notes: `Imported from MT5 report (position ${r.positionId})${pipDecimal && r.sl && r.sl > 0 && stopLossPips === null ? ' — stop was moved to breakeven/profit, original risk unknown' : ''}`,
    });
  }

  return {
    trades, duplicateCount, reconciliation,
    balancesTrustworthy: !!balancesTrustworthy,
    totalParsed: positionRows.length + (adjustmentRows || []).length,
  };
}

/**
 * Extracts the closing ("out") deal for every trade from the Deals
 * section, in chronological order — same set of trades as
 * extractMt5PositionsRows, one-to-one, carrying MT5's own post-trade
 * running balance for each. Used to pair with positionRows by order.
 *
 * @param {Array<Array<any>>} sheetRows raw grid
 * @returns {Array<{time, symbol, profit, mt5Balance}>}
 */
function extractMt5ClosingDeals(sheetRows) {
  const startIdx = sheetRows.findIndex((r) => String(r[0] || '').trim() === 'Deals');
  if (startIdx === -1) return [];

  const rows = [];
  for (let i = startIdx + 2; i < sheetRows.length; i++) {
    const r = sheetRows[i];
    const first = r[0];
    if (first === null || first === undefined || first === '') break;
    if (typeof first === 'string' && !/^\d{4}\./.test(first.trim())) break;

    const type = String(r[3] || '').toLowerCase();
    const direction = String(r[4] || '').toLowerCase();
    if ((type !== 'buy' && type !== 'sell') || direction !== 'out') continue;

    const mt5Balance = parseFloat(r[12]);
    if (isNaN(mt5Balance)) continue;

    rows.push({ time: String(r[0]), symbol: String(r[2]), profit: parseFloat(r[11]), mt5Balance });
  }
  return rows;
}

/**
 * Extracts deposit/withdrawal ("balance") and bonus ("credit") entries
 * from the MT5 report's "Deals" section — trade fill deals (buy/sell
 * type) are skipped here; those come from extractMt5PositionsRows
 * instead, which already nets entry+exit into one row per position.
 *
 * @param {Array<Array<any>>} sheetRows raw grid
 * @returns {Array<{time, dealId, type:'balance'|'credit', amount, comment}>}
 */
function extractMt5DealsAdjustments(sheetRows) {
  const startIdx = sheetRows.findIndex((r) => String(r[0] || '').trim() === 'Deals');
  if (startIdx === -1) return [];

  const rows = [];
  for (let i = startIdx + 2; i < sheetRows.length; i++) {
    const r = sheetRows[i];
    const first = r[0];
    if (first === null || first === undefined || first === '') break;
    if (typeof first === 'string' && !/^\d{4}\./.test(first.trim())) break;

    const type = String(r[3] || '').toLowerCase();
    if (type !== 'balance' && type !== 'credit') continue; // trade fills handled via Positions instead

    const dealId = r[1];
    const amount = parseFloat(r[11]); // "Profit" column holds the deposit/credit amount for these row types
    if (isNaN(amount)) continue;
    const mt5Balance = parseFloat(r[12]); // MT5's own running balance after this event — ground truth

    rows.push({
      time: String(r[0]),
      dealId: String(dealId),
      type,
      amount,
      mt5Balance: isNaN(mt5Balance) ? null : mt5Balance,
      comment: r[13] ? String(r[13]) : (type === 'credit' ? 'Credit' : 'Deposit/withdrawal'),
    });
  }
  return rows;
}

/**
 * The pre-trade rule-adherence checklist (v1, flat). Deliberately not a
 * tree yet — the scenario field captures the Weekly/Daily/H4 branch as
 * a classification, while the rest are flat yes/no compliance checks.
 * Stored as JSON (not individual columns) so new rules or a future
 * conditional hierarchy can be added without another migration.
 */
const CHECKLIST_RULES = [
  { key: 'weekly_target_defined', label: 'Weekly target defined (liquidity zone or swing symmetry)' },
  { key: 'liquidity_sweep', label: 'Genuine liquidity sweep / Judas swing confirmed' },
  { key: 'sr_level_present', label: 'Real support/resistance level identified' },
  { key: 'impulse_from_level', label: 'Impulsive reaction off that level' },
  { key: 'poi_valid', label: 'Order Block/Breaker in correct discount/premium zone' },
  { key: 'killzone_timing', label: 'Entry within a killzone session' },
  { key: 'ote_entry', label: 'Entry within the OTE retracement zone' },
  { key: 'stop_at_invalidation', label: 'Stop placed at structural invalidation, not arbitrary' },
  { key: 'liquidity_target_defined', label: 'Clear draw-on-liquidity target defined' },
];

/** Weekly/Daily/H4 alignment classification — not scored as pass/fail, just tagged. */
const SCENARIO_OPTIONS = [
  { value: 'aligned', label: 'Aligned — Weekly = Daily = H4' },
  { value: 'counter_weekly', label: 'Counter-weekly — Daily & H4 agree, against Weekly (low probability)' },
  { value: 'retracement_resumption', label: 'Retracement resumption — H4 realigns with Weekly, Daily still against (reduced size)' },
  { value: 'noise', label: 'Noise — H4 drift only, no confirmation (should not have been a trade)' },
];

/**
 * Scores a logged checklist against CHECKLIST_RULES.
 * @param {Object|null} checklist
 * @returns {{followed:number, total:number, pct:number}|null}
 */
function computeChecklistScore(checklist) {
  if (!checklist) return null;
  const total = CHECKLIST_RULES.length;
  const followed = CHECKLIST_RULES.filter((r) => checklist[r.key] === true).length;
  return { followed, total, pct: round2((followed / total) * 100) };
}

/** Deposit/credit ledger rows share the trades table but aren't trades. */
function isLedgerRow(t) {
  return t.pair === 'DEPOSIT' || t.pair === 'CREDIT';
}

/**
 * R-multiple per trade: P&L divided by the dollars risked at entry
 * (risk % x balance just before the trade). Ledger rows and trades with
 * no recorded risk % get null rather than a guess.
 * @returns {Array<{trade_number:number, r:number|null}>}
 */
function computeRMultiples(trades, startingBalance) {
  let prevBalance = Number(startingBalance);
  return trades.map((t) => {
    const balanceBefore = prevBalance;
    prevBalance = Number(t.balance_after);
    if (isLedgerRow(t)) return { trade_number: t.trade_number, r: null };
    // Preferred: pips moved / stop distance. Needs no pip value, so it is
    // right for every pair (the stored risk % is not, for non-USD-quoted pairs).
    const stop = Number(t.stop_loss_pips);
    if (stop > 0 && t.pips_result !== null && t.pips_result !== undefined && !isNaN(Number(t.pips_result))) {
      return { trade_number: t.trade_number, r: round2(Number(t.pips_result) / stop) };
    }
    // Fallback: P&L / dollars risked (trades entered in $, with no stop).
    const riskPct = Number(t.risk_pct_used);
    if (!riskPct || riskPct <= 0 || !balanceBefore || balanceBefore <= 0) return { trade_number: t.trade_number, r: null };
    const riskDollars = (riskPct / 100) * balanceBefore;
    return { trade_number: t.trade_number, r: round2(Number(t.pnl_amount) / riskDollars) };
  });
}

/**
 * Deposit-neutral equity series. Each point carries the account balance
 * AND a performance index that starts at 100 and compounds only on
 * trade returns (P&L / balance before the trade). Deposits and credits
 * move the balance but not the index, so drawdown and return measured
 * on the index aren't distorted by money added to the account.
 * @returns {Array<{trade_number, trade_date, balance:number, index:number, ledger:boolean}>}
 */
function computeEquitySeries(trades, startingBalance) {
  let prevBalance = Number(startingBalance);
  let index = 100;
  return trades.map((t) => {
    const balanceBefore = prevBalance;
    const balance = Number(t.balance_after);
    prevBalance = balance;
    const ledger = isLedgerRow(t);
    if (!ledger && balanceBefore > 0) index = index * (1 + Number(t.pnl_amount) / balanceBefore);
    return { trade_number: t.trade_number, trade_date: t.trade_date, balance, index: Math.round(index * 10000) / 10000, ledger };
  });
}

/**
 * Drawdown from the running peak of a numeric series.
 * @param {number[]} values
 * @returns {{drawdowns:number[], maxDrawdownPct:number, currentDrawdownPct:number}}
 *   drawdowns are <= 0 (percent below peak); the two summary numbers are positive magnitudes.
 */
function computeDrawdownSeries(values) {
  let peak = -Infinity;
  let maxDD = 0;
  const drawdowns = values.map((v) => {
    if (v > peak) peak = v;
    const d = peak > 0 ? (v / peak - 1) * 100 : 0;
    if (-d > maxDD) maxDD = -d;
    return round2(d);
  });
  const last = drawdowns.length ? drawdowns[drawdowns.length - 1] : 0;
  return { drawdowns, maxDrawdownPct: round2(maxDD), currentDrawdownPct: round2(-last) };
}

/**
 * Keeps points on or after a calendar cutoff ('1W' = 7 days, '1M' = 30
 * days, 'ALL' = everything), measured back from `today` (YYYY-MM-DD).
 */
function sliceByRange(points, range, today) {
  if (range === 'ALL' || !range) return points;
  const days = range === '1W' ? 7 : range === '1M' ? 30 : null;
  if (days === null) return points;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  const cutoff = d.toISOString().slice(0, 10);
  return points.filter((p) => String(p.trade_date) >= cutoff);
}

/**
 * What the sizer would recommend next, and what it would recommend
 * after a win vs after a loss — so the consequence of the next trade
 * is visible before taking it. Dollar figures use today's balance
 * (the real figure moves with the trade's result).
 */
function previewNextRisk(trades, settings, balance) {
  const current = computeNextRisk(trades, settings);
  const after = (result) => computeNextRisk([...trades, { result, risk_pct_used: current.riskPct }], settings);
  const shape = (r) => ({
    riskPct: r.riskPct, dollars: riskPctToAmount(r.riskPct, balance),
    streakType: r.streakType, streakCount: r.streakCount,
  });
  return { current: shape(current), ifWin: shape(after('win')), ifLoss: shape(after('loss')) };
}

const SizingEngine = {
  suggestModelDefaults,
  computeNextRisk,
  computePositionUnits,
  computePnl,
  detectPipDecimal,
  classifyWinRateBand,
  riskAmountToPct,
  riskPctToAmount,
  computeRealizedStats,
  computeStatsBySetup,
  isLedgerRow,
  estimateRiskPct,
  computeRMultiples,
  computeEquitySeries,
  computeDrawdownSeries,
  sliceByRange,
  previewNextRisk,
  CHECKLIST_RULES,
  SCENARIO_OPTIONS,
  computeChecklistScore,
  buildTradesFromManualRows,
  recomputeBalances,
  unitsToLots,
  extractMt5PositionsRows,
  extractMt5DealsAdjustments,
  extractMt5ClosingDeals,
  buildTradesFromMt5Report,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SizingEngine;
}
if (typeof window !== 'undefined') {
  window.SizingEngine = SizingEngine;
}
