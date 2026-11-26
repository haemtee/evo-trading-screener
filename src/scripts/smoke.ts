import { BinanceFuturesClient } from '../binance/client.ts';
import { loadConfig } from '../config.ts';
import { detectMomentumSignal, isHtfTrendAligned } from '../strategy/detector.ts';
import { filterWatchlist } from '../strategy/screener.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new BinanceFuturesClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    tradeUrl: config.binanceTradeUrl,
    marketDataUrl: config.binanceMarketDataUrl,
  });

  console.log(`Fetching Demo ExchangeInfo from ${config.binanceTradeUrl}...`);
  const filters = await client.getDemoExchangeInfo();
  console.log(`Tradable Demo USDT Perpetual symbols: ${filters.size}`);

  console.log(`Fetching 24h Tickers from ${config.binanceMarketDataUrl}...`);
  const tickers = await client.get24hTickers();

  const { gainers, losers } = filterWatchlist(
    tickers,
    new Set(filters.keys()),
    config.defaults.minVolumeUsd,
    config.defaults.topN,
    Date.now(),
    {
      minChangePct: config.defaults.min24hChangePct,
      maxChangePct: config.defaults.max24hChangePct,
    },
  );

  console.log('\n=== TOP GAINERS (24h Vol > $5M) ===');
  for (const g of gainers) {
    console.log(
      `${g.symbol.padEnd(14)} +${g.priceChangePct.toFixed(2)}% | Vol $${(g.quoteVolume / 1e6).toFixed(2)}M | Price ${g.lastPrice}`,
    );
  }

  console.log('\n=== TOP LOSERS (24h Vol > $5M) ===');
  for (const l of losers) {
    console.log(
      `${l.symbol.padEnd(14)} ${l.priceChangePct.toFixed(2)}% | Vol $${(l.quoteVolume / 1e6).toFixed(2)}M | Price ${l.lastPrice}`,
    );
  }

  console.log('\nScanning 15m closed candles for momentum signals...');
  const watchlist = [...gainers, ...losers];
  let signalsFound = 0;

  for (const item of watchlist) {
    const candles = await client.getKlines(item.symbol, '15m', 60);
    if (candles.length < 31) continue;
    const closed = candles.slice(0, -1);
    const sig = detectMomentumSignal(closed, item.side, {
      symbol: item.symbol,
      emaPeriod: config.defaults.emaPeriod,
      rrRatio: config.defaults.rrRatio,
      minSlPct: config.defaults.minSlPct / 100,
    });
    if (sig) {
      const htfCandles = await client.getKlines(item.symbol, '1h', 30);
      const closed1h = htfCandles.length > 1 ? htfCandles.slice(0, -1) : htfCandles;
      if (!isHtfTrendAligned(closed1h, item.side, config.defaults.emaPeriod)) continue;
      signalsFound++;
      console.log(
        `[SIGNAL] ${sig.symbol} ${sig.side} ${sig.pattern} | Entry=${sig.entryPrice} SL=${sig.stopLoss.toFixed(6)} TP=${sig.takeProfit.toFixed(6)} Vol=${sig.volumeRatio.toFixed(2)}x`,
      );
    }
  }

  console.log(`\nSmoke check complete. Evaluated ${watchlist.length} symbols, signals found: ${signalsFound}.`);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
