/**
 * The watch cycle's cold-start behaviour.
 *
 * The case that matters here was found by running the real process rather
 * than by reasoning: seeding the indicator from candle history leaves the
 * engine's clock at the last bar it applied, so any tick older than that is
 * already inside the indicator and is correctly rejected as out-of-order. If
 * the observation cursor is not moved forward at the same time, the loop
 * re-reads and discards the same historical ticks on every cycle, forever.
 *
 * Observed live on a cold start before the fix: 44,992 ticks read, 44,992
 * rejected, zero applied, and an RSI frozen at one value.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';
import { RsiCoordinatorService } from '../../src/xauusd-rsi/coordinator.service';
import { RsiLiquidationService } from '../../src/xauusd-rsi/liquidation.service';
import { RsiRuntimeSettingsService } from '../../src/xauusd-rsi/runtime-settings.service';
import { RsiWatchService } from '../../src/xauusd-rsi/watch.service';
import { RsiDecisionService } from '../../src/xauusd-rsi/decision.service';
import { createWatchState, RsiWatchStore } from '../../src/xauusd-rsi/state-store';
import { SPEC } from '../../src/xauusd-rsi/spec';
import { M1_MS } from '../../src/xauusd-rsi/engine';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Wednesday 2026-09-23, 15:00 Beirut — an ordinary eligible instant. */
const NOW_T = Date.parse('2026-09-23T12:00:00.000Z');
const BARS = SPEC.rsi.period + 1 + SPEC.rsi.warmupBars + 20;

