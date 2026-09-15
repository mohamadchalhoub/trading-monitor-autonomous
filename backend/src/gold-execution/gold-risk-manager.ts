import {
  GOLD_COMBINED_RISK_CAP_PCT,
  GOLD_DAILY_LOSS_CAP_PCT,
  GOLD_DRAWDOWN_CAP_PCT,
  GOLD_SL_TP_TOLERANCE_POINTS,
  GOLD_STOP_RISK_CAP_PCT,
  GOLD_TP_SL_POINTS,
  GOLD_VOLUME_LOTS,
} from './gold-safety-constants';

/** Same closed-set posture as autonomous/risk-manager.ts's AccountTradeMode — mirrors MT5's own enum, not a boolean. */
export type GoldAccountTradeMode = 'DEMO' | 'REAL' | 'CONTEST';

export interface GoldCandidateOrder {
  action: 'OPEN_BUY' | 'OPEN_SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Points, not dollars — same convention as the EURUSD risk manager. */
  stopLossDistancePoints: number;
  takeProfitDistancePoints: number;
}

export interface GoldBrokerVolumeConstraints {
  minLots: number;
  maxLots: number;
  stepLots: number;
}

export interface GoldOccupancyState {
  /**
   * True if ANY XAUUSD exposure already exists — manual positions, this or
   * any other strategy's magic number, pending orders, or an UNKNOWN
   * (unreconciled) submission. Friend rule: "one at a time" is enforced
   * across ALL of these, not just this strategy's own magic number.
   */
  hasExistingXauusdExposure: boolean;
  exposureDescription: string | null;
}

export interface GoldAccountRiskInfo {
  tradeMode: GoldAccountTradeMode;
  /** Real, live-queried equity — never an assumed balance. */
  equity: number;
  /** Sum of stop-risk of any other currently-open combined-risk-counted positions, in account currency. */
  existingCombinedRiskAmount: number;
  /** Realized+floating loss so far today, in account currency (positive number = loss). */
  todaysLossAmount: number;
  /** Peak-to-current drawdown percentage already incurred, independent of this candidate. */
  currentDrawdownPct: number;
}

export interface GoldRiskManagerInput {
  candidate: GoldCandidateOrder;
  accountInfo: GoldAccountRiskInfo;
  occupancy: GoldOccupancyState;
  volumeConstraints: GoldBrokerVolumeConstraints;
  killSwitchActive: boolean;
  /** Signal-time executable price vs. current executable price, both already point-distance in gold points. */
  entryDeviationPoints: number;
  maxEntryDeviationPoints: number;
}

export interface GoldRiskManagerVerdict {
  approved: boolean;
  rejectionReason: string | null;
  volumeLots: number | null;
}

/**
 * Gold's independent, deterministic risk gate — analogous to
 * `autonomous/risk-manager.ts`'s `evaluateRiskManager`, but for the
 * mechanical confirmed-retest-v2-derived gold strategy instead of an
 * AI-assisted EURUSD decision. Deliberately re-checks everything a
 * coordinator might already have checked (defense in depth, same posture
 * as the EURUSD risk manager's own header comment).
 */
