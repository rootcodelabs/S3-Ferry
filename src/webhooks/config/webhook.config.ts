import { registerAs } from '@nestjs/config';

export interface WebhookEventConfig {
  enabled: boolean;
  url: string | null;
}

export interface WebhookConfig {
  enabled: boolean;
  globalUrl: string;
  secret: string;
  timeout: number;
  retries: number;
  events: Record<string, WebhookEventConfig>;
}

export const webhookConfigFactory = registerAs('webhooks', () => {
  const config = {
    enabled: process.env.WEBHOOK_ENABLED === 'true',
    globalUrl:
      process.env.WEBHOOK_GLOBAL_URL || 'http://localhost:3001/webhooks',
    secret: process.env.WEBHOOK_SECRET || 'your-webhook-secret-key',
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '5000', 10),
    retries: parseInt(process.env.WEBHOOK_RETRIES || '3', 10),
    events: {},
  };

  return config;
});
