/**
 * The four entry setups of `xauusd-m1-rsi-retest-extremes-v1`, as a pure,
 * deterministic state machine.
 *
 * Pure on purpose: no clock, no database, no price feed, no scheduling. It
 * is handed one RSI observation at a time, in order, and returns whatever
 * setups fired. Everything about WHETHER a fired signal may become an order
 * — schedule, occupancy, risk, DEMO identity — belongs to the execution
 * layer and is deliberately not visible here, so the rules can be tested
 * exhaustively without a broker, a database or a fake clock.
 *
 * Signals that the execution layer then refuses are still **consumed** here
 * under the normal rearming rules (spec §9.5): a blocked signal is never
 * replayed later. That is why `observe()` advances state identically
 * regardless of what downstream does with its output.
 */
import { SPEC } from './spec';

export type SetupKind = 'SELL_PEAK_RETEST' | 'BUY_TROUGH_RETEST' | 'EXTREME_SELL' | 'EXTREME_BUY';
export type Direction = 'BUY' | 'SELL';

export interface TriggeredSetup {
  kind: SetupKind;
  direction: Direction;
  /** Human-readable justification, carried into the decision record for audit. */
  reason: string;
  /** The RSI level the setup keyed on — the frozen peak/trough, or the extreme crossing level. */
  keyLevel: number;
}

/**
 * `AWAITING_ARM_RESET` is the start-up and post-gap state (spec §8.6, §7's
 * "avoid entering merely because the first reading is already extreme").
 * The engine refuses to claim a peak it never watched form: it must first
 * see RSI back inside the ordinary range before a fresh pattern may arm.
 */
export type RetestPhase = 'AWAITING_ARM_RESET' | 'IDLE' | 'TRACKING_EXTREME' | 'EXTREME_FROZEN' | 'AWAITING_REARM';

export interface RetestState {
  phase: RetestPhase;
  /** Running max (SELL) or min (BUY) while `TRACKING_EXTREME`. */
  runningExtreme: number | null;
  /** The frozen peak (SELL) or trough (BUY) being watched for a retest. */
  frozenExtreme: number | null;
}

export type ExtremePhase = 'AWAITING_RESET' | 'ARMED' | 'DISARMED';

export interface ExtremeState {
  phase: ExtremePhase;
}

export interface PatternState {
  specHash: string;
  sellRetest: RetestState;
  buyRetest: RetestState;
  extremeSell: ExtremeState;
  extremeBuy: ExtremeState;
  /** Previous accepted RSI observation — the `previous` half of every crossing test. */
  previousRsi: number | null;
  /** Timestamp (UTC ms) of that previous observation, for continuity checks. */
  previousAtT: number | null;
  /** Count of observations folded in since the last reset — diagnostics only. */
  observationCount: number;
}

export function createPatternState(specHash: string): PatternState {
  return {
    specHash,
    sellRetest: { phase: 'AWAITING_ARM_RESET', runningExtreme: null, frozenExtreme: null },
    buyRetest: { phase: 'AWAITING_ARM_RESET', runningExtreme: null, frozenExtreme: null },
    extremeSell: { phase: 'AWAITING_RESET' },
    extremeBuy: { phase: 'AWAITING_RESET' },
    previousRsi: null,
    previousAtT: null,
    observationCount: 0,
  };
}

/**
 * Discards everything the engine cannot still vouch for after a gap, a
 * restart or a market closure. Pattern progress is NOT carried across an
 * unobserved interval (spec §8.6) — a peak whose pullback happened while
 * nobody was watching is not a peak this engine may trade.
 */
export function resetPatternState(state: PatternState, specHash: string = state.specHash): PatternState {
  return createPatternState(specHash);
}

export interface ObserveResult {
  state: PatternState;
  triggered: TriggeredSetup[];
  /** Diagnostics for the dashboard and decision audit — never control flow. */
  notes: string[];
}

/**
 * Folds one RSI observation into the state.
 *
 * `canEmit` is the warm-up / freshness gate. When false the state still
 * advances exactly as it otherwise would (so continuity and rearming stay
 * correct) but no setup is allowed to fire. This is what makes warm-up and
 * stale data safe: they suppress signals without corrupting pattern state.
 */
