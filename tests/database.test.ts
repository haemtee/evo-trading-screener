import { describe, expect, test } from 'bun:test';
import { AppDatabase } from '../src/db/database.ts';

describe('AppDatabase', () => {
  test('initializes default settings and updates them', () => {
    const db = new AppDatabase(':memory:');
    const initial = db.getSettings();
    expect(initial.riskPct).toBe(1);
    expect(initial.rrRatio).toBe(2);
    expect(initial.minVolumeUsd).toBe(5_000_000);

    db.setSetting('risk_pct', '2.5');
    db.setSetting('auto_trade', 'true');
    const updated = db.getSettings();
    expect(updated.riskPct).toBe(2.5);
    expect(updated.autoTrade).toBe(true);
    db.close();
  });

  test('deduplicates signals by (symbol, side, candleOpenTime)', () => {
    const db = new AppDatabase(':memory:');
    const sig = {
      symbol: 'BTCUSDT',
      side: 'LONG' as const,
      pattern: 'BULLISH_ENGULFING' as const,
      candleOpenTime: 1_700_000_000_000,
      entryPrice: 90000,
      stopLoss: 89000,
      takeProfit: 92000,
      ema21: 89500,
      volumeRatio: 1.8,
      bodyRatio: 0.8,
    };

    const first = db.insertSignalIfNew(sig);
    const second = db.insertSignalIfNew(sig);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(db.getRecentSignals(10)).toHaveLength(1);
    db.close();
  });

  test('tracks trade open and close lifecycle', () => {
    const db = new AppDatabase(':memory:');
    const trade = db.createTrade({
      signalId: null,
      symbol: 'ETHUSDT',
      side: 'SHORT',
      quantity: 0.5,
      entryPrice: 3000,
      stopLoss: 3050,
      takeProfit: 2900,
      riskUsd: 25,
      leverage: 5,
      entryOrderId: '101',
      slOrderId: '102',
      tpOrderId: '103',
    });

    expect(db.getOpenTrades()).toHaveLength(1);
    db.closeTrade(trade.id, 50, 1_700_001_000_000, 2900, 1.25);
    expect(db.getOpenTrades()).toHaveLength(0);
    const recent = db.getRecentTrades(5);
    expect(recent[0]?.status).toBe('CLOSED');
    expect(recent[0]?.pnlUsd).toBe(50);
    expect(recent[0]?.closePrice).toBe(2900);
    expect(recent[0]?.feeUsd).toBe(1.25);

    const lossTrade = db.createTrade({
      signalId: null,
      symbol: 'SOLUSDT',
      side: 'LONG',
      quantity: 1,
      entryPrice: 150,
      stopLoss: 145,
      takeProfit: 160,
      riskUsd: 5,
      leverage: 5,
      entryOrderId: '201',
      slOrderId: '202',
      tpOrderId: '203',
    });
    db.markTradeBreakEven(lossTrade.id, 150.2, '204');
    expect(db.getOpenTrades()[0]?.beMoved).toBe(true);
    expect(db.getOpenTrades()[0]?.stopLoss).toBe(150.2);

    db.closeTrade(lossTrade.id, -5, 1_700_002_000_000, 145, 0.5);
    expect(db.getDailyNetPnl(1_700_000_000_000)).toBeCloseTo(50 - 1.25 - 5 - 0.5, 6);
    expect(db.getLastClosedLossForSymbol('SOLUSDT')?.id).toBe(lossTrade.id);
    db.close();
  });
});
