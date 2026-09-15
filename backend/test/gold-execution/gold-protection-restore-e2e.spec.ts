import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { createCollectorToken, setupAccountWithDashboardToken, validSnapshotPayload } from '../helpers/factories';
import { request } from '../helpers/http';
import { GOLD_MAGIC_NUMBER } from '../../src/gold-execution/gold-safety-constants';

/**
 * Task item 3, corrected — "restore-then-close" protection remediation.
 * End-to-end over the real HTTP layer: a snapshot reporting an unprotected,
 * this-strategy-owned (magic-matched) gold position -> a
 * GoldProtectionRestoreRequest is queued -> the collector polls/claims it
 * -> a SIMULATED broker result is reported (exactly the shape runner.py
 * sends for real). Proves BOTH branches: a successful restore reaches
 * RESTORED and creates no close request; a restore that fails
 * `maxAttempts` times in a row is exhausted and THEN (only then) falls
 * back to the existing close-position path.
 */
describe('Gold protection restore-then-close (snapshot -> restore request -> collector poll -> broker-confirmed result)', () => {
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

  function unprotectedOwnGoldPosition(ticket: string) {
    return {
      externalPositionId: ticket,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: 0.01,
      openPrice: 2650,
      // stopLoss/takeProfit deliberately omitted — unprotected.
      profit: 0,
      swap: 0,
      openedAt: new Date().toISOString(),
      raw: { magic: GOLD_MAGIC_NUMBER },
    };
  }

  it('a successful restore reaches RESTORED and never creates a close request', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    // 1. Snapshot reports an unprotected, this-strategy position -> queues a restore request.
    const snapshotRes = await request(app, {
      method: 'POST', url: '/collector/snapshot',
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [unprotectedOwnGoldPosition('888001')] }),
    });
    expect(snapshotRes.statusCode).toBeLessThan(300);

    const restoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { accountId: mt5Account.id, positionTicket: '888001' } });
    expect(restoreRows).toHaveLength(1);
    expect(restoreRows[0].status).toBe('PENDING');
    expect(restoreRows[0].attemptNumber).toBe(1);
    // Frozen distance from entry (2650), same formula every fill uses.
    expect(restoreRows[0].stopLoss.toNumber()).toBeLessThan(2650);
    expect(restoreRows[0].takeProfit.toNumber()).toBeGreaterThan(2650);

    // 2. Collector polls and claims it.
    const pollRes = await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    expect(pollRes.body.request).not.toBeNull();
    expect(pollRes.body.request.ticket).toBe(888001);

    const afterClaim = await prisma.goldProtectionRestoreRequest.findUnique({ where: { id: restoreRows[0].id } });
    expect(afterClaim?.status).toBe('SENT');

    // 3. Collector reports a SIMULATED broker-confirmed success.
    const resultRes = await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${restoreRows[0].id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: true },
    });
    expect(resultRes.statusCode).toBeLessThan(300);

    const restored = await prisma.goldProtectionRestoreRequest.findUnique({ where: { id: restoreRows[0].id } });
    expect(restored?.status).toBe('RESTORED');
    expect(restored?.restoredAt).not.toBeNull();

    // Never fell back to closing.
    const closeRows = await prisma.goldCloseRequest.findMany({ where: { accountId: mt5Account.id, positionTicket: '888001' } });
    expect(closeRows).toHaveLength(0);
  });

  it('restore failing 3 times in a row is exhausted and THEN falls back to a close request — never before', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    await prisma.position.create({
      data: {
        accountId: mt5Account.id, platform: 'MT5', externalPositionId: '888002', symbol: 'XAUUSD',
        side: 'BUY', volume: 0.01, openPrice: 2650, profit: 0, swap: 0, status: 'OPEN', openedAt: new Date(),
      },
    });

    await request(app, {
      method: 'POST', url: '/collector/snapshot',
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [unprotectedOwnGoldPosition('888002')] }),
    });

    // Drive 3 attempts, each: poll/claim -> report a SIMULATED broker failure.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pending = await prisma.goldProtectionRestoreRequest.findFirst({
        where: { accountId: mt5Account.id, positionTicket: '888002', status: 'PENDING' },
        orderBy: { requestedAt: 'desc' },
      });
      expect(pending?.attemptNumber).toBe(attempt);

      const pollRes = await request(app, {
        method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
        headers: { authorization: `Bearer ${collectorToken}` },
      });
      expect(pollRes.body.request?.attemptNumber).toBe(attempt);

      await request(app, {
        method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${pending!.id}/result`,
        headers: { authorization: `Bearer ${collectorToken}` },
        payload: { ok: false, errorMessage: `simulated broker rejection, attempt ${attempt}` },
      });
    }

    // No 4th attempt was queued.
    const allRestoreRows = await prisma.goldProtectionRestoreRequest.findMany({ where: { accountId: mt5Account.id, positionTicket: '888002' } });
    expect(allRestoreRows).toHaveLength(3);
    expect(allRestoreRows.every((r) => r.status === 'FAILED')).toBe(true);

    // NOW (only now) a close request exists.
    const closeRows = await prisma.goldCloseRequest.findMany({ where: { accountId: mt5Account.id, positionTicket: '888002' } });
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0].status).toBe('PENDING');
  });

  it('a restore that succeeds on the 2nd attempt (1st fails) never reaches close', async () => {
    const { account: mt5Account, token: dashboardToken } = await setupAccountWithDashboardToken(prisma, { platform: 'MT5' });
    const { plaintext: collectorToken } = await createCollectorToken(prisma, mt5Account.id);

    await request(app, {
      method: 'POST', url: '/collector/snapshot',
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: validSnapshotPayload(mt5Account.id, { positions: [unprotectedOwnGoldPosition('888003')] }),
    });

    const first = await prisma.goldProtectionRestoreRequest.findFirst({ where: { positionTicket: '888003' } });
    await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${first!.id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: false, errorMessage: 'simulated transient rejection' },
    });

    const second = await prisma.goldProtectionRestoreRequest.findFirst({ where: { positionTicket: '888003', status: 'PENDING' } });
    expect(second?.attemptNumber).toBe(2);
    await request(app, {
      method: 'GET', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request`,
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    await request(app, {
      method: 'POST', url: `/collector/${mt5Account.id}/gold-execution/restore-protection-request/${second!.id}/result`,
      headers: { authorization: `Bearer ${collectorToken}` },
      payload: { ok: true },
    });

    const restored = await prisma.goldProtectionRestoreRequest.findUnique({ where: { id: second!.id } });
    expect(restored?.status).toBe('RESTORED');
    const closeRows = await prisma.goldCloseRequest.findMany({ where: { positionTicket: '888003' } });
    expect(closeRows).toHaveLength(0);
  });
});