export function observe(params: {
  state: PatternState;
  rsi: number;
  atT: number;
  canEmit: boolean;
}): ObserveResult {
  const { state, rsi, atT, canEmit } = params;
  const notes: string[] = [];
  const triggered: TriggeredSetup[] = [];

  if (!Number.isFinite(rsi)) {
    return { state, triggered: [], notes: [`ignored non-finite RSI ${rsi}`] };
  }

  const prev = state.previousRsi;

  const sellRetest = stepSellRetest(state.sellRetest, prev, rsi, triggered, notes, canEmit);
  const buyRetest = stepBuyRetest(state.buyRetest, prev, rsi, triggered, notes, canEmit);
  const extremeSell = stepExtremeSell(state.extremeSell, prev, rsi, triggered, notes, canEmit);
  const extremeBuy = stepExtremeBuy(state.extremeBuy, prev, rsi, triggered, notes, canEmit);

  return {
    state: {
      ...state,
      sellRetest,
      buyRetest,
      extremeSell,
      extremeBuy,
      previousRsi: rsi,
      previousAtT: atT,
      observationCount: state.observationCount + 1,
    },
    triggered,
    notes,
  };
}

function stepSellRetest(
  s: RetestState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): RetestState {
  const t = SPEC.thresholds;

  switch (s.phase) {
    case 'AWAITING_ARM_RESET':
      // Must be seen at or below Sell 2 before a fresh pattern may arm, so
      // the running maximum is one this engine actually watched from the start.
      if (rsi <= t.sell2) return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      return s;

    case 'IDLE':
      if (rsi > t.sell2) {
        notes.push(`SELL retest armed: RSI ${fmt(rsi)} rose above Sell 2 (${t.sell2})`);
        return { phase: 'TRACKING_EXTREME', runningExtreme: rsi, frozenExtreme: null };
      }
      return s;

    case 'TRACKING_EXTREME': {
      // Invalidation is checked FIRST: a drop straight through Sell 1 kills
      // the pattern rather than freezing a peak on the way down.
      if (rsi < t.sell1) {
        notes.push(`SELL retest invalidated while tracking: RSI ${fmt(rsi)} fell below Sell 1 (${t.sell1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const runningMax = s.runningExtreme ?? rsi;
      if (rsi > runningMax) return { ...s, runningExtreme: rsi };
      // Equal readings extend the plateau; only a STRICTLY lower one confirms
      // the reversal and freezes the peak (spec §4).
      if (rsi === runningMax) return s;
      notes.push(`SELL peak frozen at ${fmt(runningMax)} (first strictly lower reading ${fmt(rsi)})`);
      return { phase: 'EXTREME_FROZEN', runningExtreme: null, frozenExtreme: runningMax };
    }

    case 'EXTREME_FROZEN': {
      if (rsi < t.sell1) {
        notes.push(`SELL retest invalidated: RSI ${fmt(rsi)} fell below Sell 1 (${t.sell1}) before returning to the peak`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const peak = s.frozenExtreme as number;
      if (prev !== null && prev < peak && rsi >= peak) {
        if (canEmit) {
          triggered.push({
            kind: 'SELL_PEAK_RETEST',
            direction: 'SELL',
            keyLevel: peak,
            reason: `RSI returned to its frozen peak ${fmt(peak)} (previous ${fmt(prev)}, current ${fmt(rsi)}) without having fallen below Sell 1 (${t.sell1})`,
          });
        } else {
          notes.push(`SELL retest condition met at peak ${fmt(peak)} but emission is suppressed (warm-up or stale data); consumed, not queued`);
        }
        // Consumed either way — a suppressed signal is never replayed later.
        return { phase: 'AWAITING_REARM', runningExtreme: null, frozenExtreme: null };
      }
      return s;
    }

    case 'AWAITING_REARM':
      if (rsi < t.sell1) {
        notes.push(`SELL retest rearmed: RSI ${fmt(rsi)} fell below Sell 1 (${t.sell1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;
  }
}

function stepBuyRetest(
  s: RetestState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): RetestState {
  const t = SPEC.thresholds;

  switch (s.phase) {
    case 'AWAITING_ARM_RESET':
      if (rsi >= t.buy2) return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      return s;

    case 'IDLE':
      if (rsi < t.buy2) {
        notes.push(`BUY retest armed: RSI ${fmt(rsi)} fell below Buy 2 (${t.buy2})`);
        return { phase: 'TRACKING_EXTREME', runningExtreme: rsi, frozenExtreme: null };
      }
      return s;

    case 'TRACKING_EXTREME': {
      if (rsi > t.buy1) {
        notes.push(`BUY retest invalidated while tracking: RSI ${fmt(rsi)} rose above Buy 1 (${t.buy1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const runningMin = s.runningExtreme ?? rsi;
      if (rsi < runningMin) return { ...s, runningExtreme: rsi };
      if (rsi === runningMin) return s;
      notes.push(`BUY trough frozen at ${fmt(runningMin)} (first strictly higher reading ${fmt(rsi)})`);
      return { phase: 'EXTREME_FROZEN', runningExtreme: null, frozenExtreme: runningMin };
    }

    case 'EXTREME_FROZEN': {
      if (rsi > t.buy1) {
        notes.push(`BUY retest invalidated: RSI ${fmt(rsi)} rose above Buy 1 (${t.buy1}) before returning to the trough`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      const trough = s.frozenExtreme as number;
      if (prev !== null && prev > trough && rsi <= trough) {
        if (canEmit) {
          triggered.push({
            kind: 'BUY_TROUGH_RETEST',
            direction: 'BUY',
            keyLevel: trough,
            reason: `RSI returned to its frozen trough ${fmt(trough)} (previous ${fmt(prev)}, current ${fmt(rsi)}) without having risen above Buy 1 (${t.buy1})`,
          });
        } else {
          notes.push(`BUY retest condition met at trough ${fmt(trough)} but emission is suppressed (warm-up or stale data); consumed, not queued`);
        }
        return { phase: 'AWAITING_REARM', runningExtreme: null, frozenExtreme: null };
      }
      return s;
    }

    case 'AWAITING_REARM':
      if (rsi > t.buy1) {
        notes.push(`BUY retest rearmed: RSI ${fmt(rsi)} rose above Buy 1 (${t.buy1})`);
        return { phase: 'IDLE', runningExtreme: null, frozenExtreme: null };
      }
      return s;
  }
}

function stepExtremeSell(
  s: ExtremeState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): ExtremeState {
  const level = SPEC.thresholds.extremeSellCross;

  if (s.phase === 'AWAITING_RESET' || s.phase === 'DISARMED') {
    // Requires RSI to be outside the extreme region before it can fire again
    // — simply REMAINING extreme can never produce repeated orders (spec §6).
    if (rsi < level) return { phase: 'ARMED' };
    return s;
  }

  // ARMED
  if (prev !== null && prev < level && rsi >= level) {
    if (canEmit) {
      triggered.push({
        kind: 'EXTREME_SELL',
        direction: 'SELL',
        keyLevel: level,
        reason: `RSI crossed into the extreme-SELL region (previous ${fmt(prev)} < ${level}, current ${fmt(rsi)} >= ${level}); no peak retest required`,
      });
    } else {
      notes.push(`extreme SELL crossing at ${fmt(rsi)} suppressed (warm-up or stale data); consumed, not queued`);
    }
    return { phase: 'DISARMED' };
  }
  return s;
}

function stepExtremeBuy(
  s: ExtremeState,
  prev: number | null,
  rsi: number,
  triggered: TriggeredSetup[],
  notes: string[],
  canEmit: boolean,
): ExtremeState {
  const level = SPEC.thresholds.extremeBuyCross;

  if (s.phase === 'AWAITING_RESET' || s.phase === 'DISARMED') {
    if (rsi > level) return { phase: 'ARMED' };
    return s;
  }

  if (prev !== null && prev > level && rsi <= level) {
    if (canEmit) {
      triggered.push({
        kind: 'EXTREME_BUY',
        direction: 'BUY',
        keyLevel: level,
        reason: `RSI crossed into the extreme-BUY region (previous ${fmt(prev)} > ${level}, current ${fmt(rsi)} <= ${level}); no trough retest required`,
      });
    } else {
      notes.push(`extreme BUY crossing at ${fmt(rsi)} suppressed (warm-up or stale data); consumed, not queued`);
    }
    return { phase: 'DISARMED' };
  }
  return s;
}

/**
 * Collapses same-observation triggers into ONE decision per direction
 * (spec §6): "If multiple same-direction setups trigger on one observation,
 * create one decision with all applicable reasons and consume those events."
 *
 * Opposite-direction triggers on a single observation are arithmetically
 * impossible (no RSI value is simultaneously >= 98 and <= 1.5, nor both
 * above a >91 peak and below a <8.9 trough), so encountering one means the
 * state machine is broken — it throws rather than guessing a direction.
 */
export function collapseToSingleDecision(triggered: readonly TriggeredSetup[]): {
  direction: Direction;
  kinds: SetupKind[];
  reason: string;
} | null {
  if (triggered.length === 0) return null;
  const directions = new Set(triggered.map((s) => s.direction));
  if (directions.size > 1) {
    throw new Error(
      `xauusd-rsi: opposite-direction setups fired on one observation (${triggered.map((s) => `${s.kind}:${s.direction}`).join(', ')}) — this is arithmetically impossible under the spec and indicates a state-machine defect.`,
    );
  }
  const direction = triggered[0].direction;
  return {
    direction,
    kinds: triggered.map((s) => s.kind),
    reason: triggered.map((s) => `[${s.kind}] ${s.reason}`).join(' | '),
  };
}

function fmt(n: number): string {
  return n.toFixed(4);
}
