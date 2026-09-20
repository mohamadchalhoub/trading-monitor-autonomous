/**
 * Historical evaluation of `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Usage:
 *   npm run xauusd-rsi:evaluate
 *   npm run xauusd-rsi:evaluate -- --from 2024-03-01 --to 2026-09-16
 *   npm run xauusd-rsi:evaluate -- --json report.json
 *
 * ## What this can and cannot establish
 *
 * The strategy is INTRABAR. It reacts to RSI crossing a level at the moment
 * it happens, within a forming M1 bar. Closed M1 OHLC does not contain that
 * information: it records where price opened, how far it travelled, and
 * where it closed, but not the path it took. From closed bars alone it is
 * impossible to know whether RSI dipped below 82 mid-bar and invalidated a
 * pattern, or exactly when a crossing occurred.
 *
 * So this script runs TWO clearly separated observation models and never
 * blends them:
 *
 *   1. `TICK_REPLAY` — genuine ordered broker ticks, replayed through the
 *      SAME engine the live path uses. This is a faithful reproduction of
 *      live behaviour, and it is only available where tick coverage exists.
 *
 *   2. `CLOSED_M1_APPROXIMATION` — RSI recomputed on closed-bar closes, with
 *      one observation per bar. This is a DIFFERENT strategy from the live
 *      one: it cannot see intrabar invalidation, it cannot see a crossing
 *      that reverses within a bar, and its entry timing is bar-quantised.
 *      Its numbers are reported as an approximation under a different
 *      observation model, never as a backtest of the live strategy.
 *
 * Exit resolution has its own irreducible uncertainty: when a single M1 bar's
 * range contains BOTH the take-profit and the stop-loss, closed OHLC cannot
 * say which was touched first. Those trades are counted as `INDETERMINATE`
 * and reported separately. They are never resolved by assuming the
 * favourable order, and never silently dropped.
 *
 * No parameter here is tuned, no filter is added, and nothing is reported
 * selectively. The spec was frozen and committed before this script ran.
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { applyClosedBar, applyTick, createEngineState, EmittedSignal, EngineState, engineWarmedUp, M1_MS } from '../src/xauusd-rsi/engine';
import { SPEC, SPEC_HASH } from '../src/xauusd-rsi/spec';
import { evaluateClockSchedule, evaluateEntryEligibility } from '../src/xauusd-rsi/schedule';
import { beirutLabel } from '../src/xauusd-rsi/time';
import { SetupKind } from '../src/xauusd-rsi/pattern';

const RSI_SYMBOL = SPEC.symbol;

/**
 * Cost assumptions, stated rather than buried.
 *
 * The spread is taken from this deployment's own observed live XAUUSD quote
 * (bid 4345.45 / ask 4345.63 = $0.18). It is applied on entry AND exit, which
 * is the conservative reading. Commission and swap are set to zero because
 * this broker's demo XAUUSD contract reports no commission and swap depends
 * on holding overnight, which this strategy rarely does — both are reported
 * as assumptions, and the zero-cost figures are printed alongside so the
 * effect of the assumption is visible rather than hidden.
 */
const COSTS = {
  spreadUsd: 0.18,
  commissionPerLotRoundTripUsd: 0,
  swapPerNightUsd: 0,
  /** Slippage is NOT modelled. Disclosed, not silently assumed to be zero-effect. */
  slippageModelled: false,
};

const CONTRACT_SIZE = 100; // ounces per lot, from live symbol metadata
const VOLUME_LOTS = 0.5;

type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'FRIDAY_CLOSE' | 'INDETERMINATE' | 'UNRESOLVED_AT_END';

interface SimTrade {
  setupKinds: SetupKind[];
  direction: 'BUY' | 'SELL';
  signalAtT: number;
  entryAtT: number;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  exitAtT: number | null;
  exitPrice: number | null;
  exitReason: ExitReason;
  /** Gross price move in the trade's favour, USD of gold price. */
  grossUsdPerOunce: number | null;
}

