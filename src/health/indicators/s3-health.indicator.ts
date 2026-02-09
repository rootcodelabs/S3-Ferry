import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import { S3Service } from '../../s3';

@Injectable()
export class S3HealthIndicator extends HealthIndicator {
  constructor(private readonly s3Service: S3Service) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      // Try to list buckets - this checks if MinIO/S3 is accessible
      // We use a timeout to prevent hanging
      await Promise.race([
        this.s3Service.listFiles(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('S3 check timeout')), 3000),
        ),
      ]);

      return this.getStatus(key, true, {
        message: 'S3/MinIO is accessible',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HealthCheckError(
        'S3 check failed',
        this.getStatus(key, false, {
          message: `S3/MinIO is not accessible: ${errorMessage}`,
        }),
      );
    }
  }
}
