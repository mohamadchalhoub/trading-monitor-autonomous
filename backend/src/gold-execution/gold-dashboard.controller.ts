import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { GoldAccountStateService } from './gold-account-state.service';
import { getGoldExecutionMode, isStopNewEntriesActive } from './gold-execution-mode';
import { isKillSwitchActive } from '../autonomous/kill-switch';
import {
  GOLD_COMBINED_RISK_CAP_PCT, GOLD_DAILY_LOSS_CAP_PCT, GOLD_DRAWDOWN_CAP_PCT, GOLD_MAGIC_NUMBER,
  GOLD_MAX_ENTRY_DEVIATION_POINTS, GOLD_POINT_SIZE, GOLD_STOP_RISK_CAP_PCT, GOLD_SYMBOL,
  GOLD_TP_SL_USD, GOLD_VOLUME_LOTS,
} from './gold-safety-constants';
import { XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION } from './gold-strategy-version';

/**
 * Dashboard read side for the gold execution strategy (task step 6F) —
 * fully separate from `ConfirmedRetestController` (v1/v2 research-only,
 * file-based, no account). This one is account-scoped and reads real DB
 * state: `AutonomousDecision` rows (symbol='XAUUSD') for recent
 * queued/skipped decisions and reasoning, `Position`/`Trade` for open/
 * closed gold exposure with real P&L, `AccountSnapshot`/`SymbolMetadata`
 * for freshness and broker constraints. LLM explanations are never
 * involved here — every field is a direct read, per the task's own "LLM
 * explanations must never change levels/orders/volume/risk/outcomes" rule
 * (trivially true: this controller has no LLM dependency at all).
 */
@Controller('research/gold-execution-status')
@UseGuards(DashboardTokenGuard)
export class GoldDashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountState: GoldAccountStateService,
  ) {}

  @Get()
  async getStatus() {
    const mode = getGoldExecutionMode();
    const stopNewEntriesActive = isStopNewEntriesActive();
    const killSwitchActive = isKillSwitchActive();

    // Gold trades on MT5 only — this deployment holds more than one
    // TradingAccount row (an XTB account exists alongside the MT5 one), so
    // "first created" is NOT a safe way to pick "the" account (found live,
    // the hard way, while verifying trade_mode: an earlier version of this
    // query picked the XTB account, which has no snapshots at all, instead
    // of the actual MT5 MetaQuotes-Demo account). Explicit platform filter
    // instead.
    const account = await this.prisma.tradingAccount.findFirst({ where: { platform: 'MT5' }, orderBy: { createdAt: 'asc' } });

    const eurusdBanner = {
      strategy: 'EURUSD (friend\'s legacy 2024 rules)',
      status: 'INACTIVE',
      note: 'EURUSD strategy is a separate legacy strategy and is NOT activated by gold execution. EURUSD collection, configurable volume, and account-wide occupancy protection remain independently in effect.',
    };

    if (!account) {
      return {
        strategyVersion: XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION,
        mode, stopNewEntriesActive, killSwitchActive,
        error: 'no trading account found',
        eurusd: eurusdBanner,
      };
    }

    const [snapshot, symbolMeta, openPositions, closedTrades, recentDecisions] = await Promise.all([
      this.prisma.accountSnapshot.findFirst({ where: { accountId: account.id }, orderBy: { capturedAt: 'desc' } }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol: GOLD_SYMBOL } }),
      this.prisma.position.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL, status: 'OPEN' } }),
      this.prisma.trade.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL }, orderBy: { executedAt: 'desc' }, take: 20 }),
      this.prisma.autonomousDecision.findMany({ where: { accountId: account.id, symbol: GOLD_SYMBOL }, orderBy: { evaluatedAt: 'desc' }, take: 20 }),
    ]);

    const occupancy = await this.accountState.resolveOccupancy(account.id);
    const volumeConstraints = await this.accountState.resolveVolumeConstraints();

    const now = Date.now();
    const snapshotAgeMs = snapshot ? now - snapshot.capturedAt.getTime() : null;
    const symbolMetaAgeMs = symbolMeta ? now - symbolMeta.updatedAt.getTime() : null;

    return {
      strategyVersion: XAUUSD_H4_CONFIRMED_RETEST_GOLD_LIVE_VERSION,
      accountMode: mode,
      stopNewEntriesActive,
      killSwitchActive,
      accountTradeMode: snapshot?.tradeMode ?? null, // null = fails closed elsewhere to REAL, never assumed DEMO here either
      settings: {
        symbol: GOLD_SYMBOL,
        volumeLots: GOLD_VOLUME_LOTS,
        magicNumber: GOLD_MAGIC_NUMBER,
        tpSlUsd: GOLD_TP_SL_USD,
        pointSize: GOLD_POINT_SIZE,
        maxEntryDeviationPoints: GOLD_MAX_ENTRY_DEVIATION_POINTS,
        riskCapsPct: {
          stopRisk: GOLD_STOP_RISK_CAP_PCT, combined: GOLD_COMBINED_RISK_CAP_PCT,
          dailyLoss: GOLD_DAILY_LOSS_CAP_PCT, drawdown: GOLD_DRAWDOWN_CAP_PCT,
        },
        note: 'Only the user changes volumeLots — this dashboard never resizes it.',
      },
      occupancy,
      volumeConstraints,
      openPositions: openPositions.map((p) => ({
        ticket: p.externalPositionId, side: p.side, volume: p.volume.toNumber(),
        entryPrice: p.openPrice.toNumber(), currentPrice: p.currentPrice?.toNumber() ?? null,
        stopLoss: p.stopLoss?.toNumber() ?? null, takeProfit: p.takeProfit?.toNumber() ?? null,
        floatingPnl: p.profit.toNumber(), openedAt: p.openedAt,
      })),
      closedTrades: closedTrades.map((t) => ({
        dealTicket: t.externalTradeId, side: t.side, volume: t.volume.toNumber(),
        price: t.price.toNumber(), realizedPnl: t.profit.toNumber(), executedAt: t.executedAt,
      })),
      recentDecisions: recentDecisions.map((d) => ({
        id: d.id, evaluatedAt: d.evaluatedAt, action: d.action, orderStatus: d.orderStatus,
        riskManagerApproved: d.riskManagerApproved, riskManagerRejectionReason: d.riskManagerRejectionReason,
        reasoning: d.reasoning, entryPrice: d.entryPrice?.toNumber() ?? null,
        stopLoss: d.stopLoss?.toNumber() ?? null, takeProfit: d.takeProfit?.toNumber() ?? null,
        mt5Ticket: d.mt5Ticket ?? null, filledPrice: d.filledPrice?.toNumber() ?? null, executionError: d.executionError ?? null,
      })),
      dataFreshness: {
        accountSnapshotAgeMs: snapshotAgeMs,
        accountSnapshotStale: snapshotAgeMs === null || snapshotAgeMs > 5 * 60_000,
        symbolMetadataAgeMs: symbolMetaAgeMs,
        symbolMetadataStale: symbolMetaAgeMs === null || symbolMetaAgeMs > 24 * 60 * 60_000,
      },
      eurusd: eurusdBanner,
    };
  }
}
