import { describe, expect, test } from 'bun:test';
import type { BinanceFuturesClient } from '../src/binance/client.ts';
import { KlineStreamManager, parseKlineStreamMessage } from '../src/binance/stream.ts';
import { AppDatabase } from '../src/db/database.ts';
import { MarketScanner } from '../src/services/scanner.ts';
import type { Candle, SignalRecord, SymbolFilter, Ticker24h } from '../src/types.ts';

function buildUptrendSeed(count = 33): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const isUp = i % 2 === 0;
    const open = price;
    const close = isUp ? price + 0.4 : price - 0.1;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    candles.push({
      openTime: i * 900_000,
      open,
      high,
      low,
      close,
      volume: 1000,
      closeTime: (i + 1) * 900_000 - 1,
      quoteVolume: 100_000,
    });
    price = close;
  }
  return candles;
}

describe('parseKlineStreamMessage', () => {
  test('parses open and closed kline events and ignores invalid payloads', () => {
    const openPayload = JSON.stringify({
      stream: 'btcusdt@kline_15m',
      data: {
        e: 'kline',
        s: 'BTCUSDT',
        k: {
          t: 1700000000000,
          T: 1700000899999,
          o: '90000.0',
          h: '90500.0',
          l: '89900.0',
          c: '90400.0',
          v: '123.45',
          q: '11111111.0',
          x: false,
        },
      },
    });

    const parsedOpen = parseKlineStreamMessage(openPayload);
    expect(parsedOpen).not.toBeNull();
    expect(parsedOpen!.symbol).toBe('BTCUSDT');
    expect(parsedOpen!.isClosed).toBe(false);
    expect(parsedOpen!.candle.close).toBe(90400);

    const closedPayload = openPayload.replace('"x":false', '"x":true');
    const parsedClosed = parseKlineStreamMessage(closedPayload);
    expect(parsedClosed).not.toBeNull();
    expect(parsedClosed!.isClosed).toBe(true);

    expect(parseKlineStreamMessage('not-json')).toBeNull();
    expect(parseKlineStreamMessage(JSON.stringify({ data: { e: 'aggTrade' } }))).toBeNull();
  });
});

describe('MarketScanner live stream integration', () => {
  test('seeds watchlist, updates stream symbols, and emits signal on closed stream candle', async () => {
    const db = new AppDatabase(':memory:');
    const seed = buildUptrendSeed(33);
    const lastClosed = seed[seed.length - 1]!;
    // Add a red pullback candle as the last closed candle, plus a forming candle at the end
    const prevRed: Candle = {
      openTime: 33 * 900_000,
      open: lastClosed.close + 0.2,
      high: lastClosed.close + 0.3,
      low: lastClosed.close - 0.5,
      close: lastClosed.close - 0.3,
      volume: 1000,
      closeTime: 34 * 900_000 - 1,
      quoteVolume: 100_000,
    };
    const formingCandle: Candle = {
      openTime: 34 * 900_000,
      open: prevRed.close,
      high: prevRed.close + 0.1,
      low: prevRed.close - 0.1,
      close: prevRed.close + 0.05,
      volume: 200,
      closeTime: 35 * 900_000 - 1,
      quoteVolume: 20_000,
    };

    const filters = new Map<string, SymbolFilter>([
      [
        'BTCUSDT',
        {
          symbol: 'BTCUSDT',
          tickSize: 0.01,
          stepSize: 0.001,
          minQty: 0.001,
          minNotional: 5,
          pricePrecision: 2,
          quantityPrecision: 3,
        },
      ],
    ]);

    const tickers: Ticker24h[] = [
      {
        symbol: 'BTCUSDT',
        priceChangePercent: 12.5,
        lastPrice: formingCandle.close,
        quoteVolume: 50_000_000,
      },
    ];

    const fakeBinance = {
      async getDemoExchangeInfo() {
        return filters;
      },
      async get24hTickers() {
        return tickers;
      },
      async getKlines() {
        return [...seed, prevRed, formingCandle];
      },
    } as unknown as BinanceFuturesClient;

    let updatedStreamSymbols: string[] = [];
    const fakeStream = {
      updateSymbols(symbols: string[]) {
        updatedStreamSymbols = symbols;
      },
      stop() {},
      getStatus() {
        return {
          connected: true,
          watchedCount: updatedStreamSymbols.length,
          watchedSymbols: updatedStreamSymbols,
          lastEventAt: null,
        };
      },
    } as unknown as KlineStreamManager;

    const emittedSignals: SignalRecord[] = [];
    const scanner = new MarketScanner(
      fakeBinance,
      db,
      {
        onSignal: async (sig) => {
          emittedSignals.push(sig);
        },
      },
      { streamManager: fakeStream },
    );

    const summary = await scanner.runScanCycle();
    expect(summary.gainers).toHaveLength(1);
    expect(updatedStreamSymbols).toEqual(['BTCUSDT']);
    expect(emittedSignals).toHaveLength(0);

    // Now simulate WebSocket closing candle #34 with a Bullish Engulfing momentum candle
    const closedStreamCandle: Candle = {
      openTime: 34 * 900_000,
      open: prevRed.close - 0.05,
      high: prevRed.open + 0.55,
      low: prevRed.close - 0.1,
      close: prevRed.open + 0.5,
      volume: 2200,
      closeTime: 35 * 900_000 - 1,
      quoteVolume: 220_000,
    };

    const sig = await scanner.handleClosedCandle('BTCUSDT', closedStreamCandle);
    expect(sig).not.toBeNull();
    expect(sig!.pattern).toBe('BULLISH_ENGULFING');
    expect(emittedSignals).toHaveLength(1);

    // Duplicate closed event for same openTime must not emit twice
    const dup = await scanner.handleClosedCandle('BTCUSDT', closedStreamCandle);
    expect(dup).toBeNull();
    expect(emittedSignals).toHaveLength(1);

    db.close();
  });
});
