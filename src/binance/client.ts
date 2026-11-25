import { createHmac } from 'node:crypto';
import type { Candle, SymbolFilter, Ticker24h } from '../types.ts';

export interface BinanceClientConfig {
  apiKey: string;
  apiSecret: string;
  tradeUrl: string;
  marketDataUrl: string;
}

export interface UsdtBalance {
  balance: number;
  availableBalance: number;
  crossUnPnl: number;
}

export interface OpenPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  leverage: number;
  marginType: string;
}

export interface OrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  avgPrice: string;
  executedQty: string;
  origQty: string;
  stopPrice?: string;
}

export interface AlgoOrderResponse {
  algoId: number;
  clientAlgoId?: string;
  algoType?: string;
  orderType?: string;
  symbol: string;
  algoStatus?: string;
  triggerPrice?: string;
}

export class BinanceApiError extends Error {
  readonly code: number;
  readonly status: number;

  constructor(message: string, code: number, status: number) {
    super(message);
    this.name = 'BinanceApiError';
    this.code = code;
    this.status = status;
  }
}

export class BinanceFuturesClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly tradeUrl: string;
  private readonly marketDataUrl: string;

  private exchangeInfoCache: {
    expiresAt: number;
    filters: Map<string, SymbolFilter>;
  } | null = null;

  constructor(config: BinanceClientConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.tradeUrl = config.tradeUrl.replace(/\/+$/, '');
    this.marketDataUrl = config.marketDataUrl.replace(/\/+$/, '');
  }

  private signQuery(params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) {
        search.set(k, String(v));
      }
    }
    search.set('timestamp', String(Date.now()));
    search.set('recvWindow', '5000');

    const queryString = search.toString();
    const signature = createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
    return `${queryString}&signature=${signature}`;
  }

  private async publicGet<T>(baseUrl: string, path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw this.parseError(text, res.status);
    }
    return JSON.parse(text) as T;
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for signed requests');
    }

    const signedQuery = this.signQuery(params);
    const url = `${this.tradeUrl}${path}?${signedQuery}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw this.parseError(text, res.status);
    }
    return JSON.parse(text) as T;
  }

  private parseError(body: string, status: number): BinanceApiError {
    try {
      const parsed = JSON.parse(body) as { code?: number; msg?: string };
      return new BinanceApiError(
        parsed.msg ?? `Binance HTTP ${status}`,
        parsed.code ?? -1,
        status,
      );
    } catch {
      return new BinanceApiError(`Binance HTTP ${status}: ${body.slice(0, 200)}`, -1, status);
    }
  }

  async getDemoExchangeInfo(forceRefresh = false): Promise<Map<string, SymbolFilter>> {
    const now = Date.now();
    if (!forceRefresh && this.exchangeInfoCache && this.exchangeInfoCache.expiresAt > now) {
      return this.exchangeInfoCache.filters;
    }

    const data = await this.publicGet<{
      symbols: Array<{
        symbol: string;
        contractType: string;
        status: string;
        quoteAsset: string;
        pricePrecision: number;
        quantityPrecision: number;
        filters: Array<{
          filterType: string;
          tickSize?: string;
          stepSize?: string;
          minQty?: string;
          notional?: string;
        }>;
      }>;
    }>(this.tradeUrl, '/fapi/v1/exchangeInfo');

    const map = new Map<string, SymbolFilter>();
    for (const s of data.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING' || s.quoteAsset !== 'USDT') {
        continue;
      }
      let tickSize = 0.0001;
      let stepSize = 0.001;
      let minQty = 0.001;
      let minNotional = 5;

      for (const f of s.filters) {
        if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
          tickSize = Number(f.tickSize);
        } else if (f.filterType === 'LOT_SIZE') {
          if (f.stepSize) stepSize = Number(f.stepSize);
          if (f.minQty) minQty = Number(f.minQty);
        } else if (f.filterType === 'MIN_NOTIONAL' && f.notional) {
          minNotional = Number(f.notional);
        }
      }

      map.set(s.symbol, {
        symbol: s.symbol,
        tickSize,
        stepSize,
        minQty,
        minNotional,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      });
    }

    this.exchangeInfoCache = {
      expiresAt: now + 30 * 60 * 1000,
      filters: map,
    };

    return map;
  }

  async get24hTickers(): Promise<Ticker24h[]> {
    const raw = await this.publicGet<
      Array<{
        symbol: string;
        priceChangePercent: string;
        lastPrice: string;
        quoteVolume: string;
      }>
    >(this.marketDataUrl, '/fapi/v1/ticker/24hr');

    return raw.map((t) => ({
      symbol: t.symbol,
      priceChangePercent: Number(t.priceChangePercent),
      lastPrice: Number(t.lastPrice),
      quoteVolume: Number(t.quoteVolume),
    }));
  }

  async getKlines(symbol: string, interval = '15m', limit = 60): Promise<Candle[]> {
    const raw = await this.publicGet<
      Array<[number, string, string, string, string, string, number, string, ...unknown[]]>
    >(
      this.marketDataUrl,
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    );

    return raw.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
      quoteVolume: Number(k[7]),
    }));
  }

  async getDemoMarkPrice(symbol: string): Promise<number> {
    const data = await this.publicGet<{ markPrice: string }>(
      this.tradeUrl,
      `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
    );
    return Number(data.markPrice);
  }

  async getUsdtBalance(): Promise<UsdtBalance> {
    const list = await this.signedRequest<
      Array<{
        asset: string;
        balance: string;
        availableBalance: string;
        crossUnPnl: string;
      }>
    >('GET', '/fapi/v2/balance');

    const usdt = list.find((a) => a.asset === 'USDT');
    if (!usdt) {
      return { balance: 0, availableBalance: 0, crossUnPnl: 0 };
    }
    return {
      balance: Number(usdt.balance),
      availableBalance: Number(usdt.availableBalance),
      crossUnPnl: Number(usdt.crossUnPnl),
    };
  }

  async getOpenPositions(): Promise<OpenPosition[]> {
    const raw = await this.signedRequest<
      Array<{
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        leverage: string;
        marginType: string;
      }>
    >('GET', '/fapi/v2/positionRisk');

    return raw
      .map((p) => ({
        symbol: p.symbol,
        positionAmt: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unRealizedProfit: Number(p.unRealizedProfit),
        leverage: Number(p.leverage),
        marginType: p.marginType,
      }))
      .filter((p) => Math.abs(p.positionAmt) > 0);
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType });
    } catch (err) {
      // -4046: "No need to change margin type."
      if (err instanceof BinanceApiError && err.code === -4046) {
        return;
      }
      throw err;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    reduceOnly = false,
  ): Promise<OrderResponse> {
    return this.signedRequest<OrderResponse>('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      ...(reduceOnly ? { reduceOnly: 'true' } : {}),
    });
  }

  async placeStopLossOrder(
    symbol: string,
    closeSide: 'BUY' | 'SELL',
    triggerPrice: string,
  ): Promise<AlgoOrderResponse> {
    return this.signedRequest<AlgoOrderResponse>('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol,
      side: closeSide,
      type: 'STOP_MARKET',
      triggerPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
  }

  async placeTakeProfitOrder(
    symbol: string,
    closeSide: 'BUY' | 'SELL',
    triggerPrice: string,
  ): Promise<AlgoOrderResponse> {
    return this.signedRequest<AlgoOrderResponse>('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol,
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    const results = await Promise.allSettled([
      this.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }),
      this.signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }),
    ]);
    const allFailed = results.every((r) => r.status === 'rejected');
    if (allFailed && results[0]?.status === 'rejected') {
      throw results[0].reason;
    }
  }

  async closePositionMarket(symbol: string, positionAmt: number, stepSizeStr: string): Promise<OrderResponse> {
    const closeSide: 'BUY' | 'SELL' = positionAmt > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(positionAmt);
    const decimals = stepSizeStr.includes('.') ? stepSizeStr.split('.')[1]!.length : 0;
    const formattedQty = qty.toFixed(decimals);
    const res = await this.placeMarketOrder(symbol, closeSide, formattedQty, true);
    try {
      await this.cancelAllOpenOrders(symbol);
    } catch {
      // Ignore if no open orders exist
    }
    return res;
  }
}
