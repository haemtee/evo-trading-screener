import { describe, expect, test } from 'bun:test';
import type { UserTrade } from '../src/binance/client.ts';
import { summarizeClosedUserTrades } from '../src/services/scanner.ts';
import {
  buildChartLinks,
  formatDuration,
  formatSignalMessage,
  summarize1hRange,
} from '../src/telegram/bot.ts';
import type { Candle } from '../src/types.ts';

describe('formatDuration', () => {
  test('formats sub-minute, minutes, hours+minutes, and days+hours', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration((60 + 3) * 60_000)).toBe('1h3m');
    expect(formatDuration((24 + 2) * 60 * 60_000)).toBe('1d2h');
  });
});

describe('summarize1hRange', () => {
  test('computes 1h high/low and percentage moves relative to reference price', () => {
    const candles: Candle[] = [
      { openTime: 1, open: 100, high: 104, low: 99, close: 102, volume: 10, closeTime: 2, quoteVolume: 1000 },
      { openTime: 3, open: 102, high: 106, low: 101, close: 105, volume: 12, closeTime: 4, quoteVolume: 1200 },
      { openTime: 5, open: 105, high: 108, low: 98, close: 103, volume: 15, closeTime: 6, quoteVolume: 1500 },
      { openTime: 7, open: 103, high: 105, low: 100, close: 104, volume: 11, closeTime: 8, quoteVolume: 1100 },
    ];

    const summary = summarize1hRange(candles, 100);
    expect(summary).not.toBeNull();
    expect(summary!.high).toBe(108);
    expect(summary!.low).toBe(98);
    expect(summary!.highPct).toBeCloseTo(8, 6);
    expect(summary!.lowPct).toBeCloseTo(-2, 6);
    expect(summary!.changePct).toBeCloseTo(4, 6);
  });
});

describe('summarizeClosedUserTrades', () => {
  test('computes weighted closePrice, realized PnL, total fees, and net PnL', () => {
    const fills: UserTrade[] = [
      {
        id: 1,
        orderId: 10,
        symbol: 'BTCUSDT',
        side: 'BUY',
        price: 100,
        qty: 2,
        realizedPnl: 0,
        commission: 0.1,
        commissionAsset: 'USDT',
        time: 1000,
      },
      {
        id: 2,
        orderId: 11,
        symbol: 'BTCUSDT',
        side: 'SELL',
        price: 105,
        qty: 1,
        realizedPnl: 5,
        commission: 0.105,
        commissionAsset: 'USDT',
        time: 2000,
      },
      {
        id: 3,
        orderId: 12,
        symbol: 'BTCUSDT',
        side: 'SELL',
        price: 107,
        qty: 1,
        realizedPnl: 7,
        commission: 0.107,
        commissionAsset: 'USDT',
        time: 3000,
      },
    ];

    const summary = summarizeClosedUserTrades(fills, 'LONG', 100, 2, 120_000, 'BTCUSDT');
    expect(summary.closePrice).toBeCloseTo(106, 6);
    expect(summary.pnlUsd).toBeCloseTo(12, 6);
    expect(summary.feeUsd).toBeCloseTo(0.312, 6);
    expect(summary.netPnlUsd).toBeCloseTo(11.688, 6);
    expect(summary.durationMs).toBe(120_000);
  });
});

describe('buildChartLinks & formatSignalMessage', () => {
  test('includes 15m TradingView and Binance Demo chart URLs', () => {
    const links = buildChartLinks('HUMAUSDT');
    expect(links.tradingViewUrl).toBe(
      'https://www.tradingview.com/chart/?symbol=BINANCE:HUMAUSDT.P&interval=15',
    );
    expect(links.binanceDemoUrl).toBe('https://testnet.binancefuture.com/en/futures/HUMAUSDT');

    const msg = formatSignalMessage(
      {
        id: 50,
        symbol: 'HUMAUSDT',
        side: 'SHORT',
        pattern: 'BEARISH_ENGULFING',
        candleOpenTime: 1_700_000_000_000,
        entryPrice: 0.007309,
        stopLoss: 0.007361,
        takeProfit: 0.007204,
        ema21: 0.007382,
        volumeRatio: 2.25,
        bodyRatio: 0.89,
        status: 'PENDING',
        createdAt: 1_700_000_000_000,
      },
      1,
      2,
    );
    expect(msg).toContain(links.tradingViewUrl);
    expect(msg).toContain(links.binanceDemoUrl);
  });
});
