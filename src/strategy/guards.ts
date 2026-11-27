import type { Side, TradeRecord } from '../types.ts';

export interface CircuitBreakerInput {
  symbol: string;
  equity: number;
  dailyNetPnlUsd: number;
  dailyMaxLossPct: number;
  recentClosedTrades: TradeRecord[];
  maxConsecutiveLosses: number;
  lossCooldownMinutes: number;
  lastSymbolLoss: TradeRecord | null;
  symbolCooldownMinutes: number;
  now?: number;
}

export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
}

function tradeNetPnl(t: TradeRecord): number {
  return (t.pnlUsd ?? 0) - (t.feeUsd ?? 0);
}

/**
 * Evaluates account-level and per-symbol circuit breakers before opening a trade:
 * 1. Daily max loss limit (% of equity)
 * 2. Consecutive loss cooldown
 * 3. Per-symbol loss cooldown
 */
export function evaluateCircuitBreakers(input: CircuitBreakerInput): CircuitBreakerResult {
  const now = input.now ?? Date.now();

  if (input.equity > 0 && input.dailyMaxLossPct > 0) {
    const maxLossUsd = input.equity * (input.dailyMaxLossPct / 100);
    if (input.dailyNetPnlUsd <= -maxLossUsd) {
      return {
        allowed: false,
        reason: `Daily loss limit reached (${input.dailyNetPnlUsd.toFixed(2)} USDT; limit -${maxLossUsd.toFixed(2)} USDT / -${input.dailyMaxLossPct}%).`,
      };
    }
  }

  if (input.maxConsecutiveLosses > 0 && input.lossCooldownMinutes > 0) {
    let consecutiveLosses = 0;
    for (const t of input.recentClosedTrades) {
      if (tradeNetPnl(t) < 0) {
        consecutiveLosses++;
      } else {
        break;
      }
    }
    if (consecutiveLosses >= input.maxConsecutiveLosses) {
      const latestLossAt = input.recentClosedTrades[0]?.closedAt ?? 0;
      const cooldownMs = input.lossCooldownMinutes * 60_000;
      const remainingMs = latestLossAt + cooldownMs - now;
      if (remainingMs > 0) {
        const mins = Math.ceil(remainingMs / 60_000);
        return {
          allowed: false,
          reason: `${consecutiveLosses} consecutive losses — cooldown active (${mins}m remaining).`,
        };
      }
    }
  }

  if (input.lastSymbolLoss && input.symbolCooldownMinutes > 0 && input.lastSymbolLoss.closedAt) {
    const cooldownMs = input.symbolCooldownMinutes * 60_000;
    const remainingMs = input.lastSymbolLoss.closedAt + cooldownMs - now;
    if (remainingMs > 0) {
      const mins = Math.ceil(remainingMs / 60_000);
      return {
        allowed: false,
        reason: `${input.symbol} stopped out recently — symbol cooldown (${mins}m remaining).`,
      };
    }
  }

  return { allowed: true };
}

export interface BreakEvenInput {
  side: Side;
  entryPrice: number;
  stopLoss: number;
  markPrice: number;
  breakEvenAtR: number;
  feeBufferPct?: number;
}

/**
 * Returns the new break-even stop loss price (entry + fee buffer) once unrealized R >= breakEvenAtR,
 * or null if the trigger has not been reached yet.
 */
export function computeBreakEvenSl(input: BreakEvenInput): number | null {
  if (input.breakEvenAtR <= 0 || input.entryPrice <= 0 || input.markPrice <= 0) {
    return null;
  }
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  if (risk <= 0) return null;

  const feeBufferPct = input.feeBufferPct ?? 0.0012; // ~0.12% covers round-trip taker fees

  if (input.side === 'LONG') {
    const triggerPrice = input.entryPrice + risk * input.breakEvenAtR;
    if (input.markPrice < triggerPrice) return null;
    const beSl = input.entryPrice * (1 + feeBufferPct);
    if (beSl <= input.stopLoss || beSl >= input.markPrice) return null;
    return beSl;
  }

  const triggerPrice = input.entryPrice - risk * input.breakEvenAtR;
  if (input.markPrice > triggerPrice) return null;
  const beSl = input.entryPrice * (1 - feeBufferPct);
  if (beSl >= input.stopLoss || beSl <= input.markPrice) return null;
  return beSl;
}

