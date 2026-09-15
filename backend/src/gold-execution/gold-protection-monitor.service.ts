import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingPositionDto } from '../collector-ingress/dto/snapshot.dto';
import { GOLD_MAGIC_NUMBER, GOLD_POINT_SIZE, GOLD_SYMBOL } from './gold-safety-constants';
import { GoldTelegramService } from './gold-telegram.service';
import { GoldAiSummaryService } from './gold-ai-summary.service';
import { GoldProtectionRestoreService } from './gold-protection-restore.service';

/**
 * Task item C — protective SL/TP verification against ACTUAL broker
 * position data (not just "was requested"). Runs on every
 * `/collector/snapshot` ingestion cycle (same reconciliation posture as
 * `GoldClosureReconciliationService`, task item B — a plain step on the
 * existing poll cycle, not a queued job), reading `stopLoss`/`takeProfit`
 * straight off the same `IncomingPositionDto` the collector already sends
 * every push (`gold-account-state.service.ts`/`gold-dashboard.controller.ts`
 * already consume this same feed for other purposes — this is not a new
 * data source). Covers BOTH "unprotected right after a fill" (the position
 * simply appears unprotected on its very first reported snapshot) and
 * "previously protected, lost protection later" (the same check re-run on
 * every subsequent cycle) with one mechanism.
 *
 * MT5 convention: 0 (or absent) means "no stop set" — both null and 0 are
 * treated as unprotected, matching how MT5 itself represents "no SL/TP" on
 * a position.
 *
 * REMEDIATION (task item 3, corrected — "restore-then-close," NOT
 * direct-close-only): on a NEW missing-protection incident, this queues a
 * `GoldProtectionRestoreRequest` (`GoldProtectionRestoreService`) to
 * re-attach SL/TP at the FROZEN distance from the position's own entry
 * price — the same mechanism every fill already uses. Only after that
 * restore path is exhausted (bounded retries, all failed — decided by
 * `GoldExecutionController.postRestoreProtectionResult`, which then falls
 * back to `GoldCloseExecutionService`) is the position actually closed.
 * This class itself never calls close directly; it only ever starts the
 * restore attempt.
 *
 * Transition-only alerting (not a resend every ~10s while unprotected):
 * reads the most recent `GoldTelegramNotification` row for this position
 * (`dedupKey` prefixed `protection:<positionId>:`) to know the
 * last-announced state, entirely from Postgres — no in-memory state, so
 * this survives a process restart exactly like B's dedup does. A fresh
 * incident (state flips OK -> missing, or missing -> OK) gets a
 * timestamp-suffixed dedupKey so it is never silently swallowed by an
 * earlier, already-resolved incident's row.
 */
@Injectable()
export class GoldProtectionMonitorService {
  private readonly logger = new Logger(GoldProtectionMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goldTelegram: GoldTelegramService,
    private readonly goldAiSummary: GoldAiSummaryService,
    private readonly protectionRestore: GoldProtectionRestoreService,
  ) {}

