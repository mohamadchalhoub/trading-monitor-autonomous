import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AutonomousDecisionLoggerService } from '../autonomous/autonomous-decision-logger.service';
import { ExecutionResultDto } from '../autonomous/dto/execution-result.dto';
import { GoldPreSendGuardService } from './gold-pre-send-guard.service';
import { GOLD_MAGIC_NUMBER, GOLD_POINT_SIZE, GOLD_SYMBOL, GOLD_VOLUME_LOTS } from './gold-safety-constants';

/**
 * Gold's OWN collector-facing poll/report route — deliberately separate
 * from AutonomousExecutionController (EURUSD), not a symbol parameter on
 * the same route, so the two strategies' wire contracts can never be
 * confused at the HTTP layer either. Shares the same underlying
 * AutonomousDecision table/logger (symbol='XAUUSD' rows) and the same
 * CollectorTokenGuard/account-scoped URL convention as every other
 * collector-facing route, but claims and serves ONLY XAUUSD rows
 * (see the required `symbol` argument added to `claimOldestPendingOrder`).
 */
@Controller('collector/:accountId/gold-execution')
@UseGuards(CollectorTokenGuard)
export class GoldExecutionController {
  private readonly preSendLogger = new Logger(GoldExecutionController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: AutonomousDecisionLoggerService,
    private readonly preSendGuard: GoldPreSendGuardService,
  ) {}

  @Get('pending-order')
  async getPendingOrder(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const decision = await this.logger.claimOldestPendingOrder(accountId, GOLD_SYMBOL);
    if (!decision || decision.entryPrice === null || decision.stopLoss === null || decision.takeProfit === null) {
      return { order: null };
    }

    const entryPrice = decision.entryPrice.toNumber();
    const stopLoss = decision.stopLoss.toNumber();
    const takeProfit = decision.takeProfit.toNumber();

    // Final re-verification, immediately before handing off to the collector — the atomic claim
    // above only proves nobody else claimed this row; it says nothing about whether window,
    // kill switch, price deviation, or occupancy are STILL valid after however long this row sat
    // PENDING plus the collector's own poll delay. This decision is already SENT at this point
    // (the claim flipped it), so a failure here must explicitly cancel it, not just skip it.
    const touchEndT = extractTouchEndT(decision.inputSnapshot);
    const preSend = await this.preSendGuard.check({
      decisionId: decision.id,
      accountId,
      action: decision.action === 'OPEN_BUY' ? 'OPEN_BUY' : 'OPEN_SELL',
      entryPrice,
      touchEndT,
    });
    if (!preSend.ok) {
      this.preSendLogger.warn(`gold decision ${decision.id}: failed pre-send re-verification, cancelling instead of sending — ${preSend.reason}`);
      await this.logger.recordExecutionResult(decision.id, { ok: false, errorMessage: `Cancelled at pre-send check: ${preSend.reason}` });
      return { order: null };
    }

    return {
      order: {
        decisionId: decision.id,
        side: decision.action === 'OPEN_BUY' ? 'BUY' : 'SELL',
        // Hardcoded, gold-specific safety constants — re-derived from the
        // already-validated absolute prices using GOLD's own point size,
        // never EURUSD's `priceDistanceInPoints` (which divides by
        // EURUSD_POINT_SIZE and would silently produce a wildly wrong
        // points figure for a $-denominated gold price distance).
        volume: GOLD_VOLUME_LOTS,
        stopLossPoints: goldPriceDistanceInPoints(entryPrice, stopLoss),
        takeProfitPoints: goldPriceDistanceInPoints(entryPrice, takeProfit),
        magic: GOLD_MAGIC_NUMBER,
        symbol: GOLD_SYMBOL,
        pointSize: GOLD_POINT_SIZE,
        comment: `gold-${decision.id.slice(0, 8)}`,
      },
    };
  }

  @Post('pending-order/:decisionId/result')
  async postResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() dto: ExecutionResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.logger.recordExecutionResult(decisionId, dto);
    return { ok: true };
  }
}

function goldPriceDistanceInPoints(priceA: number, priceB: number): number {
  return Math.round((Math.abs(priceA - priceB) / GOLD_POINT_SIZE) * 1e6) / 1e6;
}

/**
 * `inputSnapshot` is this coordinator's own JSON, shaped by
 * `GoldExecutionCoordinatorService.evaluate()`'s `inputSnapshot = { signal, context, mode, ... }`
 * — `signal.touchEndT` is always present on a genuinely-queued decision.
 * Returns null (never a guessed fallback) for anything else, so the guard
 * fails closed rather than assume freshness it cannot actually verify.
 */
function extractTouchEndT(inputSnapshot: unknown): number | null {
  if (typeof inputSnapshot !== 'object' || inputSnapshot === null) return null;
  const signal = (inputSnapshot as Record<string, unknown>).signal;
  if (typeof signal !== 'object' || signal === null) return null;
  const touchEndT = (signal as Record<string, unknown>).touchEndT;
  return typeof touchEndT === 'number' && Number.isFinite(touchEndT) ? touchEndT : null;
}
