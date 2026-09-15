import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { redactToken } from '../common/redact';

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

const SEND_MESSAGE_TIMEOUT_MS = 20_000;

/**
 * Gold execution's OWN, fully isolated Telegram notification path — task
 * requirement: "an isolated gold notification path... using its OWN bot
 * token/chat ID read directly from config (NOT the shared
 * TELEGRAM_TRADING_CHAT_IDS/OPS lists)". Deliberately does NOT depend on
 * `TelegramBotClient`/`TELEGRAM_CONFIG` (those are validated at startup
 * against the shared legacy bot/chat-id lists — see telegram.config.ts —
 * and this path must keep working, or fail, entirely independently of that
 * config) nor on the shared `TELEGRAM_DELIVERY_QUEUE` BullMQ pipeline
 * (Alert/AlertDelivery is a different, EURUSD/legacy-shaped concept). Calls
 * the Bot API directly with plain factual template strings — no AI
 * narration, ever.
 *
 * Durable dedup + delivery-result persistence: one row per notification
 * attempt in `GoldTelegramNotification`, keyed by a caller-supplied
 * `dedupKey` (`@unique` in the schema) — same "unique key closes the
 * duplicate-send race" posture as `AlertDelivery.alertId @unique` and
 * `deliveryJobId()` (jobs.constants.ts). A second call with the same
 * dedupKey is a guaranteed no-op (checked first, and the DB unique
 * constraint is the actual backstop against a race). `messageId`/`status`/
 * `lastError` are persisted the same way `AlertDelivery`/`AiAnalysis`
 * persist `telegramMessageIds`/`status`/`lastError` — kept in Postgres, not
 * memory, so a restart never loses the delivery record.
 */
@Injectable()
export class GoldTelegramService {
  private readonly logger = new Logger(GoldTelegramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends `text` once per `dedupKey`. Returns silently (logging only) on
   * any failure — a Telegram outage must never throw back into, or block,
   * the trading-path code calling this (fills/closures/rejections must
   * still be recorded even if the notification itself cannot go out).
   */
  async notify(eventType: string, dedupKey: string, text: string): Promise<void> {
    const existing = await this.prisma.goldTelegramNotification.findUnique({ where: { dedupKey } });
    if (existing && existing.status === 'SENT') {
      this.logger.debug(`gold telegram: dedupKey ${dedupKey} already sent (message ${existing.messageId}) — skipping`);
      return;
    }

    const botToken = this.config.get<string>('GOLD_TELEGRAM_BOT_TOKEN')?.trim();
    const chatId = this.config.get<string>('GOLD_TELEGRAM_CHAT_ID')?.trim();

    if (!botToken || !chatId) {
      this.logger.error(`gold telegram: GOLD_TELEGRAM_BOT_TOKEN/GOLD_TELEGRAM_CHAT_ID not configured — cannot send (${eventType}, dedupKey=${dedupKey})`);
      await this.upsertResult(dedupKey, eventType, text, { status: 'FAILED', lastError: 'GOLD_TELEGRAM_BOT_TOKEN/GOLD_TELEGRAM_CHAT_ID not configured' });
      return;
    }

    try {
      const messageId = await this.sendMessage(botToken, chatId, text);
      await this.upsertResult(dedupKey, eventType, text, { status: 'SENT', messageId, sentAt: new Date() });
      this.logger.log(`gold telegram: sent ${eventType} (dedupKey=${dedupKey}, message_id=${messageId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`gold telegram: failed to send ${eventType} (dedupKey=${dedupKey}): ${message}`);
      await this.upsertResult(dedupKey, eventType, text, { status: 'FAILED', lastError: message.slice(0, 500) });
    }
  }

  private async sendMessage(botToken: string, chatId: string, text: string): Promise<number> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`network error calling Telegram: ${redactToken(message, botToken)}`);
    }

    const body = (await response.json().catch(() => ({ ok: false }))) as TelegramSendMessageResponse;
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new Error(`Telegram ${response.status}: ${redactToken((body.description ?? JSON.stringify(body)).slice(0, 300), botToken)}`);
    }
    return body.result.message_id;
  }

  private async upsertResult(
    dedupKey: string,
    eventType: string,
    text: string,
    result: { status: 'SENT' | 'FAILED'; messageId?: number; lastError?: string; sentAt?: Date },
  ): Promise<void> {
    await this.prisma.goldTelegramNotification.upsert({
      where: { dedupKey },
      create: {
        dedupKey,
        eventType,
        text,
        status: result.status,
        messageId: result.messageId ?? null,
        lastError: result.lastError ?? null,
        sentAt: result.sentAt ?? null,
      },
      update: {
        status: result.status,
        messageId: result.messageId ?? null,
        lastError: result.lastError ?? null,
        sentAt: result.sentAt ?? null,
      },
    });
  }
}
