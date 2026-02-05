import joi from 'joi';

export const natsConfigSchema = joi.object({
  NATS_SERVERS: joi.string().default('nats://localhost:4222'),
  NATS_MAX_RECONNECT_ATTEMPTS: joi.number().default(10),
  NATS_RECONNECT_TIME_WAIT: joi.number().default(2000),
  NATS_FILE_VALIDATION_STREAM: joi.string().default('FILE_VALIDATION'),
  NATS_VALIDATION_RESULTS_STREAM: joi.string().default('VALIDATION_RESULTS'),
});
