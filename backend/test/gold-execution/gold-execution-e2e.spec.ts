import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';
import { GoldAccountStateService } from '../../src/gold-execution/gold-account-state.service';

describe('Gold execution — collector poll/report route is symbol-scoped', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function createDecision(accountId: string, symbol: string, overrides: Record<string, unknown> = {}) {
    return prisma.autonomousDecision.create({
      data: {
        accountId, symbol, action: 'OPEN_BUY', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2640, takeProfit: 2660,
        reasoning: 'test setup', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'PENDING',
        ...overrides,
      },
    });
  }

  it('gold route never claims a EURUSD pending row', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createDecision(account.id, 'EURUSD');

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${account.id}/gold-execution/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.body.order).toBeNull();
  });

  it('EURUSD route never claims an XAUUSD pending row', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createDecision(account.id, 'XAUUSD');

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${account.id}/autonomous/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.body.order).toBeNull();
  });

  it('gold route claims an XAUUSD pending row with gold-specific magic/volume/pointSize', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createDecision(account.id, 'XAUUSD');

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${account.id}/gold-execution/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBeLessThan(300);
    const order = res.body.order;
    expect(order).not.toBeNull();
    expect(order.symbol).toBe('XAUUSD');
    expect(order.magic).toBe(262610181);
    expect(order.volume).toBe(0.01);
    expect(order.pointSize).toBe(0.01);
    expect(order.stopLossPoints).toBeCloseTo(1000, 1);
    expect(order.takeProfitPoints).toBeCloseTo(1000, 1);
  });

  it('a second poll after claiming sees nothing pending (atomic claim, gold route)', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createDecision(account.id, 'XAUUSD');

    const first = await request(app, {
      method: 'GET', url: `/collector/${account.id}/gold-execution/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await request(app, {
      method: 'GET', url: `/collector/${account.id}/gold-execution/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(first.body.order).not.toBeNull();
    expect(second.body.order).toBeNull();
  });

  it('reports a gold execution result as FILLED via its own route', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const decision = await createDecision(account.id, 'XAUUSD');

    const res = await request(app, {
      method: 'POST',
      url: `/collector/${account.id}/gold-execution/pending-order/${decision.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ok: true, ticket: 999, filledPrice: 2650.3 },
    });

    expect(res.statusCode).toBeLessThan(300);
    const updated = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.orderStatus).toBe('FILLED');
    expect(updated.mt5Ticket).toBe(999);
  });
});

describe('GoldAccountStateService — occupancy resolution', () => {
  let prisma: PrismaClient;
  let service: GoldAccountStateService;

  beforeAll(() => {
    prisma = new PrismaClient();
    service = new GoldAccountStateService(prisma as any);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('reports no exposure when nothing exists', async () => {
    const { account } = await setupAccountWithToken(prisma);
    const occupancy = await service.resolveOccupancy(account.id);
    expect(occupancy.hasExistingXauusdExposure).toBe(false);
  });

  it('reports exposure for an OPEN XAUUSD position regardless of magic/source', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'manual-1', symbol: 'XAUUSD',
        side: 'BUY', volume: 0.02, openPrice: 2650, status: 'OPEN', openedAt: new Date(),
      },
    });
    const occupancy = await service.resolveOccupancy(account.id);
    expect(occupancy.hasExistingXauusdExposure).toBe(true);
    expect(occupancy.exposureDescription).toMatch(/manual-1/);
  });

  it('does not count a CLOSED XAUUSD position as exposure', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'closed-1', symbol: 'XAUUSD',
        side: 'BUY', volume: 0.02, openPrice: 2650, status: 'CLOSED', openedAt: new Date(),
      },
    });
    const occupancy = await service.resolveOccupancy(account.id);
    expect(occupancy.hasExistingXauusdExposure).toBe(false);
  });

  it('reports exposure for an in-flight (PENDING/SENT) gold decision even with no Position row yet', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.autonomousDecision.create({
      data: {
        accountId: account.id, symbol: 'XAUUSD', action: 'OPEN_SELL', source: 'RULES_ONLY',
        entryPrice: 2650, stopLoss: 2660, takeProfit: 2640, reasoning: 'test', inputSnapshot: {},
        riskManagerApproved: true, orderStatus: 'SENT',
      },
    });
    const occupancy = await service.resolveOccupancy(account.id);
    expect(occupancy.hasExistingXauusdExposure).toBe(true);
    expect(occupancy.exposureDescription).toMatch(/in-flight/);
  });

  it('does not count a EURUSD position as gold exposure', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.position.create({
      data: {
        accountId: account.id, platform: 'MT5', externalPositionId: 'eur-1', symbol: 'EURUSD',
        side: 'BUY', volume: 0.12, openPrice: 1.1, status: 'OPEN', openedAt: new Date(),
      },
    });
    const occupancy = await service.resolveOccupancy(account.id);
    expect(occupancy.hasExistingXauusdExposure).toBe(false);
  });

  it('fails closed to REAL trade_mode when no snapshot exists', async () => {
    const { account } = await setupAccountWithToken(prisma);
    const info = await service.resolveAccountRiskInfo(account.id);
    expect(info.tradeMode).toBe('REAL');
    expect(info.equity).toBe(0);
  });

  it('reports DEMO trade_mode and real equity from the latest snapshot', async () => {
    const { account } = await setupAccountWithToken(prisma);
    await prisma.accountSnapshot.create({
      data: {
        accountId: account.id, balance: 10000, equity: 9800, margin: 0, freeMargin: 9800,
        profit: -200, tradeMode: 'DEMO', capturedAt: new Date(),
      },
    });
    const info = await service.resolveAccountRiskInfo(account.id);
    expect(info.tradeMode).toBe('DEMO');
    expect(info.equity).toBe(9800);
  });

  it('fails closed to an impossible-to-satisfy volume constraint when no SymbolMetadata row exists', async () => {
    await prisma.symbolMetadata.deleteMany({ where: { symbol: 'XAUUSD' } });
    const constraints = await service.resolveVolumeConstraints();
    expect(constraints.maxLots).toBe(0); // no fixed volume can ever be <= 0 max, so this always rejects
  });

  it('fails closed when the SymbolMetadata row is stale (older than 24h)', async () => {
    await prisma.symbolMetadata.deleteMany({ where: { symbol: 'XAUUSD' } });
    await prisma.symbolMetadata.create({
      data: {
        symbol: 'XAUUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
        digits: 2, point: 0.01, contractSize: 100, profitCurrency: 'USD',
      },
    });
    // Force updatedAt into the past via a raw update — Prisma's @updatedAt auto-sets it on create/update.
    await prisma.$executeRawUnsafe(`UPDATE symbol_metadata SET updated_at = NOW() - INTERVAL '48 hours' WHERE symbol = 'XAUUSD'`);
    const constraints = await service.resolveVolumeConstraints();
    expect(constraints.maxLots).toBe(0);
  });

  it('reports real broker volume constraints from a fresh SymbolMetadata row', async () => {
    await prisma.symbolMetadata.deleteMany({ where: { symbol: 'XAUUSD' } });
    await prisma.symbolMetadata.create({
      data: {
        symbol: 'XAUUSD', volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01,
        digits: 2, point: 0.01, contractSize: 100, profitCurrency: 'USD',
      },
    });
    const constraints = await service.resolveVolumeConstraints();
    expect(constraints).toEqual({ minLots: 0.01, maxLots: 50, stepLots: 0.01 });
  });
});