  async checkPositions(accountId: string, positions: IncomingPositionDto[]): Promise<void> {
    const goldPositions = positions.filter((p) => p.symbol.toUpperCase() === GOLD_SYMBOL);
    for (const position of goldPositions) {
      try {
        await this.checkOne(accountId, position);
      } catch (err) {
        this.logger.error(
          `protection check failed for position ${position.externalPositionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async checkOne(accountId: string, position: IncomingPositionDto): Promise<void> {
    const isProtected = isSet(position.stopLoss) && isSet(position.takeProfit);
    const positionId = position.externalPositionId;

    const lastNotification = await this.prisma.goldTelegramNotification.findFirst({
      where: { dedupKey: { startsWith: `protection:${positionId}:` } },
      orderBy: { createdAt: 'desc' },
    });
    const lastKnownMissing = lastNotification?.eventType === 'MISSING_PROTECTION';

    if (!isProtected && !lastKnownMissing) {
      // New incident: was protected (or never checked before) -> now missing.
      const dedupKey = `protection:${positionId}:missing:${Date.now()}`;
      const text =
        `GOLD DEMO — CRITICAL: missing protection. position=${positionId} side=${position.side} volume=${position.volume} ` +
        `openPrice=${position.openPrice} stopLoss=${position.stopLoss ?? 'NONE'} takeProfit=${position.takeProfit ?? 'NONE'} — ` +
        `broker does not currently show a stop-loss and/or take-profit attached to this position.`;
      await this.goldTelegram.notify('MISSING_PROTECTION', dedupKey, text);
      void this.goldAiSummary.generateForEvent('MISSING_PROTECTION', new Date().toISOString(), text);
      this.logger.warn(`gold position ${positionId}: missing protection detected`);

      // Task item 4's ownership-scoping principle applied here too — the
      // ALERT above fires for any unprotected XAUUSD position (still useful
      // information), but auto-REMEDIATION (closing it) is strictly scoped
      // to positions this strategy itself opened (magic number match). This
      // system must never auto-close a manual trade, or another bot's
      // position, just because it happens to be unprotected gold.
      if (!isOwnMagic(position)) {
        this.logger.warn(`gold position ${positionId}: unprotected but magic does not match this strategy (or is absent) — alerted only, NOT auto-remediated (not confirmed to be this strategy's own position).`);
        return;
      }

      // Remediation, corrected: queue a RESTORE attempt first — never a
      // direct close. requestRestore() computes the target SL/TP at the
      // frozen GOLD_TP_SL_POINTS distance from the position's own entry
      // price (same formula every fill uses). The collector executes it via
      // executor.py's modify_protection (TRADE_ACTION_SLTP); only after
      // GoldExecutionController.postRestoreProtectionResult sees this
      // exhaust its bounded retries does anything fall back to closing.
      try {
        const { id: restoreRequestId } = await this.protectionRestore.requestRestore({
          accountId,
          positionTicket: positionId,
          side: position.side,
          entryPrice: position.openPrice,
          goldPointSize: GOLD_POINT_SIZE,
        });
        const remediationText =
          `GOLD DEMO — REMEDIATION: requesting protection restore for unprotected position=${positionId} (request=${restoreRequestId}). ` +
          `Queued for the collector's next poll — will retry (bounded) before falling back to close.`;
        await this.goldTelegram.notify('PROTECTION_RESTORE_REQUESTED', `protection-restore-request:${positionId}:${Date.now()}`, remediationText);
      } catch (err) {
        this.logger.error(`remediation restore-request failed for position ${positionId}: ${err instanceof Error ? err.message : String(err)}`);
        await this.goldTelegram.notify(
          'PROTECTION_REMEDIATION_FAILED',
          `protection-remediation-failed:${positionId}:${Date.now()}`,
          `GOLD DEMO — CRITICAL: could not queue a protection restore for unprotected position=${positionId}: ${err instanceof Error ? err.message : String(err)}. Manual intervention required.`,
        );
      }
    } else if (isProtected && lastKnownMissing) {
      // Recovery: was missing -> now protected again.
      const dedupKey = `protection:${positionId}:restored:${Date.now()}`;
      const text =
        `GOLD DEMO — protection restored. position=${positionId} stopLoss=${position.stopLoss} takeProfit=${position.takeProfit}`;
      await this.goldTelegram.notify('PROTECTION_RESTORED', dedupKey, text);
      this.logger.log(`gold position ${positionId}: protection restored`);
    }
  }
}

function isSet(value: number | undefined | null): boolean {
  return value !== undefined && value !== null && value !== 0;
}

/** True only when the position's raw MT5 payload carries a `magic` matching this strategy's own — never assumed true when absent. */
function isOwnMagic(position: IncomingPositionDto): boolean {
  const raw = (position as { raw?: Record<string, unknown> }).raw;
  const magic = raw?.magic;
  return typeof magic === 'number' && magic === GOLD_MAGIC_NUMBER;
}
