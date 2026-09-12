import { Injectable } from '@nestjs/common';
import { AutonomousDecisionAction, AutonomousOrderStatus, Prisma, TrendBreakoutInstrument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GateResult } from './gate-result';

/**
 * §12 — writes the full observability record for every H1 signal-candle
 * evaluation (HOLD included). One row per (account, strategy version,
 * instrument, signal-close timestamp) — see `TrendBreakoutDecision`'s own
 * schema comment for why that tuple is both the durable signal identity
 * AND the idempotency guard.
 */
export interface LogDecisionInput {
  accountId: string;
  strategyVersion: string;
  instrument: TrendBreakoutInstrument;
  signalCloseAt: Date;
  decisionAtUtc: Date;
  decisionAtBeirut: string;
  action: AutonomousDecisionAction;
  h4Close: number | null;
  h4Ema50: number | null;
  h4Ema200: number | null;
  h1RangeHigh: number | null;
  h1RangeLow: number | null;
  h1SignalClose: number | null;
  h1SignalHigh: number | null;
  h1SignalLow: number | null;
  atr14: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  quoteAt: Date | null;
  volumeUsed: number | null;
  volumeConfigVersion: number | null;
  riskPolicyVersion: number | null;
  estimatedStopRiskAmount: number | null;
  estimatedStopRiskCcy: string | null;
  intendedEntryPrice: number | null;
  intendedStopLoss: number | null;
  intendedTakeProfit: number | null;
  gateResults: GateResult[];
  rejectionReason: string | null;
  orderStatus: AutonomousOrderStatus;
}

@Injectable()
export class TrendBreakoutDecisionLoggerService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: LogDecisionInput) {
    return this.prisma.trendBreakoutDecision.create({
      data: {
        accountId: input.accountId,
        strategyVersion: input.strategyVersion,
        instrument: input.instrument,
        signalCloseAt: input.signalCloseAt,
        decisionAtUtc: input.decisionAtUtc,
        decisionAtBeirut: input.decisionAtBeirut,
        action: input.action,
        h4CloseAt: input.h4Close,
        h4Ema50: input.h4Ema50,
        h4Ema200: input.h4Ema200,
        h1RangeHigh: input.h1RangeHigh,
        h1RangeLow: input.h1RangeLow,
        h1SignalClose: input.h1SignalClose,
        h1SignalHigh: input.h1SignalHigh,
        h1SignalLow: input.h1SignalLow,
        atr14: input.atr14,
        bid: input.bid,
        ask: input.ask,
        spreadPoints: input.spreadPoints,
        quoteAt: input.quoteAt,
        volumeUsed: input.volumeUsed,
        volumeConfigVersion: input.volumeConfigVersion,
        riskPolicyVersion: input.riskPolicyVersion,
        estimatedStopRiskAmount: input.estimatedStopRiskAmount,
        estimatedStopRiskCcy: input.estimatedStopRiskCcy,
        intendedEntryPrice: input.intendedEntryPrice,
        intendedStopLoss: input.intendedStopLoss,
        intendedTakeProfit: input.intendedTakeProfit,
        gateResults: input.gateResults as unknown as Prisma.InputJsonValue,
        rejectionReason: input.rejectionReason,
        orderStatus: input.orderStatus,
      },
    });
  }

  async recent(accountId: string, instrument?: TrendBreakoutInstrument, limit = 50) {
    return this.prisma.trendBreakoutDecision.findMany({
      where: { accountId, ...(instrument ? { instrument } : {}) },
      orderBy: { decisionAtUtc: 'desc' },
      take: limit,
    });
  }
}
