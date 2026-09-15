import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradingDataModule } from '../trading-data/trading-data.module';
import { TrendBreakoutModule } from '../trend-breakout/trend-breakout.module';
import { CollectorIngressController } from './collector-ingress.controller';
import { GoldClosureReconciliationService } from '../gold-execution/gold-closure-reconciliation.service';
import { GoldProtectionMonitorService } from '../gold-execution/gold-protection-monitor.service';
import { GoldTelegramService } from '../gold-execution/gold-telegram.service';
import { GoldAiSummaryService } from '../gold-execution/gold-ai-summary.service';
import { GoldCloseExecutionService } from '../gold-execution/gold-close-execution.service';
import { AiModule } from '../ai/ai.module';

// AlertsModule (→ RuleEngineService) is imported here per RULE_ENGINE_SPEC.md
// §12.12 decision 4a: the existing ingestion path is the evaluation trigger,
// not a separate cron (Phase 0 §01's own invariant — "the collector is a
// client of the API, never a peer it polls" — extends naturally to "one
// thing pushes, the pipeline reacts synchronously," with no new scheduler).
// MarketDataModule (historical chart reconstruction phase) — the collector
// pushes candles through this same controller, same one-way architecture.
@Module({
  imports: [AccountsModule, TradingDataModule, AuthModule, AlertsModule, MarketDataModule, TrendBreakoutModule, AiModule],
  controllers: [CollectorIngressController],
  providers: [GoldClosureReconciliationService, GoldProtectionMonitorService, GoldTelegramService, GoldAiSummaryService, GoldCloseExecutionService],
})
export class CollectorIngressModule {}
