/**
 * Atomic claim and durable result recording for queued XAUUSD RSI orders,
 * plus the final pre-send re-verification.
 *
 * Two separate concerns deliberately kept in one place because they share the
 * same invariant: a decision is claimed exactly once, and whatever happens
 * after the claim is recorded durably, including "we do not know".
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RsiAccountStateService } from './account-state.service';
import { entriesBlockedByControls } from './controls';
import { evaluateEntryEligibility } from './schedule';
import {
  RSI_GOLD_POINT_SIZE,
  RSI_MAX_ENTRY_DEVIATION_POINTS,
  RSI_MAX_SIGNAL_AGE_SECONDS,
  RSI_SYMBOL,
} from './safety-constants';

export interface RsiExecutionResult {
  ok: boolean;
  ticket?: number | null;
  filledPrice?: number | null;
  /** SL/TP the broker actually reports on the resulting position. */
  brokerStopLoss?: number | null;
  brokerTakeProfit?: number | null;
  errorMessage?: string | null;
  /** True when the broker's response was lost or ambiguous — outcome genuinely unknown. */
  uncertain?: boolean;
}

export interface RsiPreSendCheckResult {
  ok: boolean;
  reason: string | null;
}

@Injectable()
export class RsiDecisionService {
  private readonly logger = new Logger(RsiDecisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: RsiAccountStateService,
  ) {}