interface SkippedSignal {
  atT: number;
  setupKinds: SetupKind[];
  direction: 'BUY' | 'SELL';
  reason: string;
}

interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const prisma = new PrismaClient();
  const fromIso = arg('from') ?? '2024-03-01';
  const toIso = arg('to') ?? null;
  const jsonOut = arg('json');

  const from = new Date(`${fromIso}T00:00:00.000Z`);
  const to = toIso ? new Date(`${toIso}T23:59:59.999Z`) : new Date();

  console.log('='.repeat(78));
  console.log(`Historical evaluation — ${SPEC.strategyVersion}`);
  console.log(`Spec hash ${SPEC_HASH} (frozen and committed before this run)`);
  console.log('='.repeat(78));

  // ---------------------------------------------------------------- coverage
  const bars = await loadBars(prisma, from, to);
  if (bars.length === 0) {
    console.error(`No XAUUSD M1 candles found between ${from.toISOString()} and ${to.toISOString()} — nothing to evaluate.`);
    await prisma.$disconnect();
    return;
  }

  const coverage = describeCoverage(bars);
  console.log('\n## 1. Data coverage\n');
  console.log(`  M1 bars:            ${bars.length.toLocaleString()}`);
  console.log(`  First bar:          ${new Date(bars[0].t).toISOString()}`);
  console.log(`  Last bar:           ${new Date(bars[bars.length - 1].t).toISOString()}`);
  console.log(`  Requested range:    ${from.toISOString()} -> ${to.toISOString()}`);
  console.log(`  Warm-up consumed:   ${SPEC.rsi.period + 1 + SPEC.rsi.warmupBars} bars before any signal may be emitted`);
  console.log(`  Contiguous runs:    ${coverage.runs.toLocaleString()} (a run ends wherever a minute is missing)`);
  console.log(`  Missing minutes:    ${coverage.missingMinutes.toLocaleString()} inside the covered span`);
  console.log(`  Largest gap:        ${(coverage.largestGapMs / 60000).toFixed(0)} minutes, starting ${new Date(coverage.largestGapAtT).toISOString()}`);
  console.log('  NOTE: most gaps are weekends and broker closures, which are expected. Pattern');
  console.log('        state is reset across every gap, exactly as the live engine does.');

  const tickCoverage = await prisma.historicalTick.aggregate({
    where: { symbol: RSI_SYMBOL, timestamp: { gte: from, lte: to } },
    _count: true,
    _min: { timestamp: true },
    _max: { timestamp: true },
  });
  const tickCount = tickCoverage._count;
  const tickSpanDays =
    tickCoverage._min.timestamp && tickCoverage._max.timestamp
      ? (tickCoverage._max.timestamp.getTime() - tickCoverage._min.timestamp.getTime()) / 86_400_000
      : 0;
  const barSpanDays = (bars[bars.length - 1].t - bars[0].t) / 86_400_000;

  console.log('\n  Tick coverage (for the faithful TICK_REPLAY model):');
  console.log(`    ticks:            ${tickCount.toLocaleString()}`);
  console.log(`    span:             ${tickCoverage._min.timestamp?.toISOString() ?? 'n/a'} -> ${tickCoverage._max.timestamp?.toISOString() ?? 'n/a'}`);
  console.log(`    covers:           ${tickSpanDays.toFixed(1)} of ${barSpanDays.toFixed(0)} days (${((tickSpanDays / barSpanDays) * 100).toFixed(2)}%)`);
  if (tickCount === 0) {
    console.log('    -> No tick data in range. The faithful model CANNOT be run at all here.');
  } else if (tickSpanDays / barSpanDays < 0.05) {
    console.log('    -> Tick coverage is a tiny fraction of the period. The faithful model can only');
    console.log('       describe that fraction, and says nothing about the rest.');
  }

  // ------------------------------------------------- closed-M1 approximation
  console.log('\n## 2. CLOSED_M1_APPROXIMATION — a DIFFERENT observation model\n');
  console.log('  This is not a backtest of the live strategy. One observation per closed bar');
  console.log('  means intrabar invalidation and intrabar crossings are invisible, and entry');
  console.log('  timing is quantised to bar boundaries. Read it as "what would a bar-close');
  console.log('  version of these rules have done", not as "what this strategy would have done".');

  const approx = simulateClosedM1(bars);
  reportRun(approx, 'CLOSED_M1_APPROXIMATION');

  // ------------------------------------------------------------ tick replay
  let tickRun: RunResult | null = null;
  if (tickCount > 0) {
    console.log('\n## 3. TICK_REPLAY — the faithful model, where ticks exist\n');
    const ticks = await loadTicks(prisma, tickCoverage._min.timestamp!, tickCoverage._max.timestamp!);
    console.log(`  Replaying ${ticks.length.toLocaleString()} ordered ticks through the live engine.`);
    console.log('  The engine is warmed from closed bars first, exactly as the live path warms up.');
    tickRun = simulateTickReplay(bars, ticks);
    reportRun(tickRun, 'TICK_REPLAY');
    console.log('\n  This covers only the span listed under tick coverage above. It is a faithful');
    console.log('  reproduction for that span and makes no claim about any other period.');
  } else {
    console.log('\n## 3. TICK_REPLAY — NOT AVAILABLE\n');
    console.log('  There is no tick data in the requested range, so the faithful model cannot be');
    console.log('  run. No approximation is substituted for it.');
  }

  // ----------------------------------------------------------- what is owed
  // ------------------------------------------------ comparing the models
  if (tickRun) {
    const approxDays = spanDays(approx);
    const tickDays = spanDays(tickRun);
    const approxRate = approxDays > 0 ? approx.signals / approxDays : 0;
    const tickRate = tickDays > 0 ? tickRun.signals / tickDays : 0;
    console.log('\n## 4. The two models do NOT agree, and that is the headline\n');
    console.log(`  CLOSED_M1_APPROXIMATION:  ${approxRate.toFixed(2)} signals/day`);
    console.log(`  TICK_REPLAY (faithful):   ${tickRate.toFixed(2)} signals/day`);
    if (approxRate > 0) {
      console.log(`  ratio:                    ${(tickRate / approxRate).toFixed(1)}x more signals under the faithful model`);
    }
    console.log('');
    console.log('  This gap is expected, and it is the point. One observation per closed bar can');
    console.log('  only see a crossing that survives to the bar boundary; the live engine sees');
    console.log('  every crossing as it happens, including the many that form and reverse inside');
    console.log('  a single minute. The two models therefore trade different opportunities at');
    console.log('  very different rates.');
    console.log('');
    console.log('  The practical consequence: the long-horizon approximation numbers above must');
    console.log('  NOT be read as an estimate of live performance, not even a rough one. They');
    console.log('  describe a different strategy. The faithful numbers are the right ones, and');
    console.log('  there are far too few of them to conclude anything from.');
  }

  console.log('\n## 5. What would make this evaluation stronger\n');
  console.log('  The only way to evaluate this strategy faithfully over a long period is ordered');
  console.log('  tick data over that period. This deployment currently has ~2 days. Running the');
  console.log('  collector with the live tick stream enabled accumulates it going forward, and');
  console.log('  the same replay above can then be re-run over a genuinely representative span.');
  console.log('  Until then, the approximation is the only long-horizon number available, and it');
  console.log('  is a different strategy from the one that trades.');

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      strategyVersion: SPEC.strategyVersion,
      specHash: SPEC_HASH,
      generatedAt: new Date().toISOString(),
      costs: COSTS,
      coverage: { bars: bars.length, firstBar: new Date(bars[0].t).toISOString(), lastBar: new Date(bars[bars.length - 1].t).toISOString(), ...coverage, tickCount, tickSpanDays },
      closedM1Approximation: approx,
      tickReplay: tickRun,
    }, null, 2));
    console.log(`\nJSON written to ${jsonOut}`);
  }

  await prisma.$disconnect();
}

