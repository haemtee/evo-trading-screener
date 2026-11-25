import type { Candle } from '../types.ts';

/**
 * Computes Exponential Moving Average (EMA) using an SMA seed for the first `period` elements.
 * Returns an array of the same length as `values`, with `NaN` for indices `< period - 1`.
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (period <= 0) {
    throw new Error(`EMA period must be > 0, got ${period}`);
  }
  const result = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < period) {
    return result;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i]!;
  }
  let ema = sum / period;
  result[period - 1] = ema;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = (values[i]! - ema) * multiplier + ema;
    result[i] = ema;
  }

  return result;
}

/**
 * Computes Wilder's Average True Range (ATR).
 * Returns an array of the same length as `candles`, with `NaN` for indices `< period`.
 */
export function calculateATR(candles: Candle[], period = 14): number[] {
  if (period <= 0) {
    throw new Error(`ATR period must be > 0, got ${period}`);
  }
  const result = new Array<number>(candles.length).fill(Number.NaN);
  if (candles.length <= period) {
    return result;
  }

  const trueRanges = new Array<number>(candles.length).fill(0);
  trueRanges[0] = candles[0]!.high - candles[0]!.low;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    trueRanges[i] = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose),
    );
  }

  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += trueRanges[i]!;
  }
  let atr = trSum / period;
  result[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
    result[i] = atr;
  }

  return result;
}
