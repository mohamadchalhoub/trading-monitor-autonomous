// Server-only fetch layer — every page in this app is a Server Component,
// so these calls run on the Next.js server and talk to the backend
// directly (server-to-server), never from the browser. That sidesteps CORS
// entirely and means the backend API is never exposed to the client bundle.
const BASE_URL = process.env.BACKEND_API_URL ?? 'http://localhost:8420';

// Dashboard authentication (production-readiness review — Option B). Read
// from a server-only env var — deliberately NOT NEXT_PUBLIC_*, which Next.js
// inlines into the client bundle at build time; this one is only ever read
// here, on the server, and only ever sent as a header, never as a query
// param, never logged, never rendered into any page's HTML. This module's
// only client-side import anywhere (AccountSwitcher.tsx) is `import type`,
// which TypeScript erases entirely at compile time — the token itself never
// reaches the browser bundle regardless.
const DASHBOARD_API_TOKEN = process.env.DASHBOARD_API_TOKEN;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DASHBOARD_API_TOKEN) {
    throw new Error('Missing required configuration: DASHBOARD_API_TOKEN. See frontend/.env.local.example.');
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    cache: 'no-store', // this is a monitoring dashboard — always read current state, never a stale cached page
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${DASHBOARD_API_TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: string;
  platform: 'MT5' | 'XTB';
  externalAccountId: string;
  broker: string | null;
  currency: string;
  displayName: string | null;
  isActive: boolean;
  tradingDayTimezone: string;
  tradingDayResetHour: number;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  accountId: string;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string | null;
  profit: string;
  capturedAt: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  openPrice: string;
  currentPrice: string | null;
  profit: string;
  swap: string;
  openedAt: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  dealEntry: 'IN' | 'OUT';
  volume: string;
  price: string;
  commission: string;
  swap: string;
  profit: string;
  executedAt: string;
  comment: string | null;
  platform: 'MT5' | 'XTB';
}

export interface Paginated {
  total: number;
  limit: number;
  offset: number;
}

export type HealthComponent =
  | 'COLLECTOR'
  | 'MT5_TERMINAL'
  | 'DATABASE'
  | 'REDIS'
  | 'TELEGRAM'
  | 'AI_PROVIDER'
  | 'XTB_IMPORT'
  | 'DATA_INTEGRITY';

export type HealthStatusValue = 'OK' | 'DEGRADED' | 'DOWN';

export interface ComponentHealth {
  status: HealthStatusValue;
  detail: Record<string, unknown> | null;
  checkedAt: string | null;
}

export type HealthSnapshot = Record<HealthComponent, ComponentHealth>;

export interface HealthIncident {
  id: string;
  component: HealthComponent;
  statusFrom: HealthStatusValue;
  statusTo: HealthStatusValue;
  openedAt: string;
  resolvedAt: string | null;
  detail: Record<string, unknown> | null;
}

export interface RuleDefinition {
  id: string;
  accountId: string;
  name: string;
  ruleType: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  cooldownSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  state: 'INACTIVE' | 'ACTIVE' | null;
}

export interface Alert {
  id: string;
  ruleId: string;
  accountId: string;
  triggeredAt: string;
  triggerValues: Record<string, unknown>;
  rule: { id: string; name: string; ruleType: string };
  delivery: { status: string; sentAt: string | null; attempts: number } | null;
  aiAnalysis: { status: string; result: unknown; safetyFlagged: boolean } | null;
}

export interface ImportBatch {
  id: string;
  accountId: string;
  fileSha256: string;
  fileName: string | null;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface EurUsdRoundTrip {
  positionId: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  profit: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface Candle {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface MarketDataCoverage {
  symbol: string;
  candles: Array<{
    timeframe: string;
    count: number;
    earliest: string | null;
    latest: string | null;
    intervalStatusCounts: Record<string, number>;
  }>;
  ticks: { count: number; earliest: string | null; latest: string | null; intervalStatusCounts: Record<string, number> };
  symbolMetadata: { present: boolean; updatedAt: string | null };
}

export interface TradeChartFeatures {
  preEntry: { returnPct: number | null; volatilityPct: number | null; recentHigh: number | null; recentLow: number | null; candleCount: number };
  duringTrade: { maxFavorableExcursionPct: number | null; maxAdverseExcursionPct: number | null; volatilityPct: number | null; candleCount: number };
  postExit: { continuationPct: number | null; candleCount: number };
}

export interface TradeChartWindow {
  positionId: string;
  symbol: string;
  timeframe: 'M5' | 'M15' | 'H1';
  side: 'BUY' | 'SELL';
  entryMarker: { time: string; price: number };
  exitMarker: { time: string; price: number; profit: number };
  stopLoss: number | null;
  takeProfit: number | null;
  candles: Candle[];
  features: TradeChartFeatures;
  dataLimitation: string | null;
}

export interface SupportResistanceLevel {
  timeframe: 'H1' | 'H4' | 'D1';
  type: 'SUPPORT' | 'RESISTANCE';
  price: number;
  method: 'FRACTAL_PIVOT';
  timestamp: string;
  touches: number;
}

export interface NearestSupportResistance {
  timeframe: 'H1' | 'H4' | 'D1';
  nearestSupport: SupportResistanceLevel | null;
  nearestResistance: SupportResistanceLevel | null;
}

export interface IchimokuStateWithTimeframe {
  timeframe: string;
  timestamp: string;
  close: number;
  spanA: number | null;
  spanB: number | null;
  position: 'ABOVE_CLOUD' | 'BELOW_CLOUD' | 'INSIDE_CLOUD' | 'INSUFFICIENT_DATA';
}

export interface FibonacciAnalysisReport {
  swingHigh: { price: number; timestamp: string };
  swingLow: { price: number; timestamp: string };
  direction: 'BULLISH' | 'BEARISH';
  levels: { ratio: number; price: number }[];
  currentPrice: number;
  nearestLevel: { ratio: number; price: number };
}

export interface MarketDirectionReport {
  symbol: string;
  dailyBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  reasons: string[];
  signals: { name: string; vote: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; reason: string }[];
  timeframes: string[];
  timestamp: string;
}

export interface TechnicalAnalysisReport {
  symbol: string;
  currentPrice: number;
  marketDirection: MarketDirectionReport;
  fibonacci: FibonacciAnalysisReport | null;
  supportResistance: NearestSupportResistance[];
  ichimoku: IchimokuStateWithTimeframe[];
  timestamp: string;
}

export interface TrendBreakoutVolumeSetting {
  instrument: 'EURUSD' | 'XAUUSD';
  volumeLots: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface TrendBreakoutInstrumentSettings {
  instrument: 'EURUSD' | 'XAUUSD';
  brokerSymbol: string;
  volume: TrendBreakoutVolumeSetting;
  slotOccupied: boolean;
  slotState: 'PENDING' | 'OPEN' | 'UNKNOWN' | null;
  symbolMetadataKnown: boolean;
}

export interface TrendBreakoutRiskPolicy {
  version: number;
  maxTradeRiskPct: number;
  maxCombinedRiskPct: number;
  dailyLossPct: number;
  drawdownPct: number;
  maxSpreadPctOfD: number;
  maxQuoteAgeSeconds: number;
}

export interface TrendBreakoutSettings {
  strategyVersion: string;
  instruments: TrendBreakoutInstrumentSettings[];
  entryWindow: { timezone: string; start: string; end: string };
  entryWindowCurrentlyOpen: boolean;
  riskPolicy: TrendBreakoutRiskPolicy;
  executionMode: string;
}

export interface TrendBreakoutVolumeAuditEntry {
  id: string;
  instrument: string;
  oldVolume: string | null;
  newVolume: string;
  newVersion: number;
  changedBy: string;
  changedAt: string;
}

export interface TrendBreakoutDecision {
  id: string;
  instrument: string;
  signalCloseAt: string;
  decisionAtUtc: string;
  decisionAtBeirut: string;
  action: 'OPEN_BUY' | 'OPEN_SELL' | 'HOLD';
  atr14: string | null;
  volumeUsed: string | null;
  estimatedStopRiskAmount: string | null;
  estimatedStopRiskCcy: string | null;
  intendedEntryPrice: string | null;
  intendedStopLoss: string | null;
  intendedTakeProfit: string | null;
  gateResults: { gate: string; passed: boolean; reason: string }[];
  rejectionReason: string | null;
  orderStatus: 'NONE' | 'PENDING' | 'SENT' | 'FILLED' | 'FAILED';
}

export const api = {
  listAccounts: () => apiFetch<Account[]>('/accounts'),
  getAccount: (id: string) => apiFetch<Account>(`/accounts/${id}`),
  latestSnapshot: (accountId: string) => apiFetch<Snapshot | null>(`/accounts/${accountId}/snapshots/latest`),
  openPositions: (accountId: string) => apiFetch<Position[]>(`/accounts/${accountId}/positions`),
  trades: (accountId: string, params: { limit?: number; offset?: number } = {}) =>
    apiFetch<{ trades: Trade[] } & Paginated>(
      `/accounts/${accountId}/trades?limit=${params.limit ?? 50}&offset=${params.offset ?? 0}`,
    ),
  rules: (accountId: string) => apiFetch<RuleDefinition[]>(`/accounts/${accountId}/rules`),
  alerts: (accountId: string, params: { limit?: number; offset?: number } = {}) =>
    apiFetch<{ alerts: Alert[] } & Paginated>(
      `/accounts/${accountId}/alerts?limit=${params.limit ?? 50}&offset=${params.offset ?? 0}`,
    ),
  health: () => apiFetch<HealthSnapshot>('/health'),
  healthIncidents: (component?: HealthComponent) =>
    apiFetch<HealthIncident[]>(`/health/incidents${component ? `?component=${component}` : ''}`),
  importBatches: (accountId: string) => apiFetch<ImportBatch[]>(`/xtb-import/batches/${accountId}`),
  importCsv: (input: { accountId: string; fileName: string; csvContent: string }) =>
    apiFetch<ImportBatch>('/xtb-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  eurUsdTrades: (accountId: string) => apiFetch<EurUsdRoundTrip[]>(`/accounts/${accountId}/eurusd-trades`),
  eurUsdTradeChart: (accountId: string, positionId: string) =>
    apiFetch<TradeChartWindow>(`/accounts/${accountId}/eurusd-trades/${encodeURIComponent(positionId)}/chart`),
  technicalAnalysis: (accountId: string) => apiFetch<TechnicalAnalysisReport | null>(`/accounts/${accountId}/technical-analysis`),
  trendBreakoutSettings: (accountId: string) => apiFetch<TrendBreakoutSettings>(`/accounts/${accountId}/trend-breakout/settings`),
  trendBreakoutVolumeAudit: (accountId: string, instrument: string) =>
    apiFetch<TrendBreakoutVolumeAuditEntry[]>(`/accounts/${accountId}/trend-breakout/volume-audit/${instrument}`),
  trendBreakoutDecisions: (accountId: string, params: { instrument?: string; limit?: number } = {}) =>
    apiFetch<TrendBreakoutDecision[]>(
      `/accounts/${accountId}/trend-breakout/decisions?limit=${params.limit ?? 30}${params.instrument ? `&instrument=${params.instrument}` : ''}`,
    ),
  updateTrendBreakoutVolume: (accountId: string, instrument: string, input: { volumeLots: number; changedBy: string }) =>
    apiFetch<{ ok: boolean; error?: string; warning?: string }>(`/accounts/${accountId}/trend-breakout/volume/${instrument}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  resetTrendBreakoutDrawdown: (accountId: string, resetBy: string) =>
    apiFetch<{ ok: boolean }>(`/accounts/${accountId}/trend-breakout/drawdown-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetBy }),
    }),
  marketCandles: (symbol: string, timeframe: string, from: string, to: string) =>
    apiFetch<{ symbol: string; timeframe: string; candles: Candle[] }>(
      `/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  marketCoverage: (symbol: string) =>
    apiFetch<MarketDataCoverage>(`/market-data/coverage?symbol=${encodeURIComponent(symbol)}`),
};
