import type { Candle, DetectedSignal, PatternType, Side } from '../types.ts';
import { calculateADX, calculateATR, calculateEMA } from './indicators.ts';

export interface DetectorOptions {
  symbol?: string;
  emaPeriod?: number;
  atrPeriod?: number;
  rrRatio?: number;
  slBufferPct?: number;
  minBodyRatio?: number;
  marubozuBodyRatio?: number;
  maxLeadWickRatio?: number;
  maxTrailWickRatio?: number;
  minVolumeMultiplier?: number;
  minAvgVolumeMultiplier?: number;
  minSlPct?: number;
  minSlAtrMult?: number;
  maxCandleAtrMult?: number;
  maxEmaDistancePct?: number;
  maxConsecutiveCandles?: number;
  minAdx?: number;
  pullbackTouchPct?: number;
}

const DEFAULT_OPTS: Required<DetectorOptions> = {
  symbol: '',
  emaPeriod: 21,
  atrPeriod: 14,
  rrRatio: 2.0,
  slBufferPct: 0.001, // 0.1% buffer beyond candle low/high
  minBodyRatio: 0.65,
  marubozuBodyRatio: 0.70,
  maxLeadWickRatio: 0.15,
  maxTrailWickRatio: 0.20,
  minVolumeMultiplier: 1.2,
  minAvgVolumeMultiplier: 1.5,
  minSlPct: 0.01, // 1.0% minimum SL distance
  minSlAtrMult: 1.0,
  maxCandleAtrMult: 3.0,
  maxEmaDistancePct: 0.04, // 4% from EMA21
  maxConsecutiveCandles: 5,
  minAdx: 0,
  pullbackTouchPct: 0.006, // 0.6% around EMA21
};

/**
 * Checks 1h higher-timeframe EMA(21) trend alignment.
 */
export function isHtfTrendAligned(
  closed1hCandles: Candle[],
  side: Side,
  emaPeriod = 21,
): boolean {
  if (closed1hCandles.length < emaPeriod + 1) return true;
  const closes = closed1hCandles.map((c) => c.close);
  const ema = calculateEMA(closes, emaPeriod);
  const lastEma = ema[ema.length - 1]!;
  const lastClose = closes[closes.length - 1]!;
  if (!Number.isFinite(lastEma)) return true;
  return side === 'LONG' ? lastClose > lastEma : lastClose < lastEma;
}

/**
 * Checks macro BTC 1h trend regime using EMA(21) and EMA(50).
 * Fail-closed when insufficient BTC candles are provided.
 */
export function isBtcRegimeAligned(
  btc1hCandles: Candle[],
  side: Side,
  fastPeriod = 21,
  slowPeriod = 50,
): boolean {
  if (btc1hCandles.length < fastPeriod + 1) return false;
  const closes = btc1hCandles.map((c) => c.close);
  const emaFast = calculateEMA(closes, fastPeriod);
  const lastFast = emaFast[emaFast.length - 1]!;
  const lastClose = closes[closes.length - 1]!;
  if (!Number.isFinite(lastFast)) return false;

  let lastSlow = Number.NaN;
  if (btc1hCandles.length >= slowPeriod + 1) {
    const emaSlow = calculateEMA(closes, slowPeriod);
    lastSlow = emaSlow[emaSlow.length - 1]!;
  }

  if (side === 'LONG') {
    if (lastClose <= lastFast) return false;
    if (Number.isFinite(lastSlow) && lastFast < lastSlow * 0.998) return false;
    return true;
  }

  if (lastClose >= lastFast) return false;
  if (Number.isFinite(lastSlow) && lastFast > lastSlow * 1.002) return false;
  return true;
}

/**
 * Evaluates closed 15m candles for a momentum entry signal:
 * - Bullish Engulfing / Bullish Marubozu for LONG (above EMA21)
 * - Bearish Engulfing / Bearish Marubozu for SHORT (below EMA21)
 * - Solid body, minimal leading wick, volume expansion vs previous candle
 * - Anti-overextension guard (ATR spike, EMA distance, consecutive run)
 */
