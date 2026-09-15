/**
 * Bridges confirmed-retest-v2's pure research engine (formation, first-
 * return consumption, entry-window, D1-descriptive-only) to the gold
 * execution coordinator — WITHOUT modifying v2 itself or its own directory
 * (`src/research/confirmed-retest-v2/`), so v2's own boundary test
 * (`test/research/confirmed-retest-v2/boundary.spec.ts`, which forbids
 * anything under that directory from importing execution code) is
 * completely unaffected: this file lives in `gold-execution/`, not there,
 * and only ever READS v2's exported types/pipeline/replay — it never
 * modifies them, and v2 never imports anything from here.
 *
 * `toGoldSignal` is the pure mapping (heavily unit-tested); `runGoldWatchCycle`
 * is the thin, DB-touching orchestration (loads data, advances replay state,
 * finds newly-observed eligible in-window events not yet acted on, and
 * calls the coordinator once per such event) — kept separate specifically
 * so the mapping logic can be tested without needing a live database.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { executeRun, loadAll } from '../research/confirmed-retest-v2/pipeline';
import type { ReplayState } from '../research/confirmed-retest-v2/replay';
import { SPEC_HASH } from '../research/confirmed-retest-v2/spec';
import type { FirstReturnEvent } from '../research/confirmed-retest-v2/types';
import { GoldCoordinatorContext, GoldExecutionCoordinatorService, GoldSignal } from './gold-execution-coordinator.service';
import { GOLD_POINT_SIZE } from './gold-safety-constants';

/**
 * A signal is only ever derived from an event that:
 * - was actually observed live by THIS watch cycle machinery (`observedAtT`
 *   is set — never a historical/backfilled event, per the task's explicit
 *   "do not execute stale historical touches as new live orders" rule),
 * - is `eligible` (already passed formation/window/gap/ambiguity checks),
 * - fell inside the entry window (`inWindow === true`), and
 * - has not already been acted on in a previous cycle (tracked by
 *   `actedEventIds`, persisted in `GoldWatchState`).
 */
export function isActionableLiveEvent(event: FirstReturnEvent, actedEventIds: ReadonlySet<string>): boolean {
  return (
    event.observedAtT !== null &&
    event.eligible === true &&
    event.inWindow === true &&
    event.direction !== null &&
    !actedEventIds.has(event.id)
  );
}

/** Pure mapping — no I/O, no live price (the caller supplies the freshest executable price separately). */
export function toGoldSignal(event: FirstReturnEvent, currentExecutablePrice: number): GoldSignal {
  if (event.direction !== 'BUY' && event.direction !== 'SELL') {
    throw new Error(`event ${event.id} has no direction — cannot build a signal from it`);
  }
  // Friend rule: BUY a qualifying support touch, SELL a qualifying resistance touch — direction
  // is already derived that way inside v2's formation engine (levels.ts); re-asserted here as a
  // defense-in-depth check rather than trusted blindly from an upstream module.
  const expectedDirection = event.role === 'SUPPORT' ? 'BUY' : 'SELL';
  if (event.direction !== expectedDirection) {
    throw new Error(`event ${event.id}: role=${event.role} but direction=${event.direction} — refusing, this should never happen (breakout entries are never valid).`);
  }
  return {
    action: event.direction === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
    signalEntryPrice: event.levelPrice / 100, // v2 stores integer cents internally; gold-execution works in dollar prices
    currentExecutablePrice,
    levelId: event.levelId,
    reasoning: `confirmed-retest-v2 first-return event ${event.id}, level ${event.levelId} (${event.role}), generation ${event.generation}, touch kind ${event.kind}, D1 agreement=${event.d1Agreement}`,
    touchEndT: event.touchEndT,
  };
}

export interface GoldWatchState {
  specHash: string;
  replay: ReplayState | null;
  actedEventIds: string[];
  lastCycleAtUtc: string | null;
}

function newGoldWatchState(): GoldWatchState {
  return { specHash: SPEC_HASH, replay: null, actedEventIds: [], lastCycleAtUtc: null };
}