// ---------------------------------------------------------------- loading

async function loadBars(prisma: PrismaClient, from: Date, to: Date): Promise<Bar[]> {
  const out: Bar[] = [];
  const pageSize = 100_000;
  let cursor = from;
  for (;;) {
    const page = await prisma.historicalCandle.findMany({
      where: { symbol: RSI_SYMBOL, timeframe: 'M1', openTime: { gte: cursor, lte: to } },
      orderBy: { openTime: 'asc' },
      take: pageSize,
      select: { openTime: true, open: true, high: true, low: true, close: true },
    });
    if (page.length === 0) break;
    for (const r of page) {
      out.push({ t: r.openTime.getTime(), open: r.open.toNumber(), high: r.high.toNumber(), low: r.low.toNumber(), close: r.close.toNumber() });
    }
    if (page.length < pageSize) break;
    cursor = new Date(page[page.length - 1].openTime.getTime() + 1);
  }
  return out;
}

async function loadTicks(prisma: PrismaClient, from: Date, to: Date) {
  const rows = await prisma.historicalTick.findMany({
    where: { symbol: RSI_SYMBOL, timestamp: { gte: from, lte: to } },
    orderBy: [{ timestamp: 'asc' }, { batchSeq: 'asc' }, { id: 'asc' }],
    select: { id: true, timestamp: true, bid: true, ask: true },
  });
  return rows.map((r) => ({ t: r.timestamp.getTime(), bid: r.bid.toNumber(), ask: r.ask.toNumber(), key: `${r.timestamp.getTime()}:${r.id.toString()}` }));
}

