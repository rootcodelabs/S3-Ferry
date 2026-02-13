import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DownloadUrlQueryDto {
  @ApiProperty({
    description: 'Object name/key in storage',
    example:
      'uploads/2026/01/28/ad461765-233f-4ca1-a15a-bd7f67072c90-document.pdf',
  })
  @IsString()
  @IsNotEmpty()
  objectName!: string;

  @ApiProperty({
    description: 'Bucket name (defaults to S3_DATA_BUCKET_NAME)',
    example: 'validated',
    required: false,
  })
  @IsString()
  @IsOptional()
  bucketName?: string;
}
