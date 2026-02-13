import { ApiProperty } from '@nestjs/swagger';

export class UploadConfigurationDto {
  @ApiProperty()
  maxFileSize!: number;

  @ApiProperty()
  maxChunkSize!: number;

  @ApiProperty()
  fileType!: string;
}