export function evaluateGoldRiskManager(input: GoldRiskManagerInput): GoldRiskManagerVerdict {
  const { candidate, accountInfo, occupancy, volumeConstraints, killSwitchActive, entryDeviationPoints, maxEntryDeviationPoints } = input;

  if (killSwitchActive) {
    return { approved: false, rejectionReason: 'Kill switch is active — no new gold orders permitted.', volumeLots: null };
  }

  // The single most safety-critical check: never trade a real-money account.
  if (accountInfo.tradeMode !== 'DEMO') {
    return {
      approved: false,
      rejectionReason: `Refusing to trade gold: account trade_mode is "${accountInfo.tradeMode}", not DEMO. This is an absolute, non-negotiable safety rule.`,
      volumeLots: null,
    };
  }

  if (occupancy.hasExistingXauusdExposure) {
    return {
      approved: false,
      rejectionReason: `Refusing to open a new XAUUSD order — existing exposure already occupies the one-position slot (${occupancy.exposureDescription ?? 'unspecified'}).`,
      volumeLots: null,
    };
  }

  if (entryDeviationPoints > maxEntryDeviationPoints) {
    return {
      approved: false,
      rejectionReason: `Executable price has moved ${entryDeviationPoints.toFixed(1)}pt since signal, beyond the max entry deviation of ${maxEntryDeviationPoints}pt — skipping, not chasing.`,
      volumeLots: null,
    };
  }

  // Volume: user-fixed, validated against real broker step/min/max — never resized.
  const volume = GOLD_VOLUME_LOTS;
  if (volume < volumeConstraints.minLots || volume > volumeConstraints.maxLots) {
    return {
      approved: false,
      rejectionReason: `Fixed volume ${volume} lots is outside broker bounds [${volumeConstraints.minLots}, ${volumeConstraints.maxLots}] — skipping, never auto-resizing.`,
      volumeLots: null,
    };
  }
  const stepRemainder = Math.abs(volume / volumeConstraints.stepLots - Math.round(volume / volumeConstraints.stepLots));
  if (stepRemainder > 1e-6) {
    return {
      approved: false,
      rejectionReason: `Fixed volume ${volume} lots is not a multiple of the broker's step ${volumeConstraints.stepLots} — skipping, never auto-resizing.`,
      volumeLots: null,
    };
  }

  if (Math.abs(candidate.stopLossDistancePoints - GOLD_TP_SL_POINTS) > GOLD_SL_TP_TOLERANCE_POINTS) {
    return {
      approved: false,
      rejectionReason: `Stop-loss distance ${candidate.stopLossDistancePoints.toFixed(1)}pt does not match the required ${GOLD_TP_SL_POINTS}pt ($10).`,
      volumeLots: null,
    };
  }
  if (Math.abs(candidate.takeProfitDistancePoints - GOLD_TP_SL_POINTS) > GOLD_SL_TP_TOLERANCE_POINTS) {
    return {
      approved: false,
      rejectionReason: `Take-profit distance ${candidate.takeProfitDistancePoints.toFixed(1)}pt does not match the required ${GOLD_TP_SL_POINTS}pt ($10).`,
      volumeLots: null,
    };
  }

  if (candidate.action === 'OPEN_BUY' && !(candidate.stopLoss < candidate.entryPrice && candidate.takeProfit > candidate.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_BUY stop-loss/take-profit are on the wrong side of entry.', volumeLots: null };
  }
  if (candidate.action === 'OPEN_SELL' && !(candidate.stopLoss > candidate.entryPrice && candidate.takeProfit < candidate.entryPrice)) {
    return { approved: false, rejectionReason: 'OPEN_SELL stop-loss/take-profit are on the wrong side of entry.', volumeLots: null };
  }

  // Equity-based risk caps — real equity, never assumed.
  if (accountInfo.equity <= 0) {
    return { approved: false, rejectionReason: 'Refusing to size risk against non-positive or unavailable account equity.', volumeLots: null };
  }
  const stopRiskAmount = volume * candidate.stopLossDistancePoints; // approximate; exact $/point conversion is broker contract-size dependent, handled by caller if more precision is needed
  const stopRiskPct = (stopRiskAmount / accountInfo.equity) * 100;
  if (stopRiskPct > GOLD_STOP_RISK_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Estimated stop risk ${stopRiskPct.toFixed(3)}% of equity exceeds the ${GOLD_STOP_RISK_CAP_PCT}% per-trade cap — skipping (fixed volume is not reduced).`,
      volumeLots: null,
    };
  }
  const combinedRiskPct = ((accountInfo.existingCombinedRiskAmount + stopRiskAmount) / accountInfo.equity) * 100;
  if (combinedRiskPct > GOLD_COMBINED_RISK_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Combined open risk ${combinedRiskPct.toFixed(3)}% of equity would exceed the ${GOLD_COMBINED_RISK_CAP_PCT}% combined cap.`,
      volumeLots: null,
    };
  }
  const dailyLossPct = (accountInfo.todaysLossAmount / accountInfo.equity) * 100;
  if (dailyLossPct >= GOLD_DAILY_LOSS_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Today's realized+floating loss ${dailyLossPct.toFixed(3)}% of equity has already reached the ${GOLD_DAILY_LOSS_CAP_PCT}% daily loss cap — no new entries today.`,
      volumeLots: null,
    };
  }
  if (accountInfo.currentDrawdownPct >= GOLD_DRAWDOWN_CAP_PCT) {
    return {
      approved: false,
      rejectionReason: `Current drawdown ${accountInfo.currentDrawdownPct.toFixed(3)}% has already reached the ${GOLD_DRAWDOWN_CAP_PCT}% cap — no new entries.`,
      volumeLots: null,
    };
  }

  return { approved: true, rejectionReason: null, volumeLots: volume };
}
