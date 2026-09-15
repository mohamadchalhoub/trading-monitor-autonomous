import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GoldProtectionMonitorService } from '../../src/gold-execution/gold-protection-monitor.service';
import { IncomingPositionDto } from '../../src/collector-ingress/dto/snapshot.dto';
import { GOLD_MAGIC_NUMBER } from '../../src/gold-execution/gold-safety-constants';

const ACCOUNT_ID = 'acc-1';

function position(overrides: Partial<IncomingPositionDto> = {}): IncomingPositionDto {
  return {
    externalPositionId: 'pos-1',
    symbol: 'XAUUSD',
    side: 'BUY',
    volume: 0.01,
    openPrice: 2400,
    stopLoss: 2390,
    takeProfit: 2420,
    profit: 1.5,
    swap: 0,
    openedAt: '2026-09-15T10:00:00.000Z',
    raw: { magic: GOLD_MAGIC_NUMBER },
    ...overrides,
  } as IncomingPositionDto;
}

describe('GoldProtectionMonitorService', () => {
  let prismaMock: any;
  let telegramMock: any;
  let goldAiSummaryMock: any;
  let closeExecutionMock: any;
  let service: GoldProtectionMonitorService;

  beforeEach(() => {
    prismaMock = { goldTelegramNotification: { findFirst: vi.fn().mockResolvedValue(null) } };
    telegramMock = { notify: vi.fn().mockResolvedValue(undefined) };
    goldAiSummaryMock = { generateForEvent: vi.fn().mockResolvedValue(undefined) };
    closeExecutionMock = { requestClose: vi.fn().mockResolvedValue({ request: { id: 'close-req-1', status: 'PENDING' }, duplicate: false }) };
    service = new GoldProtectionMonitorService(prismaMock, telegramMock, goldAiSummaryMock, closeExecutionMock);
  });

  it('ignores non-gold symbols entirely', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ symbol: 'EURUSD', stopLoss: undefined, takeProfit: undefined })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('a fully protected position (SL and TP both set) never alerts or remediates', async () => {
    await service.checkPositions(ACCOUNT_ID, [position()]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('missing stopLoss alone is unprotected: alerts MISSING_PROTECTION AND queues a remediation close', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('MISSING_PROTECTION');
    expect(eventTypes).toContain('PROTECTION_REMEDIATION_CLOSE_REQUESTED');
    expect(closeExecutionMock.requestClose).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID, positionTicket: 'pos-1', side: 'BUY', volume: 0.01,
    });
  });

  it('MT5 convention: stopLoss/takeProfit of 0 also counts as unprotected, not "set to zero"', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: 0, takeProfit: 0 })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(closeExecutionMock.requestClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-alert or re-remediate on every cycle while still unprotected (transition-only)', async () => {
    // First check: no prior notification on record -> new incident, alerts + remediates.
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce(null);
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    expect(closeExecutionMock.requestClose).toHaveBeenCalledTimes(1);

    // Second check (next cycle): last known state IS already MISSING_PROTECTION -> no resend, no re-remediation.
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'MISSING_PROTECTION' });
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    expect(closeExecutionMock.requestClose).toHaveBeenCalledTimes(1); // still just the one call
  });

  it('alerts PROTECTION_RESTORED (and does not remediate) when a previously-missing position becomes protected again', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'MISSING_PROTECTION' });
    await service.checkPositions(ACCOUNT_ID, [position()]); // now fully protected
    expect(telegramMock.notify).toHaveBeenCalledTimes(1);
    expect(telegramMock.notify.mock.calls[0][0]).toBe('PROTECTION_RESTORED');
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('a repeat incident after a restoration alerts and remediates again (fresh, non-colliding dedup key)', async () => {
    // Last known state is RESTORED -> a fresh missing-protection incident must alert again.
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORED' });
    await service.checkPositions(ACCOUNT_ID, [position({ takeProfit: undefined })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(closeExecutionMock.requestClose).toHaveBeenCalledTimes(1);
  });

  it('dedup key for the alert is scoped per-position and includes a fresh timestamp per incident (never a static collision)', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const dedupKey = telegramMock.notify.mock.calls[0][1];
    expect(dedupKey).toMatch(/^protection:pos-1:missing:\d+$/);
  });

  it('a duplicate remediation request (one already in flight) does not queue a second close, and says so in the notification', async () => {
    closeExecutionMock.requestClose.mockResolvedValueOnce({ request: { id: 'close-req-1', status: 'SENT' }, duplicate: true });
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const remediationCall = telegramMock.notify.mock.calls.find((c: any[]) => c[0] === 'PROTECTION_REMEDIATION_CLOSE_REQUESTED');
    expect(remediationCall[2]).toContain('already queued');
  });

  it('if queuing the remediation close itself fails, alerts a CRITICAL PROTECTION_REMEDIATION_FAILED — never fails silently', async () => {
    closeExecutionMock.requestClose.mockRejectedValueOnce(new Error('db down'));
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('PROTECTION_REMEDIATION_FAILED');
  });

  it('task item 4 — alerts on an unprotected position with a DIFFERENT magic (not ours), but does NOT auto-close it', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined, raw: { magic: 999999999 } })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('task item 4 — alerts on an unprotected position with NO magic at all (manual trade), but does NOT auto-close it', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined, raw: {} })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('one position failing does not stop the others in the same batch', async () => {
    prismaMock.goldTelegramNotification.findFirst
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(null);
    await service.checkPositions(ACCOUNT_ID, [
      position({ externalPositionId: 'pos-fail', stopLoss: undefined }),
      position({ externalPositionId: 'pos-ok', stopLoss: undefined }),
    ]);
    const missingCalls = telegramMock.notify.mock.calls.filter((c: any[]) => c[0] === 'MISSING_PROTECTION');
    expect(missingCalls).toHaveLength(1);
    expect(missingCalls[0][1]).toContain('pos-ok');
  });
});
