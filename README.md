# Cliff FX — Account Manager

A live position-sizing tool built on the "cut-on-loss, scale-on-win" money
management model, parametrized by your win rate and reward:risk ratio
instead of a fixed leverage ladder.

## What it does

- You create an account with a starting balance.
- In **Settings**, you set your assumed win rate and R:R, then hit
  "Suggest settings" to get a starting loss-cut trigger, escalation step,
  and max risk % (editable — these are starting points, not fixed rules).
- In **Trade log**, the app tells you the risk % to use on your next
  trade before you take it, based on your current win/loss streak. You
  log the actual result afterward and it recalculates your balance and
  the next suggestion.
- **Dashboard** shows your equity curve and recent trades at a glance.

## The model (see sizingEngine.js)

- `suggestModelDefaults` — derives a loss-cut trigger, escalation step,
  and max risk % from win rate + R:R. Lower win rate → cut size sooner
  (losing streaks are statistically normal). Higher R:R → bigger
  escalation steps (a single win recovers more). Lower win rate → more
  confirmed wins required before reaching max size (win streaks are
  rarer and more meaningful).
- `computeNextRisk` — looks at the trade history, finds the current
  win/loss streak, and returns the risk % to use next.
- `computePositionUnits` / `computePnl` — converts risk % into a unit
  size given a stop-loss distance in pips, and turns an actual pip
  result into a dollar P&L. Uses the same math as the ICT reference
  case (25,000 units × 20 pips × 0.0001 = $50 risk).

`sizingEngine.js` has no DOM dependencies — it's plain, testable logic.

## Stack

Vanilla HTML/CSS/JS, same pattern as the rental manager, now split across
two pages for security:

- **`index.html`** — the only entry point. Contains *only* the sign-in
  form — no account-manager markup exists in this file at all. On load,
  it checks for a session and redirects to `app.html` if one exists.
- **`app.html`** — the actual account manager (dashboard, trade log,
  settings). Its root element starts with the native HTML `hidden`
  attribute, not just a CSS class, so it's invisible by the browser's
  own default behavior even if `styles.css` fails to load — it doesn't
  depend on CSS to stay hidden. On load, `app.js` checks for a session;
  if there isn't one, it redirects straight back to `index.html` before
  rendering anything.
- **`supabaseClient.js`** — the shared Supabase client, loaded by both
  pages.
- **`auth.js`** — sign-in/sign-up logic for `index.html` only.
- **`sizingEngine.js`** / **`app.js`** — the account manager's logic,
  loaded only by `app.html`.
- **`chart.min.js`**, **`xlsx.min.js`**, **`supabase.min.js`** — Chart.js,
  SheetJS, and the Supabase client, all self-hosted locally rather than
  loaded from a CDN. Ad blockers and privacy extensions commonly block
  CDN script domains; a blocked library used to silently break the
  whole render pipeline (see "Resilience" below), so nothing in this
  app depends on an external CDN being reachable anymore.
- **`styles.css`** — shared by both pages.

Backend is Supabase (Postgres + Auth), in its **own dedicated project**
(`cliff-fx-account-manager`, ref `qepjeigzkzzvipgisvza`) — fully
separate from the rental manager's project. Free tier, $0/month.

- `fx_accounts` — one row per trading account, owned by a user
- `fx_model_settings` — one row per account: win rate, R:R, base/max
  risk %, escalation step, loss-cut trigger, pip decimal
- `fx_trades` — the trade log: pair, direction, stop loss, result,
  pips, risk % used, units, P&L, running balance

Row Level Security is enabled on all three tables — a user can only
see and edit their own accounts, settings, and trades.

## Pip decimal, mixed instruments, and risk entry

Pip decimal is just "how big is one pip in raw price terms" — `0.0001`
for most forex pairs, `0.01` for JPY pairs. It's used to convert between
risk %, position size, and pip distance.

The trade form auto-detects it from whatever you type in the pair field
(anything with "jpy" in it switches to 0.01). For instruments where pips
don't really apply — GOLD, SILVER, US30, US100, USDX, etc. — switch
"Sizing basis" to **Other**, and enter the $ P&L directly instead of
pips. Those trades still count toward your balance, equity curve, and
win rate; they just don't get a suggested position size, since the pip
math doesn't generalize to them.

**Risk entry** also doesn't require exact pips: on any trade (forex or
other), switch "Risk entry" to **$ amount** and type what you actually
risked in dollars (e.g. "SL was $2") — the app converts that into the
% of balance it represents against your current balance, and stores
the %, so it still feeds correctly into the next trade's suggested size.

