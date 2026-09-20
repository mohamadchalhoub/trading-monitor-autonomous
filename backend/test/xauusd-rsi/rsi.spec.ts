/**
 * MT5-compatible Wilder RSI(5) — seeding, smoothing, the zero-loss
 * convention, and intrabar projection (spec §8.1).
 *
 * The reference numbers below are computed by hand from Wilder's own
 * definition and written into the test, rather than snapshotted from this
 * implementation's output — a snapshot of the code under test proves only
 * that it still does what it did.
 */
import { describe, expect, it } from 'vitest';
import {
  commitClosedBar,
  createRsiState,
  currentRsi,
  isWarmedUp,
  projectRsi,
  rsiFromAverages,
  rsiSeries,
} from '../../src/xauusd-rsi/rsi';
import { SPEC } from '../../src/xauusd-rsi/spec';

describe('Wilder seeding', () => {
  it('produces no value until period + 1 closes have been seen', () => {
    let state = createRsiState(5);
    for (const close of [10, 11, 12, 11, 13]) {
      state = commitClosedBar(state, close);
      expect(currentRsi(state)).toBeNull();
    }
    state = commitClosedBar(state, 14);
    expect(currentRsi(state)).not.toBeNull();
  });

  it('seeds with the arithmetic mean of the first `period` changes', () => {
    // closes 10,11,12,11,13,14 -> changes +1,+1,-1,+2,+1
    // avgGain = (1+1+0+2+1)/5 = 1.0 ; avgLoss = (0+0+1+0+0)/5 = 0.2
    // RS = 5 ; RSI = 100 - 100/6 = 83.3333...
    const series = rsiSeries([10, 11, 12, 11, 13, 14], 5);
    expect(series[5]).toBeCloseTo(83.333333, 5);
  });

  it('smooths subsequent changes with Wilder recursion, not a fresh average', () => {
    // From the state above: next close 15 -> gain 1, loss 0
    // avgGain = (1.0*4 + 1)/5 = 1.0 ; avgLoss = (0.2*4 + 0)/5 = 0.16
    // RS = 6.25 ; RSI = 100 - 100/7.25 = 86.206896...
    const series = rsiSeries([10, 11, 12, 11, 13, 14, 15], 5);
    expect(series[6]).toBeCloseTo(86.206897, 5);
  });

  it('defaults to the spec period of 5', () => {
    expect(createRsiState().period).toBe(5);
    expect(SPEC.rsi.period).toBe(5);
  });
});

describe("MT5's zero-loss convention", () => {
  it('returns 100 when average loss is zero', () => {
    expect(rsiFromAverages(1, 0)).toBe(100);
  });

  it('returns 100 for a perfectly FLAT series, matching MT5 rather than a 50 convention', () => {
    // This reproduces the terminal's own behaviour. It is disclosed rather
    // than filtered: a motionless market reads 100, which is inside the
    // extreme-SELL region. See rsi.ts's own note and the spec's §8.1.
    const series = rsiSeries([2000, 2000, 2000, 2000, 2000, 2000], 5);
    expect(series[5]).toBe(100);
  });

  it('returns 0 when there are only losses', () => {
    const series = rsiSeries([20, 19, 18, 17, 16, 15], 5);
    expect(series[5]).toBe(0);
  });

  it('returns 50 for perfectly balanced average gain and loss', () => {
    expect(rsiFromAverages(1, 1)).toBe(50);
  });
});

describe('Intrabar projection (spec §8.1)', () => {
  const seeded = () => {
    let s = createRsiState(5);
    for (const c of [10, 11, 12, 11, 13, 14]) s = commitClosedBar(s, c);
    return s;
  };

  it('does not mutate or advance the committed closed-bar state', () => {
    const before = seeded();
    const snapshot = { ...before };
    projectRsi(before, 20);
    expect(before).toEqual(snapshot);
    expect(before.closedBarCount).toBe(6);
  });

  it('is independent of how many ticks arrive — the same price always gives the same RSI', () => {
    const state = seeded();
    const once = projectRsi(state, 15);
    // Ten "ticks" at the same price, none of which advance the state.
    for (let i = 0; i < 10; i += 1) projectRsi(state, 15);
    expect(projectRsi(state, 15)).toBe(once);
  });

  it('agrees with the committed value once that same price actually closes the bar', () => {
    const state = seeded();
    const projected = projectRsi(state, 15);
    const committed = currentRsi(commitClosedBar(state, 15));
    expect(projected).toBe(committed);
  });

  it('moves with price within the forming bar', () => {
    const state = seeded();
    expect(projectRsi(state, 20)!).toBeGreaterThan(projectRsi(state, 14)!);
    expect(projectRsi(state, 8)!).toBeLessThan(projectRsi(state, 14)!);
  });

  it('yields null before the state is seeded', () => {
    expect(projectRsi(createRsiState(5), 100)).toBeNull();
  });
});

describe('Warm-up gating (spec §8.5)', () => {
  it('is not warmed up immediately after seeding', () => {
    let s = createRsiState(5);
    for (const c of [10, 11, 12, 11, 13, 14]) s = commitClosedBar(s, c);
    expect(isWarmedUp(s)).toBe(false);
  });

  it('becomes warmed up only after period + 1 + warmupBars closed bars', () => {
    const required = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars;
    let s = createRsiState(5);
    for (let i = 0; i < required - 1; i += 1) s = commitClosedBar(s, 2000 + Math.sin(i) * 5);
    expect(isWarmedUp(s)).toBe(false);
    s = commitClosedBar(s, 2001);
    expect(isWarmedUp(s)).toBe(true);
  });
});
