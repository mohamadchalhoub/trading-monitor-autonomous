/**
 * Everything the operator needs to answer "what is this strategy doing, and
 * why is it or isn't it trading right now?" in one read-only payload.
 *
 * Two rules govern what this endpoint is allowed to say:
 *
 * 1. **It never claims health it cannot see.** The watch loop is a separate
 *    process, so its heartbeat is read from its own state file and is
 *    reported as STALE unless the timestamp is genuinely recent — a dead
 *    process's last cycle is never presented as current.
 * 2. **It never claims the account is flat when only owned exposure is.**
 *    Foreign and manual XAUUSD positions are reported in their own section
 *    (spec §9.3), never folded into the strategy's own totals.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RsiAccountStateService } from './account-state.service';
import { RsiRuntimeSettingsService } from './runtime-settings.service';
import { getRsiExecutionMode, killSwitchState, stopNewEntriesState } from './controls';
import { evaluateClockSchedule, evaluateEntryEligibility, evaluateLiquidationPhase, nextClockEligibleAt, nextFridayDeadlineAt } from './schedule';
import { beirutLabel } from './time';
import { SPEC, SPEC_HASH } from './spec';
import { engineRsiNow, engineWarmedUp, EngineState } from './engine';
import { defaultStateDir, RsiWatchState } from './state-store';
import { describeOwnership } from './ownership';
import {
  RSI_COMBINED_RISK_CAP_PCT,
  RSI_DAILY_LOSS_CAP_PCT,
  RSI_DEFAULT_VOLUME_LOTS,
  RSI_DRAWDOWN_CAP_PCT,
  RSI_GOLD_POINT_SIZE,
  RSI_MAGIC_RETEST,
  RSI_MAGIC_EXTREME,
  RSI_MAX_ENTRY_DEVIATION_POINTS,
  RSI_SL_USD,
  RSI_STOP_RISK_CAP_PCT,
  RSI_SYMBOL,
  RSI_TP_USD,
} from './safety-constants';

const HEARTBEAT_STALE_THRESHOLD_SECONDS = Number(process.env.HEARTBEAT_STALE_THRESHOLD_SECONDS ?? '300');

@Controller('research/xauusd-rsi-status')
@UseGuards(DashboardTokenGuard)
export class RsiDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: RsiAccountStateService,
    private readonly runtimeSettings: RsiRuntimeSettingsService,
  ) {}

  @Get()
  async getStatus() {
    const now = new Date();
    const nowT = now.getTime();
    const accountId = process.env.AUTONOMOUS_TRADING_ACCOUNT_ID?.trim() || null;

    const watch = readWatchState();
    const session = accountId ? await this.accountState.resolveBrokerSessionOpen(now) : { open: null, detail: 'No trading account configured.', quoteAgeSeconds: null };
    const exposure = accountId ? await this.accountState.resolveExposure(accountId) : null;
    const riskInfo = accountId ? await this.accountState.resolveAccountRiskInfo(accountId) : null;
    const constraints = await this.accountState.resolveBrokerConstraints(now);
    const volume = this.runtimeSettings.resolveVolume();
    const tick = await this.prisma.liveTick.findUnique({ where: { symbol: RSI_SYMBOL } });

    const kill = killSwitchState();
    const stop = stopNewEntriesState();
    const mode = getRsiExecutionMode();

    const eligibility = evaluateEntryEligibility({
      utcMs: nowT,
      brokerSessionOpen: session.open,
      dataFresh: session.open === true,
      recoveryComplete: watch.state?.recovery.recoveryComplete ?? false,
      otherBlock: kill.active ? `Kill switch active (${kill.source}).` : stop.active ? `STOP NEW ENTRIES active (${stop.source}).` : mode === 'OFF' ? 'Execution mode is OFF.' : null,
    });
    const clock = evaluateClockSchedule(nowT);
    const liquidationPhase = evaluateLiquidationPhase({ utcMs: nowT, ownedExposureFlat: exposure?.ownedExposureFlat ?? true });

    const engine = watch.state?.engine ?? null;
    const lastDecisions = await this.prisma.xauusdRsiDecision.findMany({
      orderBy: { evaluatedAt: 'desc' },
      take: 20,
    });
    const filled = await this.prisma.xauusdRsiDecision.findMany({
      where: { orderStatus: 'FILLED' },
      orderBy: { filledAt: 'desc' },
      take: 50,
    });
    const liquidationItems = await this.prisma.xauusdRsiLiquidationItem.findMany({
      where: { status: { in: ['OUTSTANDING', 'SUBMITTED', 'FAILED'] } },
      orderBy: { deadlineAt: 'desc' },
      take: 20,
    });
    const heartbeat = accountId ? await this.prisma.collectorHeartbeat.findUnique({ where: { accountId } }) : null;

    return {
      strategy: {
        version: SPEC.strategyVersion,
        specHash: SPEC_HASH,
        symbol: RSI_SYMBOL,
        timeframe: SPEC.timeframe,
        magicNumbers: { RETEST: RSI_MAGIC_RETEST, EXTREME: RSI_MAGIC_EXTREME },
        executionMode: mode,
        isTheOnlyEnabledEntryStrategy: true,
      },

      demo: {
        accountId,
        tradeMode: riskInfo?.tradeMode ?? 'UNKNOWN',
        // Stated plainly: anything other than DEMO blocks every entry.
        demoVerified: riskInfo?.tradeMode === 'DEMO',
        equity: riskInfo?.equity ?? null,
        accountCurrency: riskInfo?.accountCurrency ?? null,
      },

      indicator: {
        period: SPEC.rsi.period,
        appliedPrice: SPEC.rsi.appliedPrice,
        smoothing: SPEC.rsi.smoothing,
        // Provenance, stated rather than implied. Until a recorded parity
        // check against trusted MT5 output exists, this stays "ASSUMED".
        appliedPriceProvenance: 'ASSUMED — MT5 iRSI default; not yet verified against terminal output for this account',
        parityVerified: false,
        currentRsi: engine ? engineRsiNow(engine) : null,
        warmedUp: engine ? engineWarmedUp(engine) : false,
        warmupBarsRequired: SPEC.rsi.period + 1 + SPEC.rsi.warmupBars,
        closedBarsApplied: engine?.closedBarsApplied ?? 0,
        // Reproduced from MT5: a perfectly flat series reads 100, which is
        // inside the extreme-SELL region. Disclosed, not filtered away.
        flatPriceBehaviourNote: 'MT5 reports RSI 100 when average loss is zero, including on a perfectly flat series. This is reproduced faithfully; staleness and gap checks are what prevent a frozen feed from acting on it.',
      },

      thresholds: {
        sell2: SPEC.thresholds.sell2,
        sell1: SPEC.thresholds.sell1,
        buy1: SPEC.thresholds.buy1,
        buy2: SPEC.thresholds.buy2,
        extremeSell: SPEC.thresholds.extremeSellCross,
        extremeBuy: SPEC.thresholds.extremeBuyCross,
        note: 'Buy 1 is 18, replacing the 14 shown in the screenshots. Extreme SELL is 98.5 and extreme BUY is 1.5, each used identically for triggering and rearming.',
      },

      patternState: engine
        ? {
            sellPeakRetest: engine.pattern.sellRetest,
            buyTroughRetest: engine.pattern.buyRetest,
            extremeSell: engine.pattern.extremeSell,
            extremeBuy: engine.pattern.extremeBuy,
            previousRsi: engine.pattern.previousRsi,
            observationCount: engine.pattern.observationCount,
          }
        : null,

      quote: {
        bid: tick?.bid.toNumber() ?? null,
        ask: tick?.ask.toNumber() ?? null,
        tickAt: tick?.tickAt.toISOString() ?? null,
        ageSeconds: session.quoteAgeSeconds,
        fresh: session.open === true,
      },

      observation: {
        mode: engine?.observationMode ?? 'UNKNOWN',
        modeLimitation:
          engine?.observationMode === 'TICK'
            ? 'Ordered broker ticks. A crossing between two ticks the broker never reported is still unobservable; absence of an observed crossing is never treated as proof one did not occur.'
            : engine?.observationMode === 'SAMPLED_INTRABAR'
              ? 'SAMPLED intrabar: periodic quote samples, not every tick. A crossing that occurs and reverses entirely between two samples is invisible to this strategy.'
              : 'Closed-bar only: intrabar crossings cannot be observed at all.',
        ticksApplied: engine?.ticksApplied ?? 0,
        duplicatesRejected: engine?.ticksRejectedDuplicate ?? 0,
        outOfOrderRejected: engine?.ticksRejectedOutOfOrder ?? 0,
        gapResets: engine?.gapResets ?? 0,
        needsReseed: engine?.needsRsiReseed ?? false,
        cursor: watch.state?.cursor ?? null,
      },

      schedule: {
        timeZone: SPEC.schedule.timeZone,
        nowBeirut: beirutLabel(nowT),
        // The distinct states spec §11 requires be distinguishable.
        state: describeScheduleState(eligibility.blockReason, liquidationPhase.phase),
        entriesAllowed: eligibility.entriesAllowed,
        blockReason: eligibility.blockReason,
        detail: eligibility.detail,
        dailyPause: '23:30 (inclusive) to 01:00 (exclusive) Beirut, every day',
        fridayEntryCutoff: '23:00 Beirut, strictly before',
        fridayClosureDeadline: '23:30 Beirut',
        nextEligibleAt: eligibility.nextEligibleAtT ? new Date(eligibility.nextEligibleAtT).toISOString() : null,
        nextEligibleLabel: eligibility.nextEligibleLabel,
        nextFridayDeadline: labelOrNull(nextFridayDeadlineAt(nowT)),
        currentFridayDeadline: labelOrNull(clock.fridayDeadlineT),
        inWeekendWindow: clock.inWeekendWindow,
      },

      brokerSession: { open: session.open, detail: session.detail },

      liquidation: {
        phase: liquidationPhase.phase,
        detail: liquidationPhase.detail,
        deadline: labelOrNull(liquidationPhase.deadlineT),
        outstandingItems: liquidationItems.map((i) => ({
          ticket: i.ticket,
          kind: i.kind,
          status: i.status,
          attempts: i.attempts,
          lastError: i.lastError,
          deadline: i.deadlineAt.toISOString(),
          ownership: describeOwnership(i.magicNumber),
        })),
        // Never "the account is flat" — only ever a statement about what this
        // application owns.
        ownedExposureFlat: exposure?.ownedExposureFlat ?? null,
      },

      exposure: {
        owned: exposure?.ownedItems ?? [],
        // Displayed separately and never closed by this application.
        foreign: exposure?.foreignItems ?? [],
        occupancyBlocksNewEntries: exposure?.anyExposure ?? false,
      },

      order: {
        volumeLots: volume.volumeLots,
        volumeSource: volume.source,
        volumeSourceDetail: volume.sourceDetail,
        defaultVolumeLots: RSI_DEFAULT_VOLUME_LOTS,
        takeProfitUsd: RSI_TP_USD,
        stopLossUsd: RSI_SL_USD,
        pointSize: RSI_GOLD_POINT_SIZE,
        maxEntryDeviationPoints: RSI_MAX_ENTRY_DEVIATION_POINTS,
        brokerConstraints: constraints,
        bracketNote: 'TP and SL are $5 moves in quoted gold price. They are not five broker points and do not guarantee a $5 account-currency result.',
      },

      risk: {
        stopRiskCapPct: RSI_STOP_RISK_CAP_PCT,
        combinedRiskCapPct: RSI_COMBINED_RISK_CAP_PCT,
        dailyLossCapPct: RSI_DAILY_LOSS_CAP_PCT,
        drawdownCapPct: RSI_DRAWDOWN_CAP_PCT,
        current: riskInfo
          ? {
              equity: riskInfo.equity,
              todaysLossAmount: riskInfo.todaysLossAmount,
              currentDrawdownPct: riskInfo.currentDrawdownPct,
              existingCombinedRiskAmount: riskInfo.existingCombinedRiskAmount,
              contractSize: riskInfo.contractSize,
              profitCurrency: riskInfo.profitCurrency,
              conversionRate: riskInfo.profitCurrencyToAccountCurrencyRate,
            }
          : null,
      },

      controls: {
        killSwitchActive: kill.active,
        killSwitchSource: kill.source,
        stopNewEntriesActive: stop.active,
        stopNewEntriesSource: stop.source,
      },

      heartbeats: {
        strategyWatch: watch.heartbeat,
        collector: heartbeat
          ? {
              lastHeartbeatAt: heartbeat.lastHeartbeatAt.toISOString(),
              ageSeconds: (nowT - heartbeat.lastHeartbeatAt.getTime()) / 1000,
              stale: (nowT - heartbeat.lastHeartbeatAt.getTime()) / 1000 > HEARTBEAT_STALE_THRESHOLD_SECONDS,
              mt5Connected: heartbeat.mt5Connected,
              lastError: heartbeat.lastError,
            }
          : { lastHeartbeatAt: null, ageSeconds: null, stale: true, mt5Connected: false, lastError: null },
      },

      recentDecisions: lastDecisions.map((d) => ({
        id: d.id,
        evaluatedAt: d.evaluatedAt.toISOString(),
        observedAt: d.observedAt.toISOString(),
        direction: d.direction,
        setupKinds: d.setupKinds,
        rsi: d.rsiValue.toNumber(),
        previousRsi: d.previousRsi?.toNumber() ?? null,
        entryPrice: d.entryPrice?.toNumber() ?? null,
        stopLoss: d.stopLoss?.toNumber() ?? null,
        takeProfit: d.takeProfit?.toNumber() ?? null,
        volumeLots: d.volumeLots?.toNumber() ?? null,
        orderStatus: d.orderStatus,
        approved: d.approved,
        skipReason: d.skipReason,
        reasoning: d.reasoning,
        ticket: d.mt5Ticket,
        filledPrice: d.filledPrice?.toNumber() ?? null,
        slippagePoints: d.slippagePoints?.toNumber() ?? null,
        brokerStopLoss: d.brokerStopLoss?.toNumber() ?? null,
        brokerTakeProfit: d.brokerTakeProfit?.toNumber() ?? null,
        executionError: d.executionError,
      })),

      confirmedEntries: {
        count: filled.length,
        // Protection as the BROKER reports it, reconciled against what was
        // requested — a mismatch is shown, not smoothed over.
        items: filled.map((d) => ({
          id: d.id,
          ticket: d.mt5Ticket,
          filledAt: d.filledAt?.toISOString() ?? null,
          filledPrice: d.filledPrice?.toNumber() ?? null,
          requestedPrice: d.requestedPrice?.toNumber() ?? null,
          slippagePoints: d.slippagePoints?.toNumber() ?? null,
          requestedStopLoss: d.stopLoss?.toNumber() ?? null,
          brokerStopLoss: d.brokerStopLoss?.toNumber() ?? null,
          requestedTakeProfit: d.takeProfit?.toNumber() ?? null,
          brokerTakeProfit: d.brokerTakeProfit?.toNumber() ?? null,
          protectionMatchesRequest:
            d.brokerStopLoss !== null && d.stopLoss !== null
              ? Math.abs(d.brokerStopLoss.toNumber() - d.stopLoss.toNumber()) < 0.01
              : null,
        })),
      },
    };
  }
}

function labelOrNull(t: number | null): { iso: string; beirut: string } | null {
  return t === null ? null : { iso: new Date(t).toISOString(), beirut: beirutLabel(t) };
}

/** The operator-facing schedule state, as the distinct labels spec §11 lists. */
function describeScheduleState(blockReason: string | null, liquidation: string): string {
  if (liquidation === 'DEADLINE_MISSED') return 'FRIDAY_CLOSURE_DEADLINE_MISSED';
  if (liquidation === 'IN_PROGRESS') return 'FRIDAY_LIQUIDATION_IN_PROGRESS';
  if (liquidation === 'CONFIRMED_FLAT' && blockReason === 'FRIDAY_ENTRY_CUTOFF') return 'FRIDAY_LIQUIDATION_CONFIRMED';
  if (blockReason === null) return 'ELIGIBLE_FOR_NEW_ENTRIES';
  if (blockReason === 'DAILY_PAUSE') return 'DAILY_PAUSE_2330_0100_BEIRUT';
  if (blockReason === 'FRIDAY_ENTRY_CUTOFF') return 'FRIDAY_ENTRY_CUTOFF_REACHED_OR_WEEKEND';
  if (blockReason === 'BROKER_SESSION_NOT_CONFIRMED_OPEN') return 'WEEKEND_OR_BROKER_CLOSURE';
  return 'OTHER_EXECUTION_BLOCK';
}

