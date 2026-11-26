import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BotSettings,
  DetectedSignal,
  NewTradeInput,
  PatternType,
  Side,
  SignalRecord,
  SignalStatus,
  TradeRecord,
  TradeStatus,
  WatchlistItem,
} from '../types.ts';

export interface DefaultSettingsInput {
  minVolumeUsd: number;
  topN: number;
  emaPeriod: number;
  riskPct: number;
  rrRatio: number;
  leverage: number;
  maxOpenPositions: number;
  autoTrade: boolean;
}

const DEFAULT_FALLBACK: DefaultSettingsInput = {
  minVolumeUsd: 5_000_000,
  topN: 10,
  emaPeriod: 21,
  riskPct: 1,
  rrRatio: 2,
  leverage: 5,
  maxOpenPositions: 3,
  autoTrade: false,
};

export class AppDatabase {
  private readonly db: Database;
  private readonly defaults: DefaultSettingsInput;

  constructor(dbPath: string, defaults: DefaultSettingsInput = DEFAULT_FALLBACK) {
    this.defaults = defaults;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watchlist_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        price_change_pct REAL NOT NULL,
        quote_volume REAL NOT NULL,
        last_price REAL NOT NULL,
        scanned_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        pattern TEXT NOT NULL,
        candle_open_time INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        ema21 REAL NOT NULL,
        volume_ratio REAL NOT NULL,
        body_ratio REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at INTEGER NOT NULL,
        UNIQUE(symbol, side, candle_open_time)
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER REFERENCES signals(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        risk_usd REAL NOT NULL,
        leverage INTEGER NOT NULL,
        entry_order_id TEXT,
        sl_order_id TEXT,
        tp_order_id TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        pnl_usd REAL,
        close_price REAL,
        fee_usd REAL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_watchlist_scanned_at ON watchlist_snapshots(scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    `);

    const cols = this.db.prepare('PRAGMA table_info(trades)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('close_price')) {
      this.db.exec('ALTER TABLE trades ADD COLUMN close_price REAL;');
    }
    if (!colNames.has('fee_usd')) {
      this.db.exec('ALTER TABLE trades ADD COLUMN fee_usd REAL;');
    }

    const seedPairs: Array<[string, string]> = [
      ['scanner_enabled', 'true'],
      ['auto_trade', String(this.defaults.autoTrade)],
      ['risk_pct', String(this.defaults.riskPct)],
      ['rr_ratio', String(this.defaults.rrRatio)],
      ['leverage', String(this.defaults.leverage)],
      ['max_open_positions', String(this.defaults.maxOpenPositions)],
      ['min_volume_usd', String(this.defaults.minVolumeUsd)],
      ['top_n', String(this.defaults.topN)],
      ['ema_period', String(this.defaults.emaPeriod)],
    ];

    const stmt = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of seedPairs) {
      stmt.run(k, v);
    }
  }

  close(): void {
    this.db.close();
  }

  getSettings(): BotSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const num = (key: string, fallback: number): number => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const bool = (key: string, fallback: boolean): boolean => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      return raw === 'true' || raw === '1';
    };

    return {
      scannerEnabled: bool('scanner_enabled', true),
      autoTrade: bool('auto_trade', this.defaults.autoTrade),
      riskPct: num('risk_pct', this.defaults.riskPct),
      rrRatio: num('rr_ratio', this.defaults.rrRatio),
      leverage: num('leverage', this.defaults.leverage),
      maxOpenPositions: num('max_open_positions', this.defaults.maxOpenPositions),
      minVolumeUsd: num('min_volume_usd', this.defaults.minVolumeUsd),
      topN: num('top_n', this.defaults.topN),
      emaPeriod: num('ema_period', this.defaults.emaPeriod),
    };
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  saveWatchlist(items: WatchlistItem[]): void {
    if (items.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO watchlist_snapshots (symbol, side, price_change_pct, quote_volume, last_price, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((rows: WatchlistItem[]) => {
      for (const item of rows) {
        insert.run(
          item.symbol,
          item.side,
          item.priceChangePct,
          item.quoteVolume,
          item.lastPrice,
          item.scannedAt,
        );
      }
    });
    tx(items);
  }

  getLatestWatchlist(): WatchlistItem[] {
    const latest = this.db
      .prepare('SELECT MAX(scanned_at) AS ts FROM watchlist_snapshots')
      .get() as { ts: number | null } | null;

    if (!latest || latest.ts === null) return [];

    const rows = this.db
      .prepare(
        `SELECT symbol, side, price_change_pct, quote_volume, last_price, scanned_at
         FROM watchlist_snapshots
         WHERE scanned_at = ?
         ORDER BY side ASC, ABS(price_change_pct) DESC`,
      )
      .all(latest.ts) as Array<{
      symbol: string;
      side: string;
      price_change_pct: number;
      quote_volume: number;
      last_price: number;
      scanned_at: number;
    }>;

    return rows.map((r) => ({
      symbol: r.symbol,
      side: r.side as Side,
      priceChangePct: r.price_change_pct,
      quoteVolume: r.quote_volume,
      lastPrice: r.last_price,
      scannedAt: r.scanned_at,
    }));
  }

  insertSignalIfNew(signal: DetectedSignal, now = Date.now()): SignalRecord | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO signals (
          symbol, side, pattern, candle_open_time, entry_price, stop_loss, take_profit,
          ema21, volume_ratio, body_ratio, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      )
      .run(
        signal.symbol,
        signal.side,
        signal.pattern,
        signal.candleOpenTime,
        signal.entryPrice,
        signal.stopLoss,
        signal.takeProfit,
        signal.ema21,
        signal.volumeRatio,
        signal.bodyRatio,
        now,
      );

    if (info.changes === 0) return null;
    const id = Number(info.lastInsertRowid);
    return this.getSignalById(id);
  }

  getSignalById(id: number): SignalRecord | null {
    const row = this.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as
      | RawSignalRow
      | null;
    return row ? mapSignalRow(row) : null;
  }

  updateSignalStatus(id: number, status: SignalStatus): void {
    this.db.prepare('UPDATE signals SET status = ? WHERE id = ?').run(status, id);
  }

  getRecentSignals(limit = 10): SignalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM signals ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as RawSignalRow[];
    return rows.map(mapSignalRow);
  }

  createTrade(input: NewTradeInput): TradeRecord {
    const openedAt = input.openedAt ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO trades (
          signal_id, symbol, side, quantity, entry_price, stop_loss, take_profit,
          risk_usd, leverage, entry_order_id, sl_order_id, tp_order_id, status, opened_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      )
      .run(
        input.signalId,
        input.symbol,
        input.side,
        input.quantity,
        input.entryPrice,
        input.stopLoss,
        input.takeProfit,
        input.riskUsd,
        input.leverage,
        input.entryOrderId,
        input.slOrderId,
        input.tpOrderId,
        openedAt,
      );

    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as RawTradeRow;
    return mapTradeRow(row);
  }

  getOpenTrades(): TradeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY opened_at DESC")
      .all() as RawTradeRow[];
    return rows.map(mapTradeRow);
  }

  closeTrade(
    id: number,
    pnlUsd: number | null,
    closedAt = Date.now(),
    closePrice: number | null = null,
    feeUsd: number | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE trades SET status = 'CLOSED', pnl_usd = ?, close_price = ?, fee_usd = ?, closed_at = ? WHERE id = ?",
      )
      .run(pnlUsd, closePrice, feeUsd, closedAt, id);
  }

  getRecentTrades(limit = 10): TradeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM trades ORDER BY opened_at DESC, id DESC LIMIT ?')
      .all(limit) as RawTradeRow[];
    return rows.map(mapTradeRow);
  }
}

interface RawSignalRow {
  id: number;
  symbol: string;
  side: string;
  pattern: string;
  candle_open_time: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  ema21: number;
  volume_ratio: number;
  body_ratio: number;
  status: string;
  created_at: number;
}

interface RawTradeRow {
  id: number;
  signal_id: number | null;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  risk_usd: number;
  leverage: number;
  entry_order_id: string | null;
  sl_order_id: string | null;
  tp_order_id: string | null;
  status: string;
  pnl_usd: number | null;
  close_price: number | null;
  fee_usd: number | null;
  opened_at: number;
  closed_at: number | null;
}

function mapSignalRow(r: RawSignalRow): SignalRecord {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as Side,
    pattern: r.pattern as PatternType,
    candleOpenTime: r.candle_open_time,
    entryPrice: r.entry_price,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    ema21: r.ema21,
    volumeRatio: r.volume_ratio,
    bodyRatio: r.body_ratio,
    status: r.status as SignalStatus,
    createdAt: r.created_at,
  };
}

function mapTradeRow(r: RawTradeRow): TradeRecord {
  return {
    id: r.id,
    signalId: r.signal_id,
    symbol: r.symbol,
    side: r.side as Side,
    quantity: r.quantity,
    entryPrice: r.entry_price,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    riskUsd: r.risk_usd,
    leverage: r.leverage,
    entryOrderId: r.entry_order_id,
    slOrderId: r.sl_order_id,
    tpOrderId: r.tp_order_id,
    status: r.status as TradeStatus,
    pnlUsd: r.pnl_usd,
    closePrice: r.close_price ?? null,
    feeUsd: r.fee_usd ?? null,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}
