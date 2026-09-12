import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read/write access to `SymbolMetadata` (schema.prisma) — broker-reported
 * volume min/max/step, price increment (point), contract size, and profit
 * currency for one broker symbol. Global, no accountId, same "market data"
 * posture as `LiveTick`/`HistoricalCandle`.
 *
 * Populated by the collector (once `mt5_client.py`'s `get_symbol_info` is
 * wired to push it — see the delivery report's "remaining prerequisites").
 * This sandbox/dev environment has never had a live MT5 terminal connected,
 * so this table is empty here today; every caller of `get()` must treat
 * `null` as "unknown," never assume permissive defaults.
 */
export interface SymbolMetadataRow {
  symbol: string;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  digits: number;
  point: number;
  contractSize: number;
  profitCurrency: string;
  updatedAt: Date;
}

@Injectable()
export class SymbolMetadataService {
  constructor(private readonly prisma: PrismaService) {}

  async get(symbol: string): Promise<SymbolMetadataRow | null> {
    const row = await this.prisma.symbolMetadata.findUnique({ where: { symbol } });
    if (!row) return null;
    return {
      symbol: row.symbol,
      volumeMin: row.volumeMin.toNumber(),
      volumeMax: row.volumeMax.toNumber(),
      volumeStep: row.volumeStep.toNumber(),
      digits: row.digits,
      point: row.point.toNumber(),
      contractSize: row.contractSize.toNumber(),
      profitCurrency: row.profitCurrency,
      updatedAt: row.updatedAt,
    };
  }

  /** Upserted by the collector-ingress route (`collector-ingress.controller.ts`) on its normal push cadence — see that file for the `CollectorTokenGuard`-protected endpoint. */
  async upsert(row: Omit<SymbolMetadataRow, 'updatedAt'>): Promise<void> {
    await this.prisma.symbolMetadata.upsert({
      where: { symbol: row.symbol },
      create: { ...row, source: 'MT5' },
      update: { ...row },
    });
  }
}
