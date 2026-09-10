import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradingDataModule } from '../trading-data/trading-data.module';
import { CollectorIngressController } from './collector-ingress.controller';

// AlertsModule (→ RuleEngineService) is imported here per RULE_ENGINE_SPEC.md
// §12.12 decision 4a: the existing ingestion path is the evaluation trigger,
// not a separate cron (Phase 0 §01's own invariant — "the collector is a
// client of the API, never a peer it polls" — extends naturally to "one
// thing pushes, the pipeline reacts synchronously," with no new scheduler).
// MarketDataModule (historical chart reconstruction phase) — the collector
// pushes candles through this same controller, same one-way architecture.
@Module({
  imports: [AccountsModule, TradingDataModule, AuthModule, AlertsModule, MarketDataModule],
  controllers: [CollectorIngressController],
})
export class CollectorIngressModule {}
