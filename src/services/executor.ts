import type { BinanceFuturesClient } from '../binance/client.ts';
import type { AppDatabase } from '../db/database.ts';
import { calculatePositionSize, formatStep } from '../strategy/risk.ts';
import type { TradeRecord } from '../types.ts';

export interface ExecutionResult {
  ok: boolean;
  trade?: TradeRecord;
  error?: string;
  warning?: string;
}

export class TradeExecutor {
  constructor(
    private readonly binance: BinanceFuturesClient,
    private readonly db: AppDatabase,
  ) {}

  async executeSignal(signalId: number): Promise<ExecutionResult> {
    const signal = this.db.getSignalById(signalId);
    if (!signal) {
      return { ok: false, error: `Signal #${signalId} not found.` };
    }
    if (signal.status === 'EXECUTED') {
      return { ok: false, error: `Signal #${signalId} was already executed.` };
    }

    const settings = this.db.getSettings();

    try {
      const [filters, balance, openPositions] = await Promise.all([
        this.binance.getDemoExchangeInfo(),
        this.binance.getUsdtBalance(),
        this.binance.getOpenPositions(),
      ]);

      if (openPositions.length >= settings.maxOpenPositions) {
        return {
          ok: false,
          error: `Max open positions reached (${openPositions.length}/${settings.maxOpenPositions}).`,
        };
      }

      if (openPositions.some((p) => p.symbol === signal.symbol)) {
        return {
          ok: false,
          error: `Position already open for ${signal.symbol}.`,
        };
      }

      const filter = filters.get(signal.symbol);
      if (!filter) {
        return {
          ok: false,
          error: `${signal.symbol} is not tradable on Binance Futures Demo.`,
        };
      }

      const sizing = calculatePositionSize({
        equity: balance.balance,
        availableBalance: balance.availableBalance,
        riskPct: settings.riskPct,
        leverage: settings.leverage,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        stepSize: filter.stepSize,
        minQty: filter.minQty,
        maxQty: filter.maxQty,
        minNotional: filter.minNotional,
      });

      if (sizing.rejectedReason || sizing.quantity <= 0) {
        return {
          ok: false,
          error: sizing.rejectedReason ?? 'Position size rejected.',
        };
      }

      await this.binance.setMarginType(signal.symbol, 'ISOLATED');
      await this.binance.setLeverage(signal.symbol, settings.leverage);

      const entrySide: 'BUY' | 'SELL' = signal.side === 'LONG' ? 'BUY' : 'SELL';
      const closeSide: 'BUY' | 'SELL' = signal.side === 'LONG' ? 'SELL' : 'BUY';

      const qtyStr = formatStep(sizing.quantity, filter.stepSize);
      const entryOrder = await this.binance.placeMarketOrder(signal.symbol, entrySide, qtyStr);

      const fillPrice =
        Number(entryOrder.avgPrice) > 0
          ? Number(entryOrder.avgPrice)
          : await this.binance.getDemoMarkPrice(signal.symbol);

      // Re-anchor SL/TP if demo mark/fill price differs from marketDataUrl signal price
      // so Binance Demo does not reject with -2021 ("Order would immediately trigger")
      const riskDistance = Math.abs(signal.entryPrice - signal.stopLoss);
      let adjustedSl = signal.stopLoss;
      let adjustedTp = signal.takeProfit;

      if (signal.side === 'LONG') {
        if (adjustedSl >= fillPrice) {
          adjustedSl = fillPrice - riskDistance;
        }
        if (adjustedTp <= fillPrice) {
          adjustedTp = fillPrice + riskDistance * settings.rrRatio;
        }
      } else {
        if (adjustedSl <= fillPrice) {
          adjustedSl = fillPrice + riskDistance;
        }
        if (adjustedTp >= fillPrice) {
          adjustedTp = fillPrice - riskDistance * settings.rrRatio;
        }
      }

      const slPriceStr = formatStep(adjustedSl, filter.tickSize);
      const tpPriceStr = formatStep(adjustedTp, filter.tickSize);

      let slOrderId: string | null = null;
      let tpOrderId: string | null = null;
      const warnings: string[] = [];

      try {
        const slOrder = await this.binance.placeStopLossOrder(signal.symbol, closeSide, slPriceStr);
        slOrderId = String(slOrder.algoId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`SL order failed (${msg})`);
      }

      try {
        const tpOrder = await this.binance.placeTakeProfitOrder(signal.symbol, closeSide, tpPriceStr);
        tpOrderId = String(tpOrder.algoId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`TP order failed (${msg})`);
      }

      const trade = this.db.createTrade({
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        quantity: sizing.quantity,
        entryPrice: fillPrice,
        stopLoss: Number(slPriceStr),
        takeProfit: Number(tpPriceStr),
        riskUsd: sizing.actualRiskUsd,
        leverage: settings.leverage,
        entryOrderId: String(entryOrder.orderId),
        slOrderId,
        tpOrderId,
      });

      this.db.updateSignalStatus(signal.id, 'EXECUTED');

      return {
        ok: true,
        trade,
        warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      };
    } catch (err) {
      this.db.updateSignalStatus(signal.id, 'FAILED');
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
