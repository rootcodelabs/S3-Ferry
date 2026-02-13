import { forwardRef, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { NatsModule } from '../nats';
import { S3Module } from '../s3';
import { ValidatorsModule } from '../validators';
import { HealthController } from './health.controller';
import {
  ClamavHealthIndicator,
  NatsHealthIndicator,
  S3HealthIndicator,
} from './indicators';
import { MetricsService } from './services';

@Module({
  imports: [
    TerminusModule, // Provides HealthCheckService
    S3Module, // Provides S3Service for health checks
    NatsModule, // Provides NatsService for health checks
    forwardRef(() => ValidatorsModule), // Provides ClamavScannerService for health checks
  ],
  controllers: [HealthController],
  providers: [
    MetricsService,
    S3HealthIndicator,
    NatsHealthIndicator,
    ClamavHealthIndicator,
  ],
  exports: [MetricsService], // Export for use in other modules if needed
})
export class HealthModule {}