  /**
   * Atomic PENDING -> SENT claim. The conditional `updateMany` is what makes
   * it safe: two concurrent pollers both read the same candidate, but only
   * one update matches a row still in PENDING, and the loser gets null.
   */
  async claimOldestPendingOrder(accountId: string) {
    const candidate = await this.prisma.xauusdRsiDecision.findFirst({
      where: { accountId, symbol: RSI_SYMBOL, orderStatus: 'PENDING' },
      orderBy: { evaluatedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.xauusdRsiDecision.updateMany({
      where: { id: candidate.id, orderStatus: 'PENDING' },
      data: { orderStatus: 'SENT' },
    });
    if (claimed.count === 0) return null;

    return candidate;
  }

  /**
   * Records the broker's reported outcome.
   *
   * An uncertain result becomes `UNKNOWN`, never `FAILED`: a lost response
   * does not mean the order did not reach the broker, and treating it as a
   * failure would free the occupancy slot for a second position while the
   * first may well be open. `UNKNOWN` keeps the slot occupied until
   * reconciliation against real broker state resolves it.
   */
  async recordExecutionResult(decisionId: string, result: RsiExecutionResult): Promise<void> {
    const requested = await this.prisma.xauusdRsiDecision.findUnique({ where: { id: decisionId } });
    const requestedPrice = requested?.requestedPrice?.toNumber() ?? requested?.entryPrice?.toNumber() ?? null;
    const filledPrice = result.filledPrice ?? null;
    const slippagePoints =
      requestedPrice !== null && filledPrice !== null
        ? Math.abs(filledPrice - requestedPrice) / RSI_GOLD_POINT_SIZE
        : null;

    const orderStatus = result.uncertain ? 'UNKNOWN' : result.ok ? 'FILLED' : 'FAILED';

    await this.prisma.xauusdRsiDecision.update({
      where: { id: decisionId },
      data: {
        orderStatus,
        mt5Ticket: result.ticket ?? null,
        filledPrice,
        slippagePoints,
        brokerStopLoss: result.brokerStopLoss ?? null,
        brokerTakeProfit: result.brokerTakeProfit ?? null,
        filledAt: result.ok && !result.uncertain ? new Date() : null,
        executionError: result.errorMessage ?? null,
      },
    });
    this.logger.log(`decision ${decisionId}: ${orderStatus}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);
  }

  /** Marks a claimed decision as never-sent, with the reason it was cancelled. */
  async cancelClaimed(decisionId: string, reason: string): Promise<void> {
    await this.prisma.xauusdRsiDecision.update({
      where: { id: decisionId },
      data: { orderStatus: 'NONE', approved: false, skipReason: reason, executionError: null },
    });
    this.logger.warn(`decision ${decisionId} cancelled at pre-send: ${reason}`);
  }

  /**
   * The final gate, run AFTER the atomic claim but BEFORE the order is handed
   * to the collector.
   *
   * The claim proves only that nobody else took this row. It says nothing
   * about whether the schedule, the controls, the price or the occupancy are
   * still valid after however long the row sat PENDING plus the collector's
   * own poll delay. Spec §9.2 is explicit that the Friday cutoff must be
   * rechecked "at the actual submission boundary" — this is that boundary.
   *
   * "Now" is taken from the freshest live quote rather than the process
   * clock, so a stale or absent feed fails the check for an honest reason
   * instead of passing against a running clock with dead market data behind it.
   */
  async preSendCheck(params: {
    decisionId: string;
    accountId: string;
    action: 'OPEN_BUY' | 'OPEN_SELL';
    entryPrice: number;
    observedAtT: number;
  }): Promise<RsiPreSendCheckResult> {
    const { decisionId, accountId, action, entryPrice, observedAtT } = params;

    const controlBlock = entriesBlockedByControls();
    if (controlBlock) {
      return { ok: false, reason: `Refusing to send at the final pre-send check — ${controlBlock}` };
    }

    const tick = await this.prisma.liveTick.findUnique({ where: { symbol: RSI_SYMBOL } });
    if (!tick) {
      return { ok: false, reason: 'No live XAUUSD quote at send time — refusing to send blind.' };
    }
    const nowT = tick.tickAt.getTime();

    const session = await this.accountState.resolveBrokerSessionOpen(new Date());
    const eligibility = evaluateEntryEligibility({
      utcMs: nowT,
      brokerSessionOpen: session.open,
      dataFresh: session.open === true,
      recoveryComplete: true,
      otherBlock: null,
    });
    if (!eligibility.entriesAllowed) {
      return {
        ok: false,
        reason: `Schedule/session no longer permits an entry at send time (${eligibility.blockReason}): ${eligibility.detail}`,
      };
    }

    const signalAgeSeconds = (nowT - observedAtT) / 1000;
    if (!Number.isFinite(observedAtT)) {
      return { ok: false, reason: 'Cannot verify signal freshness at send time — the observation timestamp is missing. Refusing rather than assuming freshness.' };
    }
    if (signalAgeSeconds > RSI_MAX_SIGNAL_AGE_SECONDS) {
      return { ok: false, reason: `Signal is ${signalAgeSeconds.toFixed(1)}s old at send time (limit ${RSI_MAX_SIGNAL_AGE_SECONDS}s) — refusing to send a stale entry.` };
    }

    const currentExecutablePrice = action === 'OPEN_BUY' ? tick.ask.toNumber() : tick.bid.toNumber();
    const deviationPoints = Math.abs(currentExecutablePrice - entryPrice) / RSI_GOLD_POINT_SIZE;
    if (deviationPoints > RSI_MAX_ENTRY_DEVIATION_POINTS) {
      return { ok: false, reason: `Executable price moved ${deviationPoints.toFixed(1)}pt since queuing (limit ${RSI_MAX_ENTRY_DEVIATION_POINTS}pt) — refusing to send, not chasing.` };
    }

    const occupancy = await this.accountState.resolveOccupancy(accountId, decisionId);
    if (occupancy.hasExistingXauusdExposure) {
      return { ok: false, reason: `XAUUSD exposure appeared since queuing (${occupancy.exposureDescription}) — refusing to send a second position.` };
    }

    const riskInfo = await this.accountState.resolveAccountRiskInfo(accountId);
    if (riskInfo.tradeMode !== 'DEMO') {
      return { ok: false, reason: `Account trade_mode is now "${riskInfo.tradeMode}", not DEMO — refusing to send. This is an absolute, non-negotiable safety rule.` };
    }

    return { ok: true, reason: null };
  }
}
