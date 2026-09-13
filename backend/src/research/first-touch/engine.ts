/**
 * research/first-touch/engine — pure functions only. No Prisma/DB import,
 * no NestJS decorator, no import from `src/trend-breakout/` or
 * `src/autonomous/` other than the one explicitly-approved read-only
 * utility below. Every function takes its price data as an explicit
 * argument and returns a plain value — safe to call twice with the same
 * input and get the same output (required for re-evaluating UNRESOLVED
 * events later with more data — see test scenario 7).
 *
 * The ONLY cross-module import in this file:
 */
import { getBeirutWallClock } from '../../trend-breakout/schedule';
import type {
  ApproachDirection,
  Candle,
  DataGap,
  EntryDirection,
  ExecutionCosts,
  Level,
  LevelHistoryEntry,
  LevelRole,
  LevelZone,
  OutcomeEvent,
  OutcomeResolution,
  ReplacementRule,
  Tick,
  TouchDetectionResult,
  TouchEvent,
} from './types';

// ---------------------------------------------------------------------------
// Eligible window — 04:00:00 inclusive .. 12:00:00 exclusive, Asia/Beirut.
// Deliberately NOT the trend-breakout strategy's own 03:00-12:00 window
// (`ENTRY_WINDOW_START_SECONDS` in schedule.ts) — this study has its own,
// different window per its spec, so it is defined here, independently,
// using the wall-clock hour/minute/second `getBeirutWallClock` returns
// (never a hand-rolled UTC offset).
// ---------------------------------------------------------------------------
const FIRST_TOUCH_WINDOW_START_SECONDS = 4 * 3600;
const FIRST_TOUCH_WINDOW_END_SECONDS = 12 * 3600;

export function isWithinFirstTouchWindow(utcInstant: Date): boolean {
  const { hour, minute, second } = getBeirutWallClock(utcInstant);
  const secondsOfDay = hour * 3600 + minute * 60 + second;
  return secondsOfDay >= FIRST_TOUCH_WINDOW_START_SECONDS && secondsOfDay < FIRST_TOUCH_WINDOW_END_SECONDS;
}

// ---------------------------------------------------------------------------
// Level construction — no-look-ahead invariant enforced here, as code, not
// just as a comment.
// ---------------------------------------------------------------------------

/** Thrown by `createLevel` when `establishedAt` predates the close of its own last confirming candle. Deliberately a REJECT, not a silent clamp — see the throw site for why. */
export class LookAheadViolationError extends Error {}

export interface CreateLevelInput {
  id: string;
  role: LevelRole;
  /** Exactly one of price/zone. */
  price?: number;
  zone?: LevelZone;
  sourceCandles: Candle[];
  establishedAt: Date;
  methodVersion: string;
}

export function createLevel(input: CreateLevelInput): Level {
  const hasPrice = input.price !== undefined;
  const hasZone = input.zone !== undefined;
  if (hasPrice === hasZone) {
    throw new Error(`Level ${input.id}: exactly one of price/zone must be supplied (got ${hasPrice ? 'price' : ''}${hasZone ? 'zone' : ''}${!hasPrice && !hasZone ? 'neither' : ''}).`);
  }
  if (input.sourceCandles.length === 0) {
    throw new Error(`Level ${input.id}: sourceCandles must be non-empty — a level must be confirmed by at least one candle.`);
  }

  const lastConfirmingCloseMs = input.sourceCandles.reduce(
    (max, c) => Math.max(max, c.closeTime.getTime()),
    -Infinity,
  );

  // No-look-ahead invariant: if the detection method needed candles closing
  // AFTER the pivot bar to confirm it, `establishedAt` must be no earlier
  // than the close of the LAST candle the method used. Rejecting (rather
  // than clamping establishedAt forward) is the deliberate choice here:
  // this engine exists to catch exactly this class of bug in whatever
  // level-selection method eventually gets approved, and a silent clamp
  // would hide a caller's off-by-one instead of surfacing it.
  if (input.establishedAt.getTime() < lastConfirmingCloseMs) {
    throw new LookAheadViolationError(
      `Level ${input.id}: establishedAt (${input.establishedAt.toISOString()}) predates the close of its own ` +
        `last confirming candle (${new Date(lastConfirmingCloseMs).toISOString()}) — look-ahead is not allowed.`,
    );
  }

  return {
    id: input.id,
    role: input.role,
    price: input.price,
    zone: input.zone,
    sourceCandles: input.sourceCandles,
    establishedAt: input.establishedAt,
    methodVersion: input.methodVersion,
    history: [],
  };
}

