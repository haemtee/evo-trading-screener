import type { Ticker24h, WatchlistItem } from '../types.ts';

export interface ScreenedWatchlist {
  gainers: WatchlistItem[];
  losers: WatchlistItem[];
}

export interface ScreenerBandOptions {
  minChangePct?: number;
  maxChangePct?: number;
}

/**
 * Screens 24h futures tickers:
 * 1. Must exist in `tradableSymbols` (USDT Perpetual & TRADING on Binance Demo)
 * 2. 24h quote volume >= `minVolumeUsd` (default $5,000,000)
 * 3. Top N Gainers within [minChangePct, maxChangePct] for LONG, Top N Losers within [-maxChangePct, -minChangePct] for SHORT
 */
export function filterWatchlist(
  tickers: Ticker24h[],
  tradableSymbols: Set<string>,
  minVolumeUsd = 5_000_000,
  topN = 10,
  scannedAt = Date.now(),
  opts: ScreenerBandOptions = {},
): ScreenedWatchlist {
  const minChangePct = opts.minChangePct ?? 5;
  const maxChangePct = opts.maxChangePct ?? 25;

  const eligible = tickers.filter(
    (t) =>
      tradableSymbols.has(t.symbol) &&
      Number.isFinite(t.quoteVolume) &&
      t.quoteVolume >= minVolumeUsd &&
      Number.isFinite(t.priceChangePercent) &&
      Number.isFinite(t.lastPrice) &&
      t.lastPrice > 0,
  );

  const gainers: WatchlistItem[] = eligible
    .filter((t) => t.priceChangePercent >= minChangePct && t.priceChangePercent <= maxChangePct)
    .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
    .slice(0, topN)
    .map((t) => ({
      symbol: t.symbol,
      side: 'LONG',
      priceChangePct: t.priceChangePercent,
      quoteVolume: t.quoteVolume,
      lastPrice: t.lastPrice,
      scannedAt,
    }));

  const losers: WatchlistItem[] = eligible
    .filter((t) => t.priceChangePercent <= -minChangePct && t.priceChangePercent >= -maxChangePct)
    .sort((a, b) => a.priceChangePercent - b.priceChangePercent)
    .slice(0, topN)
    .map((t) => ({
      symbol: t.symbol,
      side: 'SHORT',
      priceChangePct: t.priceChangePercent,
      quoteVolume: t.quoteVolume,
      lastPrice: t.lastPrice,
      scannedAt,
    }));

  return { gainers, losers };
}