## Getting existing trade history in

Three ways now, in order of how much manual work they save:

**MT5 report import (recommended for XM/any MT5 broker).** In MT5:
History tab → right-click → **Save as Report** → save the `.xlsx` file.
Trade log → **Import from MT5 report (.xlsx)** → upload it → "Parse
preview" → "Import new trades".

This is safe to do repeatedly with your **full, growing** history —
you don't need to track what's already been imported yourself:

- Every closed position in MT5 has a permanent ticket number. Each
  imported trade stores that as `external_id`, and a database-level
  unique constraint on `(account, external_id)` — not just app logic —
  means the same MT5 position can never be inserted twice for an
  account, even if you re-upload the exact same file or the same
  trade appears in two different exports.
- The preview shows how many positions were in the file, how many were
  already imported (skipped), and how many are actually new — so you
  can just re-export "everything" each time and only the genuinely new
  trades get added.
- New trades are appended from the account's *current* balance,
  continuing the trade number sequence — it picks up after the last
  saved trade rather than recomputing everything from scratch.
- P&L uses MT5's Profit **+ Commission + Swap** combined (verified
  against the actual balance deltas in a real report) — not just the
  Profit column alone, which understates the true result whenever swap
  or commission apply.
- Non-forex instruments (GOLD, indices, etc.) still import correctly —
  pip-based fields (stop distance, pip result, risk %) are just left
  blank for those, same as everywhere else in the app.
