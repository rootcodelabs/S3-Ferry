import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Version,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import { ApiOkDataWithMetaResponse } from './common/decorators';
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
  ListFilesQueryDto,
  LocalFilesListMetaDto,
  ResumeUploadDto,
  ResumeUploadResponseDto,
  StorageAccountDto,
  UploadStatusQueryDto,
  UploadStatusResponseDto,
} from './common/dtos';
import { AppService } from './services';

@Controller('')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private readonly appService: AppService) {}

  @Get('/')
  @ApiOperation({ summary: 'Root' })
  get(): { data: string } {
    return { data: 'Storage Ferry' };
  }

  @Version('1')
  @Get('/storage-accounts')
  @ApiOkResponse({
    type: [StorageAccountDto],
    description: 'List all available storage accounts',
  })
  @ApiOperation({ summary: 'List all available storage accounts' })
  listStorageAccounts(): StorageAccountDto[] {
    return this.appService.listAccounts();
  }

  @Version('1')
  @Get('/files')
  @ApiOkDataWithMetaResponse({
    data: { type: FileDto, isArray: true },
    meta: { type: LocalFilesListMetaDto },
  })
  @ApiOperation({ summary: 'List local or remote files' })
  async listFiles(
    @Query() query: ListFilesQueryDto,
  ): Promise<DataWithMetaResponseDto<FileDto[], LocalFilesListMetaDto>> {
    return await this.appService.listFiles(query.type);
  }

  @Version('1')
  @Post('/files/copy')
  @ApiOperation({ summary: 'Copy file from source to destination' })
  async copyFile(@Body() data: CopyFileBodyDto): Promise<void> {
    return this.appService.copyFile(data);
  }

  @Version('1')
  @Post('/files/create')
  @ApiOperation({ summary: 'Create a file in storage' })
  async createFile(@Body() data: CreateFileBodyDto): Promise<void> {
    return this.appService.createFile(data);
  }

  @Version('1')
  @Delete('/files/delete')
  @ApiOperation({ summary: 'Delete a file from storage' })
  async deleteFile(@Body() data: DeleteFileBodyDto): Promise<void> {
    return this.appService.deleteFile(data);
  }

  @Version('1')
  @Get('/files/download-url')
  @ApiOperation({ summary: 'Get presigned download URL' })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL generated',
    type: DownloadUrlResponseDto,
  })
  async getDownloadUrl(
    @Query() query: DownloadUrlQueryDto,
  ): Promise<DownloadUrlResponseDto> {
    return this.appService.getDownloadUrl(query);
  }

  @Version('1')
  @Post('/upload/initiate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Initiate multipart file upload',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Upload initiated',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 413, description: 'File too large' })
  async initiateUpload(
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    this.logger.log(
      `Initiating upload for ${dto.fileName} (${dto.fileSize} bytes)`,
    );
    return this.appService.initiateUpload(dto);
  }

  @Version('1')
  @Post('/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete multipart upload',
    description: 'Finalizes the upload after all chunks are uploaded.',
  })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Upload completed',
    type: CompleteUploadResponseDto,
  })
  async completeUpload(
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    this.logger.log(`Completing upload: ${dto.uploadId}`);
    return this.appService.completeUpload(dto);
  }

  @Version('1')
  @Get('/upload/status')
  @ApiOperation({
    summary: 'Get upload status',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload status retrieved',
    type: UploadStatusResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Upload not found' })
  async getUploadStatus(
    @Query() query: UploadStatusQueryDto,
  ): Promise<UploadStatusResponseDto> {
    this.logger.log(`Getting upload status: ${query.uploadId}`);
    return this.appService.getUploadStatus(query);
  }

  @Version('1')
  @Post('/upload/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume interrupted upload',
    description:
      'Calculates total chunks from file size and generates presigned URLs only for missing chunks. Requires file metadata to determine chunk boundaries.',
  })
  @ApiBody({ type: ResumeUploadDto })
  @ApiResponse({
    status: 200,
    description: 'New presigned URLs generated for missing chunks',
    type: ResumeUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or all chunks already uploaded',
  })
  @ApiResponse({ status: 404, description: 'Upload not found' })
  async resumeUpload(
    @Body() dto: ResumeUploadDto,
  ): Promise<ResumeUploadResponseDto> {
    this.logger.log(
      `Resuming upload: ${dto.uploadId} for file ${dto.fileName} (${dto.fileSize} bytes)`,
    );
    return this.appService.resumeUpload(dto);
  }

  @Version('1')
  @Delete('/s3/delete')
  @ApiOperation({
    summary: 'Delete an object from S3 storage',
  })
  @ApiBody({ type: DeleteS3ObjectDto })
  @ApiResponse({
    status: 200,
    description: 'Object deleted successfully',
    type: DeleteS3ObjectResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Object not found' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async deleteS3Object(
    @Body() dto: DeleteS3ObjectDto,
  ): Promise<DeleteS3ObjectResponseDto> {
    this.logger.log(`Deleting S3 object: ${dto.objectName}`);
    return this.appService.deleteFromS3(dto);
  }
}