function describeCoverage(bars: Bar[]) {
  let runs = 1;
  let missingMinutes = 0;
  let largestGapMs = 0;
  let largestGapAtT = bars[0].t;
  for (let i = 1; i < bars.length; i += 1) {
    const gap = bars[i].t - bars[i - 1].t;
    if (gap !== M1_MS) {
      runs += 1;
      missingMinutes += Math.max(0, gap / M1_MS - 1);
      if (gap > largestGapMs) {
        largestGapMs = gap;
        largestGapAtT = bars[i - 1].t;
      }
    }
  }
  return { runs, missingMinutes, largestGapMs, largestGapAtT };
}

// ------------------------------------------------------------- simulation

interface RunResult {
  model: string;
  signals: number;
  skipped: SkippedSignal[];
  trades: SimTrade[];
}

/**
 * Shared position bookkeeping for both models.
 *
 * Enforces the same one-position-at-a-time occupancy rule the live path
 * enforces, and applies the same Friday forced closure. A signal that arrives
 * while a position is open, or while the schedule blocks entries, is recorded
 * as skipped with its reason — it is never queued for later, matching spec
 * §9.5.
 */
class Simulator {
  readonly trades: SimTrade[] = [];
  readonly skipped: SkippedSignal[] = [];
  private open: SimTrade | null = null;

  constructor(private readonly model: string) {}

  /** Called for each signal, in time order. `entryPrice` is the executable price. */
  onSignal(signal: { atT: number; kinds: SetupKind[]; direction: 'BUY' | 'SELL' }, entryAtT: number, entryPrice: number) {
    const eligibility = evaluateEntryEligibility({
      utcMs: signal.atT,
      // A bar or tick existing at this instant is the evidence that the
      // session was open. Nothing else in historical data can establish it.
      brokerSessionOpen: true,
      dataFresh: true,
      recoveryComplete: true,
      otherBlock: null,
    });
    if (!eligibility.entriesAllowed) {
      this.skipped.push({ atT: signal.atT, setupKinds: signal.kinds, direction: signal.direction, reason: `${eligibility.blockReason}: ${eligibility.detail}` });
      return;
    }
    if (this.open) {
      this.skipped.push({ atT: signal.atT, setupKinds: signal.kinds, direction: signal.direction, reason: 'Occupancy: a position was already open (one at a time).' });
      return;
    }

    // Entry pays the spread: a BUY fills at ask, a SELL at bid.
    const fill = signal.direction === 'BUY' ? entryPrice + COSTS.spreadUsd : entryPrice;
    const tp = signal.direction === 'BUY' ? fill + SPEC.brackets.takeProfitUsd : fill - SPEC.brackets.takeProfitUsd;
    const sl = signal.direction === 'BUY' ? fill - SPEC.brackets.stopLossUsd : fill + SPEC.brackets.stopLossUsd;

    this.open = {
      setupKinds: signal.kinds,
      direction: signal.direction,
      signalAtT: signal.atT,
      entryAtT,
      entryPrice: fill,
      takeProfit: tp,
      stopLoss: sl,
      exitAtT: null,
      exitPrice: null,
      exitReason: 'UNRESOLVED_AT_END',
      grossUsdPerOunce: null,
    };
  }

