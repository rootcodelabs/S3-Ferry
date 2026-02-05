import { ApiProperty } from '@nestjs/swagger';

import { ChunkInfoDto } from './chunk-info.dto';
import { UploadConfigurationDto } from './upload-configuration.dto';

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