- **Deposits, withdrawals, and bonus credits are captured too** — not
  just closed trades. MT5's report has a separate "Deals" ledger that
  records every balance-changing event, including ones with no
  associated trade (a deposit, a bonus credit). These import as their
  own ledger entries (shown as `DEPOSIT` or `CREDIT` in the pair
  column, tagged `breakeven` so they don't affect win rate), merged
  chronologically with your trades.
- **Balance is taken directly from MT5's own numbers, not accumulated
  math.** The report already has an authoritative running balance after
  every single event. The importer uses that directly rather than
  adding the report's P&L on top of whatever the account currently
  shows — which used to double-count deposits if the account's stored
  balance already reflected them from an earlier rough setup. If the
  report's own numbers imply a different starting point than the
  account currently shows, the preview flags it with a clear note
  rather than silently picking one or the other.

**Quick add from a screenshot.** A small spreadsheet-style grid — add
a row per trade, read the values straight off your screen: date, pair,
direction, how much you risked (% or $), result, and the exact P&L. No
pips required, no AI/vision involved. Use this for brokers/platforms
that don't offer a report export, or for the odd trade you didn't get
into an export.

- Rows are sorted by date before saving, so balance accrues in the
  right order regardless of entry order.
- Appends after whatever's already logged, starting from the account's
  current balance.

**Log a trade (one at a time).** The full form, for logging as you go.

## Win rate, R:R, and start style — no longer hardcoded

Two things changed here:

1. **Realized stats replace guesswork.** As you log trades, the
   dashboard shows your *realized* win rate and R:R — computed from
   actual $ P&L, so partial closes and breakevens are reflected
   automatically rather than assumed away. Once you've logged 5+
   decided trades, Settings shows the same numbers with a "Use my
   realized win rate + R:R" button, so the sizing model tunes itself
   to what's actually happening instead of a number you typed in
   before you had data.
2. **Win-rate bands, explained.** Both the dashboard and Settings show
   which band your realized win rate falls into (≤40%, 41–55%, 56–70%,
   >70%) with a plain-language note on what to expect at that level —
   how long losing streaks are statistically normal there — so the
   loss-cut trigger isn't a black box.

**Start style** (Settings → Sizing model) lets you pick between the two
legitimate approaches from the reference case:
- **Modest** — cuts to base risk on the very first loss within your
  band, ramps up slowly. Smoother curve, the best-performing approach
  in the ICT reference case. Default.
- **Aggressive** — higher base risk, tolerates a longer losing streak
  before cutting, ramps to max size faster. Bigger swings both ways.

Neither is "right" — it's a real trade-off between smoothness and
compounding speed, and both are legitimate; only the ICT "what NOT to
do" case (increasing size into a losing streak) is excluded entirely.

## Resilience — one failure can no longer break everything

Previously, all rendering for a view happened in one unbroken chain: if
any single part threw (most notably, Chart.js failing to load because
an ad blocker blocked the CDN), execution stopped right there — so the
trade log table, save confirmations, and everything after the failure
point silently never ran, even though the underlying save to Supabase
had actually succeeded. That's what caused trades to "just sit there"
with no confirmation and not show up in All trades.

Now:
- Chart.js is self-hosted (`chart.min.js`), removing the most common
  cause of that failure outright.
- Dashboard, trade log, and settings each render independently — one
  section failing shows a toast naming which part broke and logs the
  real error to the console, but never blocks the others.
- The equity chart specifically checks that Chart.js actually loaded
  before trying to use it, rather than throwing.

If you ever see a "part of the page failed to load" toast, your data
is safe — check the browser console for the actual error.

## Dollar-first: the recommendation and the result

**Next-trade risk is shown in dollars.** The dashboard's "Next trade —
risk ($)" is the amount to risk if the stop is hit (e.g. `$1.93`), with
the percentage and balance underneath as context. No lot-size
calculation is forced on you. The "Log a trade" form pre-fills that
dollar figure in `$ amount` risk mode.

**Results can be typed as a dollar P&L, not just pips.** "Result entry"
on the trade form defaults to `$ amount` — type what the trade actually
made or lost (negative for a loss). The stop loss in pips is optional in
this mode: if you give one, units are recorded and the pip result is
back-derived for the table; if you leave it blank, those stay blank
rather than being invented. The stop field is no longer pre-filled with
the account default for exactly that reason. Switch "Result entry" to
`Pips` to get the old pip-based flow back.

The form also blocks a Result/P&L contradiction (e.g. "Win" with a
negative amount) so win rate and expectancy can't be silently corrupted
by a mis-click.

If you still want lot sizes for a particular trade, enter a stop in
pips and the form's "Suggested units" field shows lots (1 lot = 100,000
units; most brokers' minimum is 0.01 lot).

## Expectancy and setup tagging

Two additions aimed directly at the actual goal — becoming consistently
profitable, not just tracking that you're trading.

**Expectancy** is a new dashboard stat: average $ result per trade,
accounting for win rate AND payoff size together —
`(win rate × avg win) − (loss rate × avg loss)`. Win rate or R:R alone
can look acceptable while the combination is quietly negative; this is
the one number that answers "is this actually profitable" directly.
Colored red when negative, green when positive.

**Setup tagging** lets you tag each trade with the concept behind it
(Order Block, FVG, Liquidity Sweep, killzone, or your own custom tag)
when logging it — available on both the single-trade form and Quick
Add. The dashboard's new **By setup** panel then breaks win rate and
expectancy down per tag, ranked best-to-worst, so you can see which
parts of your process actually have edge instead of only ever seeing
one blended number. Untagged trades group separately at the bottom
rather than being silently excluded. Trades imported from an MT5
report have no setup info in the source data, so they land in
Untagged — tag them by hand afterward if useful, or just tag going
forward.

## Pre-trade checklist (v1)

A flat, testable first version — deliberately not the full conditional
tree yet. Available on the single-trade "Log a trade" form only (not
Quick Add or MT5 import, since those are backward-looking bulk paths
where this real-time analysis wasn't captured at the time).

- **Weekly/Daily/H4 scenario** — a classification, not a pass/fail:
  Aligned, Counter-weekly, Retracement resumption, or Noise. Tagged on
  the trade so you can later see whether your actual results differ by
  scenario (e.g. Counter-weekly should be losing more, or shouldn't be
  taken at all).
- **9 flat compliance checks** — weekly target defined, liquidity
  sweep/Judas confirmed, real S/R level, impulsive reaction off it,
  valid Order Block/Breaker in the correct discount/premium zone,
  killzone timing, OTE entry, invalidation-based stop, defined
  liquidity target. A live score ("x/9 rules") shows while filling out
  the form, and the same score shows per-trade in the All Trades table
  (colored green/amber/red), with the scenario shown on hover.

Stored as a single `checklist` JSON column (not one column per rule) —
this is deliberate: the rule set and its structure (a decision tree,
not a flat list) are both still being worked out, and JSON lets new
rules or a conditional hierarchy get added later without another
migration or touching existing data.

**Not built yet, on purpose:** the actual tree logic (e.g. Counter-weekly
implying certain later checks don't apply), any UI for adding your own
rules, and any adherence-vs-result analytics (e.g. "does a low score
correlate with losses"). The plan is to log real trades with this flat
version first, then let the real data — not more speculation — drive
what the tree and any deeper analysis should look like.

## Dashboard (v11)

Laid out as a hero card plus KPI cards, in the Cliff FX brand palette
(electric teal as the single accent; muted sage/rust used only for
win/loss; JetBrains Mono for figures). The teal in `styles.css`
(`--accent`) is a close match — set it to the exact hex from your IG cards.

- **Next trade — risk.** Dollars first, with the % and balance as context.
  Below it, the sizer's answer *after* each outcome ("if it wins, next
  risk → $1.69 · 2.50%", "if it loses → …") so the consequence of the next
  trade is visible before you take it. Dollar figures use today's balance.
- **Recent results strip.** Last 8 trades as W/L chips with their
  R-multiple, plus a NEXT marker.
- **KPI cards.** Balance (with peak), Drawdown (current and worst), Win
  rate, Realized R:R, Expectancy per trade.
- **Equity curve.** Balance or Performance %, ranges 1W / 1M / ALL, a
  dashed high-water-mark line, deposits marked as teal dots, and a drawdown
  strip underneath.
- **Settings** shows every risk % as a dollar amount at today's balance.

### Deposits no longer look like performance

Balance jumps when you add money, which would corrupt any drawdown or
"best balance" figure. Performance % and the drawdown strip use a
deposit-neutral index: it starts at 100 and compounds only on each trade's
return (P&L / balance before the trade). Deposits and credits move the
balance but not the index.

### R-multiples

R = pips moved / stop distance when both are known (right for every pair,
no pip value needed); otherwise P&L / dollars risked. Trades with no known
stop and no risk % show `—` rather than a guess.

### Imported risk % fix (non-USD-quoted pairs)

The importer used `units × pip size` as the dollar value of a pip. That is
only true when USD is the quote currency (EURUSD, GBPUSD, AUDUSD, NZDUSD).
For USDCAD, GBPAUD and the JPY pairs it overstated risk — JPY trades showed
hundreds of percent. The pip value is now taken from the trade itself
(|profit| / pips moved, needs at least 3 pips), otherwise risk is left blank.

**Moved stops.** An MT5 report only has the *final* stop. If it sits on the
profit side of the entry (moved to breakeven or trailed), the original risk
is unknown, so stop and risk are left blank and the trade is noted as such.
Going forward the importer detects this exactly; for trades imported
before the fix, sub-3-pip final stops were treated the same way.

Existing imported rows were repaired in place (risk % and, for moved
stops, stop distance only — P&L, balances and results untouched). The
previous values are kept in `fx_trades_risk_repair_backup`.

**Known limit:** a stop trailed *partway* (not to breakeven) can still make
a trade's R look inflated, because the original stop isn't in the report.

## Running it

This is a static site — no build step. Two options:

1. **Locally**: serve the folder with any static file server
   (`npx serve .`) and open it — you'll land on `index.html` (sign in)
   automatically. Opening `app.html` directly with no session just
   bounces you back to `index.html`.
2. **Deploy**: upload all files (`index.html`, `app.html`,
   `styles.css`, `supabaseClient.js`, `auth.js`, `app.js`,
   `sizingEngine.js`, `chart.min.js`, `xlsx.min.js`, `supabase.min.js`)
   to any static host (Vercel, Netlify, Cloudflare Pages, or a plain
   web server) — same folder, same relative paths. No CDN access
   required at all.

Note: opening `index.html` directly via a `file://` URL (double-clicking
it in a file browser) will not work — relative script loading and
Supabase's redirect flow need to be served over `http://` or `https://`,
even locally. Use a static file server.

Sign up with an email + password on first load — Supabase Auth handles
the rest. Since this is for internal use, email confirmation is on by
default; if that's friction, it can be turned off in Supabase Auth
settings.

## Notes / next steps

- Editing an account's starting balance in Settings recalculates every
  logged trade's running balance to stay consistent — it doesn't touch
  each trade's own P&L, only the cumulative balance column.
- The suggested model defaults are heuristics from the thesis, not a
  statistically fitted formula — Start style and the realized-stats
  button give you two ways to steer them, but the numbers underneath
  (Loss-cut trigger, escalation step, max risk %) are always yours to
  hand-edit too.
- Deleting a trade doesn't renumber or recompute the balances of trades
  after it — if you delete a trade partway through history, double-check
  the sequence afterward.
- Security note: `app.html`'s markup is never sent to a browser that
  didn't get there via `index.html`'s redirect, and it's hidden by a
  native HTML attribute rather than only a CSS class, so a CSS load
  failure can't accidentally reveal it. That said, Supabase's Row Level
  Security is still what actually protects the data — the page
  structure being hidden is a UX/defense-in-depth measure, not the
  security boundary itself.
- Not built yet, if useful later: a Monte-Carlo simulator (run the
  model against many random win/loss sequences at your win rate to see
  a range of outcomes, not just one path); multi-user/public access for
  opening this up to the Cliff FX audience.
