import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoldAccountRiskInfo, GoldAccountTradeMode, GoldOccupancyState } from './gold-risk-manager';
import { GOLD_SYMBOL } from './gold-safety-constants';

/**
 * Resolves live account/occupancy state from what the collector has
 * already reconciled into the database (`Position` rows come from real
 * broker state — collector/app/mt5_client.py's own positions sync, not
 * this strategy's own memory), plus this table's own PENDING/SENT rows for
 * a submission that may not have reached (or may have raced ahead of) a
 * Position row yet. This is what makes the occupancy check count ALL
 * XAUUSD exposure (manual, other-strategy, pending, UNKNOWN), per the
 * friend rule — not just this strategy's own magic number.
 *
 * Fails closed: no snapshot, or one that never recorded tradeMode, is
 * reported as REAL (same posture as AutonomousExecutionCoordinatorService's
 * own `resolveAccountInfo`) — never silently treated as DEMO.
 */
@Injectable()
export class GoldAccountStateService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveOccupancy(accountId: string): Promise<GoldOccupancyState> {
    const openPosition = await this.prisma.position.findFirst({
      where: { accountId, symbol: GOLD_SYMBOL, status: 'OPEN' },
    });
    if (openPosition) {
      return {
        hasExistingXauusdExposure: true,
        exposureDescription: `open position ticket=${openPosition.externalPositionId} (side=${openPosition.side}, volume=${openPosition.volume})`,
      };
    }

    // A decision already PENDING (queued, not yet claimed) or SENT (claimed
    // by the collector, outcome not yet reported back — includes the
    // window where the broker may have already filled it) also occupies
    // the slot — an ambiguous/in-flight submission counts, per the task's
    // explicit "include ... UNKNOWN submissions" requirement.
    const inFlight = await this.prisma.autonomousDecision.findFirst({
      where: { accountId, symbol: GOLD_SYMBOL, orderStatus: { in: ['PENDING', 'SENT'] } },
      orderBy: { evaluatedAt: 'desc' },
    });
    if (inFlight) {
      return {
        hasExistingXauusdExposure: true,
        exposureDescription: `in-flight decision ${inFlight.id} (orderStatus=${inFlight.orderStatus})`,
      };
    }

    return { hasExistingXauusdExposure: false, exposureDescription: null };
  }

  async resolveAccountRiskInfo(accountId: string): Promise<GoldAccountRiskInfo> {
    const snapshot = await this.prisma.accountSnapshot.findFirst({
      where: { accountId },
      orderBy: { capturedAt: 'desc' },
    });
    const tradeMode: GoldAccountTradeMode = (snapshot?.tradeMode as GoldAccountTradeMode | undefined) ?? 'REAL';
    const equity = snapshot ? snapshot.equity.toNumber() : 0;

    // Combined open risk from any OTHER currently-open position this
    // account holds (not just gold) — approximated here as each position's
    // absolute floating profit magnitude when negative (a rough proxy for
    // "risk currently in play"); a more precise per-symbol stop-distance
    // sum would need each position's own SL distance, deferred as a
    // documented simplification, not a silently invented precise number.
    const openPositions = await this.prisma.position.findMany({ where: { accountId, status: 'OPEN' } });
    const existingCombinedRiskAmount = openPositions.reduce((sum, p) => {
      const profit = p.profit.toNumber();
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    // Account-wide, not gold-only — the daily loss cap is a whole-account
    // protection (task step 5), so it must see every symbol's realized
    // deals today, not just gold's.
    const todaysTrades = await this.prisma.trade.findMany({
      where: { accountId, executedAt: { gte: dayStart } },
      select: { profit: true },
    });
    const todaysLossAmount = todaysTrades.reduce((sum, t) => {
      const profit = typeof t.profit?.toNumber === 'function' ? t.profit.toNumber() : Number(t.profit ?? 0);
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    // Drawdown: peak equity over the last 30 days of snapshots vs current.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSnapshots = await this.prisma.accountSnapshot.findMany({
      where: { accountId, capturedAt: { gte: thirtyDaysAgo } },
      select: { equity: true },
    });
    const peakEquity = recentSnapshots.length > 0 ? Math.max(...recentSnapshots.map((s) => s.equity.toNumber())) : equity;
    const currentDrawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100) : 0;

    return { tradeMode, equity, existingCombinedRiskAmount, todaysLossAmount, currentDrawdownPct };
  }
}
