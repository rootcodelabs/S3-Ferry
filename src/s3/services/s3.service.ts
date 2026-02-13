import * as fs from 'fs';
import * as path from 'path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import * as minio from 'minio';

import {
  DataWithMetaResponseDto,
  FileDto,
  LocalFilesListMetaDto,
} from '../../common/dtos';
import { FileNotFoundException } from '../../common/exceptions';
import { s3ConfigFactory } from '../config';
import { S3Config } from '../config/s3.config.interface';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private minioClient: minio.Client;

  constructor(@Inject(s3ConfigFactory.KEY) private readonly config: S3Config) {
    // Parse endpoint URL to extract host, port, and SSL settings
    const endpointUrl = config.endpointUrl || '';
    const url = endpointUrl ? new URL(endpointUrl) : null;

    const clientConfig: any = {
      endPoint: url ? url.hostname : 'localhost',
      port: url?.port
        ? parseInt(url.port)
        : url?.protocol === 'https:'
          ? 443
          : 9000,
      useSSL: url?.protocol === 'https:' || false,
      accessKey: config.accessKeyId,
      secretKey: config.secretAccessKey,
    };

    this.minioClient = new minio.Client(clientConfig);
    this.logger.log(
      `MinIO client initialized with endpoint: ${clientConfig.endPoint}:${clientConfig.port} (SSL: ${clientConfig.useSSL})`,
    );
  }

  public async listFiles(): Promise<
    DataWithMetaResponseDto<FileDto[], LocalFilesListMetaDto>
  > {
    try {
      const files: FileDto[] = [];
      const objectsList = this.minioClient.listObjects(
        this.config.dataBucketName,
        this.config.dataBucketPath,
        false,
      );

      return new Promise((resolve, reject) => {
        objectsList.on('data', (obj: any) => {
          files.push(
            new FileDto({
              name: obj.name,
              size: obj.size,
              lastModified: obj.lastModified,
            }),
          );
        });

        objectsList.on('error', (error: any) => {
          this.logger.error(`Failed to list files: ${error}`);
          reject(error);
        });

        objectsList.on('end', () => {
          resolve({ data: files, meta: { count: files.length } });
        });
      });
    } catch (error) {
      this.logger.error(`List files failed: ${error}`);
      throw error;
    }
  }

  async copyFileFromRemoteToLocal(
    destinationFilePath: string,
    sourceFilePath: string,
    fsDataDirectoryPath: string,
  ): Promise<void> {
    try {
      const objectPath = path.join(this.config.dataBucketPath, sourceFilePath);
      const dataStream = await this.minioClient.getObject(
        this.config.dataBucketName,
        objectPath,
      );

      const writeStream = fs.createWriteStream(
        path.join(fsDataDirectoryPath, destinationFilePath),
      );

      await new Promise<void>((resolve, reject) => {
        dataStream.pipe(writeStream).on('finish', resolve).on('error', reject);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('The specified key does not exist')) {
        throw new FileNotFoundException('File not found in MinIO');
      }
      throw error;
    }
  }

  async copyFileFromLocalToRemote(
    sourceFilePath: string,
    destinationFilePath: string,
    fsDataDirectoryPath: string,
  ): Promise<void> {
    const fileExists = fs.existsSync(
      path.join(fsDataDirectoryPath, sourceFilePath),
    );
    if (!fileExists) throw new FileNotFoundException('File not found in FS');

    const filePath = path.join(fsDataDirectoryPath, sourceFilePath);
    const objectPath = path.join(
      this.config.dataBucketPath,
      destinationFilePath,
    );

    await this.minioClient.fPutObject(
      this.config.dataBucketName,
      objectPath,
      filePath,
    );
  }

  async initiateMultipartUpload(
    objectName: string,
    metadata: Record<string, string>,
  ): Promise<string> {
    try {
      this.logger.log(
        `[DEBUG] Initiating multipart upload with metadata: ${JSON.stringify(metadata)}`,
      );

      const uploadId = await this.minioClient.initiateNewMultipartUpload(
        'quarantined',
        objectName,
        metadata,
      );
      this.logger.log(`Multipart upload initiated to quarantine: ${uploadId}`);
      return uploadId;
    } catch (error) {
      this.logger.error(`Failed to initiate multipart upload: ${error}`);
      throw error;
    }
  }

  async generatePresignedUrls(
    objectName: string,
    uploadId: string,
    totalChunks: number,
  ): Promise<Array<{ partNumber: number; url: string }>> {
    const expiry = 3600; // 1 hour
    const urls: Array<{ partNumber: number; url: string }> = [];

    try {
      for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
        const url = await this.minioClient.presignedUrl(
          'PUT',
          'quarantined',
          objectName,
          expiry,
          {
            uploadId: uploadId,
            partNumber: partNumber.toString(),
          },
        );
        urls.push({ partNumber, url });
      }
      this.logger.log(
        `Generated ${totalChunks} presigned URLs for upload ${uploadId}`,
      );
      return urls;
    } catch (error) {
      this.logger.error(`Failed to generate presigned URLs: ${error}`);
      throw error;
    }
  }

  async completeMultipartUpload(
    objectName: string,
    uploadId: string,
    parts: Array<{ part: number; etag: string }>,
  ): Promise<void> {
    try {
      await this.minioClient.completeMultipartUpload(
        'quarantined',
        objectName,
        uploadId,
        parts,
      );
      this.logger.log(
        `Multipart upload completed in quarantine: ${objectName}`,
      );
    } catch (error) {
      this.logger.error(`Failed to complete multipart upload: ${error}`);
      throw error;
    }
  }

  async listUploadedParts(
    objectName: string,
    uploadId: string,
  ): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
    try {
      this.logger.log(
        `Listing parts for bucket=quarantined, objectName=${objectName}, uploadId=${uploadId}`,
      );

      // Use MinIO's listParts method (protected, but accessible via type casting)
      const minioClientAny = this.minioClient as any;

      // Check if listParts method exists
      if (typeof minioClientAny.listParts !== 'function') {
        this.logger.error('listParts method not available on MinIO client');
        throw new Error('listParts method not available');
      }

      const parts = await minioClientAny.listParts(
        'quarantined',
        objectName,
        uploadId,
      );

      this.logger.log(
        `Successfully listed ${parts?.length || 0} uploaded parts for ${objectName}`,
      );
      this.logger.debug(`Parts detail: ${JSON.stringify(parts)}`);

      if (!parts || !Array.isArray(parts)) {
        this.logger.warn(`listParts returned invalid data: ${typeof parts}`);
        return [];
      }

      return parts.map((part: any) => ({
        partNumber: part.part || part.partNumber || part.PartNumber,
        etag: part.etag || part.ETag,
        size: part.size || part.Size || 0,
      }));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';

      this.logger.error(`Failed to list uploaded parts for ${uploadId}:`);
      this.logger.error(`  Error message: ${errorMsg}`);
      this.logger.error(`  Error stack: ${errorStack}`);
      this.logger.error(`  Object name: ${objectName}`);
      this.logger.error(`  Upload ID: ${uploadId}`);

      if (
        errorMsg.includes('NoSuchUpload') ||
        errorMsg.includes('does not exist')
      ) {
        this.logger.warn(`Upload not found in MinIO: ${uploadId}`);
        return [];
      }

      // Log but don't throw - return empty array for graceful degradation
      this.logger.warn(
        `Returning empty array due to error - upload may not be tracked properly`,
      );
      return [];
    }
  }

  async objectExists(objectName: string): Promise<boolean> {
    try {
      await this.minioClient.statObject('quarantined', objectName);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCode = (error as any)?.code || '';

      // Handle various "not found" error formats
      if (
        errorMsg.toLowerCase().includes('not found') ||
        errorMsg.includes('NotFound') ||
        errorMsg.includes('does not exist') ||
        errorMsg.includes('NoSuchKey') ||
        errorCode === 'NotFound' ||
        errorCode === 'NoSuchKey'
      ) {
        return false;
      }

      this.logger.warn(
        `objectExists check for ${objectName} threw unexpected error: ${errorMsg}`,
      );
      throw error;
    }
  }

  /**
   * Download file from quarantine bucket as Buffer
   */
  async downloadFileAsBuffer(objectName: string): Promise<Buffer> {
    try {
      this.logger.log(`Downloading file from quarantine: ${objectName}`);

      const dataStream = await this.minioClient.getObject(
        'quarantined',
        objectName,
      );

      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];

        dataStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        dataStream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this.logger.log(
            `Downloaded ${buffer.length} bytes for ${objectName}`,
          );
          resolve(buffer);
        });

        dataStream.on('error', (error) => {
          this.logger.error(`Failed to download file: ${error}`);
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Failed to download file from quarantine: ${error}`);
      throw error;
    }
  }

  /**
   * Download a byte range from quarantine bucket as Buffer
   * Useful for MIME type detection which only needs the first few KB
   * @param objectName - The S3 object name
   * @param start - Start byte position (inclusive, 0-based)
   * @param end - End byte position (inclusive)
   */
  async downloadFileRangeAsBuffer(
    objectName: string,
    start: number,
    end: number,
  ): Promise<Buffer> {
    try {
      this.logger.log(
        `Downloading bytes ${start}-${end} from quarantine: ${objectName}`,
      );

      const dataStream = await this.minioClient.getPartialObject(
        'quarantined',
        objectName,
        start,
        end - start + 1, // getPartialObject expects length, not end position
      );

      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];

        dataStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        dataStream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this.logger.log(
            `Downloaded ${buffer.length} bytes (range ${start}-${end}) for ${objectName}`,
          );
          resolve(buffer);
        });

        dataStream.on('error', (error) => {
          this.logger.error(`Failed to download file range: ${error}`);
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error(
        `Failed to download file range from quarantine: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Download file as stream - efficient for large files
   * Returns the stream directly without loading into memory
   */
  async downloadFileAsStream(
    objectName: string,
  ): Promise<NodeJS.ReadableStream> {
    try {
      this.logger.log(`Streaming file from quarantine: ${objectName}`);

      const dataStream = await this.minioClient.getObject(
        'quarantined',
        objectName,
      );

      return dataStream;
    } catch (error) {
      this.logger.error(`Failed to stream file from quarantine: ${error}`);
      throw error;
    }
  }

  async generatePresignedDownloadUrl(
    objectName: string,
    bucketName?: string,
  ): Promise<{
    url: string;
    objectName: string;
    bucketName: string;
    expiresAt: number;
  }> {
    const expiry = 3600; // 1 hour
    const effectiveBucket = bucketName?.trim()
      ? bucketName.trim()
      : this.config.dataBucketName;

    try {
      // Check if object exists before generating presigned URL
      // objectName is the full S3 key (no need to prepend dataBucketPath)
      this.logger.debug(
        `Checking object existence: ${objectName} in bucket ${effectiveBucket}`,
      );
      await this.minioClient.statObject(effectiveBucket, objectName);

      this.logger.debug(`Object exists, generating presigned URL`);
      const url = await this.minioClient.presignedGetObject(
        effectiveBucket,
        objectName,
        expiry,
      );
      this.logger.log(
        `Generated presigned download URL for ${objectName} in bucket ${effectiveBucket}`,
      );
      return {
        url,
        objectName,
        bucketName: effectiveBucket,
        expiresAt: Math.floor(Date.now() / 1000) + expiry,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Download URL error for ${objectName}: ${errorMsg}`);
      if (
        errorMsg.includes('NotFound') ||
        errorMsg.includes('does not exist') ||
        errorMsg.includes('NoSuchKey')
      ) {
        this.logger.warn(
          `Object not found: ${objectName} in bucket ${effectiveBucket}`,
        );
        throw new FileNotFoundException(`File not found: ${objectName}`);
      }
      throw error;
    }
  }

  async generatePresignedUrlsForParts(
    objectName: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<Array<{ partNumber: number; url: string }>> {
    const expiry = 3600; // 1 hour
    const urls: Array<{ partNumber: number; url: string }> = [];

    try {
      for (const partNumber of partNumbers) {
        const url = await this.minioClient.presignedUrl(
          'PUT',
          'quarantined',
          objectName,
          expiry,
          {
            uploadId: uploadId,
            partNumber: partNumber.toString(),
          },
        );
        urls.push({ partNumber, url });
      }
      this.logger.log(
        `Generated ${urls.length} presigned URLs for parts: ${partNumbers.join(', ')}`,
      );
      return urls;
    } catch (error) {
      this.logger.error(
        `Failed to generate presigned URLs for parts: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Copy object from quarantined bucket to validated/flagged bucket
   */
  public async copyFromQuarantineToBucket(
    objectName: string,
    destinationBucket: string,
  ): Promise<void> {
    try {
      const targetBucket =
        destinationBucket === 'validated'
          ? this.config.dataBucketName
          : this.config.flaggedBucketName;

      // Ensure destination bucket exists
      const bucketExists = await this.minioClient.bucketExists(targetBucket);
      if (!bucketExists) {
        await this.minioClient.makeBucket(targetBucket, 'us-east-1');
        this.logger.log(`Created bucket: ${targetBucket}`);
      }

      // Copy object
      await this.minioClient.copyObject(
        targetBucket,
        objectName,
        `/${this.config.quarantinedBucketName}/${objectName}`,
      );

      this.logger.log(
        `Copied object ${objectName} from quarantined to ${targetBucket}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to copy object ${objectName} to ${destinationBucket}: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Delete object from quarantined bucket
   */
  public async deleteFromQuarantine(objectName: string): Promise<void> {
    try {
      await this.minioClient.removeObject(
        this.config.quarantinedBucketName,
        objectName,
      );
      this.logger.log(`Deleted object ${objectName} from quarantined bucket`);
    } catch (error) {
      this.logger.error(
        `Failed to delete object ${objectName} from quarantined: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Check if object exists in quarantined bucket
   */
  public async objectExistsInQuarantine(objectName: string): Promise<boolean> {
    try {
      await this.minioClient.statObject(
        this.config.quarantinedBucketName,
        objectName,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an object from S3
   */
  async deleteObject(
    objectName: string,
    bucketName?: string,
  ): Promise<{ objectName: string; bucketName: string }> {
    const bucket = bucketName || this.config.dataBucketName;

    try {
      this.logger.log(`Deleting object: ${objectName} from bucket: ${bucket}`);

      await this.minioClient.removeObject(bucket, objectName);

      this.logger.log(`Successfully deleted object: ${objectName}`);

      return {
        objectName,
        bucketName: bucket,
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);

      // Check if object doesn't exist
      if (
        errorMsg.includes('NotFound') ||
        errorMsg.includes('does not exist') ||
        errorMsg.includes('NoSuchKey')
      ) {
        this.logger.warn(
          `Object not found: ${objectName} in bucket: ${bucket}`,
        );
        throw new FileNotFoundException(
          `Object '${objectName}' not found in bucket '${bucket}'`,
        );
      }

      // Other errors - log and rethrow
      this.logger.error(`Failed to delete object ${objectName}: ${error}`);
      throw error;
    }
  }

  /**
   * Get object metadata from quarantine bucket
   */
  async getObjectMetadata(objectName: string): Promise<Record<string, string>> {
    try {
      this.logger.log(`[DEBUG] Getting metadata for object: ${objectName}`);

      const stat = await this.minioClient.statObject('quarantined', objectName);

      this.logger.log(
        `[DEBUG] statObject returned - size: ${stat.size}, etag: ${stat.etag}`,
      );
      this.logger.log(
        `[DEBUG] Full stat object keys: ${Object.keys(stat).join(', ')}`,
      );
      this.logger.log(
        `[DEBUG] metaData property: ${JSON.stringify(stat.metaData)}`,
      );
      this.logger.log(
        `[DEBUG] metaData keys: ${stat.metaData ? Object.keys(stat.metaData).join(', ') : 'NONE'}`,
      );

      return stat.metaData || {};
    } catch (error) {
      this.logger.error(
        `Failed to get metadata for object ${objectName}: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Check if object exists in quarantined bucket
   * @throws FileNotFoundException if object doesn't exist
   */
  async checkObjectExists(objectName: string): Promise<void> {
    try {
      await this.minioClient.statObject('quarantined', objectName);
      // If statObject succeeds, object exists
      this.logger.log(`[CHECK] Object exists: ${objectName}`);
    } catch (error: any) {
      // If statObject fails with NotFound error, object doesn't exist
      if (
        error.code === 'NotFound' ||
        error.message?.includes('does not exist')
      ) {
        throw new FileNotFoundException(
          `Object "${objectName}" does not exist in quarantined bucket`,
        );
      }
      // Other errors (permissions, network, etc.)
      this.logger.error(`Failed to check object existence: ${error}`);
      throw error;
    }
  }
}
