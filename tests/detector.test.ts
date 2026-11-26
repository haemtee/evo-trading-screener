import { describe, expect, test } from 'bun:test';
import { detectMomentumSignal, isHtfTrendAligned } from '../src/strategy/detector.ts';
import type { Candle } from '../src/types.ts';

function buildUptrendBase(count = 32): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    // Alternating small candles drifting slightly up so we don't trigger consecutive run guard
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

function buildDowntrendBase(count = 32): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const isDown = i % 2 === 0;
    const open = price;
    const close = isDown ? price - 0.4 : price + 0.1;
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

describe('detectMomentumSignal', () => {
  test('detects BULLISH_ENGULFING above EMA21 with 2R TP and lower-low SL', () => {
    const base = buildUptrendBase(32);
    const last = base[base.length - 1]!;
    // Previous red pullback candle (~1.3% below entry)
    const prevRed: Candle = {
      openTime: 32 * 900_000,
      open: last.close + 0.3,
      high: last.close + 0.4,
      low: last.close - 0.9,
      close: last.close - 0.7,
      volume: 1000,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 100_000,
    };
    // Current solid green engulfing candle with tiny upper wick and 2x volume
    const currGreen: Candle = {
      openTime: 33 * 900_000,
      open: prevRed.close - 0.05,
      high: prevRed.open + 0.65,
      low: prevRed.close - 0.1,
      close: prevRed.open + 0.6,
      volume: 2000,
      closeTime: 34 * 900_000 - 1,
      quoteVolume: 200_000,
    };

    const sig = detectMomentumSignal([...base, prevRed, currGreen], 'LONG', { symbol: 'BTCUSDT' });
    expect(sig).not.toBeNull();
    expect(sig!.pattern).toBe('BULLISH_ENGULFING');
    expect(sig!.side).toBe('LONG');
    const expectedBaseSl = Math.min(prevRed.low, currGreen.low);
    expect(sig!.stopLoss).toBeCloseTo(expectedBaseSl * 0.999, 6);
    const risk = sig!.entryPrice - sig!.stopLoss;
    expect(sig!.takeProfit).toBeCloseTo(sig!.entryPrice + 2 * risk, 6);
  });

  test('detects BEARISH_MARUBOZU below EMA21', () => {
    const base = buildDowntrendBase(32);
    const last = base[base.length - 1]!;
    const prevRed: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 0.1,
      low: last.close - 0.3,
      close: last.close - 0.2,
      volume: 1000,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 100_000,
    };
    const currMarubozu: Candle = {
      openTime: 33 * 900_000,
      open: prevRed.close,
      high: prevRed.close + 0.05,
      low: prevRed.close - 1.25,
      close: prevRed.close - 1.2,
      volume: 1800,
      closeTime: 34 * 900_000 - 1,
      quoteVolume: 180_000,
    };

    const sig = detectMomentumSignal([...base, prevRed, currMarubozu], 'SHORT', { symbol: 'ACEUSDT' });
    expect(sig).not.toBeNull();
    expect(sig!.pattern).toBe('BEARISH_MARUBOZU');
    expect(sig!.side).toBe('SHORT');
    expect(sig!.stopLoss).toBeGreaterThan(currMarubozu.high);
    expect(sig!.takeProfit).toBeLessThan(sig!.entryPrice);
  });

  test('rejects tight SL (< 1%) and low average volume', () => {
    const base = buildUptrendBase(32);
    const last = base[base.length - 1]!;
    const tightSlCandle: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 0.62,
      low: last.close - 0.02,
      close: last.close + 0.6, // SL distance ~0.6% < 1%
      volume: 2000,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 200_000,
    };
    expect(detectMomentumSignal([...base, tightSlCandle], 'LONG', { symbol: 'BTCUSDT' })).toBeNull();

    // Volume is > 1.2x prev (1000 -> 1300) but < 1.5x avg10 (1000 * 1.5 = 1500)
    const lowAvgVol: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 1.22,
      low: last.close - 0.05,
      close: last.close + 1.2,
      volume: 1300,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 130_000,
    };
    expect(detectMomentumSignal([...base, lowAvgVol], 'LONG', { symbol: 'BTCUSDT' })).toBeNull();
  });

  test('isHtfTrendAligned checks 1h EMA21 direction', () => {
    const up1h = buildUptrendBase(25);
    const down1h = buildDowntrendBase(25);
    expect(isHtfTrendAligned(up1h, 'LONG', 21)).toBe(true);
    expect(isHtfTrendAligned(up1h, 'SHORT', 21)).toBe(false);
    expect(isHtfTrendAligned(down1h, 'SHORT', 21)).toBe(true);
    expect(isHtfTrendAligned(down1h, 'LONG', 21)).toBe(false);
  });

  test('rejects candle with large upper wick on LONG', () => {
    const base = buildUptrendBase(32);
    const last = base[base.length - 1]!;
    const badWick: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 1.5, // huge upper wick
      low: last.close - 0.05,
      close: last.close + 0.6,
      volume: 2000,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 200_000,
    };
    const sig = detectMomentumSignal([...base, badWick], 'LONG', { symbol: 'BTCUSDT' });
    expect(sig).toBeNull();
  });

  test('rejects signal without volume expansion', () => {
    const base = buildUptrendBase(32);
    const last = base[base.length - 1]!;
    const lowVol: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 0.82,
      low: last.close - 0.02,
      close: last.close + 0.8,
      volume: 900, // lower than prev 1000
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 90_000,
    };
    const sig = detectMomentumSignal([...base, lowVol], 'LONG', { symbol: 'BTCUSDT' });
    expect(sig).toBeNull();
  });

  test('rejects climax / overextended candle (> 3x ATR)', () => {
    const base = buildUptrendBase(32);
    const last = base[base.length - 1]!;
    const climax: Candle = {
      openTime: 32 * 900_000,
      open: last.close,
      high: last.close + 12.1,
      low: last.close - 0.1,
      close: last.close + 12.0,
      volume: 5000,
      closeTime: 33 * 900_000 - 1,
      quoteVolume: 500_000,
    };
    const sig = detectMomentumSignal([...base, climax], 'LONG', { symbol: 'BTCUSDT' });
    expect(sig).toBeNull();
  });
});
