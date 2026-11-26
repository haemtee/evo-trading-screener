import type { BinanceFuturesClient, UserTrade } from '../binance/client.ts';
import { KlineStreamManager, type StreamStatus } from '../binance/stream.ts';
import type { AppDatabase } from '../db/database.ts';
import { detectMomentumSignal } from '../strategy/detector.ts';
import { filterWatchlist } from '../strategy/screener.ts';
import type { Candle, Side, SignalRecord, WatchlistItem } from '../types.ts';

export interface ClosedTradeSummary {
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  closePrice: number | null;
  feeUsd: number | null;
  pnlUsd: number | null;
  netPnlUsd: number | null;
  durationMs: number;
}

export function summarizeClosedUserTrades(
  trades: UserTrade[],
  side: Side,
  entryPrice: number,
  quantity: number,
  durationMs: number,
  symbol = '',
): ClosedTradeSummary {
  if (trades.length === 0) {
    return {
      symbol,
      side,
      quantity,
      entryPrice,
      closePrice: null,
      feeUsd: null,
      pnlUsd: null,
      netPnlUsd: null,
      durationMs,
    };
  }

  const closeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'SELL' : 'BUY';
  const closingFills = trades.filter((t) => t.side === closeSide || t.realizedPnl !== 0);

  let closePrice: number | null = null;
  if (closingFills.length > 0) {
    let weightedSum = 0;
    let totalQty = 0;
    for (const f of closingFills) {
      weightedSum += f.price * f.qty;
      totalQty += f.qty;
    }
    if (totalQty > 0) {
      closePrice = weightedSum / totalQty;
    }
  }

  const pnlUsd = trades.reduce((acc, t) => acc + t.realizedPnl, 0);
  const feeUsd = trades.reduce((acc, t) => acc + Math.abs(t.commission), 0);
  const netPnlUsd = pnlUsd - feeUsd;

  return {
    symbol: trades[0]?.symbol ?? symbol,
    side,
    quantity,
    entryPrice,
    closePrice,
    feeUsd,
    pnlUsd,
    netPnlUsd,
    durationMs,
  };
}

export interface ScanCycleSummary {
  gainers: WatchlistItem[];
  losers: WatchlistItem[];
  newSignals: SignalRecord[];
  evaluatedSymbols: number;
  errors: number;
}

export interface MarketScannerOptions {
  wsBaseUrl?: string;
  watchlistRefreshMinutes?: number;
  streamManager?: KlineStreamManager;
}

const MAX_BUFFER_CANDLES = 80;

export class MarketScanner {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private running = false;

  private readonly watchedSides = new Map<string, Side>();
  private readonly candleBuffers = new Map<string, Candle[]>();
  private readonly stream: KlineStreamManager;
  private readonly watchlistRefreshMinutes: number;

  constructor(
    private readonly binance: BinanceFuturesClient,
    private readonly db: AppDatabase,
    private readonly callbacks: {
      onSignal: (signal: SignalRecord) => Promise<void>;
      onTradeClosed?: (summary: ClosedTradeSummary) => Promise<void>;
    },
    options: MarketScannerOptions = {},
  ) {
    this.watchlistRefreshMinutes = options.watchlistRefreshMinutes ?? 15;
    this.stream =
      options.streamManager ??
      new KlineStreamManager({
        wsBaseUrl: options.wsBaseUrl ?? 'wss://fstream.binancefuture.com',
        interval: '15m',
        onClosedCandle: async (symbol, candle) => {
          await this.handleClosedCandle(symbol, candle);
        },
      });
  }

  /**
   * Refreshes the screened Top Gainers & Top Losers (> $5M 24h volume),
   * seeds 15m candle history for any newly added symbols, and updates the live WebSocket stream.
   */
  async runScanCycle(forceReseed = false): Promise<ScanCycleSummary> {
    if (this.isScanning) {
      throw new Error('Scan is already in progress');
    }
    this.isScanning = true;

    try {
      const settings = this.db.getSettings();
      const [filters, tickers] = await Promise.all([
        this.binance.getDemoExchangeInfo(),
        this.binance.get24hTickers(),
      ]);

      const tradableSymbols = new Set(filters.keys());
      const { gainers, losers } = filterWatchlist(
        tickers,
        tradableSymbols,
        settings.minVolumeUsd,
        settings.topN,
      );

      const allWatchlist = [...gainers, ...losers];
      this.db.saveWatchlist(allWatchlist);

      // Update watchedSides map and prune stale candle buffers
      this.watchedSides.clear();
      for (const item of allWatchlist) {
        this.watchedSides.set(item.symbol, item.side);
      }
      for (const cachedSymbol of this.candleBuffers.keys()) {
        if (!this.watchedSides.has(cachedSymbol)) {
          this.candleBuffers.delete(cachedSymbol);
        }
      }

      const symbolsToSeed = allWatchlist.filter(
        (item) => forceReseed || !this.candleBuffers.has(item.symbol),
      );

      const newSignals: SignalRecord[] = [];
      let errors = 0;

      const batchSize = 5;
      for (let i = 0; i < symbolsToSeed.length; i += batchSize) {
        const batch = symbolsToSeed.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const candles = await this.binance.getKlines(item.symbol, '15m', 60);
            if (candles.length < 31) return null;
            // Exclude the currently forming candle
            const closedCandles = candles.slice(0, -1).slice(-MAX_BUFFER_CANDLES);
            this.candleBuffers.set(item.symbol, closedCandles);

            return detectMomentumSignal(closedCandles, item.side, {
              symbol: item.symbol,
              emaPeriod: settings.emaPeriod,
              rrRatio: settings.rrRatio,
            });
          }),
        );

