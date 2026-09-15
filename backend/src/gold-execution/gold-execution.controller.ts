import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AutonomousDecisionLoggerService } from '../autonomous/autonomous-decision-logger.service';
import { ExecutionResultDto } from '../autonomous/dto/execution-result.dto';
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
  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: AutonomousDecisionLoggerService,
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
