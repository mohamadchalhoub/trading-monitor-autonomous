import { Module } from '@nestjs/common';
import { HistoricalCandleService } from './historical-candle.service';

/**
 * Historical chart reconstruction phase — owns `historical_candles`
 * storage/queries only (no controller of its own: the collector-push HTTP
 * surface lives on `collector-ingress`'s existing `/collector/*` routes,
 * same as snapshots/trades; this module is imported there). Independent of
 * `market-events` (economic events/news) — candles are raw OHLC price
 * history, a different domain, never conflated even though both are
 * "market data" in the loose sense.
 */
@Module({
  providers: [HistoricalCandleService],
  exports: [HistoricalCandleService],
})
export class MarketDataModule {}
