import { BadRequestException, Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CollectorTokenGuard } from '../auth/collector-token.guard';
import { AccountsService } from '../accounts/accounts.service';
import { RuleEngineService } from '../alerts/rule-engine.service';
import { HistoricalCandleService } from '../market-data/historical-candle.service';
import { TradingDataService } from '../trading-data/trading-data.service';
import { CandlesPushDto } from '../market-data/dto/candles-push.dto';
import { SymbolMetadataService } from '../trend-breakout/symbol-metadata.service';
import { SnapshotDto } from './dto/snapshot.dto';
import { SymbolMetadataPushDto } from './dto/symbol-metadata-push.dto';
import { TradesPushDto } from './dto/trades.dto';

const VALID_TIMEFRAMES = ['M5', 'M15', 'H1', 'M30', 'H4', 'D1', 'W1', 'MN1'] as const;
type Timeframe = (typeof VALID_TIMEFRAMES)[number];

function parseTimeframe(raw: string | undefined): Timeframe {
  if (!raw || !(VALID_TIMEFRAMES as readonly string[]).includes(raw)) {
    throw new BadRequestException(`timeframe must be one of ${VALID_TIMEFRAMES.join(', ')}`);
  }
  return raw as Timeframe;
}

// MT5 deal tickets are always numeric, so BigInt comparison is the correct
// way to find the highest one — but this field is a free-form string in
// the schema (XTB import rows, or any future source, may not be purely
// numeric), and lastDealTicket is diagnostic metadata, not something
// correctness depends on. A malformed/non-numeric ticket must degrade
// gracefully here, not 500 the whole ingestion request.
function higherTicket(a: string, b: string): string {
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return a > b ? a : b; // lexicographic fallback — never throws
  }
}

@Controller('collector')
@UseGuards(CollectorTokenGuard)
export class CollectorIngressController {
  private readonly logger = new Logger(CollectorIngressController.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly tradingData: TradingDataService,
    private readonly ruleEngine: RuleEngineService,
    private readonly historicalCandles: HistoricalCandleService,
    private readonly symbolMetadata: SymbolMetadataService,
  ) {}

  @Post('snapshot')
  async postSnapshot(@Body() dto: SnapshotDto) {
    const account = await this.accounts.getOrThrow(dto.accountId);

    await this.tradingData.upsertSnapshot(dto.accountId, dto);
    await this.tradingData.replaceOpenPositions(dto.accountId, account.platform, dto.positions);
    if (dto.liveTick) {
      await this.tradingData.upsertLiveTick(dto.liveTick);
    }
    await this.tradingData.upsertHeartbeat(
      dto.accountId,
      dto.terminal.connected,
      dto.terminal.lastError ?? null,
      dto.collectorVersion ?? null,
    );

    this.logger.log(
      `snapshot accepted account=${dto.accountId} positions=${dto.positions.length} mt5_connected=${dto.terminal.connected}`,
    );
    await this.evaluateRulesSafely(dto.accountId);
    return { ok: true };
  }

  @Post('trades')
  async postTrades(@Body() dto: TradesPushDto) {
    const account = await this.accounts.getOrThrow(dto.accountId);

    const result = await this.tradingData.upsertDeals(dto.accountId, account.platform, dto.deals);

    const maxTicket = dto.deals.reduce<string | null>((max, d) => {
      if (max === null) return d.externalTradeId;
      return higherTicket(d.externalTradeId, max);
    }, null);
    const existingCursor = await this.tradingData.getSyncCursor(dto.accountId);
    const lastDealTicket =
      maxTicket !== null
        ? existingCursor?.lastDealTicket
          ? higherTicket(maxTicket, existingCursor.lastDealTicket)
          : maxTicket
        : existingCursor?.lastDealTicket ?? null;

    await this.tradingData.updateSyncCursor(dto.accountId, new Date(), lastDealTicket);

    this.logger.log(
      `trades accepted account=${dto.accountId} received=${dto.deals.length} created=${result.created} updated=${result.updated}`,
    );
    await this.evaluateRulesSafely(dto.accountId);
    return { ok: true, ...result };
  }

  // Rule evaluation runs synchronously as part of ingestion (RULE_ENGINE_SPEC.md
  // §12.12 decision 4a) but must never be able to fail an otherwise-successful
  // ingestion request — a bug in a trader's rule configuration must not stop
  // their trading data from being recorded (the same "one component's failure
  // must never take down another" posture Phase 0 §21 applies to health
  // checks).
  private async evaluateRulesSafely(accountId: string): Promise<void> {
    try {
      await this.ruleEngine.evaluateAccount(accountId, new Date());
    } catch (err) {
      this.logger.error(
        `rule evaluation failed for account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @Get('cursor/:accountId')
  async getCursor(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    const cursor = await this.tradingData.getSyncCursor(accountId);
    return {
      lastSyncedAt: cursor?.lastSyncedAt ?? null,
      lastDealTicket: cursor?.lastDealTicket ?? null,
    };
  }

  @Get('heartbeat/:accountId')
  async getHeartbeat(@Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.accounts.getOrThrow(accountId);
    return this.tradingData.getHeartbeat(accountId);
  }

  // Historical chart reconstruction phase — candles carry no accountId at
  // all (schema.prisma's HistoricalCandle: symbol/timeframe data, shared
  // across every account). CollectorTokenGuard's own contract already
  // covers this: a request naming no target accountId is accepted from any
  // valid, unrevoked collector-scope token (auth/collector-token.guard.ts's
  // `requestedAccountId` returns undefined here, so the account-match check
  // never applies) — no guard change needed for these two routes.
  @Post('candles')
  async postCandles(@Body() dto: CandlesPushDto) {
    const result = await this.historicalCandles.upsertCandles(dto.symbol, dto.timeframe, dto.candles);
    this.logger.log(`candles accepted symbol=${dto.symbol} timeframe=${dto.timeframe} count=${dto.candles.length}`);
    return { ok: true, ...result };
  }

  @Get('candles/latest')
  async getLatestCandleTime(@Query('symbol') symbol: string, @Query('timeframe') timeframeRaw: string) {
    if (!symbol) throw new BadRequestException('symbol is required');
    const timeframe = parseTimeframe(timeframeRaw);
    const latestOpenTime = await this.historicalCandles.getLatestOpenTime(symbol, timeframe);
    return { latestOpenTime };
  }

  // trend-breakout strategy (v3) — broker symbol metadata (volume min/max/
  // step, price increment, contract size, profit currency), same "no
  // accountId" posture as candles above: one symbol's metadata is shared
  // across every account/collector that trades it. Every volume/price-
  // rounding validation in the new strategy fails closed until a row
  // exists here — see SymbolMetadataService's own doc comment.
  @Post('symbol-metadata')
  async postSymbolMetadata(@Body() dto: SymbolMetadataPushDto) {
    await this.symbolMetadata.upsert(dto);
    this.logger.log(`symbol metadata accepted symbol=${dto.symbol} volumeMin=${dto.volumeMin} volumeMax=${dto.volumeMax} volumeStep=${dto.volumeStep} point=${dto.point}`);
    return { ok: true };
  }
}