/**
 * File-based persisted state, same restart-safe posture as v1's own
 * `WatchStore` (task requirement: "restart-safe level retirement/trade
 * eligibility," "reconstruct current state WITHOUT executing stale
 * historical touches as new live orders" — the persisted `actedEventIds`
 * set is exactly what prevents the latter across a restart).
 */
export class GoldWatchStore {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'gold-watch-state.json');
    this.lockPath = join(dir, 'gold-watch.lock');
  }

  load(): GoldWatchState {
    if (!existsSync(this.statePath)) return newGoldWatchState();
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as GoldWatchState;
    if (state.specHash !== SPEC_HASH) {
      throw new Error(`gold watch state belongs to spec ${state.specHash}; current v2 spec is ${SPEC_HASH}. Refusing to mix rule versions — archive ${this.dir} first.`);
    }
    return state;
  }

  save(state: GoldWatchState): void {
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    if (existsSync(this.statePath)) renameSync(this.statePath, `${this.statePath}.previous`);
    renameSync(tmp, this.statePath);
  }

  acquireLock(nowT: number, staleAfterMs = 15 * 60_000): void {
    if (existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number; atT: number };
      if (nowT - lock.atT < staleAfterMs) throw new Error(`another gold watch cycle holds ${this.lockPath} (pid ${lock.pid})`);
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, atT: nowT }));
  }

  releaseLock(): void {
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
  }
}

export interface GoldWatchCycleResult {
  actionableEvents: FirstReturnEvent[];
  results: Array<{ event: FirstReturnEvent; signal: GoldSignal; coordinatorResult: Awaited<ReturnType<GoldExecutionCoordinatorService['evaluate']>> }>;
  skippedNoExecutablePrice: FirstReturnEvent[];
}

/**
 * One watch cycle: load current data, advance v2's replay state from where
 * it last left off, find newly-actionable events, and (only for those with
 * a live executable price available) call the coordinator. Never invoked on
 * a timer by this file itself — same deliberate "built and tested ahead of
 * its own scheduler" posture as every other coordinator in this codebase.
 */
export async function runGoldWatchCycle(params: {
  prisma: PrismaClient;
  coordinator: GoldExecutionCoordinatorService;
  store: GoldWatchStore;
  nowT: number;
  accountId: string;
  buildContext: () => Promise<Omit<GoldCoordinatorContext, 'accountId' | 'nowT'>>;
  getExecutablePrice: (direction: 'BUY' | 'SELL') => Promise<number | null>;
}): Promise<GoldWatchCycleResult> {
  const { prisma, coordinator, store, nowT, accountId, buildContext, getExecutablePrice } = params;

  store.acquireLock(nowT);
  try {
    const state = store.load();
    const loaded = await loadAll(prisma, nowT);
    const run = executeRun(loaded, { state: state.replay ?? undefined, observedAtT: nowT });

    const actedIds = new Set(state.actedEventIds);
    const actionableEvents = run.events.filter((e) => isActionableLiveEvent(e, actedIds));

    const results: GoldWatchCycleResult['results'] = [];
    const skippedNoExecutablePrice: FirstReturnEvent[] = [];

    for (const event of actionableEvents) {
      const direction = event.direction === 'BUY' ? 'BUY' : 'SELL';
      const price = await getExecutablePrice(direction);
      if (price === null) {
        skippedNoExecutablePrice.push(event);
        continue; // never invent an unavailable executable price
      }
      const signal = toGoldSignal(event, price);
      const context = await buildContext();
      const coordinatorResult = await coordinator.evaluate(signal, { ...context, accountId, nowT });
      results.push({ event, signal, coordinatorResult });
      actedIds.add(event.id); // marked acted-on regardless of approval — an event is a one-shot opportunity, per the friend's "first return consumes it" rule
    }

    store.save({ specHash: SPEC_HASH, replay: run.state, actedEventIds: [...actedIds], lastCycleAtUtc: new Date(nowT).toISOString() });
    return { actionableEvents, results, skippedNoExecutablePrice };
  } finally {
    store.releaseLock();
  }
}

// GOLD_POINT_SIZE re-exported for callers building GoldCoordinatorContext without re-importing gold-safety-constants directly.
export { GOLD_POINT_SIZE };
