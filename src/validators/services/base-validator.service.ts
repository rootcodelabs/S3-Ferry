import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fileTypeFromBuffer } from 'file-type';

import { MetricsService } from '../../health/services';
import {
  FileUploadedMessage,
  NatsService,
  ValidationResultMessage,
} from '../../nats';
import { S3Service } from '../../s3/services/s3.service';
import { WebhookEventType, WebhookService } from '../../webhooks';

interface ParsedFileMessage {
  metadata: FileUploadedMessage['metadata'];
  fileData: Buffer;
}

@Injectable()
export class BaseValidatorService implements OnModuleInit {
  private readonly logger = new Logger(BaseValidatorService.name);
  private isPolling = false;
  private allowedMimeTypes: Set<string> = new Set();
  private allowedExtensions: Set<string> = new Set();

  // Only download first 16KB for MIME type detection (magic bytes are at file start)
  // This prevents loading entire large files (videos, archives) into memory
  private readonly MAGIC_BYTES_SIZE = 16 * 1024; // 16KB

  // Fallback MIME rules if configuration is not available
  private readonly FALLBACK_MIME_RULES = {
    images: {
      allowed: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/tiff',
        'image/svg+xml',
        'image/heic',
        'image/heif',
        'image/heic-sequence',
        'image/heif-sequence',
        'image/avif',
        'image/jxl',
      ],
      extensions: [
        '.jpg',
        '.jpeg',
        '.png',
        '.gif',
        '.webp',
        '.bmp',
        '.tiff',
        '.svg',
        '.heic',
        '.heif',
        '.avif',
        '.jxl',
      ],
    },
    pdf: {
      allowed: ['application/pdf'],
      extensions: ['.pdf'],
    },
    documents: {
      allowed: [
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
      ],
      extensions: [
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.txt',
        '.csv',
      ],
    },
    archives: {
      allowed: [
        'application/zip',
        'application/x-zip-compressed',
        'application/x-rar-compressed',
        'application/x-7z-compressed',
        'application/gzip',
        'application/x-tar',
      ],
      extensions: ['.zip', '.rar', '.7z', '.gz', '.tar'],
    },
    videos: {
      allowed: [
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/x-matroska',
        'video/webm',
      ],
      extensions: ['.mp4', '.mpeg', '.mov', '.avi', '.mkv', '.webm'],
    },
    audio: {
      allowed: [
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'audio/webm',
        'audio/aac',
        'audio/flac',
      ],
      extensions: ['.mp3', '.wav', '.ogg', '.webm', '.aac', '.flac'],
    },
  };

  constructor(
    private readonly natsService: NatsService,
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly metricsService: MetricsService,
  ) {
    this.loadAllowedTypesFromConfig();
  }

  /**
   * Load allowed MIME types and extensions from application.yml configuration
   */
  private loadAllowedTypesFromConfig() {
    try {
      const fileTypes =
        this.configService.get<Record<string, any>>('fileTypes');

      if (fileTypes && Object.keys(fileTypes).length > 0) {
        // Load from configuration
        this.logger.log(
          '[CONFIG] Loading allowed file types from application.yml',
        );

        for (const [category, config] of Object.entries(fileTypes)) {
          const mimeTypes = config.mimeTypes || [];
          const extensions = config.extensions || [];

          mimeTypes.forEach((mime: string) => this.allowedMimeTypes.add(mime));
          extensions.forEach((ext: string) => this.allowedExtensions.add(ext));

          this.logger.log(
            `[CONFIG] Loaded ${category}: ${mimeTypes.length} MIME types, ${extensions.length} extensions`,
          );
        }

        this.logger.log(
          `[CONFIG] Total allowed: ${this.allowedMimeTypes.size} MIME types, ${this.allowedExtensions.size} extensions`,
        );
      } else {
        // Fallback to hardcoded rules
        this.logger.warn(
          '[CONFIG] No fileTypes configuration found in application.yml, using fallback rules',
        );
        this.loadFallbackRules();
      }
    } catch (error) {
      this.logger.error(
        `[CONFIG] Failed to load configuration: ${error}. Using fallback rules.`,
      );
      this.loadFallbackRules();
    }
  }

  /**
   * Load fallback MIME rules if configuration is not available
   */
  private loadFallbackRules() {
    for (const category of Object.values(this.FALLBACK_MIME_RULES)) {
      category.allowed.forEach((mime) => this.allowedMimeTypes.add(mime));
      category.extensions.forEach((ext) => this.allowedExtensions.add(ext));
    }
    this.logger.log(
      `[FALLBACK] Loaded ${this.allowedMimeTypes.size} MIME types from fallback rules`,
    );
  }

  async onModuleInit() {
    this.logger.log(
      '[INIT] Base Validator initialized (MIME + File Type checking)',
    );
    await this.cleanupLegacyConsumer();
    // Start polling in the background
    this.startPolling();
  }

  /**
   * Remove legacy consumers to avoid old filter conflicts
   */
  private async cleanupLegacyConsumer() {
    try {
      const connection = this.natsService.getConnection();
      if (!connection) {
        return;
      }

      const jsm = await connection.jetstreamManager();

      // Remove old mime-validator consumers
      try {
        await jsm.consumers.delete('FILE_VALIDATION', 'mime-validator');
        this.logger.log('Removed legacy mime-validator consumer');
      } catch (error: any) {
        if (!error?.message?.includes('consumer not found')) {
          this.logger.warn(
            `Failed to remove mime-validator consumer: ${error}`,
          );
        }
      }

      try {
        await jsm.consumers.delete('FILE_VALIDATION', 'mime-validator-v2');
        this.logger.log('Removed legacy mime-validator-v2 consumer');
      } catch (error: any) {
        if (!error?.message?.includes('consumer not found')) {
          this.logger.warn(
            `Failed to remove mime-validator-v2 consumer: ${error}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.warn(`Failed to cleanup legacy consumers: ${error}`);
    }
  }

  /**
   * Start polling NATS JetStream for files to validate
   */
  private async startPolling() {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    this.logger.log(
      'Starting NATS JetStream polling for base validation (MIME + File Type)...',
    );

    try {
      const jetStream = this.natsService.getJetStream();
      if (!jetStream) {
        this.logger.warn(
          'NATS JetStream not available - Base validation polling disabled',
        );
        this.isPolling = false;
        return;
      }
      const consumer = await jetStream!.consumers.get(
        'FILE_VALIDATION',
        'base-validator',
      );

      // Poll continuously
      while (this.isPolling) {
        try {
          const messages = await consumer.fetch({
            max_messages: 1,
            expires: 5000,
          });

          for await (const msg of messages) {
            try {
              await this.processMessage(msg);
              msg.ack();
            } catch (error) {
              this.logger.error(`Failed to process message: ${error}`);
              msg.nak();
            }
          }
        } catch (error: any) {
          if (
            error.message?.includes('timeout') ||
            error.message?.includes('no messages')
          ) {
            // No messages available, continue polling
            await this.sleep(1000); // Wait 1 second before next poll
          } else {
            this.logger.error(`Polling error: ${error}`);
            await this.sleep(5000); // Wait 5 seconds on error
          }
        }
      }
    } catch (error: any) {
      if (error.message?.includes('consumer not found')) {
        this.logger.log('Consumer not found, creating...');
        await this.createConsumer();
        // Retry polling
        this.isPolling = false;
        setTimeout(() => this.startPolling(), 2000);
      } else {
        this.logger.warn(
          `NATS polling unavailable: ${error.message || error}. Files will remain in quarantine until NATS is available.`,
        );
        this.isPolling = false;
      }
    }
  }

  /**
   * Create the durable consumer for base validation (MIME + File Type)
   */
  private async createConsumer() {
    try {
      const connection = this.natsService.getConnection();
      if (!connection) {
        this.logger.warn(
          'NATS not available - skipping base validator consumer creation',
        );
        return;
      }
      const jsm = await connection!.jetstreamManager();

      await jsm.consumers.add('FILE_VALIDATION', {
        durable_name: 'base-validator',
        ack_policy: 'explicit' as any,
        deliver_policy: 'all' as any,
        filter_subject: 'file.uploaded.base',
        max_deliver: 3,
        ack_wait: 60_000_000_000, // 60 seconds in nanoseconds
      });

      this.logger.log('Created base validator consumer');
    } catch (error) {
      this.logger.error(`Failed to create consumer: ${error}`);
      throw error;
    }
  }

  /**
   * Process a single message from NATS
   */
  private async processMessage(msg: any) {
    try {
      // Parse metadata from message (file data is fetched from S3, not from message)
      const metadata: FileUploadedMessage['metadata'] = JSON.parse(
        msg.string(),
      );

      // ✅ LOG INPUT PAYLOAD
      console.log('========================================');
      console.log('📥 [BASE VALIDATOR] INPUT PAYLOAD');
      console.log('========================================');
      console.log(
        JSON.stringify(
          {
            uploadId: metadata.uploadId,
            objectName: metadata.objectName,
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            mimeType: metadata.mimeType,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log('========================================\n');

      this.logger.log(
        `Processing file for base validation: ${metadata.fileName} (${metadata.fileSize} bytes)`,
      );

      // Download only first 16KB from S3 for MIME detection (magic bytes validation)
      // This prevents loading large files entirely into memory
      const bytesToDownload = Math.min(
        metadata.fileSize,
        this.MAGIC_BYTES_SIZE,
      );

      this.logger.log(
        `Downloading first ${bytesToDownload} bytes for validation (${metadata.fileSize} total)`,
      );

      const fileData = await this.s3Service.downloadFileRangeAsBuffer(
        metadata.objectName,
        0,
        bytesToDownload - 1,
      );

      // Validate file (MIME type + File type allowlist)
      const validationResult = await this.validateFile(
        fileData,
        metadata.fileName,
        metadata.mimeType,
      );

      // Publish validation result
      await this.publishValidationResult(metadata, validationResult);

      // ✅ LOG OUTPUT PAYLOAD
      console.log('========================================');
      console.log('📤 [BASE VALIDATOR] OUTPUT PAYLOAD');
      console.log('========================================');
      console.log(
        JSON.stringify(
          {
            uploadId: metadata.uploadId,
            objectName: metadata.objectName,
            fileName: metadata.fileName,
            validator: 'base',
            status: validationResult.passed ? 'passed' : 'failed',
            detectedMimeType: validationResult.detectedMimeType,
            declaredMimeType: validationResult.declaredMimeType,
            reason: validationResult.reason,
            details: validationResult.details,
            validatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log('========================================\n');

      this.logger.log(
        `Base validation ${validationResult.passed ? 'PASSED' : 'FAILED'}: ${metadata.fileName}`,
      );
    } catch (error) {
      this.logger.error(`Error processing message: ${error}`);
      throw error;
    }
  }

  /**
   * Parse message format - now just JSON metadata (file fetched from S3)
   */
  private parseMessage(data: Uint8Array): ParsedFileMessage {
    const buffer = Buffer.from(data);
    const metadata = JSON.parse(buffer.toString('utf8'));
    // fileData is fetched from S3, not included in message
    return { metadata, fileData: Buffer.alloc(0) };
  }

  /**
   * Validate file using dual checks:
   * 1. MIME type detection via magic bytes (detects actual file type)
   * 2. File type allowlist checking (verifies against DSL configuration)
   */
  private async validateFile(
    fileData: Buffer,
    fileName: string,
    declaredMimeType: string,
  ): Promise<{
    passed: boolean;
    detectedMimeType: string | null;
    declaredMimeType: string;
    reason?: string;
    details?: Record<string, any>;
  }> {
    try {
      // Detect MIME type using magic bytes
      const fileTypeResult = await fileTypeFromBuffer(fileData);

      if (!fileTypeResult) {
        // Could not detect MIME type - might be text file or unknown format
        const extension = fileName.toLowerCase().split('.').pop() || '';
        const fileExtension = `.${extension}`;

        // Check if extension is in allowed list from configuration
        if (this.allowedExtensions.has(fileExtension)) {
          return {
            passed: true,
            detectedMimeType: null,
            declaredMimeType,
            reason: `Text file or undetectable format - extension ${fileExtension} is in allowed list`,
          };
        }

        return {
          passed: false,
          detectedMimeType: null,
          declaredMimeType,
          reason: `Could not detect file type using magic bytes and extension ${fileExtension} is not in allowed list`,
        };
      }

      const detectedMimeType = fileTypeResult.mime;
      const detectedExt = fileTypeResult.ext;

      this.logger.log(
        `Detected MIME: ${detectedMimeType}, Extension: ${detectedExt}, Declared: ${declaredMimeType} for ${fileName}`,
      );

      // Check if detected MIME type is in allowed list
      const isAllowed = this.isAllowedMimeType(detectedMimeType);

      if (!isAllowed) {
        return {
          passed: false,
          detectedMimeType,
          declaredMimeType,
          reason: `Detected MIME type '${detectedMimeType}' is not in allowed list`,
          details: {
            detectedExtension: detectedExt,
          },
        };
      }

      // Check for MIME type mismatch (possible spoofing)
      const isMismatch = this.isMimeTypeMismatch(
        declaredMimeType,
        detectedMimeType,
      );

      if (isMismatch) {
        return {
          passed: false,
          detectedMimeType,
          declaredMimeType,
          reason: `MIME type mismatch: declared '${declaredMimeType}' but detected '${detectedMimeType}'`,
          details: {
            detectedExtension: detectedExt,
            possibleSpoofing: true,
          },
        };
      }

      return {
        passed: true,
        detectedMimeType,
        declaredMimeType,
        reason: 'MIME type validation passed',
        details: {
          detectedExtension: detectedExt,
        },
      };
    } catch (error) {
      this.logger.error(`File validation error: ${error}`);
      return {
        passed: false,
        detectedMimeType: null,
        declaredMimeType,
        reason: `Validation error: ${error}`,
      };
    }
  }

  /**
   * Check if MIME type is in allowed list (loaded from configuration)
   */
  private isAllowedMimeType(mimeType: string): boolean {
    return this.allowedMimeTypes.has(mimeType);
  }

  /**
   * Check for significant MIME type mismatch (allowing minor variations)
   */
  private isMimeTypeMismatch(declared: string, detected: string): boolean {
    // Exact match
    if (declared === detected) {
      return false;
    }

    // Allow certain known variations
    const allowedVariations: Record<string, string[]> = {
      'application/zip': ['application/x-zip-compressed', 'application/zip'],
      'application/x-zip-compressed': [
        'application/zip',
        'application/x-zip-compressed',
      ],
      'image/jpeg': ['image/jpg', 'image/jpeg'],
      'text/plain': ['text/csv', 'text/plain'],
    };

    const variations = allowedVariations[declared] || [];
    if (variations.includes(detected)) {
      return false;
    }

    // Check if they're in the same major category (e.g., image/*, video/*)
    const declaredMajor = declared.split('/')[0];
    const detectedMajor = detected.split('/')[0];

    if (declaredMajor === detectedMajor) {
      // Same major category, but different subtypes - might be okay
      this.logger.warn(
        `MIME subtype mismatch but same category: ${declared} vs ${detected}`,
      );
      return false; // Allow for now
    }

    return true; // Significant mismatch
  }

  /**
   * Publish validation result to NATS
   */
  private async publishValidationResult(
    metadata: FileUploadedMessage['metadata'],
    validationResult: {
      passed: boolean;
      detectedMimeType: string | null;
      declaredMimeType: string;
      reason?: string;
      details?: Record<string, any>;
    },
  ) {
    const resultMessage: ValidationResultMessage = {
      uploadId: metadata.uploadId,
      objectName: metadata.objectName,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
      validator: 'base',
      status: validationResult.passed ? 'passed' : 'failed',
      validatedAt: new Date().toISOString(),
      issues: validationResult.passed
        ? undefined
        : [validationResult.reason || 'Unknown validation error'],
      declaredMimeType: validationResult.declaredMimeType,
      detectedMimeType: validationResult.detectedMimeType || undefined,
      details: validationResult.details,
    };

    // ✅ LOG NATS PUBLISH MESSAGE
    console.log('========================================');
    console.log('📨 [BASE VALIDATOR] PUBLISHING TO NATS');
    console.log('========================================');
    console.log(JSON.stringify(resultMessage, null, 2));
    console.log('========================================\n');

    // Record validation metrics for Prometheus
    this.metricsService.recordValidation(
      'base',
      resultMessage.status as 'passed' | 'failed',
    );

    await this.natsService.publishValidationResult(resultMessage);

    // Send webhook notification for MIME validation result
    const eventType = validationResult.passed
      ? WebhookEventType.MimeValidationPassed
      : WebhookEventType.MimeValidationFailed;

    await this.webhookService.sendWebhook(eventType, {
      uploadId: metadata.uploadId,
      objectName: metadata.objectName,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
      details: {
        validator: 'base',
        status: resultMessage.status,
        declaredMimeType: validationResult.declaredMimeType,
        detectedMimeType: validationResult.detectedMimeType,
        reason: validationResult.reason,
        validatedAt: resultMessage.validatedAt,
      },
    });
  }

  /**
   * Helper to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stop polling (for cleanup)
   */
  async stopPolling() {
    this.logger.log('Stopping base validation polling...');
    this.isPolling = false;
  }
}
