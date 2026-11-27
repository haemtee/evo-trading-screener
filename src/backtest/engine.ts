import {
  detectMomentumSignal,
  isBtcRegimeAligned,
  isHtfTrendAligned,
} from '../strategy/detector.ts';
import {
  computeBreakEvenSl,
  computeDynamicRiskPct,
  computeTrailingSl,
  evaluateCircuitBreakers,
} from '../strategy/guards.ts';
import { calculateATR } from '../strategy/indicators.ts';
import { calculatePositionSize } from '../strategy/risk.ts';
import type { Candle, Side, TradeRecord } from '../types.ts';

export interface BacktestConfig {
  name: string;
  initialEquity: number;
  riskPct: number;
  rrRatio: number;
  leverage: number;
  maxOpenPositions: number;
  maxNotionalEquityMult: number;
  emaPeriod: number;
  minSlPct: number;
  breakEvenAtR: number;
  partialTpAtR: number;
  partialTpPct: number;
  trailingAtrMult: number;
  minAdx: number;
  btcRegimeFilter: boolean;
  dynamicRiskEnabled: boolean;
  dailyMaxLossPct: number;
  maxConsecutiveLosses: number;
  lossCooldownMinutes: number;
  symbolCooldownMinutes: number;
  feeRatePerSide?: number;
  slippagePct?: number;
}

export const BASELINE_BACKTEST_CONFIG: BacktestConfig = {
  name: 'Old Strategy (Baseline)',
  initialEquity: 5000,
  riskPct: 1,
  rrRatio: 2,
  leverage: 5,
  maxOpenPositions: 3,
  maxNotionalEquityMult: 2,
  emaPeriod: 21,
  minSlPct: 1,
  breakEvenAtR: 1,
  partialTpAtR: 0,
  partialTpPct: 0,
  trailingAtrMult: 0,
  minAdx: 0,
  btcRegimeFilter: false,
  dynamicRiskEnabled: false,
  dailyMaxLossPct: 3,
  maxConsecutiveLosses: 3,
  lossCooldownMinutes: 90,
  symbolCooldownMinutes: 180,
};

export const GROWTH_10X_BACKTEST_CONFIG: BacktestConfig = {
  name: 'New Strategy (Growth 10x)',
  initialEquity: 5000,
  riskPct: 2,
  rrRatio: 6,
  leverage: 8,
  maxOpenPositions: 4,
  maxNotionalEquityMult: 5,
  emaPeriod: 21,
  minSlPct: 1,
  breakEvenAtR: 1.5,
  partialTpAtR: 2,
  partialTpPct: 50,
  trailingAtrMult: 2,
  minAdx: 20,
  btcRegimeFilter: true,
  dynamicRiskEnabled: true,
  dailyMaxLossPct: 6,
  maxConsecutiveLosses: 3,
  lossCooldownMinutes: 90,
  symbolCooldownMinutes: 180,
};

export interface SymbolHistory {
  candles15m: Candle[];
  candles1h: Candle[];
}

export interface BacktestDataset {
  symbols: Record<string, SymbolHistory>;
  btc1h: Candle[];
}

export interface BacktestTrade {
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  netPnlUsd: number;
  rMultiple: number;
  openedAt: number;
  closedAt: number;
}

export interface BacktestResult {
  name: string;
  initialEquity: number;
  finalEquity: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number;
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  tradesTo10xEstimate: number | null;
  trades: BacktestTrade[];
}

interface SimPosition {
  id: number;
  symbol: string;
  side: Side;
  entryPrice: number;
  stopLoss: number;
  initialStopLoss: number;
  takeProfit: number;
  quantity: number;
  remainingQty: number;
  riskUsd: number;
  realizedPartialPnl: number;
  totalFees: number;
  beMoved: boolean;
  partialTpTaken: boolean;
  peakPrice: number;
  openedAt: number;
}

