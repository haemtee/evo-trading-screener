export type Side = 'LONG' | 'SHORT';

export type PatternType =
  | 'BULLISH_ENGULFING'
  | 'BULLISH_MARUBOZU'
  | 'BEARISH_ENGULFING'
  | 'BEARISH_MARUBOZU';

export type SignalStatus = 'PENDING' | 'EXECUTED' | 'SKIPPED' | 'FAILED';

export type TradeStatus = 'OPEN' | 'CLOSED';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
}

export interface Ticker24h {
  symbol: string;
  priceChangePercent: number;
  lastPrice: number;
  quoteVolume: number;
}

export interface SymbolFilter {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export interface WatchlistItem {
  symbol: string;
  side: Side;
  priceChangePct: number;
  quoteVolume: number;
  lastPrice: number;
  scannedAt: number;
}

export interface DetectedSignal {
  symbol: string;
  side: Side;
  pattern: PatternType;
  candleOpenTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  ema21: number;
  volumeRatio: number;
  bodyRatio: number;
}

export interface SignalRecord extends DetectedSignal {
  id: number;
  status: SignalStatus;
  createdAt: number;
}

export interface NewTradeInput {
  signalId: number | null;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUsd: number;
  leverage: number;
  entryOrderId: string | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  openedAt?: number;
}

export interface TradeRecord {
  id: number;
  signalId: number | null;
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUsd: number;
  leverage: number;
  entryOrderId: string | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  status: TradeStatus;
  pnlUsd: number | null;
  openedAt: number;
  closedAt: number | null;
}

export interface BotSettings {
  scannerEnabled: boolean;
  autoTrade: boolean;
  riskPct: number;
  rrRatio: number;
  leverage: number;
  maxOpenPositions: number;
  minVolumeUsd: number;
  topN: number;
  emaPeriod: number;
}
