import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { AccountsService } from '../accounts/accounts.service';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AutonomousDecisionLoggerService } from '../autonomous/autonomous-decision-logger.service';
import { ExecutionResultDto } from '../autonomous/dto/execution-result.dto';
import { GoldPreSendGuardService } from './gold-pre-send-guard.service';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldCloseExecutionService } from './gold-close-execution.service';
import { GOLD_MAGIC_NUMBER, GOLD_POINT_SIZE, GOLD_SYMBOL, GOLD_VOLUME_LOTS } from './gold-safety-constants';

/** What the collector reports back after attempting a claimed close request (runner.py's OrderResult, over the wire). */
class GoldCloseResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsInt() dealTicket?: number;
  @IsOptional() @IsNumber() closedPrice?: number;
  @IsOptional() @IsString() errorMessage?: string;
}

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
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldAiSummary: GoldAiSummaryService,
    private readonly closeExecution: GoldCloseExecutionService,
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
      void this.goldTelegram.notify(
        'SUBMISSION_REJECTED',
        `reject:${decision.id}`,
        `GOLD DEMO — order cancelled at pre-send check (never sent to broker). decision=${decision.id} reason=${preSend.reason}`,
      );
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
        // The SAME volume snapshot the risk gate approved this decision
        // against (persisted on the row at evaluation time, in
        // gold-execution-coordinator.service.ts) — never a fresh read of
        // live runtime settings here, which could have changed since
        // evaluation and would then submit a volume risk was never actually
        // computed against. Falls back to the frozen GOLD_VOLUME_LOTS
        // constant only for a pre-existing row from before this column
        // existed (decision.volumeLots null).
        volume: decision.volumeLots?.toNumber() ?? GOLD_VOLUME_LOTS,
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

    // Broker-confirmed fill, or a rejected/unknown submission — plain factual
    // notification, dedup'd on decisionId+result so a duplicate collector
    // report (e.g. a retried POST) never sends twice. Fire-and-forget: a
    // Telegram outage must never fail this endpoint's response to the
    // collector (recordExecutionResult above has already durably persisted
    // the real outcome regardless of whether this notification succeeds).
    if (dto.ok) {
      const text = `GOLD DEMO — order filled. decision=${decisionId} ticket=${dto.ticket ?? 'n/a'} filledPrice=${dto.filledPrice ?? 'n/a'}`;
      void this.goldTelegram.notify('FILL_CONFIRMED', `fill:${decisionId}`, text);
      void this.goldAiSummary.generateForEvent('FILL_CONFIRMED', new Date().toISOString(), text);
    } else {
      const text = `GOLD DEMO — order rejected/failed. decision=${decisionId} error=${dto.errorMessage ?? 'unknown'}`;
      void this.goldTelegram.notify('SUBMISSION_REJECTED', `reject:${decisionId}`, text);
    }

    return { ok: true };
  }

  // --- Close-request poll/report — task item 2. Symmetric to the open pair
  // above but for GoldCloseRequest rows (created by GoldControlsController's
  // requestClose, gold-controls.controller.ts). ---

  @Get('close-request')
  async getCloseRequest(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const request = await this.closeExecution.claimOldestPendingRequest(accountId);
    if (!request) return { request: null };

    return {
      request: {
        requestId: request.id,
        ticket: Number(request.positionTicket),
        side: request.side,
        volume: request.volume.toNumber(),
        symbol: request.symbol,
      },
    };
  }

  @Post('close-request/:requestId/result')
  async postCloseResult(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: GoldCloseResultDto,
  ) {
    await this.accounts.getOrThrow(accountId);
    await this.closeExecution.recordResult(requestId, {
      ok: dto.ok,
      dealTicket: dto.dealTicket ?? null,
      closedPrice: dto.closedPrice ?? null,
      errorMessage: dto.errorMessage ?? null,
    });

    // "closed" is reported ONLY here, ONLY when dto.ok is a broker-confirmed
    // success from executor.py's close_position — never at request-creation
    // time (gold-controls.controller.ts's CLOSE_REQUESTED notification is
    // explicitly a different, earlier, "request sent" event).
    if (dto.ok) {
      void this.goldTelegram.notify(
        'CLOSE_CONFIRMED',
        `close-confirmed:${requestId}`,
        `GOLD DEMO — position closed (broker-confirmed). request=${requestId} dealTicket=${dto.dealTicket ?? 'n/a'} closedPrice=${dto.closedPrice ?? 'n/a'}`,
      );
    } else {
      void this.goldTelegram.notify(
        'CLOSE_FAILED',
        `close-failed:${requestId}`,
        `GOLD DEMO — close request FAILED at the broker. request=${requestId} error=${dto.errorMessage ?? 'unknown'}. Position may still be open — verify manually.`,
      );
    }

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
