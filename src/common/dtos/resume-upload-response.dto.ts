import { ApiProperty } from '@nestjs/swagger';

import { ChunkInfoDto } from './chunk-info.dto';
import { UploadedPartDto } from './upload-status-response.dto';

export class ResumeUploadResponseDto {
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
    description: 'New presigned URLs for the requested chunks',
    type: [ChunkInfoDto],
  })
  chunks!: ChunkInfoDto[];

  @ApiProperty({
    description: 'Timestamp when URLs were generated',
    example: '2026-01-29T10:30:00.000Z',
  })
  generatedAt!: string;

  @ApiProperty({
    description: 'Number of new URLs generated',
    example: 3,
  })
  urlsGenerated!: number;

  @ApiProperty({
    description: 'Current upload status (in-progress, completed, not-found)',
    example: 'in-progress',
  })
  status!: string;

  @ApiProperty({
    description: 'Number of chunks already uploaded',
    example: 5,
  })
  uploadedChunks!: number;

  @ApiProperty({
    description: 'Total number of chunks expected',
    example: 10,
  })
  totalChunks!: number;

  @ApiProperty({
    description: 'Detailed information about uploaded parts',
    type: [UploadedPartDto],
  })
  uploadedParts!: UploadedPartDto[];

  @ApiProperty({
    description: 'Array of chunk numbers that still need to be uploaded',
    example: [1, 3, 7],
  })
  missingChunks!: number[];
}
