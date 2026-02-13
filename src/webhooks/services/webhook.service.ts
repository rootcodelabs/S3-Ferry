import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WebhookEventType,
  WebhookPayload,
} from '../interfaces/webhook-event.interface';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly enabled: boolean;
  private readonly globalUrl: string;
  private readonly secret: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly events: Record<string, any>;

  constructor(private readonly configService: ConfigService) {
    const webhookConfig = this.configService.get('webhooks') || {};
    this.enabled = webhookConfig.enabled ?? false;
    this.globalUrl = webhookConfig.globalUrl || '';
    this.secret = webhookConfig.secret || '';
    this.timeout = webhookConfig.timeout || 5000;
    this.retries = webhookConfig.retries || 3;
    this.events = webhookConfig.events || {};

    if (this.enabled) {
      this.logger.log(
        `Webhooks enabled - Global URL: ${this.globalUrl}, Timeout: ${this.timeout}ms, Retries: ${this.retries}`,
      );
    } else {
      this.logger.warn('Webhooks disabled in configuration');
    }
  }

  /**
   * Send webhook notification (async, fire-and-forget)
   */
  async sendWebhook(
    eventType: WebhookEventType,
    data: WebhookPayload['data'],
  ): Promise<void> {
    // Don't block if webhooks disabled
    if (!this.enabled) {
      this.logger.debug(`Webhooks disabled, skipping ${eventType}`);
      return;
    }

    // Check if event is enabled
    const eventConfig = this.events[eventType];
    if (!eventConfig || !eventConfig.enabled) {
      this.logger.debug(`Event ${eventType} is disabled, skipping`);
      return;
    }

    // Determine target URL (event-specific or global)
    const targetUrl = eventConfig.url || this.globalUrl;
    if (!targetUrl) {
      this.logger.warn(`No URL configured for ${eventType}, skipping`);
      return;
    }

    // Build payload
    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    // Generate HMAC signature
    const signature = this.generateSignature(payload);
    payload.signature = signature;

    // Send asynchronously (don't await, fire-and-forget)
    this.sendWithRetry(targetUrl, payload, eventType).catch((error) => {
      this.logger.error(
        `Failed to send webhook ${eventType} after all retries: ${error.message}`,
      );
    });
  }

  /**
   * Send HTTP POST with retry logic
   */
  private async sendWithRetry(
    url: string,
    payload: WebhookPayload,
    eventType: WebhookEventType,
    attempt: number = 1,
  ): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': payload.signature || '',
          'X-Webhook-Event': eventType,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        );
      }

      this.logger.log(
        `✅ Webhook sent successfully: ${eventType} → ${url} (${response.status})`,
      );
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      const isTimeout = error.name === 'AbortError';
      const statusDisplay = isTimeout ? 'TIMEOUT' : 'ERROR';

      if (attempt < this.retries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
        this.logger.warn(
          `⚠️  Webhook failed (attempt ${attempt}/${this.retries}): ${eventType} → ${url} (${statusDisplay}). Retrying in ${delay}ms...`,
        );

        await this.sleep(delay);
        return this.sendWithRetry(url, payload, eventType, attempt + 1);
      } else {
        this.logger.error(
          `❌ Webhook failed after ${this.retries} attempts: ${eventType} → ${url} (${statusDisplay}) - ${errorMsg}`,
        );
        throw error;
      }
    }
  }

  /**
   * Generate HMAC SHA256 signature for payload verification
   */
  private generateSignature(payload: WebhookPayload): string {
    const payloadString = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(payloadString);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Helper to sleep (for retry delays)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Verify webhook signature (for consumers to validate authenticity)
   */
  verifySignature(payload: string, signature: string): boolean {
    const expectedSignature = this.generateSignature(JSON.parse(payload));
    return signature === expectedSignature;
  }
}
