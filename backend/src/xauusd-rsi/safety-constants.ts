/**
 * Absolute, non-negotiable safety bounds for
 * `xauusd-m1-rsi-retest-extremes-v1`.
 *
 * Compile-time constants, deliberately NOT `.env` config — the same posture
 * as the strategies this one replaces. A bound an operator could edit
 * without a code change and a spec re-freeze is not a bound.
 *
 * This is its OWN file rather than an extension of
 * `gold-execution/gold-safety-constants.ts`, for the reason that file gives
 * for itself: two strategies must never share a magic number or a volume
 * constant, so that a position can always be attributed to exactly one
 * owner and an accidental code-path reuse fails a magic-number check
 * loudly instead of operating on the wrong strategy's position.
 */
import { SPEC } from './spec';

export const RSI_SYMBOL = SPEC.symbol;

/**
 * XAUUSD price increment at this broker: 2 decimal digits, so one point is
 * $0.01. Same figure the previous gold module verified against broker
 * contract metadata; the live value is still validated per-order against
 * `SymbolMetadata` before submission, so this constant is the expectation,
 * never the authority.
 */
export const RSI_GOLD_POINT_SIZE = 0.01;

/**
 * USER RULE — TP and SL are each a $5.00 move in quoted gold price
 * (spec §7). Expressed in points for the broker hand-off.
 */
export const RSI_TP_USD = SPEC.brackets.takeProfitUsd;
export const RSI_SL_USD = SPEC.brackets.stopLossUsd;
export const RSI_TP_POINTS = RSI_TP_USD / RSI_GOLD_POINT_SIZE; // 500 points
export const RSI_SL_POINTS = RSI_SL_USD / RSI_GOLD_POINT_SIZE; // 500 points

/** Tolerance when re-verifying a candidate's bracket distances, in points. */
export const RSI_SL_TP_TOLERANCE_POINTS = 1;

/**
 * A magic number used by no previous strategy in this codebase. The two
 * that came before are 262610180 (legacy EURUSD autonomous) and 262610181
 * (H4 confirmed-retest gold); trend-breakout allocates its own from its
 * instrument config. 262610190 is deliberately well clear of that run so a
 * future off-by-one in either family cannot collide with it.
 *
 * Ownership matters more here than usual: spec §10 requires that existing
 * old-strategy positions keep their original identity, so this strategy
 * claims ONLY positions carrying this magic number, and never adopts or
 * relabels one it did not open.
 */
export const RSI_MAGIC_NUMBER = 262610190;

/**
 * USER RULE (spec §10) — "Keep the current valid configured volume. Default
 * to 0.5 lot if no valid explicit setting exists." This is the fallback
 * only; the live value comes from the runtime settings service and is
 * validated against real broker min/max/step before every submission.
 * Never auto-resized to make an order acceptable.
 */
export const RSI_DEFAULT_VOLUME_LOTS = 0.5;

/**
 * Max drift, in gold points, between the price a signal was formed at and
 * the executable price at send time. 100 points = $1.00, 20% of the $5
 * stop distance. Tighter than the previous strategy's 200pt because this
 * strategy's stop is half as wide: the guard is scaled to the bracket it
 * protects, not carried over unchanged. Beyond this the entry is skipped,
 * never chased.
 */
export const RSI_MAX_ENTRY_DEVIATION_POINTS = 100;

/**
 * Max age, in seconds, between the observation that produced a signal and
 * the moment it is actually submitted. This strategy is intrabar and M1;
 * a signal that has sat for more than a minute is no longer the event the
 * rules described, so it is dropped rather than submitted late.
 */
export const RSI_MAX_SIGNAL_AGE_SECONDS = 60;

/**
 * A quote older than this, measured against the moment it is read, is not
 * usable for entry detection or submission.
 */
export const RSI_QUOTE_MAX_STALENESS_SECONDS = SPEC.observation.maxStalenessMs / 1000;

/**
 * Risk caps. Carried over UNWEAKENED from the strategy this one replaces
 * (spec §10 — "Do not increase volume, weaken caps"). Percentages of live,
 * real-queried account equity.
 */
export const RSI_STOP_RISK_CAP_PCT = 0.5;
export const RSI_COMBINED_RISK_CAP_PCT = 1;
export const RSI_DAILY_LOSS_CAP_PCT = 2;
export const RSI_DRAWDOWN_CAP_PCT = 5;

/**
 * Friday liquidation: how long a single close/cancel attempt may remain
 * unconfirmed before the worker re-queries broker state rather than
 * assuming the earlier request worked. Bounded retry, never unbounded.
 */
export const RSI_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS = 30;

/** Maximum liquidation attempts per owned item before it is escalated as a critical incident. */
export const RSI_LIQUIDATION_MAX_ATTEMPTS = 8;
