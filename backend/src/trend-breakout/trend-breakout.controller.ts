import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrendBreakoutInstrument } from '@prisma/client';
import { DashboardTokenGuard } from '../auth/dashboard-token.guard';
import { TREND_BREAKOUT_STRATEGY_VERSION } from '../strategy-versions';
import { resolveInstrumentMappings, TREND_BREAKOUT_INSTRUMENTS } from './instrument-config';
import { TrendBreakoutRiskPolicySettingsService } from './risk-policy-settings.service';
import { TrendBreakoutRiskStateService } from './risk-state.service';
import { isWithinEntryWindow, BEIRUT_TIMEZONE } from './schedule';
import { TrendBreakoutSlotLockService } from './slot-lock.service';
import { SymbolMetadataService } from './symbol-metadata.service';
import { TrendBreakoutDecisionLoggerService } from './trend-breakout-decision-logger.service';
import { TrendBreakoutVolumeSettingsService } from './volume-settings.service';

/**
 * §12 — "Provide a focused settings view... Keep the UI concise. Reuse the
 * existing dashboard rather than rebuilding it." This controller is the
 * backend half; `frontend/src/app/trend-breakout/[accountId]/page.tsx` is
 * the read/edit UI, same `DashboardTokenGuard` + `accounts/:accountId/...`
 * URL convention every other account-scoped route in this codebase uses.
 */
@Controller('accounts/:accountId/trend-breakout')
@UseGuards(DashboardTokenGuard)
export class TrendBreakoutController {
  constructor(
    private readonly volumeSettings: TrendBreakoutVolumeSettingsService,
    private readonly symbolMetadata: SymbolMetadataService,
    private readonly slotLock: TrendBreakoutSlotLockService,
    private readonly riskState: TrendBreakoutRiskStateService,
    private readonly riskPolicySettings: TrendBreakoutRiskPolicySettingsService,
    private readonly decisionLogger: TrendBreakoutDecisionLoggerService,
    private readonly config: ConfigService,
  ) {}

  @Get('settings')
  async getSettings(@Param('accountId') accountId: string) {
    const mappings = resolveInstrumentMappings(this.config);
    const [volumes, riskPolicy, ...slots] = await Promise.all([
      this.volumeSettings.getAll(),
      this.riskPolicySettings.getActive(),
      ...TREND_BREAKOUT_INSTRUMENTS.map((i) => this.slotLock.getLock(accountId, i)),
    ]);
    const metadataByInstrument = Object.fromEntries(
      await Promise.all(TREND_BREAKOUT_INSTRUMENTS.map(async (i) => [i, await this.symbolMetadata.get(mappings[i].brokerSymbol)] as const)),
    );

    return {
      strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
      instruments: TREND_BREAKOUT_INSTRUMENTS.map((instrument, idx) => ({
        instrument,
        brokerSymbol: mappings[instrument].brokerSymbol,
        volume: volumes.find((v) => v.instrument === instrument),
        slotOccupied: slots[idx] !== null,
        slotState: slots[idx]?.state ?? null,
        symbolMetadataKnown: metadataByInstrument[instrument] !== null,
      })),
      entryWindow: { timezone: BEIRUT_TIMEZONE, start: '03:00:00', end: '12:00:00 (exclusive)' },
      entryWindowCurrentlyOpen: isWithinEntryWindow(new Date()),
      riskPolicy,
      executionMode: 'DISABLED — collector execution and any scheduler for this strategy remain off; see README/delivery report',
    };
  }

  @Get('volume-audit/:instrument')
  async getVolumeAudit(@Param('instrument') instrument: TrendBreakoutInstrument) {
    return this.volumeSettings.getAuditLog(instrument);
  }

  /**
   * §2/§12 — "Only the authenticated user can change these volumes." Auth
   * is `DashboardTokenGuard` (the controller-level guard); `changedBy`
   * identifies WHICH authenticated operator made the change, for the audit
   * trail — this single-tenant dashboard has one shared bearer token, not
   * per-user login sessions, so the caller supplies their own identifying
   * string (e.g. an email) rather than it being extracted from a session.
   */
  @Post('volume/:instrument')
  async updateVolume(@Param('instrument') instrument: TrendBreakoutInstrument, @Body() body: { volumeLots: number; changedBy: string }) {
    const mappings = resolveInstrumentMappings(this.config);
    const metadata = await this.symbolMetadata.get(mappings[instrument].brokerSymbol);
    const result = await this.volumeSettings.updateVolume(instrument, body.volumeLots, body.changedBy, metadata);
    return { ...result, note: 'Applies to future entry requests only — never resizes an existing position.' };
  }

  @Get('decisions')
  async getDecisions(@Param('accountId') accountId: string, @Query('instrument') instrument?: TrendBreakoutInstrument, @Query('limit') limit?: string) {
    return this.decisionLogger.recent(accountId, instrument, limit ? Number(limit) : 50);
  }

  @Post('drawdown-reset')
  async resetDrawdown(@Param('accountId') accountId: string, @Body() body: { resetBy: string }) {
    await this.riskState.resetDrawdown(accountId, body.resetBy);
    return { ok: true };
  }
}