export function detectMomentumSignal(
  closedCandles: Candle[],
  side: Side,
  options: DetectorOptions = {},
): DetectedSignal | null {
  const opts = { ...DEFAULT_OPTS, ...options };
  if (closedCandles.length < 30) {
    return null;
  }

  const n = closedCandles.length;
  const curr = closedCandles[n - 1]!;
  const prev = closedCandles[n - 2]!;

  const closes = closedCandles.map((c) => c.close);
  const emaSeries = calculateEMA(closes, opts.emaPeriod);
  const atrSeries = calculateATR(closedCandles, opts.atrPeriod);

  const emaCurr = emaSeries[n - 1]!;
  const emaPrev = emaSeries[n - 2]!;
  const atrCurr = atrSeries[n - 1]!;

  if (!Number.isFinite(emaCurr) || !Number.isFinite(emaPrev) || !Number.isFinite(atrCurr) || atrCurr <= 0) {
    return null;
  }

  // 1. Trend alignment with EMA(21) and optional ADX trend-strength filter
  if (side === 'LONG') {
    if (curr.close <= emaCurr) return null;
    if (emaCurr < emaPrev * 0.9995) return null;
  } else {
    if (curr.close >= emaCurr) return null;
    if (emaCurr > emaPrev * 1.0005) return null;
  }

  if (opts.minAdx > 0) {
    const adxSeries = calculateADX(closedCandles, opts.atrPeriod);
    const adxCurr = adxSeries[n - 1]!;
    if (Number.isFinite(adxCurr) && adxCurr < opts.minAdx) {
      return null;
    }
  }

  // 2. Candle direction & solid body
  const range = curr.high - curr.low;
  if (range <= 0) return null;

  const isGreen = curr.close > curr.open;
  const isRed = curr.close < curr.open;
  if (side === 'LONG' && !isGreen) return null;
  if (side === 'SHORT' && !isRed) return null;

  const body = Math.abs(curr.close - curr.open);
  const bodyRatio = body / range;
  if (bodyRatio < opts.minBodyRatio) return null;

  // 3. Minimal leading wick ("Hanya sedikit atau gak ada wick ke atas" for LONG; mirrored for SHORT)
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  const leadWickRatio = side === 'LONG' ? upperWick / range : lowerWick / range;
  const trailWickRatio = side === 'LONG' ? lowerWick / range : upperWick / range;

  if (leadWickRatio > opts.maxLeadWickRatio) return null;

  // 4. Volume expansion relative to previous candle AND 10-candle average
  if (prev.volume <= 0) return null;
  const volumeRatio = curr.volume / prev.volume;
  let avgVolRatio = Number.POSITIVE_INFINITY;

  const lookbackStart = Math.max(0, n - 11);
  const lookbackCount = n - 1 - lookbackStart;
  if (lookbackCount > 0) {
    let volSum = 0;
    for (let i = lookbackStart; i < n - 1; i++) {
      volSum += closedCandles[i]!.volume;
    }
    const avgVol = volSum / lookbackCount;
    if (avgVol > 0) {
      avgVolRatio = curr.volume / avgVol;
    }
  }

  // 5. Pattern classification (Engulfing, Marubozu, or EMA Pullback Continuation)
  let pattern: PatternType | null = null;
  let useTwoCandleSl = false;

  const hasFullVolume =
    volumeRatio >= opts.minVolumeMultiplier && avgVolRatio >= opts.minAvgVolumeMultiplier;
  const hasPullbackVolume = volumeRatio >= 1.1 && avgVolRatio >= 1.2;

  if (side === 'LONG') {
    const prevWasRed = prev.close < prev.open;
    const engulfed = prevWasRed && curr.close >= prev.open && curr.open <= prev.close * 1.001;
    const touchedEma = Math.min(curr.low, prev.low) <= emaCurr * (1 + opts.pullbackTouchPct);
    const pullbackReject = touchedEma && curr.close > prev.high && curr.close > emaCurr;

    if (hasFullVolume && engulfed) {
      pattern = 'BULLISH_ENGULFING';
      useTwoCandleSl = true;
    } else if (hasFullVolume && bodyRatio >= opts.marubozuBodyRatio && trailWickRatio <= opts.maxTrailWickRatio) {
      pattern = 'BULLISH_MARUBOZU';
    } else if (hasPullbackVolume && pullbackReject) {
      pattern = 'BULLISH_PULLBACK';
      useTwoCandleSl = true;
    }
  } else {
    const prevWasGreen = prev.close > prev.open;
    const engulfed = prevWasGreen && curr.close <= prev.open && curr.open >= prev.close * 0.999;
    const touchedEma = Math.max(curr.high, prev.high) >= emaCurr * (1 - opts.pullbackTouchPct);
    const pullbackReject = touchedEma && curr.close < prev.low && curr.close < emaCurr;

    if (hasFullVolume && engulfed) {
      pattern = 'BEARISH_ENGULFING';
      useTwoCandleSl = true;
    } else if (hasFullVolume && bodyRatio >= opts.marubozuBodyRatio && trailWickRatio <= opts.maxTrailWickRatio) {
      pattern = 'BEARISH_MARUBOZU';
    } else if (hasPullbackVolume && pullbackReject) {
      pattern = 'BEARISH_PULLBACK';
      useTwoCandleSl = true;
    }
  }

  if (!pattern) return null;

  // 6. Anti-overextension / climax guard ("Hindari: Candle yang terlalu besar atau terlalu atas")
  if (range > atrCurr * opts.maxCandleAtrMult) return null;

  const emaDistancePct = Math.abs(curr.close - emaCurr) / emaCurr;
  if (emaDistancePct > opts.maxEmaDistancePct) return null;

  // Count consecutive same-direction candles immediately before `curr`
  let consecutive = 0;
  for (let i = n - 2; i >= 0; i--) {
    const c = closedCandles[i]!;
    const sameDir = side === 'LONG' ? c.close > c.open : c.close < c.open;
    if (!sameDir) break;
    consecutive++;
    if (consecutive >= opts.maxConsecutiveCandles) {
      return null;
    }
  }

  // 7. Stop Loss & Take Profit (2R default)
  const entryPrice = curr.close;
  let stopLoss: number;
  if (side === 'LONG') {
    const baseSl = useTwoCandleSl ? Math.min(curr.low, prev.low) : curr.low;
    stopLoss = baseSl * (1 - opts.slBufferPct);
  } else {
    const baseSl = useTwoCandleSl ? Math.max(curr.high, prev.high) : curr.high;
    stopLoss = baseSl * (1 + opts.slBufferPct);
  }

  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0) return null;

  // Enforce minimum SL distance (% and ATR) to avoid fee/noise stop-outs
  if (riskPerUnit / entryPrice < opts.minSlPct) return null;
  if (riskPerUnit < atrCurr * opts.minSlAtrMult) return null;

  const takeProfit =
    side === 'LONG' ? entryPrice + riskPerUnit * opts.rrRatio : entryPrice - riskPerUnit * opts.rrRatio;

  return {
    symbol: opts.symbol,
    side,
    pattern,
    candleOpenTime: curr.openTime,
    entryPrice,
    stopLoss,
    takeProfit,
    ema21: emaCurr,
    volumeRatio,
    bodyRatio,
  };
}
