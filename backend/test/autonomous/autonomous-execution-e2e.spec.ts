import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app';
import { resetDatabase } from '../helpers/db';
import { setupAccountWithToken } from '../helpers/factories';
import { request } from '../helpers/http';

describe('Phase 6 — autonomous execution poll/report (end-to-end)', () => {
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

  async function createPendingDecision(accountId: string, overrides: Record<string, unknown> = {}) {
    return prisma.autonomousDecision.create({
      data: {
        accountId,
        action: 'OPEN_BUY',
        source: 'AI_ASSISTED',
        entryPrice: 1.1,
        stopLoss: 1.0982,
        takeProfit: 1.1018,
        reasoning: 'test setup',
        inputSnapshot: {},
        riskManagerApproved: true,
        orderStatus: 'PENDING',
        ...overrides,
      },
    });
  }

  it('returns null when there is no pending order', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const res = await request(app, {
      method: 'GET',
      url: `/collector/${account.id}/autonomous/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ order: null });
  });

  it('returns a correctly-shaped order and atomically claims it (flips PENDING to SENT)', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const decision = await createPendingDecision(account.id);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${account.id}/autonomous/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.order.decisionId).toBe(decision.id);
    expect(body.order.side).toBe('BUY');
    expect(body.order.volume).toBe(0.01);
    expect(body.order.stopLossPoints).toBeCloseTo(180, 0);
    expect(body.order.takeProfitPoints).toBeCloseTo(180, 0);
    expect(typeof body.order.magic).toBe('number');

    const row = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(row.orderStatus).toBe('SENT');
  });

  it('never returns the same order twice — a second poll after claiming sees nothing pending', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createPendingDecision(account.id);

    const first = await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });
    const second = await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });

    expect(first.body.order).not.toBeNull();
    expect(second.body.order).toBeNull();
  });

  it('claims the OLDEST pending order first', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const older = await createPendingDecision(account.id, { evaluatedAt: new Date('2026-01-01T00:00:00Z') });
    await createPendingDecision(account.id, { evaluatedAt: new Date('2026-01-02T00:00:00Z') });

    const res = await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });
    expect(res.body.order.decisionId).toBe(older.id);
  });

  it('a SELL order reports the correct side', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    await createPendingDecision(account.id, { action: 'OPEN_SELL', entryPrice: 1.1, stopLoss: 1.1018, takeProfit: 1.0982 });

    const res = await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });
    expect(res.body.order.side).toBe('SELL');
  });

  it("rejects a request for an accountId the token isn't bound to", async () => {
    const { token } = await setupAccountWithToken(prisma);
    const { account: otherAccount } = await setupAccountWithToken(prisma);

    const res = await request(app, {
      method: 'GET',
      url: `/collector/${otherAccount.id}/autonomous/pending-order`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('records a successful execution result as FILLED', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const decision = await createPendingDecision(account.id);

    await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });
    const res = await request(app, {
      method: 'POST',
      url: `/collector/${account.id}/autonomous/pending-order/${decision.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ok: true, ticket: 12345, filledPrice: 1.10001 },
    });

    expect(res.statusCode).toBe(201);
    const row = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(row.orderStatus).toBe('FILLED');
    expect(row.mt5Ticket).toBe(12345);
    expect(Number(row.filledPrice)).toBeCloseTo(1.10001, 5);
    expect(row.filledAt).not.toBeNull();
  });

  it('records a failed execution result as FAILED, with the error message, and no ticket', async () => {
    const { account, token } = await setupAccountWithToken(prisma);
    const decision = await createPendingDecision(account.id);

    await request(app, { method: 'GET', url: `/collector/${account.id}/autonomous/pending-order`, headers: { authorization: `Bearer ${token}` } });
    await request(app, {
      method: 'POST',
      url: `/collector/${account.id}/autonomous/pending-order/${decision.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ok: false, errorMessage: 'Requote, retry also failed' },
    });

    const row = await prisma.autonomousDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(row.orderStatus).toBe('FAILED');
    expect(row.mt5Ticket).toBeNull();
    expect(row.executionError).toBe('Requote, retry also failed');
  });
});
