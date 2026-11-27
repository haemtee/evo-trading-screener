import { describe, expect, test } from 'bun:test';
import {
  BASELINE_BACKTEST_CONFIG,
  GROWTH_10X_BACKTEST_CONFIG,
  runBacktest,
  type BacktestDataset,
} from '../src/backtest/engine.ts';
import type { Candle } from '../src/types.ts';

function buildDeterministicDataset(): BacktestDataset {
  const total15m = 300;
  const btc1h: Candle[] = [];
  for (let h = 0; h < total15m / 4; h++) {
    const base = 60000 + h * 30;
    btc1h.push({
      openTime: h * 3_600_000,
      open: base,
      high: base + 120,
      low: base - 40,
      close: base + 60,
      volume: 4000,
      closeTime: (h + 1) * 3_600_000 - 1,
      quoteVolume: 200_000_000,
    });
  }

  const candles15m: Candle[] = [];
  let price = 100;
  for (let i = 0; i < total15m; i++) {
    const phase = i % 20;
    const isBreakout = phase === 10;
    const isPullback = phase === 9;
    const open = price;
    const delta = isBreakout ? 2.2 : isPullback ? -0.9 : i % 2 === 0 ? 0.35 : -0.1;
    const close = open + delta;
    candles15m.push({
      openTime: i * 900_000,
      open,
      high: isBreakout ? close + 0.05 : Math.max(open, close) + 0.2,
      low: isBreakout ? open - 0.05 : Math.min(open, close) - 0.2,
      close,
      volume: isBreakout ? 3500 : 1000,
      closeTime: (i + 1) * 900_000 - 1,
      quoteVolume: isBreakout ? 350_000 : 100_000,
    });
    price = close;
  }

  const candles1h: Candle[] = [];
  for (let h = 0; h < total15m / 4; h++) {
    const slice = candles15m.slice(h * 4, h * 4 + 4);
    candles1h.push({
      openTime: slice[0]!.openTime,
      open: slice[0]!.open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1]!.close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
      closeTime: slice[slice.length - 1]!.closeTime,
      quoteVolume: slice.reduce((s, c) => s + c.quoteVolume, 0),
    });
  }

  return {
    symbols: { SOLUSDT: { candles15m, candles1h } },
    btc1h,
  };
}

describe('Backtesting Engine', () => {
  test('replays trades and captures higher upside with growth10x runner config', () => {
    const dataset = buildDeterministicDataset();
    const baseline = runBacktest(dataset, BASELINE_BACKTEST_CONFIG);
    const growth = runBacktest(dataset, GROWTH_10X_BACKTEST_CONFIG);

    expect(baseline.totalTrades).toBeGreaterThan(0);
    expect(growth.totalTrades).toBeGreaterThan(0);
    expect(growth.finalEquity).toBeGreaterThan(growth.initialEquity);
    expect(growth.finalEquity).toBeGreaterThan(baseline.finalEquity);
  });
});
