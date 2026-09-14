/**
 * scripts/confirmed-retest-watch.ts — WATCH-ONLY runner for
 * `xauusd-h4-confirmed-retest-v1`.
 *
 * Reads stored (completed, settled) XAUUSD bars, advances the persisted
 * replay state, appends forward observations to a journal and writes a
 * summary for the dashboard. It cannot place orders: there is no order code
 * path anywhere in this script or the modules it imports, and it never
 * writes to the database. It does not fetch data itself — new bars arrive
 * only if the existing collector/backfill pipeline stores them.
 *
 * Run once:   npm run confirmed-retest:watch
 * Loop:       npm run confirmed-retest:watch -- --interval-seconds 300
 * Volume (user-only, audited): npm run confirmed-retest:watch -- --set-volume-lots 0.01 --changed-by "<name>"
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { latestCompletedM1CloseUtc } from '../src/research/confirmed-retest/data-source';
import { executeRun, loadAll } from '../src/research/confirmed-retest/pipeline';
import { eventRows } from '../src/research/confirmed-retest/report';
import { SPEC, SPEC_HASH } from '../src/research/confirmed-retest/spec';
import { iso } from '../src/research/confirmed-retest/time';
import type { OutcomeStatus } from '../src/research/confirmed-retest/types';
import {
  diffEvents,
  evaluateQuoteGate,
  ORDER_EXECUTION,
  setVolume,
  shadowSimulations,
  WatchStore,
  type QuoteSnapshot,
} from '../src/research/confirmed-retest/watch';

const STATE_DIR = resolve(process.env.RESEARCH_STATE_DIR ?? resolve(__dirname, '..', 'research-state'), SPEC.version);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readQuote(prisma: PrismaClient, nowT: number): Promise<QuoteSnapshot | null> {
  const row = await prisma.liveTick.findUnique({ where: { symbol: SPEC.symbol } });
  if (!row) return null;
  return { bid: Math.round(Number(row.bid) * 100), ask: Math.round(Number(row.ask) * 100), tickT: row.tickAt.getTime(), readAtT: nowT };
}

async function cycle(prisma: PrismaClient, store: WatchStore): Promise<void> {
  const nowT = Date.now();
  store.acquireLock(nowT);
  try {
    const state = store.load(nowT);
    const volumeLots = arg('set-volume-lots');
    if (volumeLots !== undefined) {
      const entry = setVolume(state, Number(volumeLots), arg('changed-by') ?? '', nowT);
      store.journal({ type: 'VOLUME_CHANGE', ...entry });
    }

    const latestClose = await latestCompletedM1CloseUtc(prisma, SPEC.symbol);
    if (latestClose === null) throw new Error('no stored XAUUSD M1 data');
    // A bar is settled once a stored bar at least watchSettleMarginMinutes newer exists.
    const settledEndT = latestClose - SPEC.data.watchSettleMarginMinutes * 60_000;
    const warnings: string[] = [];
    if (nowT - latestClose > 3 * 86_400_000) {
      warnings.push(
        `latest stored XAUUSD M1 bar closed ${iso(latestClose)} — no new gold bars are arriving. Gold bars reach the database only through the collector ` +
          '(check CANDLE_SYMBOLS in collector/.env, which was EURUSD-only when this version was built) or a gold backfill run.',
      );
    }

    const before: Record<string, OutcomeStatus | null> = {};
    for (const e of Object.values(state.replay?.events ?? {})) before[e.id] = e.outcome?.status ?? null;
    const bootstrap = state.replay === null;

    let run = null;
    if (bootstrap || (state.settledEndT ?? 0) < settledEndT) {
      const loaded = await loadAll(prisma, settledEndT);
      run = executeRun(loaded, { state: state.replay ?? undefined, observedAtT: bootstrap ? null : nowT });
      state.replay = run.state;
      state.settledEndT = settledEndT;
      if (bootstrap) state.bootstrapSettledEndUtc = iso(settledEndT);

      const diff = diffEvents(before, run.events);
      const quote = bootstrap ? null : await readQuote(prisma, Date.now());
      for (const e of diff.newEvents) {
        if (!bootstrap && e.eligible && e.selection?.isSelected) {
          const gate = evaluateQuoteGate(e, quote, Date.now());
          state.quoteGate[e.id] = gate;
          store.journal({ type: 'SHADOW_QUOTE_GATE', orderExecution: ORDER_EXECUTION, ...gate });
        }
        if (!bootstrap) store.journal({ type: 'FORWARD_FIRST_RETURN', event: e });
      }
      for (const change of diff.statusChanges) store.journal({ type: 'OUTCOME_UPDATE', ...change });
      store.journal({ type: bootstrap ? 'BOOTSTRAP' : 'CYCLE', settledEndUtc: iso(settledEndT), newEvents: diff.newEvents.length, statusChanges: diff.statusChanges.length, dataHash: loaded.dataHash });
    } else {
      store.journal({ type: 'CYCLE_NO_NEW_SETTLED_DATA', settledEndUtc: iso(settledEndT) });
    }
    state.lastCycleAtUtc = new Date(nowT).toISOString();
    store.save(state);

    const replay = state.replay!;
    const events = replay.eventOrder.map((id) => replay.events[id]);
    const forward = events.filter((e) => e.observedAtT !== null);
    const levels = replay.levels;
    const shadow = run ? shadowSimulations(run, state) : null;
    store.writeSummary({
      mode: 'WATCH_ONLY',
      orderExecution: ORDER_EXECUTION,
      strategyVersion: SPEC.version,
      specHash: SPEC_HASH,
      lastCycleAtUtc: state.lastCycleAtUtc,
      latestStoredM1CloseUtc: iso(latestClose),
      settledEndUtc: iso(state.settledEndT),
      bootstrapSettledEndUtc: state.bootstrapSettledEndUtc,
      volumeLots: state.volumeLots,
      volumeAudit: state.volumeAudit,
      activeLevels: levels.activeLevelIds.map((id) => levels.levels[id]).map((l) => ({ id: l.id, role: l.role, price: (l.price / 100).toFixed(2), activatedUtc: iso(l.activatedT), h4BarsSinceActivation: l.barsSinceActivation, d1Agreement: l.d1Agreement })),
      counts: {
        levelsEver: Object.keys(levels.levels).length,
        eventsEver: events.length,
        forwardEvents: forward.length,
        pendingOutcomes: replay.pendingRaceEventIds.length,
      },
      forwardEvents: eventRows(forward, {}),
      quoteGate: state.quoteGate,
      shadow,
      warnings,
      limitations: [
        'Shadow decisions are taken when a settled bar is processed (≥ the settle margin after the touch), so the quote reflects decision time, not the touch minute.',
        'live_ticks.tick_at time basis for XAUUSD is not independently verified; a future-dated quote fails the gate.',
        'Forward events are the only non-inspected evidence; historical bootstrap events are not forward evidence.',
      ],
    });
    console.log(`[watch ${SPEC.version}] settled through ${iso(state.settledEndT)}; ${forward.length} forward events; ${levels.activeLevelIds.length} active levels; orders: ${ORDER_EXECUTION}`);
    for (const w of warnings) console.warn(`WARNING: ${w}`);
  } finally {
    store.releaseLock();
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const store = new WatchStore(STATE_DIR);
  const interval = arg('interval-seconds');
  try {
    do {
      await cycle(prisma, store);
      if (interval) await new Promise((r) => setTimeout(r, Math.max(30, Number(interval)) * 1000));
    } while (interval);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
