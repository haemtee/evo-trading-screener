import { describe, expect, test } from 'bun:test';
import { calculateATR, calculateEMA } from '../src/strategy/indicators.ts';
import type { Candle } from '../src/types.ts';

function makeFlatCandles(count: number, price = 100, range = 2): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: i * 900_000,
    open: price,
    high: price + range / 2,
    low: price - range / 2,
    close: price,
    volume: 1000,
    closeTime: (i + 1) * 900_000 - 1,
    quoteVolume: 100_000,
  }));
}

describe('calculateEMA', () => {
  test('returns NaN before period - 1 and SMA seed at period - 1', () => {
    const values = [10, 12, 14, 16, 18];
    const ema3 = calculateEMA(values, 3);
    expect(Number.isNaN(ema3[0])).toBe(true);
    expect(Number.isNaN(ema3[1])).toBe(true);
    expect(ema3[2]).toBeCloseTo(12, 6); // (10+12+14)/3
    // k = 2/(3+1) = 0.5 -> (16 - 12)*0.5 + 12 = 14
    expect(ema3[3]).toBeCloseTo(14, 6);
    // (18 - 14)*0.5 + 14 = 16
    expect(ema3[4]).toBeCloseTo(16, 6);
  });

  test('throws on non-positive period', () => {
    expect(() => calculateEMA([1, 2, 3], 0)).toThrow();
  });
});

describe('calculateATR', () => {
  test('computes Wilder ATR for constant-range candles', () => {
    const candles = makeFlatCandles(20, 100, 4);
    const atr = calculateATR(candles, 14);
    expect(Number.isNaN(atr[13])).toBe(true);
    expect(atr[14]).toBeCloseTo(4, 6);
    expect(atr[19]).toBeCloseTo(4, 6);
  });
});