describe('Watch cycle — cold start', () => {
  let prisma: PrismaClient;
  let watch: RsiWatchService;
  let accountId: string;
  let store: RsiWatchStore;

  beforeAll(() => {
    prisma = new PrismaClient();
    const accountState = new RsiAccountStateService(prisma as never);
    const runtimeSettings = new RsiRuntimeSettingsService();
    const coordinator = new RsiCoordinatorService(prisma as never, runtimeSettings, accountState);
    const liquidation = new RsiLiquidationService(prisma as never, accountState);
    const decisions = new RsiDecisionService(prisma as never, accountState);
    // Telegram is stubbed: this file is about observation, and a real send
    // would be an outbound network call from a unit test.
    const telegram = { notify: async () => undefined } as never;
    watch = new RsiWatchService(prisma as never, coordinator, accountState, liquidation, decisions, telegram);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
    store = new RsiWatchStore(mkdtempSync(join(tmpdir(), 'rsi-watch-state-')));
  });

  /** A contiguous run of M1 bars ending just before `endT`. */
  async function seedCandles(endT: number) {
    const rows = [];
    for (let i = BARS; i >= 1; i -= 1) {
      const openTime = new Date(endT - i * M1_MS);
      const base = 4300 + Math.sin(i / 7) * 3;
      rows.push({
        symbol: 'XAUUSD',
        timeframe: 'M1' as const,
        openTime,
        open: base,
        high: base + 0.5,
        low: base - 0.5,
        close: base,
        volume: 10,
      });
    }
    await prisma.historicalCandle.createMany({ data: rows });
  }

  /** Ticks positioned BEFORE the candle history ends — the trap case. */
  async function seedStaleTicks(endT: number, count: number) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({
        symbol: 'XAUUSD',
        timestamp: new Date(endT - (count - i) * 1_000 - 10 * M1_MS),
        bid: 4300 + i * 0.01,
        ask: 4300.18 + i * 0.01,
        flags: 6,
        batchSeq: i,
      });
    }
    await prisma.historicalTick.createMany({ data: rows });
  }

  it('moves the observation cursor to the end of the seeded range, instead of re-reading history forever', async () => {
    await seedCandles(NOW_T);
    await seedStaleTicks(NOW_T, 200);

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const first = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    expect(first.result.reseeded).toBe(true);
    expect(first.result.warmedUp).toBe(true);

    // The cursor now sits at the seed boundary, so the stale ticks are simply
    // not read — they are not read-and-rejected.
    const lastBarT = NOW_T - M1_MS;
    expect(first.state.cursor.lastTimestampMs).toBe(lastBarT + M1_MS);
    expect(first.state.engine.ticksRejectedOutOfOrder).toBe(0);

    // A second cycle finds nothing new rather than re-reading the same ticks.
    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 5_000 });
    expect(second.result.ticksConsumed).toBe(0);
    expect(second.state.engine.ticksRejectedOutOfOrder).toBe(0);
  });

  it('consumes ticks that arrive AFTER the seeded range', async () => {
    await seedCandles(NOW_T);
    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const first = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    // Fresh ticks, after the last seeded bar.
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push({
        symbol: 'XAUUSD',
        timestamp: new Date(NOW_T + i * 1_000),
        bid: 4302 + i * 0.05,
        ask: 4302.18 + i * 0.05,
        flags: 6,
        batchSeq: i,
      });
    }
    await prisma.historicalTick.createMany({ data: rows });

    const second = await watch.runCycle({ accountId, store, state: first.state, nowT: NOW_T + 21_000 });
    expect(second.result.ticksConsumed).toBe(20);
    expect(second.state.engine.ticksApplied).toBe(20);
    expect(second.state.engine.ticksRejectedOutOfOrder).toBe(0);
    expect(second.result.currentRsi).not.toBeNull();
  });

  it('completes recovery when there is nothing in flight, and reports it', async () => {
    await seedCandles(NOW_T);
    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const result = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    expect(result.result.recoveryComplete).toBe(true);
    expect(result.result.recoveryDetail).toMatch(/No in-flight decisions/);
  });

  it('retires an unsent decision left behind by a restart, and does not submit it', async () => {
    await seedCandles(NOW_T);
    const planted = await prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: SPEC.strategyVersion,
        specHash: 'whatever',
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date(NOW_T - 600_000),
        direction: 'SELL',
        ruleFamily: 'EXTREME',
        eventId: 'test-restart-1',
        setupKinds: ['EXTREME_SELL'],
        rsiValue: 99,
        basisPrice: 4300,
        observationMode: 'TICK',
        reasoning: 'planted by a restart test',
        evidence: {},
        approved: true,
        orderStatus: 'PENDING',
        magicNumber: 262610191,
      },
    });

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    const after = await prisma.xauusdRsiDecision.findUniqueOrThrow({ where: { id: planted.id } });
    expect(after.orderStatus).toBe('NONE');
    expect(after.skipReason).toMatch(/restarted before this queued entry was ever sent/);
  });

  it('keeps entries blocked while an UNKNOWN submission is unresolved', async () => {
    await seedCandles(NOW_T);
    await prisma.xauusdRsiDecision.create({
      data: {
        strategyVersion: SPEC.strategyVersion,
        specHash: 'whatever',
        accountId,
        symbol: 'XAUUSD',
        observedAt: new Date(NOW_T - 600_000),
        direction: 'BUY',
        ruleFamily: 'EXTREME',
        eventId: 'test-restart-2',
        setupKinds: ['EXTREME_BUY'],
        rsiValue: 1,
        basisPrice: 4300,
        observationMode: 'TICK',
        reasoning: 'planted by a restart test',
        evidence: {},
        approved: true,
        orderStatus: 'SENT',
        magicNumber: 262610191,
      },
    });

    const state = createWatchState(SPEC.strategyVersion, 'TICK');
    const result = await watch.runCycle({ accountId, store, state, nowT: NOW_T });

    // No matching open position, so the outcome stays genuinely unknown and
    // recovery does NOT complete — it is never assumed to have failed.
    expect(result.result.recoveryComplete).toBe(false);
    expect(result.result.recoveryDetail).toMatch(/UNKNOWN/);
    expect(result.result.entriesAllowed).toBe(false);
  });
});
