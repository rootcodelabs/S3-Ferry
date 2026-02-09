import { forwardRef, Module } from '@nestjs/common';

import { HealthModule } from '../health';
import { NatsModule } from '../nats';
import { S3Module } from '../s3';
import { WebhooksModule } from '../webhooks';
import {
  BaseValidatorService,
  ClamavScannerService,
  ObjectTransferService,
} from './services';

@Module({
  imports: [
    NatsModule,
    S3Module,
    WebhooksModule,
    forwardRef(() => HealthModule),
  ],
  providers: [
    BaseValidatorService,
    ClamavScannerService,
    ObjectTransferService,
  ],
  exports: [BaseValidatorService, ClamavScannerService, ObjectTransferService],
})
export class ValidatorsModule {}
