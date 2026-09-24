/**
 * Regression test for a live bug: an account row that spans a credential
 * switch (e.g. demo -> real, same DB account id) must never let a stale
 * peak equity from the OLD account contaminate the drawdown calculation for
 * the CURRENT one. Found live when mfginvest's real $47.31 equity was
 * measured against a 30-day peak that still included the prior demo
 * account's ~$50,440 equity, producing a nonsensical ~99.9% "drawdown".
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db';
import { createTradingAccount, createUser } from '../helpers/factories';
import { RsiAccountStateService } from '../../src/xauusd-rsi/account-state.service';

describe('resolveAccountRiskInfo — drawdown scoped to the current trade_mode', () => {
  let prisma: PrismaClient;
  let accountState: RsiAccountStateService;
  let accountId: string;

  beforeAll(() => {
    prisma = new PrismaClient();
    accountState = new RsiAccountStateService(prisma as never);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await createUser(prisma);
    const account = await createTradingAccount(prisma, user.id);
    accountId = account.id;
  });

  it('ignores a prior DEMO account\'s much higher equity when computing REAL drawdown', async () => {
    const now = Date.now();
    // The old demo account, days ago, on a completely different equity scale.
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'DEMO', marginMode: 'RETAIL_HEDGING',
        balance: 50440.62, equity: 50440.62, margin: 0, freeMargin: 50440.62, profit: 0,
        capturedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
    });
    // The new real account, just connected, at its actual (small) scale.
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'REAL', marginMode: 'RETAIL_HEDGING',
        balance: 47.31, equity: 47.31, margin: 0, freeMargin: 47.31, profit: 0,
        capturedAt: new Date(now),
      },
    });

    const info = await accountState.resolveAccountRiskInfo(accountId);
    expect(info.tradeMode).toBe('REAL');
    // Peak equity must come from REAL snapshots only — with just one, drawdown is ~0%.
    expect(info.currentDrawdownPct).toBeLessThan(1);
  });

  it('still computes real drawdown correctly within a single trade_mode', async () => {
    const now = Date.now();
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'REAL', marginMode: 'RETAIL_HEDGING',
        balance: 100, equity: 100, margin: 0, freeMargin: 100, profit: 0,
        capturedAt: new Date(now - 60 * 60 * 1000),
      },
    });
    await prisma.accountSnapshot.create({
      data: {
        accountId, tradeMode: 'REAL', marginMode: 'RETAIL_HEDGING',
        balance: 90, equity: 90, margin: 0, freeMargin: 90, profit: 0,
        capturedAt: new Date(now),
      },
    });

    const info = await accountState.resolveAccountRiskInfo(accountId);
    expect(info.currentDrawdownPct).toBeCloseTo(10, 5);
  });
});
