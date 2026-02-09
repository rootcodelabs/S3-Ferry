import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import {
  ClamavHealthIndicator,
  NatsHealthIndicator,
  S3HealthIndicator,
} from './indicators';
import { MetricsService } from './services';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly s3Health: S3HealthIndicator,
    private readonly natsHealth: NatsHealthIndicator,
    private readonly clamavHealth: ClamavHealthIndicator,
    private readonly metricsService: MetricsService,
  ) {}

  /**
   * Kubernetes Liveness Probe
   * Returns 200 if the application is running
   * Does NOT check dependencies - only checks if the process is alive
   */
  @Get('/health')
  @ApiExcludeEndpoint()
  @HealthCheck()
  checkLiveness() {
    // Simple liveness check - if this endpoint responds, the app is alive
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Kubernetes Readiness Probe
   * Returns 200 if the application is ready to serve traffic
   * Checks critical dependencies: S3 and NATS
   * ClamAV is optional - failures are reported but don't fail the probe
   */
  @Get('/ready')
  @ApiExcludeEndpoint()
  @HealthCheck()
  async checkReadiness() {
    return this.health.check([
      () => this.s3Health.isHealthy('s3'),
      () => this.natsHealth.isHealthy('nats'),
      // ClamAV check - non-critical, errors won't fail readiness
      async () => {
        try {
          return await this.clamavHealth.isHealthy('clamav');
        } catch (error) {
          // ClamAV down is not critical - return degraded status
          return {
            clamav: {
              status: 'down',
              message:
                error instanceof Error
                  ? error.message
                  : 'ClamAV unavailable (non-critical)',
            },
          };
        }
      },
    ]);
  }

  /**
   * Prometheus Metrics Endpoint
   * Returns metrics in Prometheus text format
   */
  @Get('/metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.metricsService.getMetrics();
  }
}
