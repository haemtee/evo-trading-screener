import { describe, expect, test } from 'bun:test';
import { loadConfig, validateBotConfig } from '../src/config.ts';
import { ADMIN_BOT_COMMANDS, isAdminUpdate } from '../src/telegram/bot.ts';

describe('isAdminUpdate', () => {
  test('allows only when both chatId and fromId match adminChatId', () => {
    expect(isAdminUpdate(123456789, 123456789, 123456789)).toBe(true);
    expect(isAdminUpdate(123456789, 999999999, 123456789)).toBe(false);
    expect(isAdminUpdate(999999999, 123456789, 123456789)).toBe(false);
    expect(isAdminUpdate(undefined, 123456789, 123456789)).toBe(false);
    expect(isAdminUpdate(123456789, undefined, 123456789)).toBe(false);
  });
});

describe('adminChatId config validation', () => {
  test('loads TELEGRAM_ADMIN_CHAT_ID and validates required fields', () => {
    const valid = loadConfig({
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_ADMIN_CHAT_ID: '123456789',
      BINANCE_API_KEY: 'key',
      BINANCE_API_SECRET: 'secret',
    });
    expect(valid.adminChatId).toBe(123456789);
    expect(() => validateBotConfig(valid)).not.toThrow();

    const invalid = loadConfig({
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_ADMIN_CHAT_ID: 'not-a-number',
      BINANCE_API_KEY: 'key',
      BINANCE_API_SECRET: 'secret',
    });
    expect(invalid.adminChatId).toBeNull();
    expect(() => validateBotConfig(invalid)).toThrow('TELEGRAM_ADMIN_CHAT_ID');
  });
});

describe('ADMIN_BOT_COMMANDS', () => {
  test('contains valid Telegram command names and descriptions', () => {
    expect(ADMIN_BOT_COMMANDS.length).toBeGreaterThanOrEqual(10);
    for (const cmd of ADMIN_BOT_COMMANDS) {
      expect(cmd.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(cmd.description.length).toBeGreaterThanOrEqual(3);
      expect(cmd.description.length).toBeLessThanOrEqual(256);
    }
  });
});