export function getLevelZone(level: Level): LevelZone {
  if (level.zone) return level.zone;
  return { lower: level.price as number, upper: level.price as number };
}

/** "P" — the ideal entry price used for TP/SL math: the level's own price, or its zone's midpoint. */
export function getLevelNominalPrice(level: Level): number {
  if (level.price !== undefined) return level.price;
  const zone = level.zone as LevelZone;
  return (zone.lower + zone.upper) / 2;
}

// ---------------------------------------------------------------------------
// Break/replacement — the engine has NO default rule of its own. Calling
// `applyReplacementRules(level)` with no rules (or none matching this
// level) returns the level unchanged, with empty history — i.e. "never
// replaced" is the default/no-argument behavior, as required.
// ---------------------------------------------------------------------------

export function applyReplacementRules(level: Level, rules: ReplacementRule[] = []): Level {
  const relevant = rules
    .filter((r) => r.levelId === level.id)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const history: LevelHistoryEntry[] = relevant.map((r) =>
    r.type === 'BROKEN'
      ? { type: 'BROKEN', at: r.at, ruleId: r.id, note: r.note }
      : { type: 'REPLACED', at: r.at, ruleId: r.id, replacementLevelId: r.replacementLevelId, note: r.note },
  );

  return { ...level, history };
}

/** A level with no BROKEN/REPLACED history entry at or before `atUtc` is active. Both entry types end the level's identity — a "replaced" level is just as inactive for further touches of the OLD level as a "broken" one. */
export function isLevelActiveAt(level: Level, atUtc: Date): boolean {
  return !level.history.some((h) => h.at.getTime() <= atUtc.getTime());
}

// ---------------------------------------------------------------------------
// First-touch detection.
// ---------------------------------------------------------------------------

function bodyRange(candle: Candle): { low: number; high: number } {
  return { low: Math.min(candle.open, candle.close), high: Math.max(candle.open, candle.close) };
}

function bodyIntersectsZone(candle: Candle, zone: LevelZone): boolean {
  const { low, high } = bodyRange(candle);
  return high >= zone.lower && low <= zone.upper;
}

function findOverlappingGap(gaps: DataGap[], symbol: string, rangeStartUtc: Date, rangeEndUtc: Date): DataGap | null {
  const startMs = rangeStartUtc.getTime();
  const endMs = rangeEndUtc.getTime();
  return (
    gaps.find((g) => g.symbol === symbol && g.start.getTime() < endMs && g.end.getTime() > startMs) ?? null
  );
}

/**
 * Scans a level's ENTIRE monitored lifetime (never reset daily, never reset
 * at 04:00 Beirut) for its one, ever, first-touch event. `candles` should be
 * every candle available for this symbol from `level.establishedAt` onward,
 * in any order (sorted defensively here) — this function does not care
 * whether they fall inside or outside the eligible window; that check
 * happens later, in `buildTouchEvent`, because an outside-window touch
 * still consumes the level's one first-touch event.
 */
