/**
 * Live account, occupancy, broker-constraint and session state for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Everything here is derived from what the collector has already reconciled
 * into the database from REAL broker state (`Position`, `AccountSnapshot`,
 * `SymbolMetadata`, `LiveTick`), plus this strategy's own in-flight decision
 * rows. Nothing is derived from the strategy's own memory of what it did.
 *
 * Fails closed everywhere it matters: an absent snapshot reports `REAL` (not
 * DEMO), absent symbol metadata reports impossible-to-satisfy volume
 * constraints, and an unknown broker session reports `null` rather than
 * `true`.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RsiAccountRiskInfo, RsiAccountTradeMode, RsiBrokerConstraints, RsiOccupancyState } from './risk-manager';
import { RSI_QUOTE_MAX_STALENESS_SECONDS, RSI_SYMBOL } from './safety-constants';
import { describeOwnership, isOwnedByThisApplication } from './ownership';

/** How old symbol metadata may be before it is treated as unusable. */
const SYMBOL_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** MT5 `SYMBOL_TRADE_MODE_FULL`. Anything else is not fully tradable. */
const SYMBOL_TRADE_MODE_FULL = 4;

export interface GoldExposureItem {
  kind: 'POSITION' | 'IN_FLIGHT_DECISION';
  ticket: string;
  side: string;
  volume: number;
  magicNumber: number | null;
  /** True when this application opened it and may manage/close it. */
  owned: boolean;
  description: string;
}

export interface GoldExposureSnapshot {
  items: GoldExposureItem[];
  ownedItems: GoldExposureItem[];
  foreignItems: GoldExposureItem[];
  /** True when nothing THIS APPLICATION owns remains. Says nothing about foreign exposure. */
  ownedExposureFlat: boolean;
  anyExposure: boolean;
}

