import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  connect,
  JetStreamClient,
  JetStreamManager,
  NatsConnection,
  RetentionPolicy,
  StorageType,
  StreamConfig,
} from 'nats';

import { natsConfigFactory } from '../config';
import { NatsConfig } from '../config/nats.config.interface';

export interface FileUploadedMessage {
  metadata: {
    uploadId: string;
    objectName: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    uploadedAt: string;
  };
}

export interface ValidationResultMessage {
  uploadId: string;
  objectName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  validator: string; // 'mime', 'clamav', 'combined'
  status: 'passed' | 'failed';
  validatedAt: string;
  issues?: string[];
  declaredMimeType?: string;
  detectedMimeType?: string;
  details?: Record<string, any>;
}

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsService.name);
  private natsConnection: NatsConnection | null = null;
  private jetStream: JetStreamClient | null = null;
  private jetStreamManager: JetStreamManager | null = null;

  constructor(
    @Inject(natsConfigFactory.KEY) private readonly config: NatsConfig,
  ) {}

  async onModuleInit() {
    try {
      this.logger.log(
        `Connecting to NATS servers: ${this.config.servers.join(', ')}`,
      );

      this.natsConnection = await connect({
        servers: this.config.servers,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
        reconnectTimeWait: this.config.reconnectTimeWait,
      });

      this.logger.log('Connected to NATS successfully');

      // Initialize JetStream
      this.jetStream = this.natsConnection.jetstream();
      this.jetStreamManager = await this.natsConnection.jetstreamManager();

      // Setup streams
      await this.setupStreams();

      this.logger.log('NATS JetStream initialized successfully');
    } catch (error) {
      if (error instanceof Error && error.message.includes('stream')) {
        this.logger.error(
          `Failed to setup NATS streams: ${error.message}. This is critical for file validation.`,
        );
      } else {
        this.logger.error(`Failed to connect to NATS: ${error}`);
      }
      this.logger.warn(
        'NATS is unavailable - server will run without message streaming. File validation and transfer features will not work.',
      );
      // Don't throw - allow the app to continue running
    }
  }

  async onModuleDestroy() {
    if (this.natsConnection) {
      await this.natsConnection.close();
      this.logger.log('NATS connection closed');
    }
  }

  private async setupStreams() {
    if (!this.jetStreamManager) {
      throw new Error('JetStream manager not initialized');
    }

    try {
      // Setup File Validation Stream - stores actual file data temporarily
      await this.createOrUpdateStream({
        name: this.config.streams.fileValidation.name,
        subjects: this.config.streams.fileValidation.subjects,
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
        max_msgs: 10000,
        max_bytes: 10 * 1024 * 1024 * 1024, // 10GB total storage for files (reduced from 100GB)
        max_msg_size: 100 * 1024 * 1024, // 100MB per message (reduced from 500MB)
      });

      this.logger.log(
        `Stream ${this.config.streams.fileValidation.name} is ready (supports up to 100MB per file)`,
      );

      // Setup Validation Results Stream
      await this.createOrUpdateStream({
        name: this.config.streams.validationResults.name,
        subjects: this.config.streams.validationResults.subjects,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: 30 * 24 * 60 * 60 * 1_000_000_000, // 30 days in nanoseconds
        max_msgs: 1000000,
        max_bytes: 5 * 1024 * 1024 * 1024, // 5GB for validation results (reasonable limit)
      });

      this.logger.log(
        `Stream ${this.config.streams.validationResults.name} is ready`,
      );
    } catch (error) {
      this.logger.error(`Failed to setup streams: ${error}`);
      throw error;
    }
  }

  private async createOrUpdateStream(config: Partial<StreamConfig>) {
    if (!this.jetStreamManager) {
      throw new Error('JetStream manager not initialized');
    }

    try {
      const streamInfo = await this.jetStreamManager.streams.info(config.name!);

      // Check if retention policy changed (can't update workqueue retention)
      if (streamInfo.config.retention !== config.retention) {
        this.logger.warn(
          `Stream ${config.name} retention policy changed. Deleting and recreating...`,
        );
        await this.jetStreamManager.streams.delete(config.name!);
        await this.jetStreamManager.streams.add(config);
        this.logger.log(
          `Stream ${config.name} recreated with new retention policy`,
        );
      } else {
        this.logger.log(`Stream ${config.name} already exists, updating...`);
        await this.jetStreamManager.streams.update(config.name!, config);
      }
    } catch (error: any) {
      if (error.message?.includes('stream not found')) {
        this.logger.log(`Creating stream ${config.name}...`);
        await this.jetStreamManager.streams.add(config);
      } else {
        throw error;
      }
    }
  }

  /**
   * Publish a file uploaded message to the validation queue
   * Only sends metadata - validators fetch file from S3 directly
   */
  async publishFileUploaded(message: FileUploadedMessage): Promise<void> {
    if (!this.jetStream) {
      this.logger.warn(
        'NATS JetStream unavailable - skipping file validation queue publish',
      );
      return;
    }

    try {
      const subjects = ['file.uploaded.base', 'file.uploaded.clamav'];
      // Send only metadata (no file data) to avoid MAX_PAYLOAD_EXCEEDED
      // Validators will fetch the file from S3 quarantined bucket directly
      const metadataJson = JSON.stringify(message.metadata);

      for (const subject of subjects) {
        const ack = await this.jetStream.publish(
          subject,
          Buffer.from(metadataJson),
        );
        this.logger.log(
          `Published file metadata to validation queue: ${message.metadata.objectName} (${message.metadata.fileSize} bytes, seq: ${ack.seq}, subject: ${subject})`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to publish file to validation queue: ${error}`);
      throw error;
    }
  }

  /**
   * Publish a validation result message
   */
  async publishValidationResult(
    message: ValidationResultMessage,
  ): Promise<void> {
    if (!this.jetStream) {
      this.logger.warn(
        'NATS JetStream unavailable - skipping validation result publish',
      );
      return;
    }

    try {
      const subject = `validation.${message.validator}.completed`;
      const data = JSON.stringify(message);

      const ack = await this.jetStream.publish(subject, Buffer.from(data));

      this.logger.log(
        `Published validation result: ${message.objectName} (${message.validator}: ${message.status}, seq: ${ack.seq})`,
      );
    } catch (error) {
      this.logger.error(`Failed to publish validation result: ${error}`);
      throw error;
    }
  }

  /**
   * Get JetStream client for direct access
   */
  getJetStream(): JetStreamClient | null {
    if (!this.jetStream) {
      this.logger.warn('JetStream not initialized - NATS may be unavailable');
      return null;
    }
    return this.jetStream;
  }

  /**
   * Get NATS connection for direct access
   */
  getConnection(): NatsConnection | null {
    if (!this.natsConnection) {
      this.logger.warn('NATS connection not initialized');
      return null;
    }
    return this.natsConnection;
  }

  /**
   * Check if NATS connection is established and healthy
   */
  async isConnected(): Promise<boolean> {
    if (!this.natsConnection) {
      return false;
    }

    try {
      // Check if connection is closed
      if (this.natsConnection.isClosed()) {
        return false;
      }

      // Connection exists and is not closed
      return true;
    } catch (error) {
      this.logger.warn(`NATS health check failed: ${error}`);
      return false;
    }
  }
}
