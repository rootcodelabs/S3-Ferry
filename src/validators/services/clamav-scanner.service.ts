import * as net from 'net';
import { Readable } from 'stream';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetricsService } from '../../health/services';
import {
  FileUploadedMessage,
  NatsService,
  ValidationResultMessage,
} from '../../nats';
import { S3Service } from '../../s3/services/s3.service';
import { WebhookEventType, WebhookService } from '../../webhooks';

@Injectable()
export class ClamavScannerService implements OnModuleInit {
  private readonly logger = new Logger(ClamavScannerService.name);
  private isPolling = false;
  private readonly host: string;
  private readonly port: number;

  constructor(
    private readonly natsService: NatsService,
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly metricsService: MetricsService,
  ) {
    this.host = this.configService.get<string>('CLAMAV_HOST') || 'localhost';
    this.port = Number(this.configService.get<string>('CLAMAV_PORT') || 3310);
    this.logger.log(`ClamAV Scanner configured: ${this.host}:${this.port}`);
  }

  async onModuleInit() {
    this.logger.log('ClamAV Scanner starting...');
    await this.verifyClamAV();
    this.startPolling();
  }

  /**
   * Verify ClamAV with EICAR test
   */
  private async verifyClamAV() {
    try {
      const eicar =
        'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
      const result = await this.scanStream(Readable.from([Buffer.from(eicar)]));
      this.logger.log(`ClamAV Test Result: ${result}`);
      this.logger.log('✅ ClamAV is ready');
    } catch (error) {
      this.logger.error(
        `❌ ClamAV verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Start polling NATS for scan requests
   */
  private async startPolling() {
    if (this.isPolling) return;

    this.isPolling = true;
    this.logger.log('Starting NATS polling...');

    try {
      const jetStream = this.natsService.getJetStream();
      if (!jetStream) {
        this.logger.warn('NATS JetStream not available');
        this.isPolling = false;
        return;
      }

      const consumer = await jetStream.consumers.get(
        'FILE_VALIDATION',
        'clamav-scanner',
      );

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
              this.logger.error(
                `Processing failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              msg.nak();
            }
          }
        } catch (error: any) {
          if (
            error.message?.includes('timeout') ||
            error.message?.includes('no messages')
          ) {
            await this.sleep(1000);
          } else {
            this.logger.error(`Polling error: ${error.message}`);
            await this.sleep(5000);
          }
        }
      }
    } catch (error: any) {
      if (error.message?.includes('consumer not found')) {
        this.logger.log('Creating ClamAV consumer...');
        await this.createConsumer();
        this.isPolling = false;
        setTimeout(() => this.startPolling(), 2000);
      } else {
        this.logger.error(`NATS unavailable: ${error.message}`);
        this.isPolling = false;
      }
    }
  }

  /**
   * Process single message from NATS
   */
  private async processMessage(msg: any) {
    const data = JSON.parse(msg.string());
    const metadata = data.metadata || data;

    this.logger.log('='.repeat(50));
    this.logger.log('📥 SCANNING FILE (STREAMING)');
    this.logger.log(`   File: ${metadata.fileName}`);
    this.logger.log(`   Size: ${metadata.fileSize} bytes`);
    this.logger.log(`   Object: ${metadata.objectName}`);
    this.logger.log('='.repeat(50));

    try {
      const scanResult = await this.scanFileFromS3(metadata.objectName);

      this.logger.log('='.repeat(50));
      this.logger.log('📤 SCAN RESULT');
      this.logger.log(`Status: ${scanResult.passed ? 'CLEAN' : 'ERROR'}`);
      this.logger.log(`   Raw: ${scanResult.rawResult}`);
      if (scanResult.signature) {
        this.logger.log(`   Virus: ${scanResult.signature}`);
      }
      this.logger.log('='.repeat(50));

      await this.publishResult(metadata, scanResult);
    } catch (error: any) {
      // Handle scan errors (empty response, connection issues, etc.)
      this.logger.error('='.repeat(50));
      this.logger.error('📤 SCAN ERROR');
      this.logger.error(`   Status: ⚠️ SCAN FAILED`);
      this.logger.error(`   Error: ${error.message}`);
      this.logger.error('='.repeat(50));

      // Publish error result
      await this.publishResult(metadata, {
        passed: false,
        rawResult: `Scan Error: ${error.message}`,
        signature: undefined,
      });

      // Re-throw to NAK the message for retry
      throw error;
    }
  }

  /**
   * Scan file from S3 using streaming (zero-copy)
   */
  private async scanFileFromS3(objectName: string): Promise<{
    passed: boolean;
    rawResult: string;
    signature?: string;
  }> {
    try {
      this.logger.log('🌊 Starting stream from S3 to ClamAV...');

      // Get readable stream from S3
      const s3Stream = await this.s3Service.downloadFileAsStream(objectName);

      // Scan the stream
      const result = await this.scanStream(s3Stream);

      this.logger.log(`📋 ClamAV Response: "${result}"`);

      // Handle empty response
      if (!result || result.trim() === '') {
        this.logger.error(
          '❌ ClamAV returned empty response - possible connection issue or scan failure',
        );
        throw new Error(
          'ClamAV scan failed: No response from antivirus scanner',
        );
      }

      // Parse result
      if (result.includes('OK')) {
        return { passed: true, rawResult: result };
      }

      if (result.includes('FOUND')) {
        const match = result.match(/:\s*(.+?)\s+FOUND/);
        const signature = match ? match[1] : 'Unknown';
        return { passed: false, rawResult: result, signature };
      }

      // Unknown response format
      this.logger.warn(
        `⚠️ Unexpected ClamAV response format: "${result}" - treating as scan error`,
      );
      throw new Error(`ClamAV scan failed: Unexpected response format`);
    } catch (error: any) {
      this.logger.error(`❌ Scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scan a readable stream with ClamAV using INSTREAM protocol
   * Stream flows: S3 -> Network -> ClamAV (zero-copy, no memory buffering)
   */
  private async scanStream(
    inputStream: NodeJS.ReadableStream,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let responseData = '';
      let bytesWritten = 0;

      // Timeout handler
      const timeout = setTimeout(() => {
        socket.destroy();
        if (
          'destroy' in inputStream &&
          typeof inputStream.destroy === 'function'
        ) {
          inputStream.destroy();
        }
        reject(new Error('ClamAV scan timeout after 120s'));
      }, 120000);

      // Socket event handlers
      socket.on('data', (data: Buffer) => {
        responseData += data.toString();
        this.logger.debug(`📨 Received data from ClamAV: ${data.toString()}`);
      });

      socket.on('end', () => {
        clearTimeout(timeout);
        this.logger.log(
          `✅ ClamAV connection closed. Total bytes sent: ${bytesWritten}`,
        );
        resolve(responseData.trim());
      });

      socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        if (
          'destroy' in inputStream &&
          typeof inputStream.destroy === 'function'
        ) {
          inputStream.destroy();
        }
        this.logger.error(`❌ Socket error: ${err.message}`);
        reject(err);
      });

      // Connect to ClamAV
      socket.connect(this.port, this.host, () => {
        this.logger.log(`📡 Connected to ClamAV at ${this.host}:${this.port}`);

        // Send INSTREAM command
        socket.write('nINSTREAM\n');
        this.logger.log('📤 Sent INSTREAM command');

        // Stream data from S3 to ClamAV
        inputStream.on('data', (chunk: Buffer) => {
          // Send chunk length (4 bytes, big-endian)
          const lengthBuffer = Buffer.alloc(4);
          lengthBuffer.writeUInt32BE(chunk.length, 0);
          socket.write(lengthBuffer);

          // Send chunk data
          socket.write(chunk);

          bytesWritten += chunk.length;
          this.logger.debug(
            `📤 Sent chunk: ${chunk.length} bytes (total: ${bytesWritten})`,
          );
        });

        inputStream.on('end', () => {
          this.logger.log('🏁 Stream ended, sending terminator');

          // Send terminator (4 bytes of zeros)
          const terminator = Buffer.alloc(4);
          terminator.writeUInt32BE(0, 0);
          socket.write(terminator);

          this.logger.log('✅ Terminator sent, waiting for ClamAV response...');

          // DON'T call socket.end() - let ClamAV close the connection
        });

        inputStream.on('error', (err: Error) => {
          clearTimeout(timeout);
          socket.destroy();
          this.logger.error(`❌ Stream error: ${err.message}`);
          reject(err);
        });
      });
    });
  }

  /**
   * Create NATS consumer
   */
  private async createConsumer() {
    const connection = this.natsService.getConnection();
    if (!connection) {
      this.logger.warn('NATS connection not available');
      return;
    }

    const jsm = await connection.jetstreamManager();

    await jsm.consumers.add('FILE_VALIDATION', {
      durable_name: 'clamav-scanner',
      ack_policy: 'explicit' as any,
      deliver_policy: 'all' as any,
      filter_subject: 'file.uploaded.clamav',
      max_deliver: 3,
      ack_wait: 60_000_000_000,
    });

    this.logger.log('✅ ClamAV consumer created');
  }

  /**
   * Publish validation result
   */
  private async publishResult(
    metadata: FileUploadedMessage['metadata'],
    scanResult: { passed: boolean; rawResult: string; signature?: string },
  ) {
    // Determine if this is an error case (rawResult contains "Error" or "Scan Error")
    const isScanError =
      scanResult.rawResult.includes('Error:') ||
      scanResult.rawResult.includes('Scan Error:');

    const message: ValidationResultMessage = {
      uploadId: metadata.uploadId,
      objectName: metadata.objectName,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
      validator: 'clamav',
      status: scanResult.passed ? 'passed' : 'failed',
      validatedAt: new Date().toISOString(),
      issues: scanResult.passed
        ? undefined
        : isScanError
          ? [`Scan error: ${scanResult.rawResult}`]
          : [
              scanResult.signature
                ? `Virus detected: ${scanResult.signature}`
                : 'File infected',
            ],
      details: {
        rawResult: scanResult.rawResult,
        signature: scanResult.signature,
        scanError: isScanError,
      },
    };

    this.logger.log('📨 Publishing to NATS...');

    // Record validation metrics for Prometheus
    this.metricsService.recordValidation(
      'clamav',
      message.status as 'passed' | 'failed',
    );

    await this.natsService.publishValidationResult(message);
    this.logger.log('✅ Result published');

    // Send webhook notification for ClamAV scan result
    const eventType = scanResult.passed
      ? WebhookEventType.ClamAvScanPassed
      : WebhookEventType.ClamAvScanFailed;

    await this.webhookService.sendWebhook(eventType, {
      uploadId: metadata.uploadId,
      objectName: metadata.objectName,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      mimeType: metadata.mimeType,
      details: {
        validator: 'clamav',
        status: message.status,
        rawResult: scanResult.rawResult,
        signature: scanResult.signature,
        scanError: isScanError,
        validatedAt: message.validatedAt,
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stopPolling() {
    this.logger.log('Stopping ClamAV polling...');
    this.isPolling = false;
  }

  /**
   * Check if ClamAV is healthy and responding
   */
  async isHealthy(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 3000); // 3 second timeout

      socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        socket.write('PING\n');
      });

      socket.on('data', (data) => {
        clearTimeout(timeout);
        const response = data.toString().trim();
        socket.destroy();
        resolve(response === 'PONG');
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }
}
