import { IsInt, IsNumber, IsPositive, IsString, Matches, Min } from 'class-validator';

// No accountId — same "market data, not account data" posture as
// CandlesPushDto: symbol metadata is shared across every account/collector
// that trades the same broker symbol. Any valid, unrevoked collector-scope
// token may push here (CollectorTokenGuard's own contract).
export class SymbolMetadataPushDto {
  @IsString() symbol!: string;
  @IsNumber() @Min(0) volumeMin!: number;
  @IsNumber() @IsPositive() volumeMax!: number;
  @IsNumber() @IsPositive() volumeStep!: number;
  @IsInt() @Min(0) digits!: number;
  @IsNumber() @IsPositive() point!: number;
  @IsNumber() @IsPositive() contractSize!: number;
  // Not restricted to a fixed list — currency-conversion.ts's own
  // `resolveConversionRate` is what actually fails closed on an
  // unsupported currency combination; this DTO only checks the SHAPE
  // (a plausible ISO-4217-looking code), not which currencies this
  // system currently knows how to convert.
  @IsString() @Matches(/^[A-Z]{3}$/) profitCurrency!: string;
}