/**
 * Reads the standalone watch process's own state file.
 *
 * That process is NOT part of this Nest application — it is started manually
 * and runs on its own — so this is a live read of its on-disk state, not a
 * service call. A cycle timestamp older than the staleness threshold is
 * reported as stale: a dead process's last cycle must never look like
 * current health.
 */
function readWatchState(): {
  state: RsiWatchState | null;
  heartbeat: { lastCycleAtUtc: string | null; ageSeconds: number | null; stale: boolean; running: boolean; detail: string };
} {
  const statePath = join(defaultStateDir(), 'xauusd-rsi-watch-state.json');
  if (!existsSync(statePath)) {
    return {
      state: null,
      heartbeat: { lastCycleAtUtc: null, ageSeconds: null, stale: true, running: false, detail: 'No watch state file — the strategy watch process has never run in this environment.' },
    };
  }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as RsiWatchState;
    const last = state.recovery?.lastCycleAtUtc ?? null;
    const ageSeconds = last ? (Date.now() - new Date(last).getTime()) / 1000 : null;
    const stale = ageSeconds === null || ageSeconds > HEARTBEAT_STALE_THRESHOLD_SECONDS;
    return {
      state,
      heartbeat: {
        lastCycleAtUtc: last,
        ageSeconds,
        stale,
        running: !stale,
        detail: stale
          ? `Last cycle ${last ?? 'never'} — older than ${HEARTBEAT_STALE_THRESHOLD_SECONDS}s, so the watch process is NOT considered running.`
          : `Last cycle ${last}.`,
      },
    };
  } catch (err) {
    return {
      state: null,
      heartbeat: { lastCycleAtUtc: null, ageSeconds: null, stale: true, running: false, detail: `Watch state unreadable: ${err instanceof Error ? err.message : err}` },
    };
  }
}

export type { EngineState };
