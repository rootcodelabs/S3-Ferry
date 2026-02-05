import { ApiProperty } from '@nestjs/swagger';

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
