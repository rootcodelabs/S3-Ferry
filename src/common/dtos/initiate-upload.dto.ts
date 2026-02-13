import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

import { StorageType } from '../enums';

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

  @ApiProperty({
    description: 'Storage type (S3 or Azure)',
    enum: StorageType,
    example: StorageType.S3,
  })
  @IsEnum(StorageType)
  storageType!: StorageType;
}
