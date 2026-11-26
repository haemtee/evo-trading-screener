import { BinanceFuturesClient } from './binance/client.ts';
import { loadConfig, validateBotConfig } from './config.ts';
import { AppDatabase } from './db/database.ts';
import { TradeExecutor } from './services/executor.ts';
import { MarketScanner } from './services/scanner.ts';
import { createTelegramBot } from './telegram/bot.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  validateBotConfig(config);

  const db = new AppDatabase(config.dbPath, config.defaults);
  const binance = new BinanceFuturesClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    tradeUrl: config.binanceTradeUrl,
    marketDataUrl: config.binanceMarketDataUrl,
  });

  const executor = new TradeExecutor(binance, db);
  const tg = createTelegramBot({
    token: config.telegramBotToken,
    adminChatId: config.adminChatId!,
    db,
    binance,
    executor,
  });

  const scanner = new MarketScanner(
    binance,
    db,
    {
      onSignal: tg.notifySignal,
      onTradeClosed: tg.notifyTradeClosed,
      onBreakEvenMoved: tg.notifyBreakEvenMoved,
    },
    {
      wsBaseUrl: config.binanceWsUrl,
      watchlistRefreshMinutes: config.watchlistRefreshMinutes,
    },
  );
  tg.attachScanner(scanner);

  const shutdown = () => {
    console.log('\n[Bot] Shutting down...');
    scanner.stopScheduler();
    tg.bot.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await tg.registerAdminCommands();
    console.log(`[Bot] Registered Telegram command menu for admin chat ${config.adminChatId}`);
  } catch (err) {
    console.warn('[Bot] Failed to register Telegram command menu:', err);
  }

  scanner.startScheduler();
  console.log('[Bot] Starting Telegram bot & 15m Futures screener...');
  await tg.bot.start();
}

main().catch((err) => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