export interface TrailingSlInput {
  side: Side;
  entryPrice: number;
  initialStopLoss: number;
  currentStopLoss: number;
  peakPrice: number;
  markPrice: number;
  atr: number;
  trailingAtrMult: number;
  partialTpTaken?: boolean;
  activateAtR?: number;
  minImprovePct?: number;
}

/**
 * Computes an updated ATR-based trailing stop loss for winning runner positions.
 * Only activates once the position has reached `activateAtR` (default 1.5R) or `partialTpTaken`.
 * Returns null if no meaningful SL improvement is warranted.
 */
export function computeTrailingSl(input: TrailingSlInput): number | null {
  if (
    input.trailingAtrMult <= 0 ||
    input.atr <= 0 ||
    input.entryPrice <= 0 ||
    input.markPrice <= 0 ||
    input.peakPrice <= 0
  ) {
    return null;
  }

  const initialRisk = Math.abs(input.entryPrice - input.initialStopLoss);
  if (initialRisk <= 0) return null;

  const activateAtR = input.activateAtR ?? 1.5;
  const minImprovePct = input.minImprovePct ?? 0.0015;
  const peakR =
    input.side === 'LONG'
      ? (input.peakPrice - input.entryPrice) / initialRisk
      : (input.entryPrice - input.peakPrice) / initialRisk;

  if (!input.partialTpTaken && peakR < activateAtR) {
    return null;
  }

  if (input.side === 'LONG') {
    const candidate = input.peakPrice - input.atr * input.trailingAtrMult;
    if (candidate <= input.entryPrice) return null;
    if (candidate <= input.currentStopLoss * (1 + minImprovePct)) return null;
    if (candidate >= input.markPrice * 0.998) return null;
    return candidate;
  }

  const candidate = input.peakPrice + input.atr * input.trailingAtrMult;
  if (candidate >= input.entryPrice) return null;
  if (candidate >= input.currentStopLoss * (1 - minImprovePct)) return null;
  if (candidate <= input.markPrice * 1.002) return null;
  return candidate;
}

export interface DynamicRiskInput {
  baseRiskPct: number;
  equity: number;
  peakEquity: number;
  recentClosedTrades: TradeRecord[];
  minRiskPct?: number;
  maxRiskPct?: number;
}

/**
 * Scales risk % dynamically:
 * - Cuts risk during drawdowns (>= 8% -> 0.75x, >= 15% -> 0.5x) to protect capital
 * - Scales up (+25%, capped at maxRiskPct) when near peak equity with >= 2 consecutive wins
 */
export function computeDynamicRiskPct(input: DynamicRiskInput): number {
  const minRiskPct = input.minRiskPct ?? 0.5;
  const maxRiskPct = input.maxRiskPct ?? 3.5;

  const ddPct =
    input.peakEquity > 0 && input.equity < input.peakEquity
      ? ((input.peakEquity - input.equity) / input.peakEquity) * 100
      : 0;

  if (ddPct >= 15) {
    return Math.max(minRiskPct, Number((input.baseRiskPct * 0.5).toFixed(2)));
  }
  if (ddPct >= 8) {
    return Math.max(minRiskPct, Number((input.baseRiskPct * 0.75).toFixed(2)));
  }

  let consecutiveWins = 0;
  for (const t of input.recentClosedTrades) {
    if (tradeNetPnl(t) > 0) {
      consecutiveWins++;
    } else {
      break;
    }
  }

  if (ddPct < 2 && consecutiveWins >= 2) {
    return Math.min(maxRiskPct, Number((input.baseRiskPct * 1.25).toFixed(2)));
  }

  return Math.min(maxRiskPct, Math.max(minRiskPct, input.baseRiskPct));
}
