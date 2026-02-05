import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class InitiateUploadDto {
  @ApiProperty({
    description: 'File name with extension',
    example: 'contract-2024.pdf',
  })
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @ApiProperty({
    description: 'File size in bytes',
    example: 10485760,
    minimum: 1,
  })
  @IsNumber()
  @Min(1)
  fileSize!: number;

  @ApiProperty({
    description: 'MIME type of the file',
    example: 'application/pdf',
  })
  @IsString()
  @IsNotEmpty()
  mimeType!: string;
}

export class ChunkInfoDto {
  @ApiProperty()
  chunkNumber!: number;

  @ApiProperty()
  size!: number;

  @ApiProperty()
  startByte!: number;

  @ApiProperty()
  endByte!: number;

  @ApiProperty()
  presignedUrl!: string;

  @ApiProperty()
  expiresAt!: number;
}

export class UploadConfigurationDto {
  @ApiProperty()
  maxFileSize!: number;

  @ApiProperty()
  maxChunkSize!: number;

  @ApiProperty()
  fileType!: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty()
  uploadId!: string;

  @ApiProperty()
  objectName!: string;

  @ApiProperty()
  totalChunks!: number;

  @ApiProperty()
  chunkSize!: number;

  @ApiProperty()
  lastChunkSize!: number;

  @ApiProperty()
  totalSize!: number;

  @ApiProperty({ type: [ChunkInfoDto] })
  chunks!: ChunkInfoDto[];

  @ApiProperty()
  initiatedAt!: string;

  @ApiProperty()
  configuration!: UploadConfigurationDto;
}

export class PartDto {
  @ApiProperty({ description: 'Part number (1-indexed)', example: 1 })
  @IsNumber()
  partNumber!: number;

  @ApiProperty({
    description: 'ETag from chunk upload response',
    example: '"abc123"',
  })
  @IsString()
  @IsNotEmpty()
  etag!: string;

  @ApiProperty({ description: 'Part size (bytes)', example: 5242880 })
  @IsNumber()
  partSize!: number;
}

export class CompleteUploadDto {
  @ApiProperty({ description: 'Upload ID from initiate response' })
  @IsString()
  @IsNotEmpty()
  uploadId!: string;

  @ApiProperty({ description: 'Object name from initiate response' })
  @IsString()
  @IsNotEmpty()
  objectName!: string;

  @ApiProperty({
    description: 'Array of uploaded parts with ETags',
    type: [PartDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartDto)
  parts!: PartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty()
  uploadId!: string;

  @ApiProperty()
  objectName!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  completedAt!: string;
}
