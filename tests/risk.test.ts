import { describe, expect, test } from 'bun:test';
import { calculatePositionSize, roundStep } from '../src/strategy/risk.ts';

describe('roundStep', () => {
  test('floors cleanly without floating-point noise', () => {
    expect(roundStep(1.2349, 0.001, 'floor')).toBe(1.234);
    expect(roundStep(15.9, 1, 'floor')).toBe(15);
  });
});

describe('calculatePositionSize', () => {
  test('computes 1% risk size floored to stepSize', () => {
    // Equity $1000, 1% risk = $10, entry 100, SL 98 (risk/unit = 2) -> rawQty = 5
    const res = calculatePositionSize({
      equity: 1000,
      availableBalance: 1000,
      riskPct: 1,
      leverage: 5,
      entryPrice: 100,
      stopLoss: 98,
      stepSize: 0.1,
      minQty: 0.1,
      minNotional: 5,
    });

    expect(res.rejectedReason).toBeUndefined();
    expect(res.quantity).toBe(5);
    expect(res.actualRiskUsd).toBeCloseTo(10, 6);
    expect(res.notionalUsd).toBeCloseTo(500, 6);
  });

  test('caps notional by availableBalance * leverage * 0.95', () => {
    // Tight SL would ask for 500 qty ($50,000 notional), but 100 * 5 * 0.95 = $475 max notional -> 4.7 qty
    const res = calculatePositionSize({
      equity: 1000,
      availableBalance: 100,
      riskPct: 1,
      leverage: 5,
      entryPrice: 100,
      stopLoss: 99.98,
      stepSize: 0.1,
      minQty: 0.1,
      minNotional: 5,
    });

    expect(res.rejectedReason).toBeUndefined();
    expect(res.quantity).toBe(4.7);
    expect(res.notionalUsd).toBeCloseTo(470, 6);
  });

  test('rejects when below minNotional', () => {
    const res = calculatePositionSize({
      equity: 100,
      availableBalance: 100,
      riskPct: 1,
      leverage: 5,
      entryPrice: 100,
      stopLoss: 50, // risk/unit = 50, targetRisk = $1 -> qty 0.02 -> notional $2 < $5
      stepSize: 0.01,
      minQty: 0.01,
      minNotional: 5,
    });

    expect(res.quantity).toBe(0);
    expect(res.rejectedReason).toContain('minNotional');
  });
});
