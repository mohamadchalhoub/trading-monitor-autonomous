import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class IncomingPositionDto {
  @IsString() externalPositionId!: string;
  @IsString() symbol!: string;
  @IsIn(['BUY', 'SELL']) side!: 'BUY' | 'SELL';
  @IsNumber() volume!: number;
  @IsNumber() openPrice!: number;
  @IsOptional() @IsNumber() currentPrice?: number;
  @IsOptional() @IsNumber() stopLoss?: number;
  @IsOptional() @IsNumber() takeProfit?: number;
  @IsNumber() profit!: number;
  @IsNumber() swap!: number;
  @IsISO8601() openedAt!: string;
  @IsOptional() raw?: Record<string, unknown>;
}

export class TerminalStatusDto {
  @IsBoolean() connected!: boolean;
  @IsOptional() @IsString() lastError?: string;
}

/** Global market data, not account-scoped — piggybacked onto the same 10s
 * snapshot push rather than a new endpoint. See LiveTick's own schema comment. */
export class LiveTickDto {
  @IsString() symbol!: string;
  @IsNumber() bid!: number;
  @IsNumber() ask!: number;
  @IsISO8601() tickAt!: string;
}

export class SnapshotDto {
  @IsUUID() accountId!: string;
  @IsISO8601() capturedAt!: string;

  @IsNumber() balance!: number;
  @IsNumber() equity!: number;
  @IsNumber() margin!: number;
  @IsNumber() freeMargin!: number;
  @IsOptional() @IsNumber() marginLevel?: number;
  @IsNumber() profit!: number;

  // @IsDefined() is required alongside @ValidateNested() here — class-validator
  // skips nested validation entirely when the property itself is `undefined`
  // (a request body that omits `terminal` altogether), which previously let a
  // malformed push reach the controller and crash with an unhandled 500 on
  // `dto.terminal.connected` instead of a clean 400 (found during production
  // readiness review's live end-to-end test).
  @IsDefined() @ValidateNested() @Type(() => TerminalStatusDto)
  terminal!: TerminalStatusDto;

  @IsOptional() @IsString() collectorVersion?: string;

  @IsOptional() @ValidateNested() @Type(() => LiveTickDto)
  liveTick?: LiveTickDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IncomingPositionDto)
  positions!: IncomingPositionDto[];
}
