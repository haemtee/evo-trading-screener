import { Bot, InlineKeyboard } from 'grammy';
import type { BinanceFuturesClient } from '../binance/client.ts';
import type { AppDatabase } from '../db/database.ts';
import type { TradeExecutor } from '../services/executor.ts';
import type { MarketScanner } from '../services/scanner.ts';
import type { SignalRecord, WatchlistItem } from '../types.ts';

export interface TelegramBotDeps {
  token: string;
  adminChatId: number;
  db: AppDatabase;
  binance: BinanceFuturesClient;
  executor: TradeExecutor;
}

export function isAdminUpdate(
  chatId: number | undefined,
  fromId: number | undefined,
  adminChatId: number,
): boolean {
  return chatId === adminChatId && fromId === adminChatId;
}

function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

function formatPrice(val: number): string {
  if (val >= 100) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

export function formatWatchlistMessage(gainers: WatchlistItem[], losers: WatchlistItem[]): string {
  const lines: string[] = ['📊 <b>Futures Screener Watchlist (24h Vol &gt; $5M)</b>\n'];

  lines.push('🟢 <b>TOP GAINERS (LONG)</b>');
  if (gainers.length === 0) {
    lines.push('  <i>No eligible gainers</i>');
  } else {
    gainers.forEach((g, idx) => {
      lines.push(
        `  ${idx + 1}. <b>${g.symbol}</b> | +${g.priceChangePct.toFixed(2)}% | Vol ${formatUsd(g.quoteVolume)} | ${formatPrice(g.lastPrice)}`,
      );
    });
  }

  lines.push('\n🔴 <b>TOP LOSERS (SHORT)</b>');
  if (losers.length === 0) {
    lines.push('  <i>No eligible losers</i>');
  } else {
    losers.forEach((l, idx) => {
      lines.push(
        `  ${idx + 1}. <b>${l.symbol}</b> | ${l.priceChangePct.toFixed(2)}% | Vol ${formatUsd(l.quoteVolume)} | ${formatPrice(l.lastPrice)}`,
      );
    });
  }

  return lines.join('\n');
}

export function formatSignalMessage(signal: SignalRecord, riskPct: number, rrRatio: number): string {
  const sideIcon = signal.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const patternLabel = signal.pattern.replace('_', ' ');
  return [
    `🚨 <b>15m Momentum Signal #${signal.id}</b>`,
    ``,
    `Pair: <b>${signal.symbol}</b> (${sideIcon})`,
    `Pattern: <b>${patternLabel}</b>`,
    `Entry: <code>${formatPrice(signal.entryPrice)}</code>`,
    `Stop Loss: <code>${formatPrice(signal.stopLoss)}</code>`,
    `Take Profit (${rrRatio}R): <code>${formatPrice(signal.takeProfit)}</code>`,
    `EMA(21): <code>${formatPrice(signal.ema21)}</code>`,
    `Vol Ratio: <b>${signal.volumeRatio.toFixed(2)}x</b> | Body: <b>${(signal.bodyRatio * 100).toFixed(0)}%</b>`,
    `Risk Setting: <b>${riskPct}%</b>`,
  ].join('\n');
}

export function createTelegramBot(deps: TelegramBotDeps) {
  const bot = new Bot(deps.token);
  let scanner: MarketScanner | null = null;

  bot.use(async (ctx, next) => {
    if (!isAdminUpdate(ctx.chat?.id, ctx.from?.id, deps.adminChatId)) {
      return;
    }
    await next();
  });

  const targetChatId = deps.adminChatId;

  async function notifySignal(signal: SignalRecord): Promise<void> {
    const settings = deps.db.getSettings();
    const text = formatSignalMessage(signal, settings.riskPct, settings.rrRatio);

    if (settings.autoTrade) {
      await bot.api.sendMessage(targetChatId, text, { parse_mode: 'HTML' });
      const res = await deps.executor.executeSignal(signal.id);
      if (res.ok && res.trade) {
        const warn = res.warning ? `\n⚠️ <b>Warning:</b> ${res.warning}` : '';
        await bot.api.sendMessage(
          targetChatId,
          `✅ <b>Auto-Executed Demo Trade #${res.trade.id}</b>\n${res.trade.symbol} ${res.trade.side} | Qty: <code>${res.trade.quantity}</code> | Risk: <b>$${res.trade.riskUsd.toFixed(2)}</b> (${res.trade.leverage}x)${warn}`,
          { parse_mode: 'HTML' },
        );
      } else {
        await bot.api.sendMessage(
          targetChatId,
          `❌ <b>Auto-Execution Failed (#${signal.id}):</b> ${res.error ?? 'Unknown error'}`,
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    const kb = new InlineKeyboard()
      .text('✅ Execute Demo Trade', `exec:${signal.id}`)
      .text('❌ Skip', `skip:${signal.id}`);

    await bot.api.sendMessage(targetChatId, text, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  async function notifyTradeClosed(symbol: string, side: string): Promise<void> {
    await bot.api.sendMessage(
      targetChatId,
      `ℹ️ <b>Position Closed:</b> ${symbol} (${side}) is no longer open on Binance Demo.`,
      { parse_mode: 'HTML' },
    );
  }

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(
      [
        '🤖 <b>Evo Trading Screener Bot (Binance Futures Demo)</b>',
        '',
        '<b>Screening &amp; Signals:</b>',
        '/watchlist — Top Gainers &amp; Losers (24h Vol &gt; $5M)',
        '/scan — Run immediate 15m momentum scan',
        '',
        '<b>Demo Account:</b>',
        '/balance — Binance Demo USDT balance',
        '/positions — Open demo positions (with Close button)',
        '/history — Recent signals &amp; trades',
        '',
        '<b>Settings:</b>',
        '/status — Current bot configuration',
        '/autotrade on|off — Toggle auto-execution',
        '/scanner on|off — Toggle 15m scheduled scanner',
        '/setrisk &lt;pct&gt; — Risk % per trade (0.25 - 10)',
        '/setrr &lt;ratio&gt; — Take profit R:R ratio (1 - 10)',
        '/setleverage &lt;x&gt; — Futures leverage (1 - 20)',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    const s = deps.db.getSettings();
    const openTrades = deps.db.getOpenTrades();
    const stream = scanner?.getStreamStatus();
    const streamLine = stream
      ? `Live 15m Stream: <b>${stream.connected ? 'CONNECTED' : 'DISCONNECTED'}</b> (${stream.watchedCount} pairs)`
      : 'Live 15m Stream: <b>N/A</b>';
    await ctx.reply(
      [
        '⚙️ <b>Bot Status</b>',
        `Scanner: <b>${s.scannerEnabled ? 'ON' : 'OFF'}</b>`,
        streamLine,
        `Auto-Trade: <b>${s.autoTrade ? 'ON' : 'OFF'}</b>`,
        `Risk / Trade: <b>${s.riskPct}%</b>`,
        `Take Profit: <b>${s.rrRatio}R</b>`,
        `Leverage: <b>${s.leverage}x</b> (ISOLATED)`,
        `Max Open Positions: <b>${s.maxOpenPositions}</b> (Tracked Open: ${openTrades.length})`,
        `Min 24h Volume: <b>${formatUsd(s.minVolumeUsd)}</b> | Top N: <b>${s.topN}</b>`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('watchlist', async (ctx) => {
    const latest = deps.db.getLatestWatchlist();
    if (latest.length === 0) {
      await ctx.reply('Watchlist is empty. Run /scan first.');
      return;
    }
    const gainers = latest.filter((i) => i.side === 'LONG');
    const losers = latest.filter((i) => i.side === 'SHORT');
    await ctx.reply(formatWatchlistMessage(gainers, losers), { parse_mode: 'HTML' });
  });

  bot.command('scan', async (ctx) => {
    if (!scanner) {
      await ctx.reply('Scanner is not initialized.');
      return;
    }
    await ctx.reply('🔍 Running 15m Futures scan...');
    try {
      const summary = await scanner.runScanCycle();
      const stream = scanner.getStreamStatus();
      await ctx.reply(
        `${formatWatchlistMessage(summary.gainers, summary.losers)}\n\n✅ Evaluated <b>${summary.evaluatedSymbols}</b> pairs | New signals: <b>${summary.newSignals.length}</b> | Errors: <b>${summary.errors}</b>\n📡 Streaming <b>${stream.watchedCount}</b> pairs live on 15m WebSocket`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Scan failed: ${msg}`);
    }
  });

  bot.command('balance', async (ctx) => {
    try {
      const bal = await deps.binance.getUsdtBalance();
      await ctx.reply(
        [
          '💰 <b>Binance Futures Demo Balance</b>',
          `Wallet Balance: <b>$${bal.balance.toFixed(2)} USDT</b>`,
          `Available: <b>$${bal.availableBalance.toFixed(2)} USDT</b>`,
          `Unrealized PnL: <b>$${bal.crossUnPnl.toFixed(2)} USDT</b>`,
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Failed to fetch balance: ${msg}`);
    }
  });

  bot.command('positions', async (ctx) => {
    try {
      const positions = await deps.binance.getOpenPositions();
      if (positions.length === 0) {
        await ctx.reply('No open positions on Binance Futures Demo.');
        return;
      }

      const kb = new InlineKeyboard();
      const lines = ['📈 <b>Open Demo Positions</b>\n'];
      for (const p of positions) {
        const side = p.positionAmt > 0 ? 'LONG' : 'SHORT';
        const pnlSign = p.unRealizedProfit >= 0 ? '+' : '';
        lines.push(
          `• <b>${p.symbol}</b> (${side} ${p.leverage}x)\n  Qty: <code>${Math.abs(p.positionAmt)}</code> | Entry: <code>${formatPrice(p.entryPrice)}</code> | Mark: <code>${formatPrice(p.markPrice)}</code>\n  uPnL: <b>${pnlSign}$${p.unRealizedProfit.toFixed(2)}</b>`,
        );
        kb.text(`Close ${p.symbol}`, `close:${p.symbol}`).row();
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Failed to fetch positions: ${msg}`);
    }
  });

  bot.command('history', async (ctx) => {
    const signals = deps.db.getRecentSignals(5);
    const trades = deps.db.getRecentTrades(5);

    const lines: string[] = ['📜 <b>Recent Signals</b>'];
    if (signals.length === 0) {
      lines.push('  <i>None</i>');
    } else {
      for (const s of signals) {
        lines.push(`  #${s.id} ${s.symbol} ${s.side} (${s.pattern}) — <b>${s.status}</b>`);
      }
    }

    lines.push('\n📜 <b>Recent Demo Trades</b>');
    if (trades.length === 0) {
      lines.push('  <i>None</i>');
    } else {
      for (const t of trades) {
        lines.push(
          `  #${t.id} ${t.symbol} ${t.side} Qty:${t.quantity} Entry:${formatPrice(t.entryPrice)} — <b>${t.status}</b>`,
        );
      }
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('autotrade', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /autotrade on|off');
      return;
    }
    deps.db.setSetting('auto_trade', String(arg === 'on'));
    await ctx.reply(`Auto-Trade is now <b>${arg.toUpperCase()}</b>.`, { parse_mode: 'HTML' });
  });

  bot.command('scanner', async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /scanner on|off');
      return;
    }
    deps.db.setSetting('scanner_enabled', String(arg === 'on'));
    await ctx.reply(`15m Scanner is now <b>${arg.toUpperCase()}</b>.`, { parse_mode: 'HTML' });
  });

  bot.command('setrisk', async (ctx) => {
    const val = Number(ctx.match.trim());
    if (!Number.isFinite(val) || val < 0.25 || val > 10) {
      await ctx.reply('Usage: /setrisk <pct> (must be between 0.25 and 10)');
      return;
    }
    deps.db.setSetting('risk_pct', String(val));
    await ctx.reply(`Risk per trade updated to <b>${val}%</b>.`, { parse_mode: 'HTML' });
  });

  bot.command('setrr', async (ctx) => {
    const val = Number(ctx.match.trim());
    if (!Number.isFinite(val) || val < 1 || val > 10) {
      await ctx.reply('Usage: /setrr <ratio> (must be between 1 and 10)');
      return;
    }
    deps.db.setSetting('rr_ratio', String(val));
    await ctx.reply(`Take Profit R:R updated to <b>${val}R</b>.`, { parse_mode: 'HTML' });
  });

  bot.command('setleverage', async (ctx) => {
    const val = Number(ctx.match.trim());
    if (!Number.isInteger(val) || val < 1 || val > 20) {
      await ctx.reply('Usage: /setleverage <x> (integer between 1 and 20)');
      return;
    }
    deps.db.setSetting('leverage', String(val));
    await ctx.reply(`Leverage updated to <b>${val}x</b>.`, { parse_mode: 'HTML' });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('exec:')) {
      const signalId = Number(data.slice(5));
      await ctx.answerCallbackQuery({ text: `Executing signal #${signalId}...` });
      const res = await deps.executor.executeSignal(signalId);
      if (res.ok && res.trade) {
        const warn = res.warning ? `\n⚠️ ${res.warning}` : '';
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(
          `✅ <b>Executed Demo Trade #${res.trade.id}</b>\n${res.trade.symbol} ${res.trade.side} | Qty: <code>${res.trade.quantity}</code> | Entry: <code>${formatPrice(res.trade.entryPrice)}</code> | SL: <code>${formatPrice(res.trade.stopLoss)}</code> | TP: <code>${formatPrice(res.trade.takeProfit)}</code> | Risk: <b>$${res.trade.riskUsd.toFixed(2)}</b>${warn}`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.reply(`❌ Execution failed (#${signalId}): ${res.error ?? 'Unknown error'}`);
      }
      return;
    }

    if (data.startsWith('skip:')) {
      const signalId = Number(data.slice(5));
      deps.db.updateSignalStatus(signalId, 'SKIPPED');
      await ctx.answerCallbackQuery({ text: `Signal #${signalId} skipped.` });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }

    if (data.startsWith('close:')) {
      const symbol = data.slice(6);
      await ctx.answerCallbackQuery({ text: `Closing ${symbol}...` });
      try {
        const [positions, filters] = await Promise.all([
          deps.binance.getOpenPositions(),
          deps.binance.getDemoExchangeInfo(),
        ]);
        const pos = positions.find((p) => p.symbol === symbol);
        if (!pos) {
          await ctx.reply(`Position ${symbol} is already closed.`);
          return;
        }
        const stepSize = filters.get(symbol)?.stepSize ?? 0.001;
        await deps.binance.closePositionMarket(symbol, pos.positionAmt, String(stepSize));
        await ctx.reply(`✅ Closed <b>${symbol}</b> on Binance Demo.`, { parse_mode: 'HTML' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Failed to close ${symbol}: ${msg}`);
      }
    }
  });

  return {
    bot,
    notifySignal,
    notifyTradeClosed,
    attachScanner(s: MarketScanner) {
      scanner = s;
    },
  };
}
