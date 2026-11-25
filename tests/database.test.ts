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
    db.closeTrade(trade.id, 50);
    expect(db.getOpenTrades()).toHaveLength(0);
    const recent = db.getRecentTrades(5);
    expect(recent[0]?.status).toBe('CLOSED');
    expect(recent[0]?.pnlUsd).toBe(50);
    db.close();
  });
});
