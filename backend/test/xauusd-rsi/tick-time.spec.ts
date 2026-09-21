/**
 * The broker wall-clock correction for stored tick and candle timestamps.
 *
 * Regression test for a demonstrated defect: `historical_ticks.timestamp`
 * held broker-local digits wearing a UTC label, so an observation recorded
 * at 01:00:01 Beirut persisted as `2026-09-21T01:00:01Z` — three hours
 * ahead of the 22:00:01Z it actually happened at — and the dashboard, which
 * formats correctly in Asia/Beirut, faithfully rendered it as 04:00.
 *
 * The same offset silently disabled the engine's staleness test, because
 * `now - atT` came out negative for every tick.
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_CURSOR_TIME_BASIS,
  storedBrokerTimeToUtcMs,
} from '../../src/xauusd-rsi/tick-time';
import { utcToWallClockMs } from '../../src/research/confirmed-retest/time';
import { beirutLabel } from '../../src/xauusd-rsi/time';

/** The exact decision the defect was demonstrated on. */
const STORED_OBSERVED_AT = Date.parse('2026-09-21T01:00:01.415Z');
const TRUE_OBSERVED_AT = Date.parse('2026-09-20T22:00:01.415Z');

describe('storedBrokerTimeToUtcMs', () => {
  it('converts the demonstrated decision back to the instant it really happened', () => {
    expect(storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')).toBe(TRUE_OBSERVED_AT);
  });

  it('renders that decision as 01:00 Beirut, not 04:00', () => {
    const corrected = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    expect(beirutLabel(corrected)).toContain('01:00:01');
    // The uncorrected value is exactly what the dashboard showed before.
    expect(beirutLabel(STORED_OBSERVED_AT)).toContain('04:00:01');
  });

  it('shifts by exactly three hours in EEST (summer)', () => {
    const july = Date.parse('2026-07-15T12:00:00.000Z');
    expect(july - storedBrokerTimeToUtcMs(july, 'EET')!).toBe(3 * 60 * 60 * 1000);
  });

  it('shifts by exactly two hours in EET (winter), rather than a hardcoded offset', () => {
    const january = Date.parse('2026-01-15T12:00:00.000Z');
    expect(january - storedBrokerTimeToUtcMs(january, 'EET')!).toBe(2 * 60 * 60 * 1000);
  });

  it('round-trips against the conversion the research layer already uses', () => {
    const utc = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    expect(utcToWallClockMs('EET', utc)).toBe(STORED_OBSERVED_AT);
  });

  it('drops a timestamp inside the DST spring-forward gap rather than guessing', () => {
    // 03:30 on the changeover Sunday does not exist in EET.
    const nonexistent = Date.parse('2026-03-29T03:30:00.000Z');
    expect(storedBrokerTimeToUtcMs(nonexistent, 'EET')).toBeNull();
  });

  it('preserves ordering, so a corrected series cannot look out of order', () => {
    const a = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT, 'EET')!;
    const b = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT + 5_000, 'EET')!;
    expect(b - a).toBe(5_000);
  });
});

describe('The staleness test the offset was disabling', () => {
  const MAX_STALENESS_MS = 30_000;

  it('an uncorrected timestamp makes every tick look fresh, however old it is', () => {
    // A tick from two hours ago, uncorrected: `now - atT` is NEGATIVE, so the
    // <= limit comparison passes and nothing can ever be rejected.
    const nowT = TRUE_OBSERVED_AT;
    const twoHoursOldStored = utcToWallClockMs('EET', nowT - 2 * 60 * 60 * 1000);
    expect(nowT - twoHoursOldStored).toBeLessThan(0);
    expect(nowT - twoHoursOldStored <= MAX_STALENESS_MS).toBe(true);
  });

  it('the corrected timestamp rejects that same tick', () => {
    const nowT = TRUE_OBSERVED_AT;
    const twoHoursOldStored = utcToWallClockMs('EET', nowT - 2 * 60 * 60 * 1000);
    const corrected = storedBrokerTimeToUtcMs(twoHoursOldStored, 'EET')!;
    expect(nowT - corrected).toBe(2 * 60 * 60 * 1000);
    expect(nowT - corrected <= MAX_STALENESS_MS).toBe(false);
  });

  it('and still accepts a genuinely fresh one', () => {
    const nowT = TRUE_OBSERVED_AT;
    const oneSecondOldStored = utcToWallClockMs('EET', nowT - 1_000);
    const corrected = storedBrokerTimeToUtcMs(oneSecondOldStored, 'EET')!;
    expect(nowT - corrected).toBe(1_000);
    expect(nowT - corrected <= MAX_STALENESS_MS).toBe(true);
  });
});

describe('The cursor time-basis tag', () => {
  it('is a stable, non-empty identifier', () => {
    expect(RSI_CURSOR_TIME_BASIS).toBe('BROKER_WALL_CLOCK_CORRECTED_V1');
  });

  it('distinguishes a pre-correction cursor, which would sit in the future', () => {
    // An untagged cursor holds the stored value; after the correction the
    // same tick reads three hours earlier, so every new tick would be
    // filtered out as "older than the cursor" and the strategy would go
    // blind while still looking healthy.
    const untaggedCursor = STORED_OBSERVED_AT;
    const nextTickCorrected = storedBrokerTimeToUtcMs(STORED_OBSERVED_AT + 1_000, 'EET')!;
    expect(nextTickCorrected).toBeLessThan(untaggedCursor);
  });
});
