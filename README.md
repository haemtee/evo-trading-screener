# Evo Trading Screener Bot (Bun + SQLite3 + Binance Futures Demo)

Telegram trading screener and execution bot implementing a 15-minute momentum strategy on **Binance Futures Demo / Testnet** (`https://testnet.binancefuture.com`, with optional override to `https://demo-fapi.binance.com` / `https://fapi.binance.com`).

## Strategy Summary
1. **Screening (Futures Market)**:
   - Filters USDT-M Perpetual pairs tradable on Binance Futures Demo with **24h quote volume >= \$5,000,000**.
   - Ranks **Top Gainers** for `LONG` setups and **Top Losers** for `SHORT` setups.
2. **Entry (15m Closed Candles + EMA 21 + Live WebSocket)**:
   - Once coins are on the screened watchlist, the bot watches all of them in real time via Binance Futures `@kline_15m` WebSocket stream (`wss://fstream.binancefuture.com`) and evaluates each candle immediately on close (while refreshing the watchlist every 15m).
   - **LONG**: Price above EMA(21), Bullish Engulfing or Bullish Marubozu with solid body, minimal upper wick, and higher volume than the previous candle.
   - **SHORT**: Price below EMA(21), Bearish Engulfing or Bearish Marubozu with solid body, minimal lower wick, and higher volume than the previous candle.
   - **Anti-overextension guard**: Skips climax candles (`> 3x ATR`), excessive distance from EMA(21), or extended consecutive runs.
3. **Stop Loss, Take Profit & Risk**:
   - **SL**: Below the signal candle low (or lower low of the 2 engulfing candles) for `LONG`; mirrored above high for `SHORT`, with a small buffer.
   - **TP**: `2R` (2x risk distance, configurable via `/setrr`).
   - **Position Sizing**: Risk-based (`1%` of demo equity per trade by default, configurable via `/setrisk`), isolated margin.

## Setup
1. Install dependencies:
   ```bash
   bun install
   ```
2. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` (from `@BotFather`)
   - `TELEGRAM_ADMIN_CHAT_ID` (your Telegram user/chat ID, e.g. from `@userinfobot` — the bot will **only** respond to and notify this admin ID)
   - `BINANCE_API_KEY` and `BINANCE_API_SECRET` (from [Binance Futures Testnet / Demo](https://testnet.binancefuture.com))
3. Run the live read-only screener smoke check (no API keys required):
   ```bash
   bun run smoke
   ```
4. Start the Telegram bot:
   ```bash
   bun run start
   ```

## Commands
- `/watchlist` — Latest Top Gainers & Top Losers (> \$5M 24h volume)
- `/scan` — Trigger an immediate 15m scan
- `/balance` — Binance Demo USDT balance
- `/positions` — Open demo positions with inline Close button
- `/history` — Recent signals & demo trades from SQLite
- `/status` — Current settings
- `/autotrade on|off` — Toggle automatic execution on new signals
- `/scanner on|off` — Toggle scheduled 15m scanning
- `/setrisk <pct>` — Risk % per trade (0.25–10)
- `/setrr <ratio>` — Take profit R:R ratio (1–10)
- `/setleverage <x>` — Futures leverage (1–20)

## Development
```bash
bun test
bun run typecheck
```
