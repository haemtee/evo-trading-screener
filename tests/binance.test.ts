import { afterEach, describe, expect, test } from 'bun:test';
import { BinanceFuturesClient } from '../src/binance/client.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createTestClient() {
  return new BinanceFuturesClient({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    tradeUrl: 'https://testnet.binancefuture.com',
    marketDataUrl: 'https://testnet.binancefuture.com',
  });
}

describe('BinanceFuturesClient Algo Order API', () => {
  test('placeStopLossOrder and placeTakeProfitOrder call /fapi/v1/algoOrder with CONDITIONAL params', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({ algoId: 987654, symbol: 'BULLAUSDT', algoStatus: 'NEW' }),
        { status: 200 },
      );
    }) as typeof fetch;

    const client = createTestClient();
    const sl = await client.placeStopLossOrder('BULLAUSDT', 'SELL', '0.02500');
    const tp = await client.placeTakeProfitOrder('BULLAUSDT', 'SELL', '0.02800');

    expect(sl.algoId).toBe(987654);
    expect(tp.algoId).toBe(987654);
    expect(calls).toHaveLength(2);

    const slUrl = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('POST');
    expect(slUrl.pathname).toBe('/fapi/v1/algoOrder');
    expect(slUrl.searchParams.get('algoType')).toBe('CONDITIONAL');
    expect(slUrl.searchParams.get('type')).toBe('STOP_MARKET');
    expect(slUrl.searchParams.get('side')).toBe('SELL');
    expect(slUrl.searchParams.get('triggerPrice')).toBe('0.02500');
    expect(slUrl.searchParams.get('closePosition')).toBe('true');
    expect(slUrl.searchParams.get('workingType')).toBe('MARK_PRICE');
    expect(slUrl.searchParams.get('signature')).toBeTruthy();

    const tpUrl = new URL(calls[1]!.url);
    expect(calls[1]!.method).toBe('POST');
    expect(tpUrl.pathname).toBe('/fapi/v1/algoOrder');
    expect(tpUrl.searchParams.get('algoType')).toBe('CONDITIONAL');
    expect(tpUrl.searchParams.get('type')).toBe('TAKE_PROFIT_MARKET');
    expect(tpUrl.searchParams.get('triggerPrice')).toBe('0.02800');
  });

  test('cancelAllOpenOrders cancels both standard and algo open orders', async () => {
    const calls: Array<{ pathname: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ pathname: new URL(url).pathname, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ code: 200, msg: 'success' }), { status: 200 });
    }) as typeof fetch;

    const client = createTestClient();
    await client.cancelAllOpenOrders('BULLAUSDT');

    expect(calls).toEqual([
      { pathname: '/fapi/v1/allOpenOrders', method: 'DELETE' },
      { pathname: '/fapi/v1/algoOpenOrders', method: 'DELETE' },
    ]);
  });
});
