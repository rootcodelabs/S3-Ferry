import { createHash } from 'crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetricsService } from '../../health/services';
import { NatsService } from '../../nats/services/nats.service';
import { S3Service } from '../../s3/services/s3.service';
import { WebhookEventType, WebhookService } from '../../webhooks';

interface ValidationResult {
  uploadId: string;
  objectName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  validator: string;
  status: 'passed' | 'failed';
  validatedAt: string;
  issues?: string[];
  declaredMimeType?: string;
  detectedMimeType?: string;
  details?: Record<string, any>;
}

interface AggregatedValidation {
  uploadId: string;
  objectName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  base?: ValidationResult;
  clamav?: ValidationResult;
  receivedAt: number;
}

@Injectable()
export class ObjectTransferService implements OnModuleInit {
  private readonly logger = new Logger(ObjectTransferService.name);
  private isPolling = false;
  private kv: any = null; // NATS KV Store for validation coordination
  private readonly validationTimeoutMs = 10 * 60 * 1000; // 10 minutes (KV TTL handles cleanup)

  constructor(
    private readonly natsService: NatsService,
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly metricsService: MetricsService,
  ) {}

  async onModuleInit() {
    this.logger.log('[INIT] Object Transfer Service initialized');
    // Initialize KV Store and consumer before starting polling
    try {
      await this.initializeKvStore();
      await this.initializeConsumer();
    } catch (error) {
      this.logger.error(`Failed to initialize: ${error}`);
    }
    // Start polling for validation results (non-blocking)
    this.startPolling().catch((error) => {
      this.logger.error(`Polling failed: ${error}`);
    });
  }

  /**
   * Initialize NATS KV Store for validation coordination
   */
  private async initializeKvStore() {
    const connection = this.natsService.getConnection();
    if (!connection) {
      this.logger.warn('NATS not available - KV Store disabled');
      return;
    }

    try {
      const js = connection.jetstream();
      const jsm = await connection.jetstreamManager();

      // Try to bind to existing KV bucket, or create it
      try {
        this.kv = await js.views.kv('VALIDATION_TRACKING');
        this.logger.log('[OK] Using existing KV Store: VALIDATION_TRACKING');
      } catch {
        // KV bucket doesn't exist, create it
        this.logger.log('[CREATE] Creating new KV Store: VALIDATION_TRACKING');
        await jsm.streams.add({
          name: 'KV_VALIDATION_TRACKING',
          subjects: ['$KV.VALIDATION_TRACKING.>'],
          max_age: this.validationTimeoutMs * 1_000_000, // TTL in nanoseconds
          allow_rollup_hdrs: true,
        });
        this.kv = await js.views.kv('VALIDATION_TRACKING');
        this.logger.log('[OK] Created KV Store: VALIDATION_TRACKING');
      }
    } catch (error) {
      this.logger.error(`Failed to initialize KV Store: ${error}`);
    }
  }

  /**
   * Initialize the consumer once during startup
   */
  private async initializeConsumer() {
    const connection = this.natsService.getConnection();
    if (!connection) {
      this.logger.warn('NATS not available - Object transfer polling disabled');
      return;
    }

    const jsm = await connection.jetstreamManager();

    try {
      // Try to get existing consumer
      await jsm.consumers.info('VALIDATION_RESULTS', 'object-transfer');
      this.logger.log('[OK] Using existing object-transfer consumer');
    } catch {
      // Consumer doesn't exist, create it
      this.logger.log('[CREATE] Creating new object-transfer consumer...');
      await jsm.consumers.add('VALIDATION_RESULTS', {
        durable_name: 'object-transfer',
        ack_policy: 'explicit' as any,
        deliver_policy: 'all' as any,
        filter_subject: 'validation.*.completed',
        max_deliver: 3,
        ack_wait: 60_000_000_000, // 60 seconds in nanoseconds
      });
      this.logger.log('[OK] Created object-transfer consumer');
    }
  }