        for (const res of results) {
          if (res.status === 'rejected') {
            errors++;
            continue;
          }
          if (res.value) {
            const inserted = this.db.insertSignalIfNew(res.value);
            if (inserted) {
              newSignals.push(inserted);
            }
          }
        }
      }

      // Keep watching all screened coins in real time via WebSocket
      if (settings.scannerEnabled) {
        this.stream.updateSymbols([...this.watchedSides.keys()]);
      }

      for (const sig of newSignals) {
        await this.callbacks.onSignal(sig);
      }

      return {
        gainers,
        losers,
        newSignals,
        evaluatedSymbols: allWatchlist.length,
        errors,
      };
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Processes a real-time closed 15m candle from the WebSocket stream for a watched coin.
   */
  async handleClosedCandle(symbol: string, candle: Candle): Promise<SignalRecord | null> {
    const settings = this.db.getSettings();
    if (!settings.scannerEnabled) return null;

    const side = this.watchedSides.get(symbol);
    const buffer = this.candleBuffers.get(symbol);
    if (!side || !buffer) return null;

    const last = buffer[buffer.length - 1];
    if (last && last.openTime === candle.openTime) {
      buffer[buffer.length - 1] = candle;
    } else if (!last || candle.openTime > last.openTime) {
      buffer.push(candle);
      if (buffer.length > MAX_BUFFER_CANDLES) {
        buffer.shift();
      }
    } else {
      return null;
    }

    const detected = detectMomentumSignal(buffer, side, {
      symbol,
      emaPeriod: settings.emaPeriod,
      rrRatio: settings.rrRatio,
    });

    if (!detected) return null;

    const inserted = this.db.insertSignalIfNew(detected);
    if (!inserted) return null;

    await this.callbacks.onSignal(inserted);
    return inserted;
  }

  getStreamStatus(): StreamStatus {
    return this.stream.getStatus();
  }

  startScheduler(): void {
    if (this.running) return;
    this.running = true;

    // Seed watchlist & start WebSocket stream immediately on boot
    const settings = this.db.getSettings();
    if (settings.scannerEnabled) {
      void this.runScanCycle().catch((err) => {
        console.error('[Scanner] Initial scan failed:', err);
      });
    }

    const refreshMs = Math.max(1, this.watchlistRefreshMinutes) * 60_000;
    this.refreshTimer = setInterval(() => {
      const current = this.db.getSettings();
      if (!current.scannerEnabled) {
        this.stream.stop();
        return;
      }
      void this.runScanCycle().catch((err) => {
        console.error('[Scanner] Watchlist refresh failed:', err);
      });
    }, refreshMs);

    this.syncTimer = setInterval(() => {
      void this.syncOpenTrades();
    }, 60_000);
  }

  stopScheduler(): void {
    this.running = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.stream.stop();
  }

  private async syncOpenTrades(): Promise<void> {
    try {
      const openTrades = this.db.getOpenTrades();
      if (openTrades.length === 0) return;

      const livePositions = await this.binance.getOpenPositions();
      const liveSymbols = new Set(livePositions.map((p) => p.symbol));

      for (const trade of openTrades) {
        if (!liveSymbols.has(trade.symbol)) {
          const closedAt = Date.now();
          let userTrades: UserTrade[] = [];
          try {
            userTrades = await this.binance.getUserTrades(trade.symbol, trade.openedAt - 5_000, 50);
          } catch {
            // Fall back to null close metrics if userTrades fails
          }

          const summary = summarizeClosedUserTrades(
            userTrades,
            trade.side,
            trade.entryPrice,
            trade.quantity,
            Math.max(0, closedAt - trade.openedAt),
            trade.symbol,
          );

          this.db.closeTrade(trade.id, summary.pnlUsd, closedAt, summary.closePrice, summary.feeUsd);
          try {
            await this.binance.cancelAllOpenOrders(trade.symbol);
          } catch {
            // Ignore cleanup errors
          }
          if (this.callbacks.onTradeClosed) {
            await this.callbacks.onTradeClosed(summary);
          }
        }
      }
    } catch (err) {
      console.error('[Scanner] Position sync failed:', err);
    }
  }
}
