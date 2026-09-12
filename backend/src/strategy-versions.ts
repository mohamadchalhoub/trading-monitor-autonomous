/**
 * The two strategy identifiers this codebase has ever run, in one place so
 * neither can be typo'd differently in two files.
 *
 * - `LEGACY_WEEKLY_H4_SR_STRATEGY_ID` — the friend's EURUSD weekly H4
 *   support/resistance rule (`backend/src/autonomous/`,
 *   `AUTONOMOUS_RULE_ENGINE_SPEC.md`). ARCHIVED as of this session: its
 *   code, tables, and historical decisions are left completely untouched
 *   (nothing here migrates or reinterprets them) so its backtest/live
 *   results stay interpretable exactly as they were reported. It is simply
 *   no longer the strategy under active development. Retroactively labeled
 *   here for reference in reports/docs — no historical row anywhere was
 *   ever tagged with this string (no such column existed on
 *   `AutonomousDecision`), so absence of the tag is what "belongs to the
 *   legacy strategy" means for anything from before this session.
 * - `TREND_BREAKOUT_STRATEGY_VERSION` — the new, deterministic H4-trend /
 *   H1-breakout / H1-ATR-exit strategy (`backend/src/trend-breakout/`).
 *   Every row this strategy ever writes (TrendBreakoutDecision, slot locks,
 *   volume/risk settings) is stamped with this exact string. A future
 *   revision of the rules gets a NEW versioned string (e.g.
 *   `h4-trend-h1-breakout-v2`) rather than an in-place semantic change to
 *   this one — so a historical decision row's own `strategyVersion` field
 *   always tells you exactly which rule set produced it, even after the
 *   rules themselves change again later.
 */
export const LEGACY_WEEKLY_H4_SR_STRATEGY_ID = 'weekly-h4-sr-v1';
export const TREND_BREAKOUT_STRATEGY_VERSION = 'h4-trend-h1-breakout-v1';