  /**
   * Start polling VALIDATION_RESULTS stream for completed validations
   */
  private async startPolling() {
    if (this.isPolling) {
      this.logger.warn('Polling already in progress');
      return;
    }

    this.isPolling = true;
    this.logger.log(
      'Starting NATS JetStream polling for validation results...',
    );

    // Check if NATS is available before starting
    const connection = this.natsService.getConnection();
    if (!connection) {
      this.logger.warn(
        'NATS connection not available - object transfer polling disabled. Files will remain in quarantine until NATS is available.',
      );
      this.isPolling = false;
      return;
    }

    // Continuously poll for messages sequentially
    while (this.isPolling) {
      try {
        const consumer = await this.getOrCreateConsumer();
        const messages = await consumer.fetch({
          max_messages: 1, // Process one message at a time
          expires: 5000,
        });

        for await (const msg of messages) {
          try {
            await this.processValidationResult(msg);
            msg.ack();
          } catch (error) {
            this.logger.error(`Failed to process validation result: ${error}`);
            msg.nak();
          }
        }
      } catch (error: any) {
        if (error.message?.includes('no messages')) {
          // No messages available, wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          this.logger.error(`Polling error: ${error}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }

  /**
   * Get consumer for validation results
   */
  private async getOrCreateConsumer() {
    const connection = this.natsService.getConnection();
    if (!connection) {
      this.isPolling = false;
      throw new Error('NATS connection lost');
    }
    const js = connection!.jetstream();
    return await js.consumers.get('VALIDATION_RESULTS', 'object-transfer');
  }

  /**
   * Generate a valid NATS KV key from uploadId and objectName
   * NATS KV keys cannot contain slashes or special characters
   */
  private generateKvKey(
    uploadId: string,
    objectName: string,
    validator: string,
  ): string {
    // Create a hash of uploadId + objectName to ensure uniqueness
    const hash = createHash('sha256')
      .update(`${uploadId}:${objectName}`)
      .digest('hex')
      .substring(0, 16); // Use first 16 chars for brevity

    // Use only alphanumeric and dashes/underscores
    return `val.${hash}.${validator}`;
  }

  /**
   * Process a validation result message using KV Store for coordination
   */
  private async processValidationResult(msg: any) {
    let data: any;
    let rawString: string | undefined;

    try {
      rawString = msg.string();
      if (rawString) {
        this.logger.debug(
          `[DEBUG] Received message, length: ${rawString.length}, first 100 chars: ${rawString.substring(0, 100)}`,
        );
      }

      if (!rawString || rawString.trim() === '') {
        this.logger.error('[ERROR] Received empty message string');
        return;
      }

      data = JSON.parse(rawString);
    } catch (error) {
      this.logger.error(
        `[ERROR] Failed to parse validation result message: ${error}`,
      );
      this.logger.error(`[ERROR] Raw message string: "${rawString}"`);
      this.logger.error(`[ERROR] Message length: ${rawString?.length || 0}`);
      throw error;
    }

    const result: ValidationResult = data;

    this.logger.log(
      `[RECV] ${result.validator} result for ${result.objectName}: ${result.status}`,
    );

    // Use KV Store if available, otherwise log warning
    if (!this.kv) {
      this.logger.warn(
        'KV Store not available, skipping validation coordination',
      );
      return;
    }

    // Build KV keys for both validators
    const validatorType = result.validator?.toLowerCase();
    if (
      !validatorType ||
      (validatorType !== 'base' && validatorType !== 'clamav')
    ) {
      this.logger.warn(`Unknown validator type: ${result.validator}`);
      return;
    }

    const baseKey = this.generateKvKey(
      result.uploadId,
      result.objectName,
      'base',
    );
    const clamavKey = this.generateKvKey(
      result.uploadId,
      result.objectName,
      'clamav',
    );
    const currentKey = validatorType === 'base' ? baseKey : clamavKey;
    const otherKey = validatorType === 'base' ? clamavKey : baseKey;
    const otherValidator = validatorType === 'base' ? 'clamav' : 'base';

    // 1. Store current validation result in KV
    try {
      await this.kv.put(currentKey, JSON.stringify(result));
      this.logger.debug(
        `[KV] Stored ${validatorType} result for ${result.objectName}`,
      );
    } catch (error) {
      this.logger.error(`Failed to store in KV: ${error}`);
      throw error;
    }

    // 2. Check if the OTHER validator's result exists (O(1) lookup)
    let otherEntry;
    try {
      otherEntry = await this.kv.get(otherKey);
    } catch (error: any) {
      this.logger.error(`Failed to query KV for ${otherValidator}: ${error}`);
      throw error;
    }

    // Check if other result exists
    if (!otherEntry) {
      // Other result doesn't exist yet - this is normal
      this.logger.log(
        `[WAIT] ${validatorType} stored, waiting for ${otherValidator} result for ${result.objectName}`,
      );
      return;
    }

    // 3. Both validations complete! Process the file
    this.logger.log(
      `[COMPLETE] Both validations ready for ${result.objectName}`,
    );

    let otherResult: ValidationResult;
    try {
      const otherString = otherEntry.string();
      this.logger.debug(
        `[DEBUG] Parsing ${otherValidator} result, length: ${otherString.length}, first 100 chars: ${otherString.substring(0, 100)}`,
      );

      if (!otherString || otherString.trim() === '') {
        this.logger.error(
          `[ERROR] Empty ${otherValidator} result from KV Store`,
        );
        throw new Error(`Empty ${otherValidator} result`);
      }

      otherResult = JSON.parse(otherString);
    } catch (error) {
      this.logger.error(
        `[ERROR] Failed to parse ${otherValidator} result from KV: ${error}`,
      );
      const otherString = otherEntry.string();
      this.logger.error(`[ERROR] Raw KV data: "${otherString}"`);
      this.logger.error(`[ERROR] KV data length: ${otherString?.length || 0}`);
      throw error;
    }

    const aggregated: AggregatedValidation = {
      uploadId: result.uploadId,
      objectName: result.objectName,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
      base: validatorType === 'base' ? result : otherResult,
      clamav: validatorType === 'clamav' ? result : otherResult,
      receivedAt: Date.now(),
    };

    // Process file transfer (sequential processing)
    await this.handleCompleteValidation(aggregated);

    // 4. Cleanup both KV entries after successful processing
    try {
      await Promise.all([this.kv.delete(baseKey), this.kv.delete(clamavKey)]);
      this.logger.debug(`[KV] Cleaned up entries for ${result.objectName}`);
    } catch (error) {
      this.logger.warn(`Failed to cleanup KV entries: ${error}`);
      // Non-critical - TTL will handle cleanup
    }
  }

  /**
   * Handle passed validation - move to validated bucket
   */
  private async handlePassedValidation(
    objectName: string,
    validation?: AggregatedValidation,
  ) {
    try {
      this.logger.log(
        `[PASS] Validation passed for ${objectName}, moving to validated bucket`,
      );

      // Copy to validated bucket
      await this.s3Service.copyFromQuarantineToBucket(objectName, 'validated');

      // Delete from quarantine
      await this.s3Service.deleteFromQuarantine(objectName);

      // Record file transfer metric
      this.metricsService.recordFileTransfer('validated');

      this.logger.log(
        `[OK] Successfully transferred ${objectName} to validated bucket`,
      );

      // Send webhook notification for file validated
      if (validation) {
        await this.webhookService.sendWebhook(WebhookEventType.FileValidated, {
          uploadId: validation.uploadId,
          objectName: validation.objectName,
          fileName: validation.fileName,
          fileSize: validation.fileSize,
          mimeType: validation.mimeType,
          details: {
            bucket: 'validated',
            baseValidator: validation.base?.status,
            clamavValidator: validation.clamav?.status,
            completedAt: new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to transfer ${objectName} to validated: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Handle failed validation - move to flagged or delete based on DSL config
   */
  private async handleFailedValidation(validation: AggregatedValidation) {
    try {
      // Get action handler configuration from DSL
      const actionHandlers = this.configService.get('actionHandlers') || {};
      const insecureFilesConfig = actionHandlers['insecure files'] || {};
      const virusDetectionConfig = actionHandlers['on-virus-detection'] || {};
      const moveToFlagged = insecureFilesConfig['move-to-flagged'] ?? true; // Default to true
      const moveToFlaggedForVirus =
        virusDetectionConfig['move-to-flagged'] ?? true; // Default to true

      const baseFailed = validation.base?.status === 'failed';
      const virusFailed = validation.clamav?.status === 'failed';
      const shouldMoveToFlagged =
        (baseFailed && moveToFlagged) || (virusFailed && moveToFlaggedForVirus);

      const issues: string[] = [];
      if (baseFailed) {
        issues.push(...(validation.base?.issues || ['Base validation failed']));
      }
      if (virusFailed) {
        issues.push(...(validation.clamav?.issues || ['Virus scan failed']));
      }

      this.logger.log(
        `[FAIL] Validation failed for ${validation.objectName}. Issues: ${issues.join(', ') || 'Unknown'}`,
      );
      this.logger.log(
        `Action: ${shouldMoveToFlagged ? 'Move to flagged' : 'Delete from quarantine'}`,
      );

      if (shouldMoveToFlagged) {
        // Copy to flagged bucket
        await this.s3Service.copyFromQuarantineToBucket(
          validation.objectName,
          'flagged',
        );

        // Record file transfer metric
        this.metricsService.recordFileTransfer('flagged');

        this.logger.log(
          `[FLAG] Moved ${validation.objectName} to flagged bucket`,
        );

        // Send webhook notification for file flagged
        await this.webhookService.sendWebhook(WebhookEventType.FileFlagged, {
          uploadId: validation.uploadId,
          objectName: validation.objectName,
          fileName: validation.fileName,
          fileSize: validation.fileSize,
          mimeType: validation.mimeType,
          details: {
            bucket: 'flagged',
            issues,
            baseValidator: validation.base?.status,
            clamavValidator: validation.clamav?.status,
            flaggedAt: new Date().toISOString(),
          },
        });
      } else {
        this.logger.log(
          `[DELETE] Deleting ${validation.objectName} from quarantine (move-to-flagged: false)`,
        );

        // Record file transfer metric
        this.metricsService.recordFileTransfer('deleted');

        // Send webhook notification for file deleted
        await this.webhookService.sendWebhook(WebhookEventType.FileDeleted, {
          uploadId: validation.uploadId,
          objectName: validation.objectName,
          fileName: validation.fileName,
          fileSize: validation.fileSize,
          mimeType: validation.mimeType,
          details: {
            reason: 'validation_failed',
            issues,
            deletedAt: new Date().toISOString(),
          },
        });
      }

      // Always delete from quarantine after processing
      await this.s3Service.deleteFromQuarantine(validation.objectName);

      this.logger.log(
        `[OK] Successfully processed failed validation for ${validation.objectName}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process failed validation for ${validation.objectName}: ${error}`,
      );
      throw error;
    }
  }

  private async handleCompleteValidation(validation: AggregatedValidation) {
    // Check if object exists in quarantine
    const exists = await this.s3Service.objectExistsInQuarantine(
      validation.objectName,
    );
    if (!exists) {
      this.logger.warn(
        `Object ${validation.objectName} not found in quarantine, skipping transfer`,
      );
      return;
    }

    const allPassed =
      validation.base?.status === 'passed' &&
      validation.clamav?.status === 'passed';

    if (allPassed) {
      await this.handlePassedValidation(validation.objectName, validation);
    } else {
      await this.handleFailedValidation(validation);
    }
  }

  /**
   * Stop polling (for graceful shutdown)
   */
  onModuleDestroy() {
    this.isPolling = false;
    this.logger.log('Object Transfer Service stopped');
  }
}
