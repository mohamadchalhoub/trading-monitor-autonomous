// Covers required scenarios 5, 6, 7, 8, 10, 11, 12.
import { describe, expect, it } from 'vitest';
import { buildTouchEvent, createLevel, findFirstTouch, resolveOutcome, resolvePriceRace } from '../../../src/research/first-touch/engine';
import type { DataGap } from '../../../src/research/first-touch/types';
import { candle, h4Candle, tick } from './helpers';

const SYMBOL = 'XAUUSD';
const ENTRY_TIME = new Date('2026-01-02T00:00:00.000Z');

describe('scenario 5 — ordinary TP-first vs SL-first resolution', () => {
  it('resolves WIN when TP is hit first', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2001, 2010, 1999, 2009); // high reaches tp=2010, low never reaches sl=1990
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('WIN');
    expect(result.resolutionPrice).toBe(2010);
    expect(result.resolvedAtUtc?.toISOString()).toBe(c1.openTime.toISOString());
  });

  it('resolves LOSS when SL is hit first', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 1999, 2001, 1990, 1991); // low reaches sl=1990, high never reaches tp=2010
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(1990);
  });

  it('the same $10 rule mirrors correctly for a SELL (resistance) entry', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2000, 2001, 1990, 1991); // low reaches SELL's tp = entry-10 = 1990
    const result = resolvePriceRace({
      direction: 'SELL', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.tp).toBe(1990);
    expect(result.sl).toBe(2010);
    expect(result.status).toBe('WIN');
  });
});

describe('scenario 6 — resolution after a significant delay, no forced cutoff at noon or any other time', () => {
  it('resolves WIN days later, after idling through several Beirut noons', () => {
    const idle1 = candle('2026-01-02T10:00:00.000Z', 2000, 2003, 1997, 2001); // 12:00 Beirut local (winter) — must NOT force a close
    const idle2 = candle('2026-01-03T10:00:00.000Z', 2001, 2004, 1996, 2002);
    const idle3 = candle('2026-01-04T10:00:00.000Z', 2002, 2004, 1995, 2000);
    const finallyHits = candle('2026-01-06T09:00:00.000Z', 2005, 2010, 2004, 2009); // 5 days after entry

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle1, idle2, idle3, finallyHits], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(finallyHits.openTime.toISOString());
    // ~4 days of holding, proving nothing forced an earlier exit.
    expect(result.holdingDurationMs).toBeGreaterThan(4 * 24 * 60 * 60 * 1000);
  });
});

describe('scenario 7 — an UNRESOLVED event is correctly carried forward and re-evaluated with more data / a later frozen end', () => {
  it('is UNRESOLVED against an early frozen end, then WIN once more data and a later frozen end are supplied', () => {
    const idle = candle('2026-01-02T01:00:00.000Z', 2000, 2003, 1997, 2001);
    const laterHit = candle('2026-01-10T00:00:00.000Z', 2005, 2010, 2004, 2009);

    const early = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'), // before laterHit even exists
    });
    expect(early.status).toBe('UNRESOLVED');
    expect(early.resolvedAtUtc).toBeNull();

    // Re-evaluate the SAME event, now with more data and a later frozen end — a pure re-computation, nothing "carried" statefully.
    const later = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [idle, laterHit], ticks: [], gaps: [], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-11T00:00:00.000Z'),
    });
    expect(later.status).toBe('WIN');
    expect(later.resolvedAtUtc?.toISOString()).toBe(laterHit.openTime.toISOString());
  });
});

describe('scenario 8 — same-M1-candle race is AMBIGUOUS without ticks, resolved correctly with ticks', () => {
  const raceCandle = candle('2026-01-02T00:01:00.000Z', 2000, 2011, 1989, 2000); // high >= tp(2010) AND low <= sl(1990) in the same candle

  it('is AMBIGUOUS when no tick data covers the race candle', () => {
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(raceCandle.openTime.toISOString());
    expect(result.resolvedAtUtc).toBeNull();
  });

  it('resolves correctly (SL first) when tick data covering the race candle is supplied', () => {
    const ticks = [
      tick('2026-01-02T00:01:10.000Z', 1995, 1996), // still between tp/sl
      tick('2026-01-02T00:01:20.000Z', 1990, 1991), // SL (1990) reached first
      tick('2026-01-02T00:01:40.000Z', 2010, 2011), // TP would be reached later — must not win
    ];
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks, gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('LOSS');
    expect(result.resolutionPrice).toBe(1990);
    expect(result.resolvedAtUtc?.toISOString()).toBe('2026-01-02T00:01:20.000Z');
  });

  it('resolves correctly (TP first) when ticks show the opposite order', () => {
    const ticks = [
      tick('2026-01-02T00:01:10.000Z', 2005, 2006),
      tick('2026-01-02T00:01:20.000Z', 2010, 2011), // TP reached first
      tick('2026-01-02T00:01:40.000Z', 1990, 1991),
    ];
    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [raceCandle], ticks, gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(result.status).toBe('WIN');
    expect(result.resolutionPrice).toBe(2010);
  });
});

