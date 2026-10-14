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

/* ===================================================================
 * THE PLAN — "10/10/20 increment model"
 * All rules live in DEFAULT_PLAN as data, so adding smoothing rules or new
 * stages later is a config change, not a rewrite.
 * =================================================================== */
const DEFAULT_PLAN = {
  version: 1,
  start_date: null,        // YYYY-MM-DD, set when the plan is started
  start_equity: null,      // balance when the plan started
  target: 10000,
  months: 12,
  split_at: 2000,          // equity at which the account is split (a road milestone)
  // The trade template: 10-pip stop, break-even at +10, target +20 (2R).
  trade: {
    stopPips: 10, bePips: 10, targetPips: 20, runnerTargetPips: 40,
    maxStopPips: 12, maxTradesPerWeek: 4, weeklyGoalR: 4, weeklyCapR: -2,
  },
  // Tier 1: fixed-dollar risk steps, each tied to an equity band.
  steps: [
    { id: 'S1', label: 'Step 1', risk: 2, equityTo: 85 },
    { id: 'S2', label: 'Step 2', risk: 3, equityTo: 110 },
    { id: 'S3', label: 'Step 3', risk: 4, equityTo: 130 },
    { id: 'S4', label: 'Step 4', risk: 5, equityTo: 150 },
  ],
  // To move up a step: equity band AND this many trades netting minNetR with no rule breaks.
  // Drop a step if that many trades net dropNetR or worse.
  stepGate: { trades: 10, minNetR: 2, dropNetR: -3 },
  // Tier 2+: risk is a percent of equity (and the swing runner leg is added).
  tiers: [
    { id: 'T2', label: 'Tier 2', equityFrom: 150, riskPct: 3, runner: true },
    { id: 'T3', label: 'Tier 3', equityFrom: 1000, riskPct: 2.5, runner: true },
    { id: 'T4', label: 'Tier 4', equityFrom: 5000, riskPct: 2, runner: true },
  ],
  rules: { riskTolerancePct: 30, minChecklist: 7, blockedScenarios: ['noise', 'counter_weekly'] },
};

/** Merges a saved plan (partial) over the defaults. */
function mergePlan(saved) {
  const p = saved || {};
  const d = DEFAULT_PLAN;
  return {
    ...d, ...p,
    trade: { ...d.trade, ...(p.trade || {}) },
    stepGate: { ...d.stepGate, ...(p.stepGate || {}) },
    rules: { ...d.rules, ...(p.rules || {}) },
    steps: p.steps || d.steps,
    tiers: p.tiers || d.tiers,
  };
}

/** Monday of the week containing dateStr (YYYY-MM-DD), as YYYY-MM-DD. */
function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function addMonthsISO(dateStr, k) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate())).toISOString().slice(0, 10);
}

/**
 * Lot size for a dollar risk. pipValuePerLot is dollars per pip per 1.00 lot
 * (10 for USD-quoted pairs like EURUSD; other pairs differ — read it from MT5).
 * Rounds DOWN to 0.01 so the real risk never exceeds the plan. With runner=true
 * and at least 0.02 lots, splits into a +20 leg (legA) and a runner (legB).
 */
function lotsForRisk({ riskDollars, stopPips, pipValuePerLot = 10, runner = false }) {
  const perLot = stopPips * pipValuePerLot;
  const raw = perLot > 0 ? riskDollars / perLot : 0;
  const total = Math.max(0.01, Math.floor(raw * 100 + 1e-9) / 100);
  const riskActual = round2(total * perLot);
  if (!runner || total < 0.02) return { total, riskActual, legA: total, legB: 0 };
  const legB = Math.floor(total * 100 / 2) / 100;
  return { total, riskActual, legA: round2(total - legB), legB };
}

function planMaxStepIndex(plan, equity) {
  const i = plan.steps.findIndex((s) => equity < s.equityTo);
  return i === -1 ? plan.steps.length - 1 : i;
}

