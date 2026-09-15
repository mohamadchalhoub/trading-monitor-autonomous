import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GOLD_SYMBOL, GOLD_TP_SL_POINTS } from './gold-safety-constants';

const MAX_RESTORE_ATTEMPTS = 3;

export interface GoldProtectionRestoreResult {
  ok: boolean;
  errorMessage?: string | null;
}

/**
 * Task item 3, corrected — "restore-then-close," the RESTORE half. On a
 * missing-protection incident, this queues a request to re-attach SL/TP at
 * the FROZEN `GOLD_TP_SL_POINTS` distance from the position's own entry
 * price (never a different distance/policy — same constant every fill
 * already uses). The collector's own poll/claim/report cycle
 * (`GoldExecutionController.getRestoreProtectionRequest`/
 * `postRestoreProtectionResult`) executes it via `executor.py`'s new
 * `modify_protection` (TRADE_ACTION_SLTP). A FAILED attempt with retries
 * remaining creates a NEW PENDING row for the next attempt — the natural
 * ~poll-interval gap between collector polls IS the "brief backoff,"
 * consistent with every other retry in this codebase being poll-cycle-
 * driven rather than a sleep-based loop. After `MAX_RESTORE_ATTEMPTS`
 * consecutive failures, `GoldProtectionMonitorService` (the caller) falls
 * back to `GoldCloseExecutionService`.
 */
@Injectable()
export class GoldProtectionRestoreService {
  private readonly logger = new Logger(GoldProtectionRestoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  async requestRestore(params: {
    accountId: string;
    positionTicket: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    goldPointSize: number;
  }): Promise<{ id: string }> {
    const { stopLoss, takeProfit } = computeFrozenProtection(params.side, params.entryPrice, params.goldPointSize);
    const row = await this.prisma.goldProtectionRestoreRequest.create({
      data: {
        accountId: params.accountId,
        symbol: GOLD_SYMBOL,
        positionTicket: params.positionTicket,
        side: params.side,
        stopLoss,
        takeProfit,
        attemptNumber: 1,
        maxAttempts: MAX_RESTORE_ATTEMPTS,
      },
    });
    return { id: row.id };
  }

  async claimOldestPendingRequest(accountId: string) {
    const candidate = await this.prisma.goldProtectionRestoreRequest.findFirst({
      where: { accountId, status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.goldProtectionRestoreRequest.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return candidate;
  }

  /**
   * Returns `{ exhausted: true }` when this was the last permitted attempt
   * and it also failed — the caller (protection monitor) is responsible for
   * falling back to a close request in that case, never this service
   * (keeps "restore" and "close" as two separately-testable concerns).
   */
  async recordResult(requestId: string, result: GoldProtectionRestoreResult): Promise<{ exhausted: boolean }> {
    const request = await this.prisma.goldProtectionRestoreRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      this.logger.error(`recordResult: no GoldProtectionRestoreRequest found for id=${requestId}`);
      return { exhausted: false };
    }

    if (result.ok) {
      await this.prisma.goldProtectionRestoreRequest.update({
        where: { id: requestId },
        data: { status: 'RESTORED', restoredAt: new Date() },
      });
      this.logger.log(`gold protection restore ${requestId}: RESTORED (attempt ${request.attemptNumber}/${request.maxAttempts})`);
      return { exhausted: false };
    }

    await this.prisma.goldProtectionRestoreRequest.update({
      where: { id: requestId },
      data: { status: 'FAILED', resultError: result.errorMessage ?? null },
    });

    const nextAttempt = request.attemptNumber + 1;
    if (nextAttempt > request.maxAttempts) {
      this.logger.warn(`gold protection restore ${requestId}: FAILED, attempt ${request.attemptNumber}/${request.maxAttempts} was the last one — exhausted`);
      return { exhausted: true };
    }

    // Queue the next attempt — same target SL/TP price (frozen distance
    // from entry, which never changes), fresh row for full attempt history.
    await this.prisma.goldProtectionRestoreRequest.create({
      data: {
        accountId: request.accountId,
        symbol: request.symbol,
        positionTicket: request.positionTicket,
        side: request.side,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        attemptNumber: nextAttempt,
        maxAttempts: request.maxAttempts,
      },
    });
    this.logger.warn(`gold protection restore ${requestId}: FAILED, queuing attempt ${nextAttempt}/${request.maxAttempts}`);
    return { exhausted: false };
  }
}

/** Same formula as gold-execution-coordinator.service.ts's own bracket pricing — frozen distance, never a different one. */
export function computeFrozenProtection(side: 'BUY' | 'SELL', entryPrice: number, goldPointSize: number): { stopLoss: number; takeProfit: number } {
  const offset = GOLD_TP_SL_POINTS * goldPointSize;
  return side === 'BUY'
    ? { stopLoss: entryPrice - offset, takeProfit: entryPrice + offset }
    : { stopLoss: entryPrice + offset, takeProfit: entryPrice - offset };
}
