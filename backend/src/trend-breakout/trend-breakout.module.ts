import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TrendBreakoutController } from './trend-breakout.controller';
import { TrendBreakoutCoordinatorService } from './trend-breakout-coordinator.service';
import { TrendBreakoutDecisionLoggerService } from './trend-breakout-decision-logger.service';
import { TrendBreakoutRiskPolicySettingsService } from './risk-policy-settings.service';
import { TrendBreakoutRiskStateService } from './risk-state.service';
import { TrendBreakoutSlotLockService } from './slot-lock.service';
import { SymbolMetadataService } from './symbol-metadata.service';
import { TrendBreakoutVolumeSettingsService } from './volume-settings.service';

/**
 * The new deterministic H4-trend/H1-breakout strategy
 * (`h4-trend-h1-breakout-v1`) — a NEW, self-contained module, deliberately
 * NOT added into `AutonomousModule` or built by extending its services: the
 * legacy weekly-H4-S/R strategy (`autonomous/`) is archived as-is (§1 —
 * "preserve unrelated work... archive the previous strategy under its
 * existing identifier"), left completely untouched, so its own code and
 * historical decisions remain exactly as interpretable as before. This
 * module can be imported by `AppModule` alongside it without either one's
 * behavior changing the other's.
 *
 * `PrismaService` comes from the global `PrismaModule` (not imported here,
 * same convention `AutonomousModule` already follows). Reuses `AuthModule`
 * for `DashboardTokenGuard`/`CollectorTokenGuard` and `MarketDataModule`
 * for `HistoricalCandleService` rather than re-implementing either.
 *
 * Deliberately has NO scheduler wiring — nothing calls
 * `TrendBreakoutCoordinatorService.evaluateAll()` on a timer, and the
 * collector's own execution-poll step stays off by default (same posture
 * as the legacy system's `AUTONOMOUS_EXECUTION_ENABLED`). See the delivery
 * report's "remaining prerequisites before demo execution."
 */
@Module({
  imports: [MarketDataModule, AuthModule],
  controllers: [TrendBreakoutController],
  providers: [
    TrendBreakoutVolumeSettingsService,
    SymbolMetadataService,
    TrendBreakoutSlotLockService,
    TrendBreakoutRiskStateService,
    TrendBreakoutRiskPolicySettingsService,
    TrendBreakoutDecisionLoggerService,
    TrendBreakoutCoordinatorService,
  ],
  exports: [
    TrendBreakoutVolumeSettingsService,
    SymbolMetadataService,
    TrendBreakoutSlotLockService,
    TrendBreakoutRiskStateService,
    TrendBreakoutRiskPolicySettingsService,
    TrendBreakoutDecisionLoggerService,
    TrendBreakoutCoordinatorService,
  ],
})
export class TrendBreakoutModule {}
