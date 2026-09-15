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
      accountCurrency: 'USD',
      profitCurrency: 'USD',
      profitCurrencyToAccountCurrencyRate: 1,
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
      baseInput({ accountInfo: { tradeMode: 'REAL', equity: 10000, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }),
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
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 5, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/per-trade cap/);
  });

  it('rejects when today\'s loss has already reached the 2% daily cap', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 10000, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 200, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/daily loss cap/);
  });

  it('rejects when drawdown has already reached the 5% cap', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 10000, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 5 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/drawdown/);
  });

  it('rejects a non-positive equity rather than sizing risk against it', () => {
    const verdict = evaluateGoldRiskManager(baseInput({ accountInfo: { tradeMode: 'DEMO', equity: 0, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 } }));
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toMatch(/equity/);
  });

  describe('currency conversion (profit currency USD vs. account currency EUR)', () => {
    it('rejects rather than assume 1:1 when a conversion is needed but no live rate is available', () => {
      const verdict = evaluateGoldRiskManager(baseInput({
        accountInfo: { tradeMode: 'DEMO', equity: 10000, accountCurrency: 'EUR', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: null, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 },
      }));
      expect(verdict.approved).toBe(false);
      expect(verdict.rejectionReason).toMatch(/no live conversion rate/);
    });

    it('applies a real conversion rate rather than treating USD stop-risk as EUR 1:1', () => {
      // 0.01 lots * 1000 points = $10 stop risk. At an EURUSD-implied rate of
      // 0.87 EUR-per-USD, that's €8.70 — 0.087% of €10,000 equity, well
      // under the 0.5% cap. Without conversion (wrongly treated as €10 flat)
      // the result would still pass here, so this test alone doesn't
      // distinguish the bug — the point is the NEXT test does.
      const verdict = evaluateGoldRiskManager(baseInput({
        accountInfo: { tradeMode: 'DEMO', equity: 10000, accountCurrency: 'EUR', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: 0.87, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 },
      }));
      expect(verdict.approved).toBe(true);
    });

    it('the real conversion and a wrong 1:1 assumption genuinely diverge in verdict', () => {
      // $10 USD stop risk. Real EUR/USD~0.87 rate: €8.70 stop risk.
      // On €1,800 equity: real 8.70/1800=0.483% (under the 0.5% cap,
      // approved); a wrong 1:1 assumption (treating $10 as €10) gives
      // 10/1800=0.556% (over the cap, rejected) — the two paths genuinely
      // produce different outcomes, proving the conversion is load-bearing,
      // not cosmetic.
      const rate = 0.87; // EUR per USD, realistic
      const withRealConversion = evaluateGoldRiskManager(baseInput({
        accountInfo: { tradeMode: 'DEMO', equity: 1800, accountCurrency: 'EUR', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: rate, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 },
      }));
      const assuming1to1 = evaluateGoldRiskManager(baseInput({
        accountInfo: { tradeMode: 'DEMO', equity: 1800, accountCurrency: 'EUR', profitCurrency: 'EUR', profitCurrencyToAccountCurrencyRate: 1, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 },
      }));
      expect(withRealConversion.approved).toBe(true);
      expect(assuming1to1.approved).toBe(false);
    });

    it('needs no conversion at all when profit and account currency already match', () => {
      const verdict = evaluateGoldRiskManager(baseInput({
        accountInfo: { tradeMode: 'DEMO', equity: 10000, accountCurrency: 'USD', profitCurrency: 'USD', profitCurrencyToAccountCurrencyRate: null, existingCombinedRiskAmount: 0, todaysLossAmount: 0, currentDrawdownPct: 0 },
      }));
      expect(verdict.approved).toBe(true); // null rate is fine here — never even consulted since currencies match
    });
  });
});