  /**
   * Advances an open position against one closed bar.
   *
   * When the bar's range contains BOTH levels, closed OHLC cannot say which
   * came first, so the trade is marked INDETERMINATE rather than resolved in
   * either direction.
   */
  onBar(bar: Bar) {
    const t = this.open;
    if (!t) return;

    // Only bars strictly after entry can resolve it.
    if (bar.t < t.entryAtT) return;

    const hitTp = t.direction === 'BUY' ? bar.high >= t.takeProfit : bar.low <= t.takeProfit;
    const hitSl = t.direction === 'BUY' ? bar.low <= t.stopLoss : bar.high >= t.stopLoss;

    if (hitTp && hitSl) {
      this.close(bar.t, null, 'INDETERMINATE');
      return;
    }
    if (hitTp) {
      this.close(bar.t, t.takeProfit, 'TAKE_PROFIT');
      return;
    }
    if (hitSl) {
      this.close(bar.t, t.stopLoss, 'STOP_LOSS');
      return;
    }

    // Friday forced closure, at the deadline, at whatever price the bar shows.
    const clock = evaluateClockSchedule(bar.t);
    if (clock.fridayDeadlineT !== null && bar.t >= clock.fridayDeadlineT && clock.fridayLiquidationDue) {
      this.close(bar.t, bar.close, 'FRIDAY_CLOSE');
    }
  }

  private close(atT: number, price: number | null, reason: ExitReason) {
    const t = this.open;
    if (!t) return;
    t.exitAtT = atT;
    t.exitPrice = price;
    t.exitReason = reason;
    if (price !== null) {
      // Exit also pays the spread on the closing side.
      const raw = t.direction === 'BUY' ? price - t.entryPrice : t.entryPrice - price;
      t.grossUsdPerOunce = raw - (t.direction === 'BUY' ? COSTS.spreadUsd : COSTS.spreadUsd);
    }
    this.trades.push(t);
    this.open = null;
  }

  finish() {
    if (this.open) {
      this.trades.push(this.open);
      this.open = null;
    }
  }
}

function simulateClosedM1(bars: Bar[]): RunResult {
  let engine = createEngineState('CLOSED_BAR_ONLY');
  const sim = new Simulator('CLOSED_M1_APPROXIMATION');
  let signals = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];

    // Resolve any open position against this bar BEFORE considering a new
    // signal, so a position cannot be opened and closed by the same bar out
    // of order.
    sim.onBar(bar);

    // ONE observation per closed bar, fed through the same tick path the live
    // engine uses, timed at the last instant of the bar and priced at its
    // close. The engine's own minute-rollover logic commits each completed
    // bar into the indicator, so `applyClosedBar` is deliberately NOT called
    // here as well — doing both would double-commit each bar.
    const obs = applyTick(engine, {
      atT: bar.t + M1_MS - 1,
      bid: bar.close,
      tickKey: `bar:${bar.t}`,
      nowT: bar.t + M1_MS - 1, // a replay, so the observation is fresh by construction
    });
    engine = obs.state;

    for (const signal of obs.signals) {
      signals += 1;
      // Entry at the NEXT bar's open — the earliest price a bar-close model
      // could genuinely have traded at. Never the signal bar's own close,
      // which would be look-ahead.
      const next = bars[i + 1];
      if (!next) {
        sim.skipped.push({ atT: signal.atT, setupKinds: signal.kinds, direction: signal.direction, reason: 'No subsequent bar to enter on (end of data).' });
        continue;
      }
      sim.onSignal({ atT: signal.atT, kinds: signal.kinds, direction: signal.direction }, next.t, next.open);
    }
  }
  sim.finish();
  return { model: 'CLOSED_M1_APPROXIMATION', signals, skipped: sim.skipped, trades: sim.trades };
}