describe('scenario 10 — a post-entry data gap forces INDETERMINATE, even when the first visible price after the gap is already beyond TP', () => {
  it('never takes the forbidden shortcut of inferring a WIN just because price is beyond TP right after the gap (UNCONFIRMED gap)', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001); // ordinary, resolves nothing
    const gap: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'UNCONFIRMED' };
    // First visible candle after the gap: already beyond TP (2010) on its low, let alone its high.
    // The forbidden shortcut would read this as an obvious WIN — the correct answer is INDETERMINATE,
    // because the untracked path through the gap could just as easily have crossed SL (1990) first.
    const afterGap = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, afterGap], ticks: [], gaps: [gap], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('INDETERMINATE');
    expect(result.status).not.toBe('WIN');
    expect(result.concealingGap).toEqual(gap);
    expect(result.resolvedAtUtc).toBeNull();
  });

  it('resolves normally through the same gap when tick data actually covers it', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const gap: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'UNCONFIRMED' };
    const afterGap = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);
    const ticksThroughGap = [
      tick('2026-01-02T02:00:00.000Z', 1995, 1996),
      tick('2026-01-02T04:00:00.000Z', 2010, 2011), // TP reached inside the gap, confirmed by ticks
    ];

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, afterGap], ticks: ticksThroughGap, gaps: [gap], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe('2026-01-02T04:00:00.000Z');
  });

  it('resolves normally off the reopen candle\'s own wicks across a CONFIRMED_CLOSURE, with no tick requirement', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    // A verified-shut weekend/holiday closure — no trading happened inside it by definition, so there is
    // no hidden path to worry about, only the single discrete jump from `clean`'s close to `reopen`'s open.
    const closure: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'CONFIRMED_CLOSURE' };
    // Reopens beyond TP (2010) on its low — since the closure is CONFIRMED, this is resolved directly off
    // this candle's own wicks (a real, single reopen-gap jump), never treated as INDETERMINATE.
    const reopen = candle('2026-01-02T06:00:00.000Z', 2015, 2020, 2011, 2018);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, reopen], ticks: [], gaps: [closure], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('WIN');
    expect(result.resolvedAtUtc?.toISOString()).toBe(reopen.openTime.toISOString());
    expect(result.resolutionPrice).toBe(2010); // TP price, not the reopen print — the fill model is a stop/limit order, filled at its own price
  });

  it('still marks the reopen AMBIGUOUS (never guesses) when the single reopen jump itself straddles both TP and SL', () => {
    const clean = candle('2026-01-02T00:01:00.000Z', 2000, 2002, 1998, 2001);
    const closure: DataGap = { symbol: SYMBOL, start: clean.closeTime, end: new Date('2026-01-02T06:00:00.000Z'), kind: 'CONFIRMED_CLOSURE' };
    // Reopens with a huge range spanning BOTH TP (2010) and SL (1990) inside one candle — the closure being
    // confirmed tells us nothing traded during it, but says nothing about which boundary this one visible
    // reopen candle reached first, so this must still be AMBIGUOUS, not resolved by guessing.
    const reopen = candle('2026-01-02T06:00:00.000Z', 2000, 2015, 1985, 2005);

    const result = resolvePriceRace({
      direction: 'BUY', entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [clean, reopen], ticks: [], gaps: [closure], symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.raceCandleUtc?.toISOString()).toBe(reopen.openTime.toISOString());
  });
});

