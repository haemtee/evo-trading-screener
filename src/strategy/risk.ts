export interface PositionSizeInput {
  equity: number;
  availableBalance: number;
  riskPct: number;
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface PositionSizeResult {
  quantity: number;
  notionalUsd: number;
  actualRiskUsd: number;
  rejectedReason?: string;
}

function decimalsFromStep(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) {
    const [, exp] = s.split('e-');
    return Number(exp) || 0;
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function roundStep(value: number, step: number, mode: 'floor' | 'round' | 'ceil' = 'floor'): number {
  if (step <= 0 || !Number.isFinite(value)) return value;
  const inv = 1 / step;
  const scaled = value * inv;
  let rounded: number;
  if (mode === 'floor') {
    rounded = Math.floor(scaled + 1e-9);
  } else if (mode === 'ceil') {
    rounded = Math.ceil(scaled - 1e-9);
  } else {
    rounded = Math.round(scaled);
  }
  const decimals = decimalsFromStep(step);
  return Number((rounded * step).toFixed(decimals));
}

export function formatStep(value: number, step: number): string {
  const decimals = decimalsFromStep(step);
  return roundStep(value, step, 'round').toFixed(decimals);
}

/**
 * Calculates risk-based position size:
 * - Risk per trade = equity * (riskPct / 100)
 * - Caps notional at availableBalance * leverage * 0.95
 * - Floors quantity to exchange `stepSize` and validates `minQty` & `minNotional`
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const riskPerUnit = Math.abs(input.entryPrice - input.stopLoss);
  if (riskPerUnit <= 0 || input.entryPrice <= 0) {
    return {
      quantity: 0,
      notionalUsd: 0,
      actualRiskUsd: 0,
      rejectedReason: 'Invalid entryPrice or stopLoss distance',
    };
  }

  if (input.equity <= 0 || input.availableBalance <= 0) {
    return {
      quantity: 0,
      notionalUsd: 0,
      actualRiskUsd: 0,
      rejectedReason: 'Insufficient demo USDT balance',
    };
  }

  const targetRiskUsd = input.equity * (input.riskPct / 100);
  const rawQty = targetRiskUsd / riskPerUnit;

  const maxNotional = input.availableBalance * input.leverage * 0.95;
  const cappedQty = Math.min(rawQty, maxNotional / input.entryPrice);
  const quantity = roundStep(cappedQty, input.stepSize, 'floor');

  if (quantity <= 0 || quantity < input.minQty) {
    return {
      quantity: 0,
      notionalUsd: 0,
      actualRiskUsd: 0,
      rejectedReason: `Calculated quantity (${quantity}) is below minQty (${input.minQty})`,
    };
  }

  const notionalUsd = quantity * input.entryPrice;
  if (notionalUsd < input.minNotional) {
    return {
      quantity: 0,
      notionalUsd,
      actualRiskUsd: 0,
      rejectedReason: `Order notional ($${notionalUsd.toFixed(2)}) is below minNotional ($${input.minNotional})`,
    };
  }

  const actualRiskUsd = quantity * riskPerUnit;
  return {
    quantity,
    notionalUsd,
    actualRiskUsd,
  };
}
