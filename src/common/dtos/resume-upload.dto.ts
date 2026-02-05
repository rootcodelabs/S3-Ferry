import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class ResumeUploadDto {
  @ApiProperty({
    description: 'Upload ID from initiate upload response',
    example: 'ZjZmNjQ4ZjgtYWFjMy00NTJhLWI2NmMtMDcxMzYyYmE0Yzk2...',
  })
  @IsString()
  @IsNotEmpty()
  uploadId!: string;

  @ApiProperty({
    description: 'Object name/key in storage',
    example:
      'uploads/2026/01/28/ad461765-233f-4ca1-a15a-bd7f67072c90-document.pdf',
  })
  @IsString()
  @IsNotEmpty()
  objectName!: string;

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