describe('scenario 11 — a gap-through entry produces DIFFERENT idealized vs executable results', () => {
  it('keeps the idealized (entry-at-level) and executable (entry-at-reachable-price) paths structurally separate and numerically different', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2005, 2015, 1995, 2010);
    const level = createLevel({
      id: 'gap-through-lvl',
      role: 'SUPPORT',
      zone: { lower: 1999, upper: 2001 },
      sourceCandles: [source],
      establishedAt: source.closeTime,
      methodVersion: 'v1',
    });

    // Approach from above: this candle's close (2010) is above zone.upper (2001).
    const previous = candle('2026-01-02T03:00:00.000Z', 2012, 2015, 2008, 2010);
    // The touch candle GAPS THROUGH on its open (1995 < zone.lower=1999) but its
    // body closes back inside the zone (2000), so it still registers as a touch.
    // 03:01 UTC = 05:01 Beirut local (winter) — inside the eligible window.
    const touchCandle = candle('2026-01-02T03:01:00.000Z', 1995, 2001, 1993, 2000);

    const candles = [source, previous, touchCandle];
    const detection = findFirstTouch({ level, candles, gaps: [], symbol: SYMBOL });
    expect(detection.status).toBe('TOUCHED');

    const touchEvent = buildTouchEvent({ level, detection, candles, symbol: SYMBOL });
    expect(touchEvent).not.toBeNull();
    expect(touchEvent!.gappedThrough).toBe(true);
    expect(touchEvent!.idealEntryPrice).toBe(2000); // zone midpoint
    expect(touchEvent!.executableEntryPrice).toBe(1995); // the actual open print
    expect(touchEvent!.entryDirection).toBe('BUY'); // SUPPORT + FROM_ABOVE

    // Ideal: entry 2000 -> tp 2010 / sl 1990. Executable: entry 1995 -> tp 2005 / sl 1985.
    const afterA = candle('2026-01-02T04:00:00.000Z', 2003, 2007, 1999, 2006); // hits executable's tp(2005), NOT ideal's tp(2010) or ideal's sl(1990)
    const afterB = candle('2026-01-02T05:00:00.000Z', 2000, 2005, 1988, 1990); // hits ideal's sl(1990); irrelevant to executable (already resolved)

    const outcome = resolveOutcome({
      touchEvent: touchEvent!,
      level,
      candles: [...candles, afterA, afterB],
      gaps: [],
      symbol: SYMBOL,
      frozenEndUtc: new Date('2026-01-02T06:00:00.000Z'),
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.idealized.status).toBe('LOSS');
    expect(outcome!.executable.status).toBe('WIN');
    expect(outcome!.idealized.entryPrice).not.toBe(outcome!.executable.entryPrice);
  });
});

describe('scenario 12 — re-processing identical input twice produces identical output (pure-function idempotence)', () => {
  it('resolvePriceRace is idempotent', () => {
    const c1 = candle('2026-01-02T00:01:00.000Z', 2001, 2010, 1999, 2009);
    const args = {
      direction: 'BUY' as const, entryPrice: 2000, entryTimeUtc: ENTRY_TIME,
      candles: [c1], ticks: [], gaps: [], symbol: SYMBOL, frozenEndUtc: new Date('2026-01-03T00:00:00.000Z'),
    };
    expect(resolvePriceRace({ ...args })).toEqual(resolvePriceRace({ ...args }));
  });

  it('the full resolveOutcome pipeline is idempotent', () => {
    const source = h4Candle('2026-01-01T00:00:00.000Z', 2000, 2010, 1995, 2005);
    const level = createLevel({ id: 'idem-lvl', role: 'SUPPORT', price: 2000, sourceCandles: [source], establishedAt: source.closeTime, methodVersion: 'v1' });
    const previous = h4Candle('2026-01-01T04:00:00.000Z', 2010, 2015, 2008, 2012);
    const touchCandle = candle('2026-01-02T03:01:00.000Z', 2005, 2006, 1994, 1996);
    const after = candle('2026-01-02T04:00:00.000Z', 2001, 2010, 1999, 2005);
    const candles = [source, previous, touchCandle, after];
    const gaps: DataGap[] = [];
    const frozenEndUtc = new Date('2026-01-03T00:00:00.000Z');

    const run = () => {
      const detection = findFirstTouch({ level, candles, gaps, symbol: SYMBOL });
      const touchEvent = buildTouchEvent({ level, detection, candles, symbol: SYMBOL });
      return resolveOutcome({ touchEvent: touchEvent!, level, candles, gaps, symbol: SYMBOL, frozenEndUtc });
    };

    expect(run()).toEqual(run());
  });
});