export function findFirstTouch(params: {
  level: Level;
  candles: Candle[];
  gaps: DataGap[];
  symbol: string;
}): TouchDetectionResult {
  const { level, gaps, symbol } = params;
  const zone = getLevelZone(level);
  const sourceOpenTimes = new Set(level.sourceCandles.map((c) => c.openTime.getTime()));

  const sorted = [...params.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  // The level's own establishing/confirming candles are never counted as a
  // touch of the level they created, and nothing before establishedAt is
  // eligible either way (no-look-ahead).
  const eligible = sorted.filter(
    (c) => c.openTime.getTime() >= level.establishedAt.getTime() && !sourceOpenTimes.has(c.openTime.getTime()),
  );

  let candidate: Candle | null = null;
  let scanEndReason: 'END_OF_DATA' | 'LEVEL_DEACTIVATED' = 'END_OF_DATA';
  let scannedThroughUtc = level.establishedAt;

  for (const candle of eligible) {
    if (!isLevelActiveAt(level, candle.openTime)) {
      scanEndReason = 'LEVEL_DEACTIVATED';
      break;
    }
    if (bodyIntersectsZone(candle, zone)) {
      candidate = candle;
      break;
    }
    scannedThroughUtc = candle.closeTime;
  }

  const rangeEnd = candidate ? candidate.openTime : scannedThroughUtc;
  const concealingGap = findOverlappingGap(gaps, symbol, level.establishedAt, rangeEnd);

  if (concealingGap) {
    return { status: 'UNKNOWN', touchCandle: candidate, scanEndReason, scannedThroughUtc, concealingGap };
  }
  if (candidate) {
    return { status: 'TOUCHED', touchCandle: candidate, scanEndReason, scannedThroughUtc, concealingGap: null };
  }
  return { status: 'NOT_TOUCHED', touchCandle: null, scanEndReason, scannedThroughUtc, concealingGap: null };
}

/** Walks backward from just before `touchIndex` to find the approach direction — the first candle CLOSE strictly outside the zone. UNKNOWN if every earlier candle's close is already inside the zone (or there is none). */
function determineApproachDirection(sorted: Candle[], touchIndex: number, zone: LevelZone): ApproachDirection {
  for (let i = touchIndex - 1; i >= 0; i--) {
    const close = sorted[i].close;
    if (close > zone.upper) return 'FROM_ABOVE';
    if (close < zone.lower) return 'FROM_BELOW';
  }
  return 'UNKNOWN';
}

/**
 * Entry-direction rule, derived mechanically from (role, approach) — never
 * hardcoded per example. Only the two classical "bounce" geometries have a
 * defined hypothesis: support tested from above (buy the bounce) and
 * resistance tested from below (sell the bounce). The other two geometries
 * (a level breached from the "wrong" side) have no defined trade in this
 * study and correctly yield null — such a TouchEvent is still recorded
 * (the first-touch event itself is real), it simply produces no
 * OutcomeEvent.
 */
export function deriveEntryDirection(role: LevelRole, approach: ApproachDirection): EntryDirection | null {
  if (role === 'SUPPORT' && approach === 'FROM_ABOVE') return 'BUY';
  if (role === 'RESISTANCE' && approach === 'FROM_BELOW') return 'SELL';
  return null;
}

/** True when the touch candle's OPEN already lies beyond the far side of the zone from its approach direction — i.e. price jumped clean over the level rather than trading through it. */
function wasGappedThrough(candle: Candle, zone: LevelZone, approach: ApproachDirection): boolean {
  if (approach === 'FROM_ABOVE') return candle.open < zone.lower;
  if (approach === 'FROM_BELOW') return candle.open > zone.upper;
  return false; // can't reason about a gap without a known approach side
}

/**
 * Packages a confirmed ('TOUCHED') detection into a TouchEvent — resolving
 * the eligible-window check and the role/approach -> entry-direction rule.
 * Returns null for 'NOT_TOUCHED'/'UNKNOWN' rather than fabricate an event
 * from an unconfirmed touch.
 */
export function buildTouchEvent(params: {
  level: Level;
  detection: TouchDetectionResult;
  candles: Candle[];
  symbol: string;
}): TouchEvent | null {
  const { level, detection, symbol } = params;
  if (detection.status !== 'TOUCHED' || !detection.touchCandle) return null;
  const touchCandle = detection.touchCandle;

  const sorted = [...params.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const index = sorted.findIndex((c) => c.openTime.getTime() === touchCandle.openTime.getTime());
  const zone = getLevelZone(level);

  const approachDirection = determineApproachDirection(sorted, index, zone);
  const entryDirection = deriveEntryDirection(level.role, approachDirection);
  const wallClock = getBeirutWallClock(touchCandle.openTime);
  const withinEligibleWindow = isWithinFirstTouchWindow(touchCandle.openTime);
  const idealEntryPrice = getLevelNominalPrice(level);
  const gappedThrough = wasGappedThrough(touchCandle, zone, approachDirection);
  const executableEntryPrice = gappedThrough ? touchCandle.open : idealEntryPrice;

  return {
    id: `touch:${level.id}`,
    levelId: level.id,
    symbol,
    touchTimestampUtc: touchCandle.openTime,
    touchCandle,
    approachDirection,
    entryDirection,
    beirutHour: wallClock.hour,
    beirutYear: wallClock.year,
    withinEligibleWindow,
    idealEntryPrice,
    gappedThrough,
    executableEntryPrice,
  };
}

// ---------------------------------------------------------------------------
// Outcome resolution.
// ---------------------------------------------------------------------------

/** null = ticks covered the segment but showed no crossing; otherwise the resolved WIN/LOSS/AMBIGUOUS. */
function scanTicksForCrossing(
  ticks: Tick[],
  direction: EntryDirection,
  tp: number,
  sl: number,
): { status: 'WIN' | 'LOSS'; atUtc: Date; price: number } | null {
  const sorted = [...ticks].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const tick of sorted) {
    // BUY exits trigger off bid (you'd sell to close), SELL exits off ask (you'd buy to close) — standard MT4/5 convention, matching this project's own broker model.
    const price = direction === 'BUY' ? tick.bid : tick.ask;
    const tpHit = direction === 'BUY' ? price >= tp : price <= tp;
    const slHit = direction === 'BUY' ? price <= sl : price >= sl;
    if (tpHit) return { status: 'WIN', atUtc: tick.timestamp, price };
    if (slHit) return { status: 'LOSS', atUtc: tick.timestamp, price };
  }
  return null;
}

function ticksWithin(ticks: Tick[], startUtc: Date, endUtc: Date): Tick[] {
  return ticks.filter((t) => t.timestamp.getTime() >= startUtc.getTime() && t.timestamp.getTime() < endUtc.getTime());
}

export interface ResolvePriceRaceParams {
  direction: EntryDirection;
  entryPrice: number;
  /** The touch candle's open time — the race looks only at candles/ticks strictly AFTER this instant (the touch candle's own remaining path isn't modeled at intra-candle precision; a deliberate M1-granularity simplification). */
  entryTimeUtc: Date;
  /** Chronological candles (any granularity — M1 is what the study spec calls for) from entry onward. */
  candles: Candle[];
  /** Optional tick coverage, used only to resolve same-candle races and post-entry data gaps. */
  ticks: Tick[];
  gaps: DataGap[];
  symbol: string;
  frozenEndUtc: Date;
}

/**
 * The core TP/SL race, reused unchanged for both the idealized and
 * executable paths (each with its own entry price -> its own TP/SL). Uses
 * candle WICKS (high/low), not bodies — this is a stop/limit order fill
 * model, a deliberately different rule from the body-only first-touch
 * detection above (a real TP/SL order fills the instant price reaches it,
 * it does not wait for a candle to close beyond it).
 */
export function resolvePriceRace(params: ResolvePriceRaceParams): OutcomeResolution {
  const { direction, entryPrice, entryTimeUtc, ticks, symbol, frozenEndUtc } = params;
  const tp = direction === 'BUY' ? entryPrice + 10 : entryPrice - 10;
  const sl = direction === 'BUY' ? entryPrice - 10 : entryPrice + 10;

  const relevantGaps = [...params.gaps]
    .filter((g) => g.symbol === symbol)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const sortedCandles = [...params.candles]
    .filter((c) => c.openTime.getTime() > entryTimeUtc.getTime() && c.openTime.getTime() < frozenEndUtc.getTime())
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

  let worstAdverse = 0;
  const trackAdverse = (price: number) => {
    const adverse = direction === 'BUY' ? entryPrice - price : price - entryPrice;
    if (adverse > worstAdverse) worstAdverse = adverse;
  };

  const finalize = (
    status: 'WIN' | 'LOSS',
    atUtc: Date,
    price: number,
  ): OutcomeResolution => ({
    status,
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: atUtc,
    resolutionPrice: price,
    adverseExcursion: worstAdverse,
    holdingDurationMs: atUtc.getTime() - entryTimeUtc.getTime(),
    raceCandleUtc: null,
    concealingGap: null,
  });

  const indeterminate = (gap: DataGap): OutcomeResolution => ({
    status: 'INDETERMINATE',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc: null,
    concealingGap: gap,
  });

  const ambiguous = (raceCandleUtc: Date): OutcomeResolution => ({
    status: 'AMBIGUOUS',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc,
    concealingGap: null,
  });

  /** Attempts to cross a [start, end) window using ticks. Returns 'resolved' (already finalized into `outcome`), 'clean' (ticks covered it, no crossing — caller should advance past it), or 'unresolved' (no tick coverage — caller must treat as INDETERMINATE). */
  const tryGap = (gap: DataGap, windowEnd: Date): { kind: 'resolved'; outcome: OutcomeResolution } | { kind: 'clean' } | { kind: 'unresolved' } => {
    const coveringTicks = ticksWithin(ticks, gap.start, gap.end.getTime() < windowEnd.getTime() ? gap.end : windowEnd);
    if (coveringTicks.length === 0) return { kind: 'unresolved' };
    const crossing = scanTicksForCrossing(coveringTicks, direction, tp, sl);
    for (const t of coveringTicks) trackAdverse(direction === 'BUY' ? t.bid : t.ask);
    if (crossing) return { kind: 'resolved', outcome: finalize(crossing.status, crossing.atUtc, crossing.price) };
    return { kind: 'clean' };
  };

  let cursor = entryTimeUtc;

  for (const candle of sortedCandles) {
    const gap = findOverlappingGap(relevantGaps, symbol, cursor, candle.openTime);
    if (gap) {
      const result = tryGap(gap, candle.openTime);
      if (result.kind === 'resolved') return result.outcome;
      if (result.kind === 'unresolved') return indeterminate(gap);
      // 'clean' — ticks covering the gap showed no crossing; fall through and keep scanning this candle normally.
    }

    trackAdverse(direction === 'BUY' ? candle.low : candle.high);

    const tpHit = direction === 'BUY' ? candle.high >= tp : candle.low <= tp;
    const slHit = direction === 'BUY' ? candle.low <= sl : candle.high >= sl;

    if (tpHit && slHit) {
      const candleTicks = ticksWithin(ticks, candle.openTime, candle.closeTime);
      if (candleTicks.length > 0) {
        const crossing = scanTicksForCrossing(candleTicks, direction, tp, sl);
        if (crossing) return finalize(crossing.status, crossing.atUtc, crossing.price);
      }
      // Both boundaries in range within one candle and no tick data (or ticks inconclusive) resolves the order — never guess.
      return ambiguous(candle.openTime);
    }
    if (tpHit) return finalize('WIN', candle.openTime, tp);
    if (slHit) return finalize('LOSS', candle.openTime, sl);

    cursor = candle.closeTime;
  }

  // Ran out of candles before a resolution. Check one trailing gap between
  // the last clean point and the frozen-end timestamp.
  const trailingGap = findOverlappingGap(relevantGaps, symbol, cursor, frozenEndUtc);
  if (trailingGap) {
    const result = tryGap(trailingGap, frozenEndUtc);
    if (result.kind === 'resolved') return result.outcome;
    if (result.kind === 'unresolved') return indeterminate(trailingGap);
    // 'clean' falls through to UNRESOLVED below — ticks proved the gap itself was quiet, but no more candle data exists yet.
  }

  return {
    status: 'UNRESOLVED',
    entryPrice,
    tp,
    sl,
    resolvedAtUtc: null,
    resolutionPrice: null,
    adverseExcursion: worstAdverse,
    holdingDurationMs: null,
    raceCandleUtc: null,
    concealingGap: null,
  };
}

/**
 * Builds the full OutcomeEvent for a touch event — idealized and executable
 * paths kept structurally separate, per the spec. Returns null when the
 * touch isn't a valid entry (outside the eligible window, or an atypical
 * approach direction with no defined entryDirection) — no OutcomeEvent
 * exists for those; the TouchEvent itself still stands as the level's
 * (consumed) first-touch record.
 */
export function resolveOutcome(params: {
  touchEvent: TouchEvent;
  level: Level;
  candles: Candle[];
  ticks?: Tick[];
  gaps: DataGap[];
  symbol: string;
  frozenEndUtc: Date;
  executionCosts?: ExecutionCosts;
}): OutcomeEvent | null {
  const { touchEvent, level, candles, gaps, symbol, frozenEndUtc } = params;
  const ticks = params.ticks ?? [];
  if (!touchEvent.withinEligibleWindow || !touchEvent.entryDirection) return null;
  const direction = touchEvent.entryDirection;

  const idealized = resolvePriceRace({
    direction,
    entryPrice: touchEvent.idealEntryPrice,
    entryTimeUtc: touchEvent.touchTimestampUtc,
    candles,
    ticks,
    gaps,
    symbol,
    frozenEndUtc,
  });

  const spread = params.executionCosts?.spreadPriceUnits ?? 0;
  const executableEntryPrice =
    direction === 'BUY' ? touchEvent.executableEntryPrice + spread : touchEvent.executableEntryPrice - spread;

  const executable = resolvePriceRace({
    direction,
    entryPrice: executableEntryPrice,
    entryTimeUtc: touchEvent.touchTimestampUtc,
    candles,
    ticks,
    gaps,
    symbol,
    frozenEndUtc,
  });

  const idealEnd = idealized.resolvedAtUtc ?? frozenEndUtc;
  const executableEnd = executable.resolvedAtUtc ?? frozenEndUtc;

  return {
    id: `outcome:${touchEvent.id}`,
    touchEventId: touchEvent.id,
    levelId: touchEvent.levelId,
    symbol,
    entryDirection: direction,
    idealized,
    executable,
    beirutHour: touchEvent.beirutHour,
    beirutYear: touchEvent.beirutYear,
    role: level.role,
    activeWindow: {
      startUtc: touchEvent.touchTimestampUtc,
      endUtc: idealEnd.getTime() > executableEnd.getTime() ? idealEnd : executableEnd,
    },
  };
}
