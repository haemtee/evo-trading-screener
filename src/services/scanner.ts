import type { BinanceFuturesClient, UserTrade } from '../binance/client.ts';
import { KlineStreamManager, type StreamStatus } from '../binance/stream.ts';
import type { AppDatabase } from '../db/database.ts';
import {
  detectMomentumSignal,
  isBtcRegimeAligned,
  isHtfTrendAligned,
} from '../strategy/detector.ts';
import { computeBreakEvenSl, computeTrailingSl } from '../strategy/guards.ts';
import { calculateATR } from '../strategy/indicators.ts';
import { formatStep, roundStep } from '../strategy/risk.ts';
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
  private btcRegimeCache: { fetchedAt: number; candles: Candle[] } | null = null;

  constructor(
    private readonly binance: BinanceFuturesClient,
    private readonly db: AppDatabase,
    private readonly callbacks: {
      onSignal: (signal: SignalRecord) => Promise<void>;
      onTradeClosed?: (summary: ClosedTradeSummary) => Promise<void>;
      onBreakEvenMoved?: (symbol: string, side: Side, newSl: number) => Promise<void>;
      onPartialTpTaken?: (symbol: string, side: Side, qtyClosed: number, newSl: number) => Promise<void>;
      onTrailingSlMoved?: (symbol: string, side: Side, newSl: number) => Promise<void>;
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
        Date.now(),
        {
          minChangePct: settings.min24hChangePct,
          maxChangePct: settings.max24hChangePct,
        },
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

            const detected = detectMomentumSignal(closedCandles, item.side, {
              symbol: item.symbol,
              emaPeriod: settings.emaPeriod,
              rrRatio: settings.rrRatio,
              minSlPct: settings.minSlPct / 100,
              minAdx: settings.minAdx,
            });
            if (!detected) return null;
            if (settings.btcRegimeFilter && !(await this.checkBtcRegime(item.side))) {
              return null;
            }
            return (await this.checkHtfAlignment(item.symbol, item.side, settings.emaPeriod))
              ? detected
              : null;
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
      minSlPct: settings.minSlPct / 100,
      minAdx: settings.minAdx,
    });

    if (!detected) return null;
    if (settings.btcRegimeFilter && !(await this.checkBtcRegime(side))) return null;
    if (!(await this.checkHtfAlignment(symbol, side, settings.emaPeriod))) return null;

    const inserted = this.db.insertSignalIfNew(detected);
    if (!inserted) return null;

    await this.callbacks.onSignal(inserted);
    return inserted;
  }

  private async checkHtfAlignment(symbol: string, side: Side, emaPeriod: number): Promise<boolean> {
    try {
      const htf = await this.binance.getKlines(symbol, '1h', 30);
      const closed1h = htf.length > 1 ? htf.slice(0, -1) : htf;
      return isHtfTrendAligned(closed1h, side, emaPeriod);
    } catch {
      return false;
    }
  }

  private async checkBtcRegime(side: Side): Promise<boolean> {
    const now = Date.now();
    try {
      if (!this.btcRegimeCache || now - this.btcRegimeCache.fetchedAt > 300_000) {
        const raw = await this.binance.getKlines('BTCUSDT', '1h', 60);
        const closed = raw.length > 1 ? raw.slice(0, -1) : raw;
        this.btcRegimeCache = { fetchedAt: now, candles: closed };
      }
      return isBtcRegimeAligned(this.btcRegimeCache.candles, side);
    } catch {
      return false;
    }
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
    }, 15_000);
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

      const [livePositions, filters] = await Promise.all([
        this.binance.getOpenPositions(),
        this.binance.getDemoExchangeInfo(),
      ]);
      const liveBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));
      const settings = this.db.getSettings();

      for (const trade of openTrades) {
        const livePos = liveBySymbol.get(trade.symbol);
        if (!livePos) {
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
          continue;
        }

        // Update favorable peak price for trailing stop calculations
        const prevPeak = trade.peakPrice ?? trade.entryPrice;
        const newPeak =
          trade.side === 'LONG'
            ? Math.max(prevPeak, livePos.markPrice)
            : Math.min(prevPeak, livePos.markPrice);
        if (newPeak !== trade.peakPrice) {
          this.db.updateTradePeakPrice(trade.id, newPeak);
        }

        const symFilter = filters.get(trade.symbol);
        const tickSize = symFilter?.tickSize ?? 0.0001;
        const stepSize = symFilter?.stepSize ?? 0.001;
        const minQty = symFilter?.minQty ?? stepSize;
        const closeSide: 'BUY' | 'SELL' = trade.side === 'LONG' ? 'SELL' : 'BUY';

        let currentSl = trade.stopLoss;
        let currentSlOrderId = trade.slOrderId;
        let beMoved = trade.beMoved;
        let partialTpTaken = trade.partialTpTaken;

        // 1. Partial Take Profit + Auto Break-Even
        if (!partialTpTaken && settings.partialTpAtR > 0 && settings.partialTpPct > 0) {
          const initialRisk = Math.abs(trade.entryPrice - trade.initialStopLoss);
          const partialTrigger =
            trade.side === 'LONG'
              ? trade.entryPrice + initialRisk * settings.partialTpAtR
              : trade.entryPrice - initialRisk * settings.partialTpAtR;
          const reached =
            initialRisk > 0 &&
            (trade.side === 'LONG'
              ? livePos.markPrice >= partialTrigger
              : livePos.markPrice <= partialTrigger);

          if (reached) {
            const totalQty = Math.abs(livePos.positionAmt);
            const partialQty = roundStep(totalQty * (settings.partialTpPct / 100), stepSize, 'floor');
            const remQty = roundStep(totalQty - partialQty, stepSize, 'floor');
            if (partialQty >= minQty && remQty >= minQty) {
              try {
                await this.binance.placeMarketOrder(
                  trade.symbol,
                  closeSide,
                  formatStep(partialQty, stepSize),
                  true,
                );
                const feeBuffer = 0.0012;
                const beTarget =
                  trade.side === 'LONG'
                    ? trade.entryPrice * (1 + feeBuffer)
                    : trade.entryPrice * (1 - feeBuffer);
                const shouldMoveBe =
                  trade.side === 'LONG' ? beTarget > currentSl : beTarget < currentSl;
                const nextSl = shouldMoveBe ? beTarget : currentSl;
                const formattedBe = formatStep(nextSl, tickSize);

                if (shouldMoveBe) {
                  if (currentSlOrderId) {
                    try {
                      await this.binance.cancelAlgoOrder(trade.symbol, currentSlOrderId);
                    } catch {
                      // Ignore if old SL was already cancelled
                    }
                  }
                  const newSlOrder = await this.binance.placeStopLossOrder(
                    trade.symbol,
                    closeSide,
                    formattedBe,
                  );
                  currentSl = Number(formattedBe);
                  currentSlOrderId = String(newSlOrder.algoId);
                }

                this.db.markTradePartialTp(trade.id, remQty, currentSl, currentSlOrderId);
                partialTpTaken = true;
                beMoved = true;
                if (this.callbacks.onPartialTpTaken) {
                  await this.callbacks.onPartialTpTaken(trade.symbol, trade.side, partialQty, currentSl);
                }
              } catch (err) {
                console.error(`[Scanner] Partial TP failed for ${trade.symbol}:`, err);
              }
            }
          }
        }

        // 2. Break-Even SL move (if not already moved by partial TP)
        if (!beMoved && settings.breakEvenAtR > 0) {
          const bePrice = computeBreakEvenSl({
            side: trade.side,
            entryPrice: trade.entryPrice,
            stopLoss: currentSl,
            markPrice: livePos.markPrice,
            breakEvenAtR: settings.breakEvenAtR,
          });
          if (bePrice !== null) {
            const formattedBe = formatStep(bePrice, tickSize);
            try {
              if (currentSlOrderId) {
                try {
                  await this.binance.cancelAlgoOrder(trade.symbol, currentSlOrderId);
                } catch {
                  // Ignore if old SL was already cancelled
                }
              }
              const newSlOrder = await this.binance.placeStopLossOrder(
                trade.symbol,
                closeSide,
                formattedBe,
              );
              currentSl = Number(formattedBe);
              currentSlOrderId = String(newSlOrder.algoId);
              beMoved = true;
              this.db.markTradeBreakEven(trade.id, currentSl, currentSlOrderId);
              if (this.callbacks.onBreakEvenMoved) {
                await this.callbacks.onBreakEvenMoved(trade.symbol, trade.side, currentSl);
              }
            } catch (err) {
              console.error(`[Scanner] Break-even move failed for ${trade.symbol}:`, err);
            }
          }
        }

        // 3. ATR Trailing Stop for runner positions
        if ((partialTpTaken || beMoved) && settings.trailingAtrMult > 0) {
          try {
            let candles = this.candleBuffers.get(trade.symbol);
            if (!candles || candles.length < 20) {
              const raw = await this.binance.getKlines(trade.symbol, '15m', 30);
              candles = raw.length > 1 ? raw.slice(0, -1) : raw;
            }
            const atrSeries = calculateATR(candles, 14);
            const atr = atrSeries[atrSeries.length - 1]!;
            if (Number.isFinite(atr) && atr > 0) {
              const trailPrice = computeTrailingSl({
                side: trade.side,
                entryPrice: trade.entryPrice,
                initialStopLoss: trade.initialStopLoss,
                currentStopLoss: currentSl,
                peakPrice: newPeak,
                markPrice: livePos.markPrice,
                atr,
                trailingAtrMult: settings.trailingAtrMult,
                partialTpTaken,
              });
              if (trailPrice !== null) {
                const formattedTrail = formatStep(trailPrice, tickSize);
                if (currentSlOrderId) {
                  try {
                    await this.binance.cancelAlgoOrder(trade.symbol, currentSlOrderId);
                  } catch {
                    // Ignore
                  }
                }
                const newSlOrder = await this.binance.placeStopLossOrder(
                  trade.symbol,
                  closeSide,
                  formattedTrail,
                );
                const newSlNum = Number(formattedTrail);
                this.db.updateTradeTrailingSl(trade.id, newSlNum, String(newSlOrder.algoId), newPeak);
                if (this.callbacks.onTrailingSlMoved) {
                  await this.callbacks.onTrailingSlMoved(trade.symbol, trade.side, newSlNum);
                }
              }
            }
          } catch (err) {
            console.error(`[Scanner] Trailing SL move failed for ${trade.symbol}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[Scanner] Position sync failed:', err);
    }
  }
}
