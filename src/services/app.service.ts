import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AzureAccountService, AzureBlobService } from '../azure/services';
import {
  CompleteUploadDto,
  CompleteUploadResponseDto,
  CopyFileBodyDto,
  CreateFileBodyDto,
  DataWithMetaResponseDto,
  DeleteFileBodyDto,
  DeleteS3ObjectDto,
  DeleteS3ObjectResponseDto,
  DownloadUrlQueryDto,
  DownloadUrlResponseDto,
  FileDto,
  InitiateUploadDto,
  InitiateUploadResponseDto,
  LocalFilesListMetaDto,
  ResumeUploadDto,
  ResumeUploadResponseDto,
  StorageAccountDto,
  UploadStatusQueryDto,
  UploadStatusResponseDto,
} from '../common/dtos';
import { StorageType } from '../common/enums';
import {
  FileNotFoundException,
  InternalServerException,
} from '../common/exceptions';
import { FsService } from '../fs';
import { MetricsService } from '../health/services';
import { NatsService } from '../nats';
import { S3Service } from '../s3';
import {
  calculateChunks,
  generateObjectName,
  prepareMetadata,
} from '../s3/utils';
import { WebhookEventType, WebhookService } from '../webhooks';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly dslConfig: any;

  constructor(
    private readonly fsService: FsService,
    private readonly s3Service: S3Service,
    private readonly azureAccountService: AzureAccountService,
    private readonly azureBlobService: AzureBlobService,
    private readonly configService: ConfigService,
    private readonly natsService: NatsService,
    private readonly webhookService: WebhookService,
    private readonly metricsService: MetricsService,
  ) {
    // Load DSL configuration from application.yml
    this.dslConfig = {
      defaults: this.configService.get('defaults') || {},
      fileTypes: this.configService.get('fileTypes') || {},
    };

    // Log DSL configuration for debugging
    this.logger.log(
      `DSL Config Loaded - Defaults: maxFileSize=${this.dslConfig.defaults.maxFileSize}, maxChunkSize=${this.dslConfig.defaults.maxChunkSize}`,
    );
    this.logger.log(
      `DSL Config - File types configured: ${Object.keys(this.dslConfig.fileTypes).join(', ')}`,
    );
  }

  async listFiles(
    storageType: StorageType,
  ): Promise<DataWithMetaResponseDto<FileDto[], LocalFilesListMetaDto>> {
    try {
      switch (storageType) {
        case StorageType.FS:
          return this.fsService.listFiles();

        case StorageType.S3:
          return await this.s3Service.listFiles();

        default:
          throw new Error(`Storage type not supported: ${storageType}`);
      }
    } catch (error) {
      this.logger.error(
        `Listing files failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw error;
    }
  }

  async copyFile(data: CopyFileBodyDto): Promise<void> {
    try {
      switch (data.destinationStorageType) {
        case StorageType.FS:
          await this.s3Service.copyFileFromRemoteToLocal(
            data.destinationFilePath,
            data.sourceFilePath,
            this.fsService.getDataDirectoryPath(),
          );
          break;

        case StorageType.S3:
          await this.s3Service.copyFileFromLocalToRemote(
            data.sourceFilePath,
            data.destinationFilePath,
            this.fsService.getDataDirectoryPath(),
          );
          break;
      }
    } catch (error) {
      this.logger.error(
        `Copying files failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw error instanceof FileNotFoundException
        ? new FileNotFoundException(error.message)
        : new InternalServerException();
    }
  }

  listAccounts(): StorageAccountDto[] {
    try {
      // For now, only return Azure accounts
      // In the future, this will aggregate accounts from all storage types
      return this.azureAccountService.listAccounts();
    } catch (error) {
      this.logger.error(
        `Listing storage accounts failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw error;
    }
  }

  async createFile(data: CreateFileBodyDto): Promise<void> {
    try {
      // Create files at all specified locations with the same content in parallel
      await Promise.all(
        data.files.map((file) => {
          // Infer storage type from account ID (e.g., "azure-account1" -> Azure, "s3-key" -> S3)
          if (file.storageAccountId.startsWith('azure-')) {
            return this.azureBlobService.createBlob(
              file.storageAccountId,
              file.container,
              file.fileName,
              data.content,
            );
          } else {
            const errorMessage = `Storage type not supported for account: ${file.storageAccountId}`;
            this.logger.error(
              `${errorMessage}. Account ID format should start with 'azure-' for Azure storage.`,
            );
            throw new BadRequestException(errorMessage);
          }
        }),
      );
    } catch (error) {
      // Re-throw HTTP exceptions (BadRequestException, NotFoundException, etc.)
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      // Log and wrap unexpected errors
      this.logger.error(
        `Creating file failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw new InternalServerException(
        `Failed to create file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async deleteFile(data: DeleteFileBodyDto): Promise<void> {
    try {
      // Delete files at all specified locations in parallel
      await Promise.all(
        data.files.map((file) => {
          // Infer storage type from account ID (e.g., "azure-account1" -> Azure, "s3-key" -> S3)
          if (file.storageAccountId.startsWith('azure-')) {
            return this.azureBlobService.deleteBlob(
              file.storageAccountId,
              file.container,
              file.fileName,
            );
          } else {
            const errorMessage = `Storage type not supported for account: ${file.storageAccountId}`;
            this.logger.error(
              `${errorMessage}. Account ID format should start with 'azure-' for Azure storage.`,
            );
            throw new BadRequestException(errorMessage);
          }
        }),
      );
    } catch (error) {
      // Re-throw HTTP exceptions (BadRequestException, NotFoundException, etc.)
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      // Log and wrap unexpected errors
      this.logger.error(
        `Deleting file failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw new InternalServerException(
        `Failed to delete file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async deleteFromS3(
    dto: DeleteS3ObjectDto,
  ): Promise<DeleteS3ObjectResponseDto> {
    try {
      // Validate input
      if (!dto.objectName || dto.objectName.trim() === '') {
        throw new BadRequestException('Object name cannot be empty');
      }

      if (dto.bucketName && dto.bucketName.trim() === '') {
        throw new BadRequestException('Bucket name cannot be empty');
      }

      this.logger.log(`Deleting S3 object: ${dto.objectName}`);

      const result = await this.s3Service.deleteObject(
        dto.objectName,
        dto.bucketName,
      );

      this.logger.log(`Successfully deleted S3 object: ${dto.objectName}`);

      return {
        objectName: result.objectName,
        bucketName: result.bucketName,
        status: 'deleted',
        message: `Object '${result.objectName}' successfully deleted from bucket '${result.bucketName}'`,
        deletedAt: new Date().toISOString(),
      };
    } catch (error) {
      // Re-throw HTTP exceptions (BadRequestException, FileNotFoundException, etc.)
      if (
        error instanceof BadRequestException ||
        error instanceof FileNotFoundException
      ) {
        throw error;
      }

      // Log and wrap unexpected errors
      this.logger.error(
        `Failed to delete S3 object: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw new InternalServerException(
        `Failed to delete S3 object: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getDownloadUrl(
    dto: DownloadUrlQueryDto,
  ): Promise<DownloadUrlResponseDto> {
    try {
      return await this.s3Service.generatePresignedDownloadUrl(
        dto.objectName,
        dto.bucketName,
      );
    } catch (error) {
      this.logger.error(
        `Failed to generate download URL: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw error;
    }
  }

  async initiateUpload(
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    // Get file extension and validate
    const extension = dto.fileName
      .substring(dto.fileName.lastIndexOf('.'))
      .toLowerCase();

    // Get configuration from DSL with defaults
    const defaults = this.dslConfig?.defaults || {};
    const maxFileSize = defaults.maxFileSize || 200 * 1024 * 1024; // Default: 200MB (matches application.yml)
    const maxChunkSize = defaults.maxChunkSize || 5 * 1024 * 1024; // Default: 5MB (matches application.yml)

    // Try to find file type specific config
    let fileTypeConfig = null;
    if (this.dslConfig?.fileTypes) {
      for (const [, config] of Object.entries(this.dslConfig.fileTypes)) {
        const ftConfig: any = config;
        if (
          ftConfig.mimeTypes?.includes(dto.mimeType) ||
          ftConfig.extensions?.includes(extension)
        ) {
          fileTypeConfig = ftConfig;
          break;
        }
      }
    }

    // Use file type specific limits if found, otherwise use defaults
    const effectiveMaxFileSize = fileTypeConfig?.maxFileSize || maxFileSize;
    const effectiveMaxChunkSize = fileTypeConfig?.maxChunkSize || maxChunkSize;

    // Validate file size
    if (dto.fileSize > effectiveMaxFileSize) {
      throw new BadRequestException(
        `File size ${dto.fileSize} exceeds maximum allowed size ${effectiveMaxFileSize}`,
      );
    }

    // Calculate chunks
    const chunkCalculation = calculateChunks(
      dto.fileSize,
      effectiveMaxChunkSize,
    );

    // Load object naming configuration from DSL
    const objectNamingConfig = this.dslConfig?.objectNaming || {
      strategy: 'unique',
      replaceOnUpload: false,
      includeDatePath: true,
    };

    // Generate object name based on DSL strategy
    const objectName = generateObjectName(dto.fileName, objectNamingConfig);

    // Check if file exists when using filename strategy and replaceOnUpload is false
    if (
      objectNamingConfig.strategy === 'filename' &&
      !objectNamingConfig.replaceOnUpload
    ) {
      try {
        // Check if object already exists in quarantined bucket
        await this.s3Service.checkObjectExists(objectName);
        // If we reach here, object exists
        throw new BadRequestException(
          `File "${dto.fileName}" already exists. ` +
            `Set objectNaming.replaceOnUpload: true in configuration to allow replacement, ` +
            `or use objectNaming.strategy: unique for automatic unique names.`,
        );
      } catch (error: any) {
        // FileNotFoundException means object doesn't exist - this is good, continue
        if (error.message?.includes('does not exist')) {
          // Object doesn't exist, safe to upload
          this.logger.log(
            `[NAMING] Object name "${objectName}" is available for upload`,
          );
        } else {
          // Some other error occurred, or object exists (re-throw)
          throw error;
        }
      }
    } else if (
      objectNamingConfig.strategy === 'filename' &&
      objectNamingConfig.replaceOnUpload
    ) {
      this.logger.log(
        `[NAMING] Using filename strategy with replace enabled for "${objectName}"`,
      );
    } else {
      this.logger.log(
        `[NAMING] Using unique strategy for "${objectName}" (UUID-based)`,
      );
    }

    // Prepare metadata
    const metadata = prepareMetadata(dto);
    this.logger.log(
      `[DEBUG] Prepared metadata for ${dto.fileName}: ${JSON.stringify(metadata)}`,
    );

    let uploadId: string;
    let presignedUrls: Array<{ partNumber: number; url: string }>;

    // Handle different storage types
    switch (dto.storageType) {
      case StorageType.S3:
        uploadId = await this.s3Service.initiateMultipartUpload(
          objectName,
          metadata,
        );
        presignedUrls = await this.s3Service.generatePresignedUrls(
          objectName,
          uploadId,
          chunkCalculation.totalChunks,
        );
        break;

      // Add Azure support if needed
      // case StorageType.Azure:
      //   const result = await this.azureBlobService.initiateMultipartUpload(...);
      //   uploadId = result.uploadId;
      //   presignedUrls = await this.azureBlobService.generatePresignedUrls(...);
      //   break;

      default:
        throw new BadRequestException(
          `Storage type not supported: ${dto.storageType}`,
        );
    }

    // Build chunks with URLs
    const chunks = chunkCalculation.chunks.map((chunk, index) => ({
      chunkNumber: chunk.chunkNumber,
      size: chunk.size,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      presignedUrl: presignedUrls[index].url,
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
    }));

    // Record upload initiated metric
    this.metricsService.recordUpload('initiated');

    // Return response
    return {
      uploadId,
      objectName,
      totalChunks: chunkCalculation.totalChunks,
      chunkSize: chunkCalculation.chunkSize,
      lastChunkSize: chunkCalculation.lastChunkSize,
      totalSize: dto.fileSize,
      chunks,
      initiatedAt: new Date().toISOString(),
      configuration: {
        maxFileSize: effectiveMaxFileSize,
        maxChunkSize: effectiveMaxChunkSize,
        fileType: `${dto.mimeType} (${extension})`,
      },
    };
  }

  async completeUpload(
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB minimum per part

    this.logger.log(`[DEBUG] Complete upload request for ${dto.uploadId}:`);
    this.logger.log(`[DEBUG] Received ${dto.parts.length} parts`);
    this.logger.log(
      `[DEBUG] Parts before sorting: ${dto.parts.map((p) => `${p.partNumber}(${p.partSize})`).join(', ')}`,
    );

    // Sort parts by part number to ensure proper validation
    const sortedParts = [...dto.parts].sort(
      (a, b) => a.partNumber - b.partNumber,
    );

    this.logger.log(
      `[DEBUG] Parts after sorting: ${sortedParts.map((p) => `${p.partNumber}(${p.partSize})`).join(', ')}`,
    );
    this.logger.log(
      `[DEBUG] Last part (should skip validation): part ${sortedParts[sortedParts.length - 1].partNumber}, size: ${sortedParts[sortedParts.length - 1].partSize}`,
    );

    // Validate parts meet minimum requirements (all parts except the last must be >= 5MB)
    if (sortedParts.length > 1) {
      for (let i = 0; i < sortedParts.length - 1; i++) {
        const part = sortedParts[i];
        this.logger.log(
          `[DEBUG] Validating part ${part.partNumber}: ${part.partSize} bytes`,
        );
        if (part.partSize < MIN_PART_SIZE) {
          throw new BadRequestException(
            `Part ${part.partNumber} size (${part.partSize} bytes) is below minimum of ${MIN_PART_SIZE} bytes. Only the last part can be smaller than 5MB.`,
          );
        }
      }
    }

    this.logger.log(`[OK] All parts validated successfully`);

    // Use sorted parts for the rest of the processing
    dto.parts = sortedParts;

    // Transform parts to storage format
    const parts = dto.parts.map((p) => ({
      part: p.partNumber,
      etag: p.etag,
    }));

    // Complete multipart upload (currently only S3 is implemented)
    await this.s3Service.completeMultipartUpload(
      dto.objectName,
      dto.uploadId,
      parts,
    );

    this.logger.log(`[OK] Upload ${dto.uploadId} completed successfully`);

    // Calculate total file size from parts
    const totalSize = dto.parts.reduce((sum, p) => sum + p.partSize, 0);

    // Extract file name from object name
    const fileName = dto.objectName.split('/').pop() || dto.objectName;

    // Push file metadata to NATS JetStream for validation
    try {
      this.logger.log(
        `Publishing file metadata to validation queue: ${dto.objectName}`,
      );

      // Retrieve object metadata to get the correct MIME type
      const metadata = await this.s3Service.getObjectMetadata(dto.objectName);
      this.logger.log(
        `[DEBUG] Retrieved metadata from S3: ${JSON.stringify(metadata)}`,
      );

      const mimeType = metadata['content-type'] || 'application/octet-stream';

      this.logger.log(
        `[DEBUG] Extracted MIME type: ${mimeType} (from key 'content-type') for ${dto.objectName}`,
      );

      if (!metadata['content-type']) {
        this.logger.warn(
          `[WARNING] 'content-type' key not found in metadata! Available keys: ${Object.keys(metadata).join(', ')}`,
        );
      }

      // Publish metadata only - consumers will download from S3 directly
      await this.natsService.publishFileUploaded({
        metadata: {
          uploadId: dto.uploadId,
          objectName: dto.objectName,
          fileName: fileName,
          fileSize: totalSize,
          mimeType: mimeType,
          uploadedAt: new Date().toISOString(),
        },
      });

      this.logger.log(
        `[OK] File metadata published to NATS validation queue: ${dto.objectName} (${totalSize} bytes) with MIME type: ${mimeType}`,
      );

      // Send webhook notification for upload completion
      await this.webhookService.sendWebhook(WebhookEventType.UploadCompleted, {
        uploadId: dto.uploadId,
        objectName: dto.objectName,
        fileName: fileName,
        fileSize: totalSize,
        mimeType: mimeType,
        details: {
          uploadedAt: new Date().toISOString(),
          status: 'awaiting_validation',
        },
      });
    } catch (error) {
      // Log error but don't fail the upload
      this.logger.error(
        `Failed to push file to NATS validation queue: ${error}. File is in S3 quarantine but validation queue not populated.`,
      );
    }

    // Record upload completed metric
    this.metricsService.recordUpload('completed');

    return {
      uploadId: dto.uploadId,
      objectName: dto.objectName,
      status: 'completed',
      message: 'File uploaded successfully and queued for validation',
      completedAt: new Date().toISOString(),
    };
  }

  async getUploadStatus(
    dto: UploadStatusQueryDto,
  ): Promise<UploadStatusResponseDto> {
    try {
      // First, check if the object already exists (completed upload)
      const objectExists = await this.s3Service.objectExists(dto.objectName);

      if (objectExists) {
        // Upload is completed - all chunks were uploaded
        this.logger.log(`Upload completed for ${dto.objectName}`);
        return {
          uploadId: dto.uploadId,
          objectName: dto.objectName,
          uploadedChunks: 0,
          uploadedParts: [],
          status: 'completed',
        };
      }

      // Get list of uploaded parts from S3
      const uploadedParts = await this.s3Service.listUploadedParts(
        dto.objectName,
        dto.uploadId,
      );

      // If no parts found, upload not found or hasn't started
      if (uploadedParts.length === 0) {
        return {
          uploadId: dto.uploadId,
          objectName: dto.objectName,
          uploadedChunks: 0,
          uploadedParts: [],
          status: 'not-found',
        };
      }

      this.logger.log(
        `Upload status for ${dto.uploadId}: ${uploadedParts.length} chunks uploaded`,
      );

      return {
        uploadId: dto.uploadId,
        objectName: dto.objectName,
        uploadedChunks: uploadedParts.length,
        uploadedParts: uploadedParts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
          size: part.size,
        })),
        status: 'in-progress',
      };
    } catch (error) {
      // Log the error for debugging but return graceful response instead of throwing
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Upload status query failed for ${dto.uploadId}: ${errorMsg}`,
      );

      // Return not-found status instead of throwing error
      return {
        uploadId: dto.uploadId,
        objectName: dto.objectName,
        uploadedChunks: 0,
        uploadedParts: [],
        status: 'not-found',
      };
    }
  }

  async resumeUpload(dto: ResumeUploadDto): Promise<ResumeUploadResponseDto> {
    try {
      // Extract file extension
      const extension = dto.fileName.includes('.')
        ? `.${dto.fileName.split('.').pop()}`
        : '';

      // Get defaults from DSL config
      const defaults = this.dslConfig?.defaults || {};
      const maxChunkSize = defaults.maxChunkSize || 5 * 1024 * 1024; // Default: 5MB

      // Try to find file type specific config
      let fileTypeConfig = null;
      if (this.dslConfig?.fileTypes) {
        for (const [, config] of Object.entries(this.dslConfig.fileTypes)) {
          const ftConfig: any = config;
          if (
            ftConfig.mimeTypes?.includes(dto.mimeType) ||
            ftConfig.extensions?.includes(extension)
          ) {
            fileTypeConfig = ftConfig;
            break;
          }
        }
      }

      // Use file type specific chunk size if found, otherwise use default
      const effectiveMaxChunkSize =
        fileTypeConfig?.maxChunkSize || maxChunkSize;

      // Calculate chunks based on file size
      const chunkCalculation = calculateChunks(
        dto.fileSize,
        effectiveMaxChunkSize,
      );

      this.logger.log(
        `Resume upload: calculated ${chunkCalculation.totalChunks} total chunks for ${dto.fileName} (${dto.fileSize} bytes)`,
      );

      // Get the current upload status to determine which chunks are already uploaded
      const status = await this.getUploadStatus({
        uploadId: dto.uploadId,
        objectName: dto.objectName,
      });

      if (status.status === 'not-found') {
        throw new NotFoundException(
          `Upload ${dto.uploadId} not found or has no uploaded parts`,
        );
      }

      if (status.status === 'completed') {
        throw new BadRequestException(
          'Upload is already completed. No chunks needed.',
        );
      }

      // Calculate missing chunks: all chunks from 1 to totalChunks minus uploaded ones
      const uploadedPartNumbers = status.uploadedParts.map((p) => p.partNumber);
      const missingChunks: number[] = [];
      for (let i = 1; i <= chunkCalculation.totalChunks; i++) {
        if (!uploadedPartNumbers.includes(i)) {
          missingChunks.push(i);
        }
      }

      if (missingChunks.length === 0) {
        throw new BadRequestException(
          'All chunks have already been uploaded. Use complete endpoint to finalize.',
        );
      }

      this.logger.log(
        `Resume upload: ${missingChunks.length} missing chunks detected - [${missingChunks.join(', ')}]`,
      );

      // Generate presigned URLs for the missing chunks
      const presignedUrls = await this.s3Service.generatePresignedUrlsForParts(
        dto.objectName,
        dto.uploadId,
        missingChunks,
      );

      // Build chunk info with correct byte ranges from calculated chunks
      const chunks = presignedUrls.map((urlInfo) => {
        const chunkInfo = chunkCalculation.chunks.find(
          (c) => c.chunkNumber === urlInfo.partNumber,
        );

        if (!chunkInfo) {
          throw new Error(
            `Chunk info not found for part ${urlInfo.partNumber}`,
          );
        }

        return {
          chunkNumber: urlInfo.partNumber,
          size: chunkInfo.size,
          startByte: chunkInfo.startByte,
          endByte: chunkInfo.endByte,
          presignedUrl: urlInfo.url,
          expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour
        };
      });

      this.logger.log(
        `Resume upload: generated ${chunks.length} new URLs for ${dto.uploadId}`,
      );

      return {
        uploadId: dto.uploadId,
        objectName: dto.objectName,
        chunks,
        generatedAt: new Date().toISOString(),
        urlsGenerated: chunks.length,
        status: status.status,
        uploadedChunks: status.uploadedChunks,
        totalChunks: chunkCalculation.totalChunks,
        uploadedParts: status.uploadedParts,
        missingChunks: missingChunks,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to resume upload: ${error instanceof Error ? error.stack : String(error)}`,
      );
      throw new InternalServerException(
        `Failed to resume upload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
