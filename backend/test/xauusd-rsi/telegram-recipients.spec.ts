/**
 * Multi-recipient Telegram delivery.
 *
 * The properties that matter are the ones about FAILURE, because the failure
 * mode here is silent: one recipient's success hiding another's failure, or a
 * retry duplicating a message that already arrived. Both are tested against
 * real Postgres, since the deduplication is a database uniqueness constraint
 * rather than application bookkeeping.
 *
 * Telegram itself is stubbed. No message leaves the machine from this file.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoldTelegramService } from '../../src/gold-execution/gold-telegram.service';
import { parseRecipients, recipientDedupKey } from '../../src/gold-execution/gold-telegram-recipients';

describe('Recipient configuration', () => {
  it('keeps the owner and adds the extras, without duplicating a repeated chat', () => {
    const { recipients, problems } = parseRecipients({
      GOLD_TELEGRAM_CHAT_ID: '111',
      GOLD_TELEGRAM_CHAT_IDS: 'Mhd Hmd:222,111',
    });
    expect(problems).toHaveLength(0);
    expect(recipients.map((r) => r.chatId)).toEqual(['111', '222']);
    expect(recipients[0].label).toBe('Owner');
    expect(recipients[1].label).toBe('Mhd Hmd');
  });

  it('accepts a bare id with no label', () => {
    const { recipients } = parseRecipients({ GOLD_TELEGRAM_CHAT_IDS: '-100987654321' });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].chatId).toBe('-100987654321');
  });

  it('reports a malformed id rather than passing it to the API', () => {
    const { recipients, problems } = parseRecipients({ GOLD_TELEGRAM_CHAT_IDS: 'Broken:abc,Good:222' });
    expect(recipients.map((r) => r.chatId)).toEqual(['222']);
    expect(problems.join(' ')).toMatch(/not a valid Telegram chat id/);
  });

  it('handles a label containing a colon by splitting on the LAST one', () => {
    const { recipients } = parseRecipients({ GOLD_TELEGRAM_CHAT_IDS: 'Ops: gold alerts:333' });
    expect(recipients[0].chatId).toBe('333');
    expect(recipients[0].label).toBe('Ops: gold alerts');
  });

  it('yields no recipients when nothing is configured', () => {
    expect(parseRecipients({}).recipients).toHaveLength(0);
  });

  it('keys deduplication per recipient', () => {
    expect(recipientDedupKey('fill:abc', '111')).not.toBe(recipientDedupKey('fill:abc', '222'));
  });
});

describe('Per-recipient delivery, against real Postgres', () => {
  let prisma: PrismaClient;
  let configValues: Record<string, string>;
  let configService: ConfigService;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    prisma = new PrismaClient();
  });
  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.goldTelegramNotification.deleteMany();
    configValues = {
      GOLD_TELEGRAM_BOT_TOKEN: 'test-token',
      GOLD_TELEGRAM_CHAT_ID: '111',
      GOLD_TELEGRAM_CHAT_IDS: 'Friend:222',
    };
    configService = { get: (k: string) => configValues[k] } as unknown as ConfigService;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ok = (messageId: number) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  });
  const forbidden = () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
  });

  function service() {
    return new GoldTelegramService(prisma as never, configService);
  }

  it('sends once to each recipient and records each separately', async () => {
    fetchMock.mockResolvedValueOnce(ok(1001)).mockResolvedValueOnce(ok(1002));

    const report = await service().notify('FILL_CONFIRMED', 'evt-1', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report.results.map((r) => r.status)).toEqual(['SENT', 'SENT']);
    expect(report.results.map((r) => r.messageId)).toEqual([1001, 1002]);

    const rows = await prisma.goldTelegramNotification.findMany({ orderBy: { chatId: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.chatId)).toEqual(['111', '222']);
    expect(rows.map((r) => r.messageId)).toEqual([1001, 1002]);
    expect(rows.map((r) => r.recipientLabel)).toEqual(['Owner', 'Friend']);
  });

  it("one recipient's failure does not hide the other's success", async () => {
    fetchMock.mockResolvedValueOnce(ok(2001)).mockResolvedValueOnce(forbidden());

    const report = await service().notify('FILL_CONFIRMED', 'evt-2', 'hello');

    expect(report.results.map((r) => r.status)).toEqual(['SENT', 'FAILED']);
    const rows = await prisma.goldTelegramNotification.findMany({ orderBy: { chatId: 'asc' } });
    expect(rows.find((r) => r.chatId === '111')?.status).toBe('SENT');
    const failed = rows.find((r) => r.chatId === '222');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.lastError).toMatch(/blocked by the user/);
  });

  it('a retry re-sends ONLY the recipient that failed', async () => {
    fetchMock.mockResolvedValueOnce(ok(3001)).mockResolvedValueOnce(forbidden());
    await service().notify('FILL_CONFIRMED', 'evt-3', 'hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The friend has now started the bot; a retry should reach them and must
    // NOT deliver a second copy to the owner.
    fetchMock.mockResolvedValueOnce(ok(3002));
    const retry = await service().notify('FILL_CONFIRMED', 'evt-3', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retry.results.find((r) => r.recipient.chatId === '111')?.status).toBe('ALREADY_SENT');
    expect(retry.results.find((r) => r.recipient.chatId === '222')?.status).toBe('SENT');

    const rows = await prisma.goldTelegramNotification.findMany({ orderBy: { chatId: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SENT')).toBe(true);
    // The owner keeps its ORIGINAL message id: it was not re-sent.
    expect(rows.find((r) => r.chatId === '111')?.messageId).toBe(3001);
    expect(rows.find((r) => r.chatId === '222')?.messageId).toBe(3002);
  });

  it('a repeated event with both already sent sends nothing at all', async () => {
    fetchMock.mockResolvedValueOnce(ok(4001)).mockResolvedValueOnce(ok(4002));
    await service().notify('FILL_CONFIRMED', 'evt-4', 'hello');
    fetchMock.mockClear();

    const again = await service().notify('FILL_CONFIRMED', 'evt-4', 'hello');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(again.results.every((r) => r.status === 'ALREADY_SENT')).toBe(true);
  });

  it('adding a recipient later delivers only to the new one for an already-sent event', async () => {
    fetchMock.mockResolvedValueOnce(ok(5001)).mockResolvedValueOnce(ok(5002));
    await service().notify('FILL_CONFIRMED', 'evt-5', 'hello');
    fetchMock.mockClear();

    configValues.GOLD_TELEGRAM_CHAT_IDS = 'Friend:222,Third:333';
    fetchMock.mockResolvedValueOnce(ok(5003));
    const report = await service().notify('FILL_CONFIRMED', 'evt-5', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.results.find((r) => r.recipient.chatId === '333')?.status).toBe('SENT');
    expect(await prisma.goldTelegramNotification.count()).toBe(3);
  });

  it('records the destination on every row, so a delivery is attributable', async () => {
    fetchMock.mockResolvedValueOnce(ok(6001)).mockResolvedValueOnce(ok(6002));
    await service().notify('CLOSE_CONFIRMED', 'evt-6', 'hello');

    const rows = await prisma.goldTelegramNotification.findMany();
    expect(rows.every((r) => r.chatId !== null && r.recipientLabel !== null)).toBe(true);
    expect(rows.every((r) => r.eventType === 'CLOSE_CONFIRMED')).toBe(true);
  });

  it('never throws when Telegram is entirely unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.telegram.org'));

    const report = await service().notify('FILL_CONFIRMED', 'evt-7', 'hello');

    expect(report.results.every((r) => r.status === 'FAILED')).toBe(true);
    const rows = await prisma.goldTelegramNotification.findMany();
    expect(rows.every((r) => r.status === 'FAILED')).toBe(true);
  });
});
