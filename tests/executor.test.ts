import { describe, expect, test } from 'bun:test';
import type { BinanceFuturesClient } from '../src/binance/client.ts';
import { AppDatabase } from '../src/db/database.ts';
import { TradeExecutor } from '../src/services/executor.ts';
import type { SymbolFilter } from '../src/types.ts';

function makeFilter(symbol = 'SOLUSDT'): SymbolFilter {
  return {
    symbol,
    tickSize: 0.01,
    stepSize: 0.1,
    minQty: 0.1,
    maxQty: 10_000,
    minNotional: 5,
    pricePrecision: 2,
    quantityPrecision: 1,
  };
}

describe('TradeExecutor safety & dynamic risk', () => {
  test('emergency-closes position and marks signal FAILED if SL fails after retry', async () => {
    const db = new AppDatabase(':memory:');
    const sig = db.insertSignalIfNew({
      symbol: 'SOLUSDT',
      side: 'LONG',
      pattern: 'BULLISH_ENGULFING',
      candleOpenTime: 1_700_000_000_000,
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 104,
      ema21: 99,
      volumeRatio: 2,
      bodyRatio: 0.8,
    })!;

    let emergencyClosed = false;
    const fakeBinance = {
      async getDemoExchangeInfo() {
        return new Map([['SOLUSDT', makeFilter()]]);
      },
      async getUsdtBalance() {
        return { balance: 5000, availableBalance: 5000, crossUnPnl: 0 };
      },
      async getOpenPositions() {
        return [];
      },
      async setMarginType() {},
      async setLeverage() {},
      async placeMarketOrder() {
        return { orderId: 10, symbol: 'SOLUSDT', status: 'FILLED', avgPrice: '100', executedQty: '25', origQty: '25' };
      },
      async getDemoMarkPrice() {
        return 100;
      },
      async placeStopLossOrder() {
        throw new Error('SL rejected');
      },
      async closePositionMarket() {
        emergencyClosed = true;
        return { orderId: 11, symbol: 'SOLUSDT', status: 'FILLED', avgPrice: '100', executedQty: '25', origQty: '25' };
      },
    } as unknown as BinanceFuturesClient;

    const executor = new TradeExecutor(fakeBinance, db);
    const res = await executor.executeSignal(sig.id);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('emergency-closed');
    expect(emergencyClosed).toBe(true);
    expect(db.getSignalById(sig.id)?.status).toBe('FAILED');
    expect(db.getOpenTrades()).toHaveLength(0);
    db.close();
  });

  test('scales risk down during drawdown when dynamicRiskEnabled is true', async () => {
    const db = new AppDatabase(':memory:', {
      minVolumeUsd: 5_000_000,
      topN: 10,
      emaPeriod: 21,
      riskPct: 2,
      rrRatio: 6,
      leverage: 8,
      maxOpenPositions: 4,
      autoTrade: true,
      dailyMaxLossPct: 6,
      maxConsecutiveLosses: 3,
      lossCooldownMinutes: 90,
      symbolCooldownMinutes: 180,
      breakEvenAtR: 1.5,
      minSlPct: 1,
      maxNotionalEquityMult: 5,
      min24hChangePct: 5,
      max24hChangePct: 25,
      partialTpAtR: 2,
      partialTpPct: 50,
      trailingAtrMult: 2,
      minAdx: 20,
      btcRegimeFilter: true,
      dynamicRiskEnabled: true,
    });
    db.setSetting('peak_equity_usd', '5000');

    const sig = db.insertSignalIfNew({
      symbol: 'SOLUSDT',
      side: 'LONG',
      pattern: 'BULLISH_PULLBACK',
      candleOpenTime: 1_700_000_000_000,
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 112,
      ema21: 99,
      volumeRatio: 1.5,
      bodyRatio: 0.75,
    })!;

    const fakeBinance = {
      async getDemoExchangeInfo() {
        return new Map([['SOLUSDT', makeFilter()]]);
      },
      async getUsdtBalance() {
        // 16% drawdown from 5000 -> dynamic risk cuts 2% -> 1% ($42)
        return { balance: 4200, availableBalance: 4200, crossUnPnl: 0 };
      },
      async getOpenPositions() {
        return [];
      },
      async setMarginType() {},
      async setLeverage() {},
      async placeMarketOrder() {
        return { orderId: 10, symbol: 'SOLUSDT', status: 'FILLED', avgPrice: '100', executedQty: '21', origQty: '21' };
      },
      async placeStopLossOrder() {
        return { algoId: 201, symbol: 'SOLUSDT' };
      },
      async placeTakeProfitOrder() {
        return { algoId: 202, symbol: 'SOLUSDT' };
      },
    } as unknown as BinanceFuturesClient;

    const executor = new TradeExecutor(fakeBinance, db);
    const res = await executor.executeSignal(sig.id);

    expect(res.ok).toBe(true);
    expect(res.trade?.riskUsd).toBeCloseTo(42, 4);
    expect(res.trade?.quantity).toBe(21);
    db.close();
  });
});