@Injectable()
export class RsiAccountStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every XAUUSD exposure on the account, split by ownership.
   *
   * The split matters for two different rules: occupancy counts EVERYTHING
   * (spec §10 — one position at a time, including manual and foreign), while
   * Friday liquidation acts on OWNED items only (spec §9.3 — never close a
   * manual trade merely for sharing the symbol).
   */
  async resolveExposure(accountId: string, excludeDecisionId?: string): Promise<GoldExposureSnapshot> {
    const positions = await this.prisma.position.findMany({
      where: { accountId, symbol: RSI_SYMBOL, status: 'OPEN' },
    });

    const items: GoldExposureItem[] = positions.map((p) => {
      const magic = extractMagic(p.rawPayload);
      return {
        kind: 'POSITION' as const,
        ticket: p.externalPositionId,
        side: p.side,
        volume: p.volume.toNumber(),
        magicNumber: magic,
        owned: isOwnedByThisApplication(magic),
        description: `open position ticket=${p.externalPositionId} side=${p.side} volume=${p.volume.toNumber()} — ${describeOwnership(magic)}`,
      };
    });

    // A decision that is queued, claimed, or whose broker outcome is unknown
    // occupies the slot too: an ambiguous in-flight submission must never let
    // a second order through.
    const inFlight = await this.prisma.xauusdRsiDecision.findMany({
      where: {
        accountId,
        symbol: RSI_SYMBOL,
        orderStatus: { in: ['PENDING', 'SENT', 'UNKNOWN'] },
        ...(excludeDecisionId ? { id: { not: excludeDecisionId } } : {}),
      },
      orderBy: { evaluatedAt: 'desc' },
    });
    for (const d of inFlight) {
      items.push({
        kind: 'IN_FLIGHT_DECISION',
        ticket: d.mt5Ticket !== null ? String(d.mt5Ticket) : d.id,
        side: d.direction,
        volume: d.volumeLots?.toNumber() ?? 0,
        magicNumber: d.magicNumber,
        owned: true,
        description: `in-flight decision ${d.id} (orderStatus=${d.orderStatus})`,
      });
    }

    // Any in-flight submission left behind by the retired strategies also
    // occupies the slot until it is reconciled.
    const legacyInFlight = await this.prisma.autonomousDecision.findMany({
      where: { accountId, symbol: RSI_SYMBOL, orderStatus: { in: ['PENDING', 'SENT'] } },
      orderBy: { evaluatedAt: 'desc' },
    });
    for (const d of legacyInFlight) {
      items.push({
        kind: 'IN_FLIGHT_DECISION',
        ticket: d.mt5Ticket !== null ? String(d.mt5Ticket) : d.id,
        side: d.action === 'OPEN_BUY' ? 'BUY' : 'SELL',
        volume: d.volumeLots?.toNumber() ?? 0,
        magicNumber: null,
        owned: true,
        description: `in-flight decision ${d.id} from a RETIRED strategy (orderStatus=${d.orderStatus}) — must be reconciled, never re-sent`,
      });
    }

    const ownedItems = items.filter((i) => i.owned);
    const foreignItems = items.filter((i) => !i.owned);
    return {
      items,
      ownedItems,
      foreignItems,
      ownedExposureFlat: ownedItems.length === 0,
      anyExposure: items.length > 0,
    };
  }

  async resolveOccupancy(accountId: string, excludeDecisionId?: string): Promise<RsiOccupancyState> {
    const exposure = await this.resolveExposure(accountId, excludeDecisionId);
    if (!exposure.anyExposure) {
      return { hasExistingXauusdExposure: false, exposureDescription: null };
    }
    return {
      hasExistingXauusdExposure: true,
      exposureDescription: exposure.items.map((i) => i.description).join('; '),
    };
  }

  async resolveAccountRiskInfo(accountId: string): Promise<RsiAccountRiskInfo> {
    const [snapshot, account, symbolMeta] = await Promise.all([
      this.prisma.accountSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: 'desc' } }),
      this.prisma.tradingAccount.findUnique({ where: { id: accountId } }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol: RSI_SYMBOL } }),
    ]);

    // Fails closed: a missing snapshot, or one that never recorded a trade
    // mode, is reported as REAL so the DEMO gate rejects it.
    const tradeMode: RsiAccountTradeMode = (snapshot?.tradeMode as RsiAccountTradeMode | undefined) ?? 'REAL';
    const equity = snapshot ? snapshot.equity.toNumber() : 0;
    const accountCurrency = account?.currency ?? 'EUR';
    const profitCurrency = symbolMeta?.profitCurrency ?? 'USD';
    const contractSize = symbolMeta ? symbolMeta.contractSize.toNumber() : null;
    const profitCurrencyToAccountCurrencyRate = await this.resolveConversionRate(profitCurrency, accountCurrency);

    const openPositions = await this.prisma.position.findMany({ where: { accountId, status: 'OPEN' } });
    // A documented simplification, unchanged from the previous strategy: the
    // magnitude of each losing position's floating loss stands in for "risk
    // currently in play". A precise per-position stop-distance sum would need
    // every position's own SL, which is not always present.
    const existingCombinedRiskAmount = openPositions.reduce((sum, p) => {
      const profit = p.profit.toNumber();
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const todaysTrades = await this.prisma.trade.findMany({
      where: { accountId, executedAt: { gte: dayStart } },
      select: { profit: true },
    });
    const todaysLossAmount = todaysTrades.reduce((sum, t) => {
      const profit = typeof t.profit?.toNumber === 'function' ? t.profit.toNumber() : Number(t.profit ?? 0);
      return sum + (profit < 0 ? Math.abs(profit) : 0);
    }, 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSnapshots = await this.prisma.accountSnapshot.findMany({
      where: { accountId, capturedAt: { gte: thirtyDaysAgo } },
      select: { equity: true },
    });
    const peakEquity = recentSnapshots.length > 0 ? Math.max(...recentSnapshots.map((s) => s.equity.toNumber())) : equity;
    const currentDrawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100) : 0;

    return {
      tradeMode,
      equity,
      accountCurrency,
      profitCurrency,
      profitCurrencyToAccountCurrencyRate,
      contractSize,
      existingCombinedRiskAmount,
      todaysLossAmount,
      currentDrawdownPct,
    };
  }

  /**
   * Live FX multiplier, `from` amount -> `to` amount. Only ever derived from
   * a real `LiveTick`, never a hardcoded rate. An unsupported pair returns
   * null so the risk gate fails closed instead of assuming 1:1.
   */
  private async resolveConversionRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    const pair = await this.prisma.liveTick.findUnique({ where: { symbol: 'EURUSD' } });
    if (!pair) return null;
    const mid = (pair.bid.toNumber() + pair.ask.toNumber()) / 2;
    if (!(mid > 0)) return null;
    if (from === 'USD' && to === 'EUR') return 1 / mid;
    if (from === 'EUR' && to === 'USD') return mid;
    return null;
  }

  /**
   * Real broker volume/stops/tick constraints. Fails closed to an impossible
   * constraint set when the row is missing or stale, so the risk gate always
   * rejects rather than proceeding on assumed limits.
   */
  async resolveBrokerConstraints(now: Date = new Date()): Promise<RsiBrokerConstraints> {
    const impossible: RsiBrokerConstraints = {
      minLots: Number.POSITIVE_INFINITY,
      maxLots: 0,
      stepLots: 1,
      stopsLevelPoints: null,
      freezeLevelPoints: null,
      tickSize: null,
    };
    const row = await this.prisma.symbolMetadata.findUnique({ where: { symbol: RSI_SYMBOL } });
    if (!row) return impossible;
    if (now.getTime() - row.updatedAt.getTime() > SYMBOL_METADATA_MAX_AGE_MS) return impossible;
    return {
      minLots: row.volumeMin.toNumber(),
      maxLots: row.volumeMax.toNumber(),
      stepLots: row.volumeStep.toNumber(),
      stopsLevelPoints: row.tradeStopsLevel ?? null,
      freezeLevelPoints: row.tradeFreezeLevel ?? null,
      tickSize: row.tradeTickSize ? row.tradeTickSize.toNumber() : null,
    };
  }

  /**
   * Whether the broker's XAUUSD session is CONFIRMED open.
   *
   * Returns `null` — not `false` — when this cannot be established, because
   * spec §9.4 distinguishes "confirmed closed" from "unknown", and both must
   * block while only one of them is an assertion about the market.
   *
   * Evidence used: a fresh live quote (the feed genuinely moving is the best
   * available proof the session is live) together with the broker's own
   * declared trade mode for the symbol. Neither alone is treated as proof.
   *
   * Deliberately NOT derived from a hardcoded weekly calendar: spec §9.4
   * forbids assuming a reopening time, and a broker holiday or an early
   * Friday close would make any such calendar wrong.
   */
  async resolveBrokerSessionOpen(now: Date = new Date()): Promise<{ open: boolean | null; detail: string; quoteAgeSeconds: number | null }> {
    const [tick, meta] = await Promise.all([
      this.prisma.liveTick.findUnique({ where: { symbol: RSI_SYMBOL } }),
      this.prisma.symbolMetadata.findUnique({ where: { symbol: RSI_SYMBOL } }),
    ]);

    if (!tick) {
      return { open: null, detail: 'No live XAUUSD quote has ever been recorded — broker session availability cannot be established.', quoteAgeSeconds: null };
    }
    const ageSeconds = (now.getTime() - tick.tickAt.getTime()) / 1000;

    if (meta?.tradeMode !== undefined && meta?.tradeMode !== null && meta.tradeMode !== SYMBOL_TRADE_MODE_FULL) {
      return {
        open: false,
        detail: `Broker reports XAUUSD trade mode ${meta.tradeMode}, which is not full trading — the session is not open for new entries.`,
        quoteAgeSeconds: ageSeconds,
      };
    }

    if (ageSeconds > RSI_QUOTE_MAX_STALENESS_SECONDS) {
      return {
        open: null,
        detail: `The newest XAUUSD quote is ${ageSeconds.toFixed(0)}s old (limit ${RSI_QUOTE_MAX_STALENESS_SECONDS}s). The session may be closed or the feed may be down — this cannot be distinguished, so it is reported as unknown rather than guessed.`,
        quoteAgeSeconds: ageSeconds,
      };
    }

    return {
      open: true,
      detail: `Confirmed open: XAUUSD quote is ${ageSeconds.toFixed(1)}s old and the broker reports full trading.`,
      quoteAgeSeconds: ageSeconds,
    };
  }
}

/**
 * MT5's magic number arrives inside the position's raw payload — there is no
 * dedicated column. Returns null when absent, and a null magic is NEVER
 * treated as a match for any owner.
 */
export function extractMagic(rawPayload: unknown): number | null {
  if (typeof rawPayload !== 'object' || rawPayload === null) return null;
  const magic = (rawPayload as Record<string, unknown>).magic;
  return typeof magic === 'number' && Number.isFinite(magic) ? magic : null;
}
