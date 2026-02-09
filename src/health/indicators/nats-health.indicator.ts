import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import { NatsService } from '../../nats';

@Injectable()
export class NatsHealthIndicator extends HealthIndicator {
  constructor(private readonly natsService: NatsService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const isConnected = await this.natsService.isConnected();

      if (!isConnected) {
        throw new Error('NATS connection is not established');
      }

      return this.getStatus(key, true, {
        message: 'NATS is connected and healthy',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HealthCheckError(
        'NATS check failed',
        this.getStatus(key, false, {
          message: `NATS is not accessible: ${errorMessage}`,
        }),
      );
    }
  }
}
