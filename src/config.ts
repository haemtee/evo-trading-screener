export interface AppConfig {
  telegramBotToken: string;
  adminChatId: number | null;
  binanceApiKey: string;
  binanceApiSecret: string;
  binanceTradeUrl: string;
  binanceMarketDataUrl: string;
  binanceWsUrl: string;
  watchlistRefreshMinutes: number;
  dbPath: string;
  defaults: {
    minVolumeUsd: number;
    topN: number;
    emaPeriod: number;
    riskPct: number;
    rrRatio: number;
    leverage: number;
    maxOpenPositions: number;
    autoTrade: boolean;
  };
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  const lower = val.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'off') return false;
  return fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const rawAdminId = (env.TELEGRAM_ADMIN_CHAT_ID ?? env.TELEGRAM_CHAT_ID ?? '').trim();
  const parsedAdminId = rawAdminId ? Number(rawAdminId) : Number.NaN;
  const adminChatId = Number.isInteger(parsedAdminId) ? parsedAdminId : null;

  return {
    telegramBotToken: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    adminChatId,
    binanceApiKey: (env.BINANCE_API_KEY ?? '').trim(),
    binanceApiSecret: (env.BINANCE_API_SECRET ?? '').trim(),
    binanceTradeUrl: (env.BINANCE_TRADE_URL ?? 'https://testnet.binancefuture.com').replace(/\/+$/, ''),
    binanceMarketDataUrl: (env.BINANCE_MARKET_DATA_URL ?? 'https://testnet.binancefuture.com').replace(/\/+$/, ''),
    binanceWsUrl: (env.BINANCE_WS_URL ?? 'wss://fstream.binancefuture.com').replace(/\/+$/, ''),
    watchlistRefreshMinutes: parseNumber(env.WATCHLIST_REFRESH_MINUTES, 15),
    dbPath: (env.DB_PATH ?? './data/screener.sqlite').trim(),
    defaults: {
      minVolumeUsd: parseNumber(env.MIN_VOLUME_USD, 5_000_000),
      topN: parseNumber(env.TOP_N, 10),
      emaPeriod: parseNumber(env.EMA_PERIOD, 21),
      riskPct: parseNumber(env.RISK_PCT, 1),
      rrRatio: parseNumber(env.RR_RATIO, 2),
      leverage: parseNumber(env.LEVERAGE, 5),
      maxOpenPositions: parseNumber(env.MAX_OPEN_POSITIONS, 3),
      autoTrade: parseBoolean(env.AUTO_TRADE, false),
    },
  };
}

export function validateBotConfig(config: AppConfig): void {
  const missing: string[] = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (config.adminChatId === null) missing.push('TELEGRAM_ADMIN_CHAT_ID (valid integer)');
  if (!config.binanceApiKey) missing.push('BINANCE_API_KEY');
  if (!config.binanceApiSecret) missing.push('BINANCE_API_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
