import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import { ClamavScannerService } from '../../validators/services';

@Injectable()
export class ClamavHealthIndicator extends HealthIndicator {
  constructor(private readonly clamavService: ClamavScannerService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const isHealthy = await this.clamavService.isHealthy();

      if (!isHealthy) {
        throw new Error('ClamAV is not responding or unavailable');
      }

      return this.getStatus(key, true, {
        message: 'ClamAV is accessible and ready',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HealthCheckError(
        'ClamAV check failed',
        this.getStatus(key, false, {
          message: `ClamAV is not accessible: ${errorMessage}`,
        }),
      );
    }
  }
}