/** Which stage applies for the NEXT trade, given equity and the earned step. */
function planStage(plan, equity, stepIdx) {
  const tiers = plan.tiers;
  if (tiers.length && equity >= tiers[0].equityFrom) {
    let t = tiers[0];
    for (const x of tiers) if (equity >= x.equityFrom) t = x;
    return { kind: 'tier', ...t };
  }
  const idx = Math.min(stepIdx, planMaxStepIndex(plan, equity));
  return { kind: 'step', ...plan.steps[idx], index: idx };
}

function planRiskDollars(stage, equity) {
  return stage.kind === 'step' ? stage.risk : round2((stage.riskPct / 100) * equity);
}

const usd = (v) => `$${Number(v).toFixed(2)}`;
const usd0 = (v) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Replays the logged trades through the plan and returns everything the Plan
 * screen shows: current stage and ticket, this week's meter and stop signal,
 * the step gate, the road, pace against the target path, and a rule audit.
 *
 * Only real trades on/after plan.start_date count (ledger rows never do).
 * Pace is deposit-neutral: it follows the performance index, not the balance.
 */
function evaluatePlan(trades, startingBalance, planIn, today) {
  const plan = mergePlan(planIn);
  if (!plan.start_date || !plan.start_equity) return { started: false, plan };

  const tr = plan.trade, gate = plan.stepGate, rules = plan.rules;
  const rs = computeRMultiples(trades, startingBalance);
  const series = computeEquitySeries(trades, startingBalance);
  let prevBal = Number(startingBalance);
  const rows = trades.map((t, i) => {
    const before = prevBal;
    prevBal = Number(t.balance_after);
    return { t, before, after: prevBal, r: rs[i].r, idx: series[i].index };
  });
  const planRows = rows.filter((x) => !isLedgerRow(x.t) && String(x.t.trade_date) >= plan.start_date);
  const tierStart = plan.tiers.length ? plan.tiers[0].equityFrom : Infinity;

  let stepIdx = 0, stepTrades = [];
  let weekKey = null, weekR = 0, weekCount = 0, weekStop = null;
  const weeks = [];
  const pushWeek = () => {
    if (!weekKey) return;
    weeks.push({ weekStart: weekKey, trades: weekCount, netR: round2(weekR),
      outcome: weekStop || (weekCount >= tr.maxTradesPerWeek ? 'limit' : 'open') });
  };
  const audit = { planTrades: planRows.length, clean: 0, flagged: 0, unverified: 0, noR: 0, flags: [] };

  for (const x of planRows) {
    const wk = weekStartOf(x.t.trade_date);
    if (wk !== weekKey) { pushWeek(); weekKey = wk; weekR = 0; weekCount = 0; weekStop = null; }

    const stage = planStage(plan, x.before, stepIdx);
    const planned = planRiskDollars(stage, x.before);
    const flags = [];

    if (x.t.risk_pct_used !== null && x.t.risk_pct_used !== undefined && planned > 0) {
      const actual = (Number(x.t.risk_pct_used) / 100) * x.before;
      if (Math.abs(actual - planned) / planned > rules.riskTolerancePct / 100) flags.push(`risk ${usd(actual)} vs plan ${usd(planned)}`);
    }
    if (x.t.stop_loss_pips !== null && x.t.stop_loss_pips !== undefined && Number(x.t.stop_loss_pips) > tr.maxStopPips) {
      flags.push(`stop ${Number(x.t.stop_loss_pips)} pips (max ${tr.maxStopPips})`);
    }
    if (weekStop) flags.push('taken after the weekly stop');
    else if (weekCount >= tr.maxTradesPerWeek) flags.push(`more than ${tr.maxTradesPerWeek} trades this week`);
    if (x.t.checklist) {
      const sc = computeChecklistScore(x.t.checklist);
      if (sc && sc.followed < rules.minChecklist) flags.push(`checklist ${sc.followed}/${sc.total}`);
      if ((rules.blockedScenarios || []).includes(x.t.checklist.scenario)) flags.push(`scenario: ${x.t.checklist.scenario}`);
    } else {
      audit.unverified++;
    }

    if (x.r === null) audit.noR++;
    if (flags.length) { audit.flagged++; audit.flags.push({ trade_number: x.t.trade_number, pair: x.t.pair, reasons: flags }); } else audit.clean++;

    weekR += x.r ?? 0;
    weekCount++;
    if (!weekStop) { if (weekR >= tr.weeklyGoalR) weekStop = 'goal'; else if (weekR <= tr.weeklyCapR) weekStop = 'cap'; }

    stepTrades.push({ r: x.r ?? 0, clean: flags.length === 0, trade_number: x.t.trade_number });
    if (x.after < tierStart) {
      const maxIdx = planMaxStepIndex(plan, x.after);
      if (stepIdx > maxIdx) { stepIdx = maxIdx; stepTrades = []; }
      else if (stepTrades.length >= gate.trades) {
        const last = stepTrades.slice(-gate.trades);
        const net = last.reduce((a, c) => a + c.r, 0);
        if (stepIdx < maxIdx && net >= gate.minNetR && last.every((c) => c.clean)) { stepIdx++; stepTrades = []; }
        else if (net <= gate.dropNetR && stepIdx > 0) { stepIdx--; stepTrades = []; }
      }
    } else {
      stepTrades = [];
    }
  }
  pushWeek();

  // ----- current state -----
  const equityNow = rows.length ? rows[rows.length - 1].after : Number(startingBalance);
  const stage = planStage(plan, equityNow, stepIdx);
  const riskNow = planRiskDollars(stage, equityNow);
  const sameWeek = weekKey === weekStartOf(today);
  const wk = sameWeek ? { trades: weekCount, netR: round2(weekR), stop: weekStop } : { trades: 0, netR: 0, stop: null };
  const weekStatus = wk.stop || (wk.trades >= tr.maxTradesPerWeek ? 'limit' : 'open');

  const ticket = {
    riskDollars: riskNow,
    riskPct: equityNow > 0 ? round2((riskNow / equityNow) * 100) : null,
    stopPips: tr.stopPips, bePips: tr.bePips, targetPips: tr.targetPips,
    runnerTargetPips: stage.runner ? tr.runnerTargetPips : null,
    winDollars: round2(riskNow * (tr.targetPips / tr.stopPips)),
    weeklyGoalDollars: round2(tr.weeklyGoalR * riskNow),
    weeklyCapDollars: round2(tr.weeklyCapR * riskNow),
    runner: !!stage.runner,
  };

  // ----- step gate -----
  let gateInfo = null;
  if (stage.kind === 'step') {
    const last = stepTrades.slice(-gate.trades);
    const netR = round2(last.reduce((a, c) => a + c.r, 0));
    const allClean = last.every((c) => c.clean);
    const bandEnd = plan.steps[stage.index].equityTo;
    const isLast = stage.index === plan.steps.length - 1;
    const requirements = isLast
      ? [{ label: `Equity at or above ${usd0(bandEnd)} (Tier 2)`, ok: equityNow >= bandEnd, detail: usd(equityNow) }]
      : [
          { label: `Equity at or above ${usd0(bandEnd)}`, ok: equityNow >= bandEnd, detail: usd(equityNow) },
          { label: `${gate.trades} trades at this step`, ok: stepTrades.length >= gate.trades, detail: `${Math.min(stepTrades.length, gate.trades)}/${gate.trades}` },
          { label: `Net ${gate.minNetR >= 0 ? '+' : ''}${gate.minNetR}R over the last ${gate.trades}`, ok: stepTrades.length >= gate.trades && netR >= gate.minNetR, detail: `${netR >= 0 ? '+' : ''}${netR}R` },
          { label: `No rule breaks in the last ${gate.trades}`, ok: allClean, detail: allClean ? 'clean' : 'a flagged trade' },
        ];
    gateInfo = {
      from: stage.label, to: isLast ? 'Tier 2' : plan.steps[stage.index + 1].label,
      slots: Array.from({ length: gate.trades }, (_, i) => last[i] || null),
      netR, requirements, isLast,
      equityReady: equityNow >= bandEnd,
    };
  }

  // ----- the road -----
  let from = 0;
  const road = [];
  plan.steps.forEach((s) => {
    road.push({ id: s.id, kind: 'step', label: s.label, from, to: s.equityTo,
      rule: `Risk ${usd0(s.risk)} per trade`,
      detail: `Week: +${tr.weeklyGoalR}R = +${usd0(tr.weeklyGoalR * s.risk)} · stop at ${tr.weeklyCapR}R = −${usd0(Math.abs(tr.weeklyCapR) * s.risk)}` });
    from = s.equityTo;
  });
  plan.tiers.forEach((t, i) => {
    const to = i + 1 < plan.tiers.length ? plan.tiers[i + 1].equityFrom : plan.target;
    road.push({ id: t.id, kind: 'tier', label: t.label, from: t.equityFrom, to,
      rule: `Risk ${t.riskPct}% of equity`, detail: t.runner ? `Two legs: +${tr.targetPips} pips and a +${tr.runnerTargetPips} pip runner` : '' });
  });
  if (plan.split_at) road.push({ id: 'SPLIT', kind: 'milestone', label: 'Split the account', from: plan.split_at, to: plan.split_at, rule: usd0(plan.split_at), detail: '' });
  road.push({ id: 'GOAL', kind: 'goal', label: 'Goal', from: plan.target, to: plan.target, rule: usd0(plan.target), detail: '' });
  road.sort((a, b) => a.from - b.from || (a.kind === 'milestone' || a.kind === 'goal' ? 1 : -1) - (b.kind === 'milestone' || b.kind === 'goal' ? 1 : -1));
  const currentPos = road.findIndex((r) => r.id === stage.id);
  road.forEach((r, i) => {
    if (r.kind === 'milestone' || r.kind === 'goal') { r.status = equityNow >= r.from ? 'done' : 'upcoming'; return; }
    r.status = i < currentPos ? 'done' : i === currentPos ? 'current' : 'upcoming';
    r.progress = r.to > r.from ? Math.max(0, Math.min(1, (equityNow - r.from) / (r.to - r.from))) : 1;
  });

  // ----- pace (deposit-neutral) -----
  const startMs = Date.parse(`${plan.start_date}T00:00:00Z`);
  const elapsedMonths = Math.max(0, (Date.parse(`${today}T00:00:00Z`) - startMs) / (30.4375 * 86400000));
  const g = Math.pow(plan.target / plan.start_equity, 1 / plan.months);
  let idxStart = 100;
  for (let i = 0; i < trades.length; i++) { if (String(trades[i].trade_date) < plan.start_date) idxStart = series[i].index; }
  const idxNow = series.length ? series[series.length - 1].index : 100;
  const adjusted = plan.start_equity * (idxNow / idxStart);
  const expected = plan.start_equity * Math.pow(g, elapsedMonths);
  const ratio = expected > 0 ? adjusted / expected : 1;
  const monthsAt = adjusted > 0 ? Math.log(adjusted / plan.start_equity) / Math.log(g) : 0;
  const path = Array.from({ length: plan.months + 1 }, (_, k) => ({ month: k, date: addMonthsISO(plan.start_date, k), equity: round2(plan.start_equity * Math.pow(g, k)) }));
  const actual = [{ x: 0, y: round2(plan.start_equity) }].concat(planRows.map((x) => ({
    x: Math.round(((Date.parse(`${x.t.trade_date}T00:00:00Z`) - startMs) / (30.4375 * 86400000)) * 100) / 100,
    y: round2(plan.start_equity * (x.idx / idxStart)),
  })));
  const pace = {
    adjustedEquity: round2(adjusted), expectedEquity: round2(expected), ratio: round2(ratio),
    monthsAhead: round2(monthsAt - elapsedMonths), elapsedMonths: round2(elapsedMonths),
    monthlyGrowthPct: round2((g - 1) * 100),
    status: ratio >= 0.95 ? 'on' : ratio >= 0.7 ? 'behind' : 'far',
    path, actual,
  };

  return {
    started: true, plan, equityNow, stage, stepIndex: stepIdx, ticket,
    week: { start: weekStartOf(today), ...wk, status: weekStatus, goalR: tr.weeklyGoalR, capR: tr.weeklyCapR, maxTrades: tr.maxTradesPerWeek },
    gate: gateInfo, road, pace, weeks: weeks.slice(-10), audit,
  };
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
  DEFAULT_PLAN,
  mergePlan,
  weekStartOf,
  lotsForRisk,
  evaluatePlan,
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
