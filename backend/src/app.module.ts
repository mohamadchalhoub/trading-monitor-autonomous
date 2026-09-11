import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AccountsModule } from './accounts/accounts.module';
import { TradingDataModule } from './trading-data/trading-data.module';
import { CollectorIngressModule } from './collector-ingress/collector-ingress.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RulesModule } from './rules/rules.module';
import { AlertsModule } from './alerts/alerts.module';
import { JobsModule } from './jobs/jobs.module';
import { TelegramModule } from './telegram/telegram.module';
import { AiModule } from './ai/ai.module';
import { HealthModule } from './health/health.module';
import { MarketEventsModule } from './market-events/market-events.module';
import { HistoricalChartsModule } from './historical-charts/historical-charts.module';
import { XtbImportModule } from './xtb-import/xtb-import.module';
import { AutonomousModule } from './autonomous/autonomous.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AccountsModule,
    TradingDataModule,
    CollectorIngressModule,
    AnalyticsModule,
    RulesModule,
    AlertsModule,
    JobsModule,
    AiModule,
    TelegramModule,
    HealthModule,
    XtbImportModule,
    MarketEventsModule,
    HistoricalChartsModule,
    AutonomousModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
