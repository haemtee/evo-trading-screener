import { describe, expect, test } from 'bun:test';
import {
  computeBreakEvenSl,
  computeDynamicRiskPct,
  computeTrailingSl,
  evaluateCircuitBreakers,
} from '../src/strategy/guards.ts';
import type { TradeRecord } from '../src/types.ts';

function makeClosedTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 1,
    signalId: null,
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: 1,
    entryPrice: 100,
    stopLoss: 98,
    initialStopLoss: 98,
    takeProfit: 104,
    riskUsd: 10,
    leverage: 5,
    entryOrderId: '1',
    slOrderId: '2',
    tpOrderId: '3',
    status: 'CLOSED',
    pnlUsd: -10,
    closePrice: 98,
    feeUsd: 0.2,
    beMoved: false,
    partialTpTaken: false,
    peakPrice: null,
    openedAt: 1_000_000,
    closedAt: 1_100_000,
    ...overrides,
  };
}

describe('evaluateCircuitBreakers', () => {
  test('blocks when daily loss limit is reached', () => {
    const res = evaluateCircuitBreakers({
      symbol: 'ETHUSDT',
      equity: 1000,
      dailyNetPnlUsd: -31,
      dailyMaxLossPct: 3,
      recentClosedTrades: [],
      maxConsecutiveLosses: 3,
      lossCooldownMinutes: 90,
      lastSymbolLoss: null,
      symbolCooldownMinutes: 180,
      now: 1_200_000,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Daily loss limit');
  });

  test('blocks after maxConsecutiveLosses within cooldown', () => {
    const losses = [
      makeClosedTrade({ id: 3, closedAt: 1_150_000 }),
      makeClosedTrade({ id: 2, closedAt: 1_100_000 }),
      makeClosedTrade({ id: 1, closedAt: 1_050_000 }),
    ];
    const res = evaluateCircuitBreakers({
      symbol: 'ETHUSDT',
      equity: 1000,
      dailyNetPnlUsd: -15,
      dailyMaxLossPct: 3,
      recentClosedTrades: losses,
      maxConsecutiveLosses: 3,
      lossCooldownMinutes: 90,
      lastSymbolLoss: null,
      symbolCooldownMinutes: 180,
      now: 1_150_000 + 10 * 60_000,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('3 consecutive losses');
  });

  test('blocks re-entry on symbol within symbolCooldownMinutes after a loss', () => {
    const res = evaluateCircuitBreakers({
      symbol: 'BTCUSDT',
      equity: 1000,
      dailyNetPnlUsd: -10,
      dailyMaxLossPct: 3,
      recentClosedTrades: [makeClosedTrade({ symbol: 'BTCUSDT', closedAt: 1_100_000 })],
      maxConsecutiveLosses: 3,
      lossCooldownMinutes: 90,
      lastSymbolLoss: makeClosedTrade({ symbol: 'BTCUSDT', closedAt: 1_100_000 }),
      symbolCooldownMinutes: 180,
      now: 1_100_000 + 30 * 60_000,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('BTCUSDT stopped out recently');
  });
});

describe('computeBreakEvenSl', () => {
  test('moves SL to entry + fee buffer at +1R for LONG and SHORT', () => {
    // LONG: entry 100, SL 98 (risk = 2), mark 102 (+1R) -> BE SL = 100.12
    const longBe = computeBreakEvenSl({
      side: 'LONG',
      entryPrice: 100,
      stopLoss: 98,
      markPrice: 102,
      breakEvenAtR: 1,
    });
    expect(longBe).toBeCloseTo(100.12, 4);

    // Not yet at +1R
    expect(
      computeBreakEvenSl({
        side: 'LONG',
        entryPrice: 100,
        stopLoss: 98,
        markPrice: 101.5,
        breakEvenAtR: 1,
      }),
    ).toBeNull();

    // SHORT: entry 100, SL 102 (risk = 2), mark 98 (+1R) -> BE SL = 99.88
    const shortBe = computeBreakEvenSl({
      side: 'SHORT',
      entryPrice: 100,
      stopLoss: 102,
      markPrice: 98,
      breakEvenAtR: 1,
    });
    expect(shortBe).toBeCloseTo(99.88, 4);
  });
});

describe('computeTrailingSl', () => {
  test('trails SL using peakPrice and ATR once runner is in profit', () => {
    // Entry 100, initialSL 98 (risk = 2), peak 108 (+4R), ATR 1.5, mult 2 -> candidate 105
    const longTrail = computeTrailingSl({
      side: 'LONG',
      entryPrice: 100,
      initialStopLoss: 98,
      currentStopLoss: 100.12,
      peakPrice: 108,
      markPrice: 107.5,
      atr: 1.5,
      trailingAtrMult: 2,
      partialTpTaken: true,
    });
    expect(longTrail).toBeCloseTo(105, 4);

    // Does not activate before 1.5R without partialTpTaken
    expect(
      computeTrailingSl({
        side: 'LONG',
        entryPrice: 100,
        initialStopLoss: 98,
        currentStopLoss: 98,
        peakPrice: 102,
        markPrice: 102,
        atr: 0.5,
        trailingAtrMult: 2,
      }),
    ).toBeNull();

    // SHORT: entry 100, initialSL 102, peak 92 (+4R), ATR 1.5, mult 2 -> candidate 95
    const shortTrail = computeTrailingSl({
      side: 'SHORT',
      entryPrice: 100,
      initialStopLoss: 102,
      currentStopLoss: 99.88,
      peakPrice: 92,
      markPrice: 92.5,
      atr: 1.5,
      trailingAtrMult: 2,
      partialTpTaken: true,
    });
    expect(shortTrail).toBeCloseTo(95, 4);
  });
});

describe('computeDynamicRiskPct', () => {
  test('reduces risk during drawdowns and scales up on win streaks near peak', () => {
    expect(
      computeDynamicRiskPct({
        baseRiskPct: 2,
        equity: 4200,
        peakEquity: 5000, // 16% DD
        recentClosedTrades: [],
      }),
    ).toBe(1);

    expect(
      computeDynamicRiskPct({
        baseRiskPct: 2,
        equity: 4550,
        peakEquity: 5000, // 9% DD
        recentClosedTrades: [],
      }),
    ).toBe(1.5);

    expect(
      computeDynamicRiskPct({
        baseRiskPct: 2,
        equity: 5200,
        peakEquity: 5200,
        recentClosedTrades: [
          makeClosedTrade({ pnlUsd: 40, feeUsd: 1 }),
          makeClosedTrade({ pnlUsd: 35, feeUsd: 1 }),
        ],
      }),
    ).toBe(2.5);
  });
});
