import { ConfigFactory, registerAs } from '@nestjs/config';

import { NatsConfig } from './nats.config.interface';

export const natsConfigFactory = registerAs('nats', () => {
  const servers = process.env.NATS_SERVERS?.split(',') || [
    'nats://localhost:4222',
  ];

  return {
    servers,
    maxReconnectAttempts: parseInt(
      process.env.NATS_MAX_RECONNECT_ATTEMPTS || '10',
      10,
    ),
    reconnectTimeWait: parseInt(
      process.env.NATS_RECONNECT_TIME_WAIT || '2000',
      10,
    ),
    streams: {
      fileValidation: {
        name: process.env.NATS_FILE_VALIDATION_STREAM || 'FILE_VALIDATION',
        subjects: [
          'file.uploaded',
          'file.uploaded.base',
          'file.uploaded.clamav',
        ],
      },
      validationResults: {
        name:
          process.env.NATS_VALIDATION_RESULTS_STREAM || 'VALIDATION_RESULTS',
        subjects: [
          'validation.base.completed',
          'validation.clamav.completed',
          'validation.completed',
        ],
      },
    },
  };
}) as ConfigFactory<NatsConfig> & { KEY: string };
