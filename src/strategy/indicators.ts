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

/**
 * Computes Wilder's Average Directional Index (ADX).
 * Returns an array of the same length as `candles`, with `NaN` for indices `< period * 2 - 1`.
 */
export function calculateADX(candles: Candle[], period = 14): number[] {
  if (period <= 0) {
    throw new Error(`ADX period must be > 0, got ${period}`);
  }
  const result = new Array<number>(candles.length).fill(Number.NaN);
  if (candles.length < period * 2) {
    return result;
  }

  const tr = new Array<number>(candles.length).fill(0);
  const plusDm = new Array<number>(candles.length).fill(0);
  const minusDm = new Array<number>(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    tr[i] = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr[i]!;
    smoothPlusDm += plusDm[i]!;
    smoothMinusDm += minusDm[i]!;
  }

  const dx = new Array<number>(candles.length).fill(Number.NaN);
  const calcDx = (sTr: number, sPlus: number, sMinus: number): number => {
    if (sTr <= 0) return 0;
    const plusDi = (100 * sPlus) / sTr;
    const minusDi = (100 * sMinus) / sTr;
    const sum = plusDi + minusDi;
    return sum > 0 ? (100 * Math.abs(plusDi - minusDi)) / sum : 0;
  };

  dx[period] = calcDx(smoothTr, smoothPlusDm, smoothMinusDm);

  for (let i = period + 1; i < candles.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i]!;
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm[i]!;
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm[i]!;
    dx[i] = calcDx(smoothTr, smoothPlusDm, smoothMinusDm);
  }

  const firstAdxIdx = period * 2 - 1;
  let dxSum = 0;
  for (let i = period; i <= firstAdxIdx; i++) {
    dxSum += dx[i]!;
  }
  let adx = dxSum / period;
  result[firstAdxIdx] = adx;

  for (let i = firstAdxIdx + 1; i < candles.length; i++) {
    adx = (adx * (period - 1) + dx[i]!) / period;
    result[i] = adx;
  }

  return result;
}