export function runBacktest(dataset: BacktestDataset, config: BacktestConfig): BacktestResult {
  const feeRate = config.feeRatePerSide ?? 0.0005; // 0.05% taker
  const slippage = config.slippagePct ?? 0.0005; // 0.05% slippage

  const symbolNames = Object.keys(dataset.symbols);
  const symbolMaps = new Map<string, Map<number, number>>();
  const atrBySymbol = new Map<string, number[]>();
  const allTimesSet = new Set<number>();

  for (const sym of symbolNames) {
    const hist = dataset.symbols[sym]!;
    const idxMap = new Map<number, number>();
    hist.candles15m.forEach((c, idx) => {
      idxMap.set(c.openTime, idx);
      allTimesSet.add(c.openTime);
    });
    symbolMaps.set(sym, idxMap);
    atrBySymbol.set(sym, calculateATR(hist.candles15m, 14));
  }

  const timeline = [...allTimesSet].sort((a, b) => a - b);

  let equity = config.initialEquity;
  let peakEquity = equity;
  let maxDrawdownPct = 0;
  let nextTradeId = 1;

  const openPositions: SimPosition[] = [];
  const closedTrades: TradeRecord[] = [];
  const results: BacktestTrade[] = [];

  const updateDrawdown = () => {
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity > 0) {
      const dd = ((peakEquity - equity) / peakEquity) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  };

  for (const ts of timeline) {
    // 1. Manage open positions on current 15m bar
    for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = openPositions[pIdx]!;
      const symIdx = symbolMaps.get(pos.symbol)?.get(ts);
      if (symIdx === undefined) continue;

      const bar = dataset.symbols[pos.symbol]!.candles15m[symIdx]!;
      const atr = atrBySymbol.get(pos.symbol)![symIdx] ?? 0;

      // Conservative SL-first check within the bar
      const hitSl = pos.side === 'LONG' ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss;
      const hitTp = pos.side === 'LONG' ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit;

      if (hitSl || hitTp) {
        const rawExit = hitSl ? pos.stopLoss : pos.takeProfit;
        const exitPrice =
          pos.side === 'LONG' ? rawExit * (1 - slippage) : rawExit * (1 + slippage);
        const exitFee = pos.remainingQty * exitPrice * feeRate;
        const priceDiff =
          pos.side === 'LONG' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
        const remPnl = priceDiff * pos.remainingQty;
        const netTradePnl = pos.realizedPartialPnl + remPnl - pos.totalFees - exitFee;

        equity += remPnl - exitFee;
        updateDrawdown();

        const rMult = pos.riskUsd > 0 ? netTradePnl / pos.riskUsd : 0;
        results.push({
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice,
          netPnlUsd: netTradePnl,
          rMultiple: rMult,
          openedAt: pos.openedAt,
          closedAt: bar.closeTime,
        });

        closedTrades.unshift({
          id: pos.id,
          signalId: null,
          symbol: pos.symbol,
          side: pos.side,
          quantity: pos.quantity,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          initialStopLoss: pos.initialStopLoss,
          takeProfit: pos.takeProfit,
          riskUsd: pos.riskUsd,
          leverage: config.leverage,
          entryOrderId: null,
          slOrderId: null,
          tpOrderId: null,
          status: 'CLOSED',
          pnlUsd: netTradePnl + pos.totalFees + exitFee,
          closePrice: exitPrice,
          feeUsd: pos.totalFees + exitFee,
          beMoved: pos.beMoved,
          partialTpTaken: pos.partialTpTaken,
          peakPrice: pos.peakPrice,
          openedAt: pos.openedAt,
          closedAt: bar.closeTime,
        });

        openPositions.splice(pIdx, 1);
        continue;
      }

      // Update peak price
      pos.peakPrice =
        pos.side === 'LONG' ? Math.max(pos.peakPrice, bar.high) : Math.min(pos.peakPrice, bar.low);

      // Partial TP check
      if (!pos.partialTpTaken && config.partialTpAtR > 0 && config.partialTpPct > 0) {
        const initRisk = Math.abs(pos.entryPrice - pos.initialStopLoss);
        const trigger =
          pos.side === 'LONG'
            ? pos.entryPrice + initRisk * config.partialTpAtR
            : pos.entryPrice - initRisk * config.partialTpAtR;
        const reached = pos.side === 'LONG' ? bar.high >= trigger : bar.low <= trigger;
        if (reached) {
          const partQty = pos.remainingQty * (config.partialTpPct / 100);
          const partPrice =
            pos.side === 'LONG' ? trigger * (1 - slippage) : trigger * (1 + slippage);
          const partFee = partQty * partPrice * feeRate;
          const partPnl =
            (pos.side === 'LONG' ? partPrice - pos.entryPrice : pos.entryPrice - partPrice) *
            partQty;

          pos.remainingQty -= partQty;
          pos.realizedPartialPnl += partPnl;
          pos.totalFees += partFee;
          pos.partialTpTaken = true;
          pos.beMoved = true;

          const beSl =
            pos.side === 'LONG' ? pos.entryPrice * 1.0012 : pos.entryPrice * 0.9988;
          if (pos.side === 'LONG' ? beSl > pos.stopLoss : beSl < pos.stopLoss) {
            pos.stopLoss = beSl;
          }

          equity += partPnl - partFee;
          updateDrawdown();
        }
      }

      // Break-Even check
      if (!pos.beMoved && config.breakEvenAtR > 0) {
        const be = computeBreakEvenSl({
          side: pos.side,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          markPrice: pos.side === 'LONG' ? bar.high : bar.low,
          breakEvenAtR: config.breakEvenAtR,
        });
        if (be !== null) {
          pos.stopLoss = be;
          pos.beMoved = true;
        }
      }

      // ATR Trailing SL check
      if ((pos.partialTpTaken || pos.beMoved) && config.trailingAtrMult > 0 && atr > 0) {
        const trail = computeTrailingSl({
          side: pos.side,
          entryPrice: pos.entryPrice,
          initialStopLoss: pos.initialStopLoss,
          currentStopLoss: pos.stopLoss,
          peakPrice: pos.peakPrice,
          markPrice: bar.close,
          atr,
          trailingAtrMult: config.trailingAtrMult,
          partialTpTaken: pos.partialTpTaken,
        });
        if (trail !== null) {
          pos.stopLoss = trail;
        }
      }
    }

    // 2. Scan for new entries on closed 15m candles
    if (openPositions.length >= config.maxOpenPositions || equity <= 10) {
      continue;
    }

    for (const sym of symbolNames) {
      if (openPositions.length >= config.maxOpenPositions) break;
      if (openPositions.some((p) => p.symbol === sym)) continue;

      const symIdx = symbolMaps.get(sym)?.get(ts);
      if (symIdx === undefined || symIdx < 40) continue;

      const hist = dataset.symbols[sym]!;
      const window15m = hist.candles15m.slice(Math.max(0, symIdx - 79), symIdx + 1);
      const currBar = hist.candles15m[symIdx]!;

      const htfClosed = hist.candles1h.filter((c) => c.closeTime <= currBar.closeTime).slice(-30);
      const btcClosed = dataset.btc1h.filter((c) => c.closeTime <= currBar.closeTime).slice(-60);

      for (const side of ['LONG', 'SHORT'] as const) {
        const sig = detectMomentumSignal(window15m, side, {
          symbol: sym,
          emaPeriod: config.emaPeriod,
          rrRatio: config.rrRatio,
          minSlPct: config.minSlPct / 100,
          minAdx: config.minAdx,
        });
        if (!sig) continue;
        if (!isHtfTrendAligned(htfClosed, side, config.emaPeriod)) continue;
        if (config.btcRegimeFilter && !isBtcRegimeAligned(btcClosed, side)) continue;

        const utcDayStart = new Date(currBar.closeTime).setUTCHours(0, 0, 0, 0);
        const dailyNet = closedTrades
          .filter((t) => (t.closedAt ?? 0) >= utcDayStart)
          .reduce((acc, t) => acc + ((t.pnlUsd ?? 0) - (t.feeUsd ?? 0)), 0);
        const lastSymLoss =
          closedTrades.find((t) => t.symbol === sym && (t.pnlUsd ?? 0) - (t.feeUsd ?? 0) < 0) ??
          null;

        const breaker = evaluateCircuitBreakers({
          symbol: sym,
          equity,
          dailyNetPnlUsd: dailyNet,
          dailyMaxLossPct: config.dailyMaxLossPct,
          recentClosedTrades: closedTrades.slice(0, Math.max(5, config.maxConsecutiveLosses)),
          maxConsecutiveLosses: config.maxConsecutiveLosses,
          lossCooldownMinutes: config.lossCooldownMinutes,
          lastSymbolLoss: lastSymLoss,
          symbolCooldownMinutes: config.symbolCooldownMinutes,
          now: currBar.closeTime,
        });
        if (!breaker.allowed) continue;

        const effectiveRisk = config.dynamicRiskEnabled
          ? computeDynamicRiskPct({
              baseRiskPct: config.riskPct,
              equity,
              peakEquity,
              recentClosedTrades: closedTrades.slice(0, 5),
            })
          : config.riskPct;

        const entryFill =
          side === 'LONG' ? sig.entryPrice * (1 + slippage) : sig.entryPrice * (1 - slippage);
        const sizing = calculatePositionSize({
          equity,
          availableBalance: equity,
          riskPct: effectiveRisk,
          leverage: config.leverage,
          entryPrice: entryFill,
          stopLoss: sig.stopLoss,
          stepSize: 0.0001,
          minQty: 0.0001,
          maxNotionalEquityMult: config.maxNotionalEquityMult,
          minNotional: 5,
        });

        if (sizing.rejectedReason || sizing.quantity <= 0) continue;

        const entryFee = sizing.notionalUsd * feeRate;
        equity -= entryFee;
        updateDrawdown();

        openPositions.push({
          id: nextTradeId++,
          symbol: sym,
          side,
          entryPrice: entryFill,
          stopLoss: sig.stopLoss,
          initialStopLoss: sig.stopLoss,
          takeProfit: sig.takeProfit,
          quantity: sizing.quantity,
          remainingQty: sizing.quantity,
          riskUsd: sizing.actualRiskUsd,
          realizedPartialPnl: 0,
          totalFees: entryFee,
          beMoved: false,
          partialTpTaken: false,
          peakPrice: entryFill,
          openedAt: currBar.closeTime,
        });
        break;
      }
    }
  }

  const wins = results.filter((t) => t.netPnlUsd > 0);
  const losses = results.filter((t) => t.netPnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  const avgWinR =
    wins.length > 0 ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
  const avgLossR =
    losses.length > 0 ? losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length : 0;
  const expectancyR =
    results.length > 0 ? results.reduce((s, t) => s + t.rMultiple, 0) / results.length : 0;

  const netReturnPct = ((equity - config.initialEquity) / config.initialEquity) * 100;
  const avgReturnPerTrade =
    results.length > 0 && equity > 0
      ? Math.pow(equity / config.initialEquity, 1 / results.length) - 1
      : 0;
  const tradesTo10xEstimate =
    avgReturnPerTrade > 0 ? Math.ceil(Math.log(10) / Math.log(1 + avgReturnPerTrade)) : null;

  return {
    name: config.name,
    initialEquity: config.initialEquity,
    finalEquity: equity,
    netReturnPct,
    maxDrawdownPct,
    totalTrades: results.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: results.length > 0 ? (wins.length / results.length) * 100 : 0,
    profitFactor,
    expectancyR,
    avgWinR,
    avgLossR,
    tradesTo10xEstimate,
    trades: results,
  };
}
