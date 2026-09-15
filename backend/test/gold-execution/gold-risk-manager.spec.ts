import { describe, expect, it } from 'vitest';
import { evaluateGoldRiskManager, GoldRiskManagerInput } from '../../src/gold-execution/gold-risk-manager';
import { GOLD_TP_SL_POINTS } from '../../src/gold-execution/gold-safety-constants';

function baseInput(overrides: Partial<GoldRiskManagerInput> = {}): GoldRiskManagerInput {
  return {
    candidate: {
      action: 'OPEN_BUY',
      entryPrice: 2650.0,
      stopLoss: 2640.0,
      takeProfit: 2660.0,
      stopLossDistancePoints: GOLD_TP_SL_POINTS,
      takeProfitDistancePoints: GOLD_TP_SL_POINTS,
    },
    accountInfo: {
      tradeMode: 'DEMO',
      equity: 10000,
      existingCombinedRiskAmount: 0,
      todaysLossAmount: 0,
      currentDrawdownPct: 0,
    },
    occupancy: { hasExistingXauusdExposure: false, exposureDescription: null },
    volumeConstraints: { minLots: 0.01, maxLots: 100, stepLots: 0.01 },
    killSwitchActive: false,
    entryDeviationPoints: 0,
    maxEntryDeviationPoints: 200,
    ...overrides,
  };
}

describe('evaluateGoldRiskManager', () => {
  it('approves a valid DEMO candidate with no occupancy and no cap breach', () => {
    const verdict = evaluateGoldRiskManager(baseInput());
    expect(verdict.approved).toBe(true);
    expect(verdict.volumeLots).toBe(0.01);
  });

  it('rejects when kill switch is active', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ killSwitchActive: true }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/kill switch/i);
  });

  it('rejects a non-DEMO account absolutely, even if everything else is valid', () => {
    const verdict = evaluateGoldRiskManager(
      baseInput({ accountInfo: { tradeMode: 'REAL', equity: 10000, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/not DEMO/);
  });

  it('rejects when XAUUSD exposure already exists (occupancy)', () => {
    const verdict = evaluateGoldRiskManager(
      baseInput({ occupancy: { hasExistingXauusdExposure: true, exposureDescription: 'manual position ticket=123' } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/existing exposure/);
  });

  it('rejects when entry deviation exceeds the max', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ entryDeviationPoints: 500, maxEntryDeviationPoints: 200 }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/max entry deviation/);
  });

  it('rejects and never resizes when fixed volume violates broker step', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ volumeConstraints: { minLots: 0.01, maxLots: 100, stepLots: 0.1 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/step/);
    expect(verdict.volumeLots).toBeNull();
  });

  it('rejects when SL distance does not match the required $10 (points)', () => {
    const verdict = evaluateGoldRiskManager(
      baseInput({ candidate: { action: 'OPEN_BUY', entryPrice: 2650, stopLoss: 2645, takeProfit: 2660, stopLossDistancePoints: 500, takeProfitDistancePoints: GOLD_TP_SL_POINTS } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/Stop-loss distance/);
  });

  it('rejects OPEN_BUY with SL/TP on the wrong side of entry', () => {
    const verdict = evaluateGoldRiskManager(
      baseInput({ candidate: { action: 'OPEN_BUY', entryPrice: 2650, stopLoss: 2660, takeProfit: 2640, stopLossDistancePoints: GOLD_TP_SL_POINTS, takeProfitDistancePoints: GOLD_TP_SL_POINTS } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/wrong side/);
  });

  it('rejects when stop risk exceeds the 0.5% per-trade cap', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 5, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/per-trade cap/);
  });

  it('rejects when today\'s loss has already reached the 2% daily cap', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 10000, existingCombinedRiskAmount: 0, todaysLossAmount: 200, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/daily loss cap/);
  });

  it('rejects when drawdown has already reached the 5% cap', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 10000, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 5 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/drawdown/);
  });

  it('rejects a non-positive equity rather than sizing risk against it', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 0, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/equity/);
  });
});
