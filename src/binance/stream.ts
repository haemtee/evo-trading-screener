import type { Candle } from '../types.ts';

export interface ParsedKlineEvent {
  symbol: string;
  isClosed: boolean;
  candle: Candle;
}

export interface StreamStatus {
  connected: boolean;
  watchedCount: number;
  watchedSymbols: string[];
  lastEventAt: number | null;
}

interface RawKlinePayload {
  stream?: string;
  data?: {
    e?: string;
    s?: string;
    k?: {
      t: number;
      T: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
      q: string;
      x: boolean;
    };
  };
}

/**
 * Parses a Binance Futures combined stream `@kline_*` message.
 * Returns null for non-kline or malformed payloads.
 */
export function parseKlineStreamMessage(raw: string): ParsedKlineEvent | null {
  try {
    const parsed = JSON.parse(raw) as RawKlinePayload;
    const data = parsed.data;
    if (!data || data.e !== 'kline' || !data.s || !data.k) {
      return null;
    }

    const k = data.k;
    const candle: Candle = {
      openTime: Number(k.t),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      closeTime: Number(k.T),
      quoteVolume: Number(k.q),
    };

    if (
      !Number.isFinite(candle.openTime) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.close)
    ) {
      return null;
    }

    return {
      symbol: data.s.toUpperCase(),
      isClosed: Boolean(k.x),
      candle,
    };
  } catch {
    return null;
  }
}

export interface KlineStreamOptions {
  wsBaseUrl: string;
  interval?: string;
  onClosedCandle: (symbol: string, candle: Candle) => void | Promise<void>;
}

/**
 * Manages a single combined Binance Futures WebSocket connection watching `@kline_15m`
 * for all currently screened watchlist symbols.
 */
export class KlineStreamManager {
  private readonly wsBaseUrl: string;
  private readonly interval: string;
  private readonly onClosedCandle: (symbol: string, candle: Candle) => void | Promise<void>;

  private ws: WebSocket | null = null;
  private watchedSymbols: string[] = [];
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventAt: number | null = null;

  constructor(options: KlineStreamOptions) {
    this.wsBaseUrl = options.wsBaseUrl.replace(/\/+$/, '');
    this.interval = options.interval ?? '15m';
    this.onClosedCandle = options.onClosedCandle;
  }

  updateSymbols(symbols: string[]): void {
    const normalized = [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
    const isSame =
      normalized.length === this.watchedSymbols.length &&
      normalized.every((s, i) => s === this.watchedSymbols[i]);

    const isAlive =
      this.ws !== null &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);

    if (isSame && isAlive) {
      return;
    }

    this.watchedSymbols = normalized;
    this.stopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  getStatus(): StreamStatus {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      watchedCount: this.watchedSymbols.length,
      watchedSymbols: [...this.watchedSymbols],
      lastEventAt: this.lastEventAt,
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    if (this.stopped || this.watchedSymbols.length === 0) {
      return;
    }

    const streams = this.watchedSymbols.map((s) => `${s.toLowerCase()}@kline_${this.interval}`);
    const url = `${this.wsBaseUrl}/stream?streams=${streams.join('/')}`;
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      console.log(`[Stream] Connected to ${this.watchedSymbols.length} ${this.interval} streams`);
    };

    socket.onmessage = (event) => {
      this.lastEventAt = Date.now();
      const parsed = parseKlineStreamMessage(String(event.data));
      if (!parsed || !parsed.isClosed) return;

      Promise.resolve(this.onClosedCandle(parsed.symbol, parsed.candle)).catch((err) => {
        console.error(`[Stream] Error handling closed candle for ${parsed.symbol}:`, err);
      });
    };

    socket.onerror = () => {
      // onclose will trigger reconnect
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      if (!this.stopped && this.watchedSymbols.length > 0) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    console.warn(`[Stream] Disconnected. Reconnecting in ${delayMs}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}
