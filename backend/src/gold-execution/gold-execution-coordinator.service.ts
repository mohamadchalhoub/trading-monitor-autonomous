import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isKillSwitchActive } from '../autonomous/kill-switch';
import { getGoldExecutionMode, isStopNewEntriesActive } from './gold-execution-mode';
import { GoldAccountRiskInfo, GoldBrokerVolumeConstraints, GoldCandidateOrder, GoldOccupancyState, evaluateGoldRiskManager } from './gold-risk-manager';
import { GOLD_SYMBOL, GOLD_TP_SL_POINTS } from './gold-safety-constants';

export interface GoldSignal {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  /** The price the confirmed-retest-v2-derived event fired at. */
  signalEntryPrice: number;
  /** The freshest executable price available right now (bid/ask side matching `action`). */
  currentExecutablePrice: number;
  levelId: string;
  reasoning: string;
}

export interface GoldCoordinatorContext {
  accountId: string;
  accountInfo: GoldAccountRiskInfo;
  occupancy: GoldOccupancyState;
  volumeConstraints: GoldBrokerVolumeConstraints;
  maxEntryDeviationPoints: number;
  goldPointSize: number;
}

export interface GoldCoordinatorResult {
  mode: 'OFF' | 'SHADOW' | 'DEMO';
  stopNewEntriesActive: boolean;
  verdict: ReturnType<typeof evaluateGoldRiskManager> | null;
  queuedDecisionId: string | null;
}

/**
 * The mechanical-signal analog of `AutonomousExecutionCoordinatorService`
 * (which is AI-decision-driven, EURUSD-only): turns a confirmed-retest-v2-
 * derived gold event into either a queued PENDING order (DEMO mode only,
 * after the independent risk gate approves) or a logged-only decision
 * (SHADOW), or nothing at all (OFF). Deliberately has no scheduler of its
 * own, same deliberate posture as the EURUSD coordinator's own header
 * comment — something else must call `evaluate()` on a real signal; it is
 * never invoked speculatively or on a timer here.
 *
 * STOP NEW ENTRIES is re-read via `isStopNewEntriesActive()` a SECOND time,
 * immediately before the DB write, not only once at the top of `evaluate` —
 * per the task's explicit requirement that it be rechecked immediately
 * before sending.
 */
@Injectable()
export class GoldExecutionCoordinatorService {
  private readonly logger = new Logger(GoldExecutionCoordinatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(signal: GoldSignal, context: GoldCoordinatorContext): Promise<GoldCoordinatorResult> {
    const mode = getGoldExecutionMode();
    const stopNewEntriesActive = isStopNewEntriesActive();

    if (mode === 'OFF') {
      this.logger.log(`GOLD_EXECUTION_MODE=OFF — not evaluating signal for level ${signal.levelId}`);
      return { mode, stopNewEntriesActive, verdict: null, queuedDecisionId: null };
    }

    const entryDeviationPoints =
      Math.abs(signal.currentExecutablePrice - signal.signalEntryPrice) / context.goldPointSize;

    const entryPrice = signal.currentExecutablePrice; // always price the bracket off the live executable price, never the stale signal price
    const stopLoss = signal.action === 'OPEN_BUY' ? entryPrice - GOLD_TP_SL_POINTS * context.goldPointSize : entryPrice + GOLD_TP_SL_POINTS * context.goldPointSize;
    const takeProfit = signal.action === 'OPEN_BUY' ? entryPrice + GOLD_TP_SL_POINTS * context.goldPointSize : entryPrice - GOLD_TP_SL_POINTS * context.goldPointSize;

    const candidate: GoldCandidateOrder = {
      action: signal.action,
      entryPrice,
      stopLoss,
      takeProfit,
      stopLossDistancePoints: GOLD_TP_SL_POINTS,
      takeProfitDistancePoints: GOLD_TP_SL_POINTS,
    };

    const verdict = evaluateGoldRiskManager({
      candidate,
      accountInfo: context.accountInfo,
      occupancy: context.occupancy,
      volumeConstraints: context.volumeConstraints,
      killSwitchActive: isKillSwitchActive(),
      entryDeviationPoints,
      maxEntryDeviationPoints: context.maxEntryDeviationPoints,
    });

    const inputSnapshot = { signal, context, mode, entryDeviationPoints };

    if (mode === 'SHADOW') {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId,
          symbol: GOLD_SYMBOL,
          action: signal.action,
          source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          reasoning: signal.reasoning,
          inputSnapshot: inputSnapshot as any,
          riskManagerApproved: verdict.approved,
          riskManagerRejectionReason: verdict.rejectionReason,
          orderStatus: 'NONE', // SHADOW never queues a real order, regardless of verdict
        },
      });
      this.logger.log(`SHADOW: logged decision ${row.id} (approved=${verdict.approved}) — no order queued`);
      return { mode, stopNewEntriesActive, verdict, queuedDecisionId: null };
    }

    // mode === 'DEMO' from here on.
    if (!verdict.approved) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit,
          reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
          riskManagerApproved: false, riskManagerRejectionReason: verdict.rejectionReason, orderStatus: 'NONE',
        },
      });
      this.logger.warn(`DEMO mode but risk gate rejected: ${verdict.rejectionReason}`);
      return { mode, stopNewEntriesActive, verdict, queuedDecisionId: row.id };
    }

    // Recheck immediately before queuing, per task requirement — a value read at the top of this method is not trusted here.
    if (isStopNewEntriesActive()) {
      const row = await this.prisma.autonomousDecision.create({
        data: {
          accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
          entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit,
          reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
          riskManagerApproved: true, riskManagerRejectionReason: 'STOP NEW ENTRIES was active at send time — not queued despite risk-gate approval.',
          orderStatus: 'NONE',
        },
      });
      this.logger.warn('Risk gate approved but STOP NEW ENTRIES is active — not queuing.');
      return { mode, stopNewEntriesActive: true, verdict, queuedDecisionId: row.id };
    }

    const row = await this.prisma.autonomousDecision.create({
      data: {
        accountId: context.accountId, symbol: GOLD_SYMBOL, action: signal.action, source: 'RULES_ONLY',
        entryPrice: candidate.entryPrice, stopLoss: candidate.stopLoss, takeProfit: candidate.takeProfit,
        reasoning: signal.reasoning, inputSnapshot: inputSnapshot as any,
        riskManagerApproved: true, riskManagerRejectionReason: null, orderStatus: 'PENDING',
      },
    });
    this.logger.log(`DEMO: queued gold order ${row.id} for collector pickup`);
    return { mode, stopNewEntriesActive, verdict, queuedDecisionId: row.id };
  }
}
