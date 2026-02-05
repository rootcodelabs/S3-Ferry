import { ApiProperty } from '@nestjs/swagger';

export class DownloadUrlResponseDto {
  @ApiProperty({
    description: 'Presigned URL for downloading the object',
    example:
      'http://localhost:9000/validated/uploads/2026/01/28/...&X-Amz-Signature=...',
  })
  url!: string;

  @ApiProperty({
    description: 'Object name/key in storage',
    example:
      'uploads/2026/01/28/ad461765-233f-4ca1-a15a-bd7f67072c90-document.pdf',
  })
  objectName!: string;

  @ApiProperty({
    description: 'Bucket name used to generate the URL',
    example: 'validated',
  })
  bucketName!: string;

  @ApiProperty({
    description: 'URL expiration time (unix timestamp, seconds)',
    example: 1706500000,
  })
  expiresAt!: number;
}