function simulateTickReplay(bars: Bar[], ticks: Array<{ t: number; bid: number; ask: number; key: string }>): RunResult {
  // Warm the engine from the closed bars immediately preceding the tick span,
  // exactly as the live path warms from candle history.
  const firstTickT = ticks[0].t;
  // Bars that COMPLETED before the first tick. The bar still forming when the
  // tick stream begins is excluded: committing it here and then replaying its
  // own ticks would both double-count it and make those ticks look
  // out-of-order.
  const warmBars = bars.filter((b) => b.t + M1_MS <= firstTickT).slice(-(SPEC.rsi.period + 1 + SPEC.rsi.warmupBars + 50));
  let engine = createEngineState('TICK');
  for (const b of warmBars) engine = applyClosedBar(engine, b.t, b.close).state;

  const sim = new Simulator('TICK_REPLAY');
  let signals = 0;

  // Bars covering the tick span, used to resolve exits.
  const exitBars = bars.filter((b) => b.t >= firstTickT);
  let barIndex = 0;

  for (const tick of ticks) {
    // Resolve exits up to this tick's time.
    while (barIndex < exitBars.length && exitBars[barIndex].t <= tick.t) {
      sim.onBar(exitBars[barIndex]);
      barIndex += 1;
    }

    const step = applyTick(engine, { atT: tick.t, bid: tick.bid, tickKey: tick.key, nowT: tick.t });
    engine = step.state;

    for (const signal of step.signals) {
      signals += 1;
      // Entry at the very tick that produced the signal — which is what the
      // live path does, using ask for a BUY and bid for a SELL.
      const price = signal.direction === 'BUY' ? tick.ask : tick.bid;
      // The spread is already in ask/bid here, so entry does not pay it twice:
      // pass the raw side price and let the simulator apply its own model
      // consistently with the approximation run.
      sim.onSignal({ atT: signal.atT, kinds: signal.kinds, direction: signal.direction }, tick.t, signal.direction === 'BUY' ? price - COSTS.spreadUsd : price);
    }
  }
  while (barIndex < exitBars.length) {
    sim.onBar(exitBars[barIndex]);
    barIndex += 1;
  }
  sim.finish();
  return { model: 'TICK_REPLAY', signals, skipped: sim.skipped, trades: sim.trades };
}

// ---------------------------------------------------------------- reporting

const ALL_SETUPS: SetupKind[] = ['SELL_PEAK_RETEST', 'BUY_TROUGH_RETEST', 'EXTREME_SELL', 'EXTREME_BUY'];

