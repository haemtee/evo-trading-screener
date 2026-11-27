import {
  BASELINE_BACKTEST_CONFIG,
  GROWTH_10X_BACKTEST_CONFIG,
  runBacktest,
  type BacktestDataset,
  type BacktestResult,
} from '../backtest/engine.ts';
import type { Candle } from '../types.ts';

const DEFAULT_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'SUIUSDT',
  'AVAXUSDT',
  'LINKUSDT',
];

async function fetchKlinesFromUrls(
  urls: string[],
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  for (const base of urls) {
    try {
      const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const raw = (await res.json()) as Array<
        [number, string, string, string, string, string, number, string, ...unknown[]]
      >;
      if (!Array.isArray(raw) || raw.length === 0) continue;
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
    } catch {
      // Try next URL
    }
  }
  throw new Error(`Unable to fetch ${symbol} ${interval} klines from Binance endpoints`);
}

function buildSyntheticDataset(): BacktestDataset {
  const symbols: BacktestDataset['symbols'] = {};
  const total15m = 800;
  const btc1h: Candle[] = [];

  for (let h = 0; h < total15m / 4; h++) {
    const base = 60000 + Math.sin(h / 25) * 2500 + h * 15;
    btc1h.push({
      openTime: h * 3_600_000,
      open: base,
      high: base + 180,
      low: base - 120,
      close: base + 80,
      volume: 5000,
      closeTime: (h + 1) * 3_600_000 - 1,
      quoteVolume: 300_000_000,
    });
  }

  for (const sym of ['SOLUSDT', 'ETHUSDT', 'AVAXUSDT']) {
    const candles15m: Candle[] = [];
    const candles1h: Candle[] = [];
    let price = 100;
    for (let i = 0; i < total15m; i++) {
      const phase = i % 24;
      const isBreakout = phase === 10 || phase === 18;
      const isPullback = phase === 9 || phase === 17;
      const open = price;
      const delta = isBreakout ? 2.1 : isPullback ? -0.9 : i % 2 === 0 ? 0.35 : -0.15;
      const close = Math.max(10, open + delta);
      const high = isBreakout ? close + 0.05 : Math.max(open, close) + 0.25;
      const low = isBreakout ? open - 0.05 : Math.min(open, close) - 0.25;
      candles15m.push({
        openTime: i * 900_000,
        open,
        high,
        low,
        close,
        volume: isBreakout ? 3500 : 1000,
        closeTime: (i + 1) * 900_000 - 1,
        quoteVolume: isBreakout ? 350_000 : 100_000,
      });
      price = close;
    }

    for (let h = 0; h < total15m / 4; h++) {
      const slice = candles15m.slice(h * 4, h * 4 + 4);
      candles1h.push({
        openTime: slice[0]!.openTime,
        open: slice[0]!.open,
        high: Math.max(...slice.map((c) => c.high)),
        low: Math.min(...slice.map((c) => c.low)),
        close: slice[slice.length - 1]!.close,
        volume: slice.reduce((s, c) => s + c.volume, 0),
        closeTime: slice[slice.length - 1]!.closeTime,
        quoteVolume: slice.reduce((s, c) => s + c.quoteVolume, 0),
      });
    }
    symbols[sym] = { candles15m, candles1h };
  }

  return { symbols, btc1h };
}

function formatResult(r: BacktestResult): string {
  const targetStr = r.tradesTo10xEstimate !== null ? `${r.tradesTo10xEstimate} trades` : 'N/A (<=0%)';
  return [
    `=== ${r.name} ===`,
    `Initial Equity : $${r.initialEquity.toFixed(2)}`,
    `Final Equity   : $${r.finalEquity.toFixed(2)} (${r.netReturnPct >= 0 ? '+' : ''}${r.netReturnPct.toFixed(2)}%)`,
    `Max Drawdown   : ${r.maxDrawdownPct.toFixed(2)}%`,
    `Trades         : ${r.totalTrades} (Wins: ${r.wins}, Losses: ${r.losses}, WinRate: ${r.winRatePct.toFixed(1)}%)`,
    `Profit Factor  : ${r.profitFactor.toFixed(2)}`,
    `Expectancy / R : ${r.expectancyR >= 0 ? '+' : ''}${r.expectancyR.toFixed(3)}R (Avg Win: +${r.avgWinR.toFixed(2)}R | Avg Loss: ${r.avgLossR.toFixed(2)}R)`,
    `Est. to 10x    : ${targetStr}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const useSynthetic = process.argv.includes('--synthetic');
  const candidateUrls = [
    process.env.BINANCE_MARKET_DATA_URL,
    'https://fapi.binance.com',
    'https://testnet.binancefuture.com',
  ]
    .filter((u): u is string => Boolean(u && u.trim()))
    .map((u) => u.replace(/\/+$/, ''));

  let dataset: BacktestDataset;
  let sourceLabel = 'Synthetic';

  if (useSynthetic) {
    dataset = buildSyntheticDataset();
  } else {
    try {
      const btc1h = await fetchKlinesFromUrls(candidateUrls, 'BTCUSDT', '1h', 500);
      const symbols: BacktestDataset['symbols'] = {};
      for (const sym of DEFAULT_SYMBOLS) {
        const [c15m, c1h] = await Promise.all([
          fetchKlinesFromUrls(candidateUrls, sym, '15m', 1500),
          fetchKlinesFromUrls(candidateUrls, sym, '1h', 500),
        ]);
        symbols[sym] = { candles15m: c15m, candles1h: c1h };
      }
      dataset = { symbols, btc1h };
      sourceLabel = `Binance Futures Live Historical (${DEFAULT_SYMBOLS.length} pairs, 1500x 15m bars)`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Backtest] Live klines unavailable (${msg}). Falling back to synthetic dataset.`);
      dataset = buildSyntheticDataset();
    }
  }

  console.log(`\nBacktest Data Source: ${sourceLabel}\n`);
  const baseline = runBacktest(dataset, BASELINE_BACKTEST_CONFIG);
  const growth = runBacktest(dataset, GROWTH_10X_BACKTEST_CONFIG);

  console.log(formatResult(baseline));
  console.log('');
  console.log(formatResult(growth));
}

main().catch((err) => {
  console.error('[Backtest] Fatal error:', err);
  process.exit(1);
});
