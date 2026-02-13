import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({
    description: 'Part/chunk number',
    example: 1,
  })
  partNumber!: number;

  @ApiProperty({
    description: 'ETag of the uploaded part',
    example: '"2db470600bb6f187b24b13b74d4d33be"',
  })
  etag!: string;

  @ApiProperty({
    description: 'Size of the part in bytes',
    example: 10485760,
  })
  size!: number;
}

export class UploadStatusResponseDto {
  @ApiProperty({
    description: 'Upload ID',
    example: 'ZjZmNjQ4ZjgtYWFjMy00NTJhLWI2NmMtMDcxMzYyYmE0Yzk2...',
  })
  uploadId!: string;

  @ApiProperty({
    description: 'Object name/key',
    example:
      'uploads/2026/01/28/ad461765-233f-4ca1-a15a-bd7f67072c90-document.pdf',
  })
  objectName!: string;

  @ApiProperty({
    description: 'Number of chunks successfully uploaded',
    example: 7,
  })
  uploadedChunks!: number;

  @ApiProperty({
    description: 'Detailed information about uploaded parts',
    type: [UploadedPartDto],
  })
  uploadedParts!: UploadedPartDto[];

  @ApiProperty({
    description: 'Upload status',
    example: 'in-progress',
    enum: ['in-progress', 'completed', 'not-found'],
  })
  status!: string;
}