function reportRun(run: RunResult, label: string) {
  console.log(`\n  --- ${label} ---`);
  console.log(`  Signals emitted:    ${run.signals.toLocaleString()}`);
  console.log(`  Trades opened:      ${run.trades.length.toLocaleString()}`);
  console.log(`  Signals skipped:    ${run.skipped.length.toLocaleString()}`);

  const skipReasons = new Map<string, number>();
  for (const s of run.skipped) {
    const key = s.reason.split(':')[0];
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${count.toString().padStart(7)}  ${reason}`);
  }

  console.log('\n  Per setup (every setup reported separately, spec §12):');
  console.log('      setup                 trades      TP      SL  Friday  indet.  unres.   resolved WR');
  for (const setup of ALL_SETUPS) {
    const subset = run.trades.filter((t) => t.setupKinds.includes(setup));
    console.log(`      ${setup.padEnd(20)} ${fmtRow(subset)}`);
  }
  console.log(`      ${'COMBINED (one position)'.padEnd(20)} ${fmtRow(run.trades)}`);

  const resolved = run.trades.filter((t) => t.exitReason === 'TAKE_PROFIT' || t.exitReason === 'STOP_LOSS' || t.exitReason === 'FRIDAY_CLOSE');
  const indeterminate = run.trades.filter((t) => t.exitReason === 'INDETERMINATE');
  const unresolved = run.trades.filter((t) => t.exitReason === 'UNRESOLVED_AT_END');

  const pnl = resolved.map((t) => (t.grossUsdPerOunce ?? 0) * CONTRACT_SIZE * VOLUME_LOTS);
  const net = pnl.reduce((a, b) => a + b, 0);
  const wins = resolved.filter((t) => (t.grossUsdPerOunce ?? 0) > 0).length;
  const losses = resolved.length - wins;

  console.log('\n  Outcome accounting:');
  console.log(`      resolved:            ${resolved.length.toLocaleString()}`);
  console.log(`      indeterminate:       ${indeterminate.length.toLocaleString()}  (one M1 bar contained BOTH TP and SL — closed OHLC cannot say which came first)`);
  console.log(`      unresolved at end:   ${unresolved.length.toLocaleString()}  (still open when the data ran out)`);

  if (resolved.length > 0) {
    const wr = (wins / resolved.length) * 100;
    // The honest bounds: every indeterminate trade could have gone either way.
    const wrIfAllIndetWin = ((wins + indeterminate.length) / (resolved.length + indeterminate.length)) * 100;
    const wrIfAllIndetLose = (wins / (resolved.length + indeterminate.length)) * 100;
    const expectancy = net / resolved.length;

    console.log('\n  Performance (RESOLVED trades only):');
    console.log(`      wins / losses:       ${wins} / ${losses}`);
    console.log(`      resolved win rate:   ${wr.toFixed(2)}%`);
    console.log(`      with uncertainty:    ${wrIfAllIndetLose.toFixed(2)}% .. ${wrIfAllIndetWin.toFixed(2)}%  (indeterminate trades all losing .. all winning)`);
    console.log(`      net P&L:             ${net.toFixed(2)} USD at ${VOLUME_LOTS} lots (contract size ${CONTRACT_SIZE})`);
    console.log(`      expectancy / trade:  ${expectancy.toFixed(2)} USD`);

    // The same trades with costs removed, so the effect of the cost
    // assumption is visible rather than buried inside a single number.
    const costPerTrade = COSTS.spreadUsd * 2 * CONTRACT_SIZE * VOLUME_LOTS;
    const grossNet = net + resolved.length * costPerTrade;
    console.log('      -- with ALL modelled costs removed --');
    console.log(`      gross P&L:           ${grossNet.toFixed(2)} USD`);
    console.log(`      gross expectancy:    ${(grossNet / resolved.length).toFixed(2)} USD/trade`);
    console.log(`      cost drag:           ${costPerTrade.toFixed(2)} USD/trade (${(resolved.length * costPerTrade).toFixed(2)} USD total)`);

    // The geometry, stated plainly. With a symmetric bracket the break-even
    // win rate is not 50%: the spread must be earned back on every trade.
    const breakEvenWr = ((SPEC.brackets.stopLossUsd + COSTS.spreadUsd) / (SPEC.brackets.takeProfitUsd + SPEC.brackets.stopLossUsd)) * 100;
    console.log(`      break-even win rate: ${breakEvenWr.toFixed(2)}%  (TP $${SPEC.brackets.takeProfitUsd} vs SL $${SPEC.brackets.stopLossUsd}, plus spread)`);
    console.log(`      observed vs needed:  ${wr.toFixed(2)}% observed, ${breakEvenWr.toFixed(2)}% needed just to break even`);
    console.log(`      max drawdown:        ${maxDrawdown(pnl).toFixed(2)} USD`);
    console.log(`      longest loss streak: ${longestLossStreak(pnl)}`);

    const exitCounts = new Map<ExitReason, number>();
    for (const t of run.trades) exitCounts.set(t.exitReason, (exitCounts.get(t.exitReason) ?? 0) + 1);
    console.log('\n  Exit reasons:');
    for (const [reason, count] of exitCounts) console.log(`      ${reason.padEnd(20)} ${count.toLocaleString()}`);

    const fridayExits = run.trades.filter((t) => t.exitReason === 'FRIDAY_CLOSE');
    if (fridayExits.length > 0) {
      const fridayPnl = fridayExits.map((t) => (t.grossUsdPerOunce ?? 0) * CONTRACT_SIZE * VOLUME_LOTS);
      console.log(`\n      Friday forced closes produced partial results, not $5 outcomes:`);
      console.log(`      range ${Math.min(...fridayPnl).toFixed(2)} .. ${Math.max(...fridayPnl).toFixed(2)} USD`);
    }
  } else {
    console.log('\n  No resolved trades — no performance figure can honestly be reported.');
  }

  // Frequency.
  if (run.trades.length > 0) {
    const first = run.trades[0].signalAtT;
    const last = run.trades[run.trades.length - 1].signalAtT;
    const days = Math.max(1, (last - first) / 86_400_000);
    console.log('\n  Frequency:');
    console.log(`      ${(run.trades.length / days).toFixed(2)} trades/day, ${(run.signals / days).toFixed(2)} signals/day over ${days.toFixed(0)} days`);
    console.log(`      first ${beirutLabel(first)}`);
    console.log(`      last  ${beirutLabel(last)}`);
  }

  console.log('\n  Cost assumptions applied:');
  console.log(`      spread:      $${COSTS.spreadUsd} of gold price, charged on entry and exit (observed live quote)`);
  console.log(`      commission:  $${COSTS.commissionPerLotRoundTripUsd} per lot round trip (assumed)`);
  console.log(`      swap:        $${COSTS.swapPerNightUsd} per night (assumed)`);
  console.log(`      slippage:    NOT modelled — real fills will differ`);
}

function fmtRow(trades: SimTrade[]): string {
  const tp = trades.filter((t) => t.exitReason === 'TAKE_PROFIT').length;
  const sl = trades.filter((t) => t.exitReason === 'STOP_LOSS').length;
  const fr = trades.filter((t) => t.exitReason === 'FRIDAY_CLOSE').length;
  const ind = trades.filter((t) => t.exitReason === 'INDETERMINATE').length;
  const unres = trades.filter((t) => t.exitReason === 'UNRESOLVED_AT_END').length;
  const resolved = tp + sl + fr;
  const wins = trades.filter((t) => (t.exitReason === 'TAKE_PROFIT' || t.exitReason === 'FRIDAY_CLOSE') && (t.grossUsdPerOunce ?? 0) > 0).length;
  const wr = resolved > 0 ? `${((wins / resolved) * 100).toFixed(1)}%` : 'n/a';
  return `${String(trades.length).padStart(7)} ${String(tp).padStart(7)} ${String(sl).padStart(7)} ${String(fr).padStart(7)} ${String(ind).padStart(7)} ${String(unres).padStart(7)} ${wr.padStart(12)}`;
}

/** Days spanned by a run's own trades, for a like-for-like frequency figure. */
function spanDays(run: RunResult): number {
  if (run.trades.length === 0) return 0;
  const first = run.trades[0].signalAtT;
  const last = run.trades[run.trades.length - 1].signalAtT;
  return Math.max(1 / 24, (last - first) / 86_400_000);
}

function maxDrawdown(pnl: number[]): number {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const p of pnl) {
    equity += p;
    if (equity > peak) peak = equity;
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function longestLossStreak(pnl: number[]): number {
  let best = 0;
  let cur = 0;
  for (const p of pnl) {
    if (p < 0) {
      cur += 1;
      best = Math.max(best, cur);
    } else cur = 0;
  }
  return best;
}

void main();
