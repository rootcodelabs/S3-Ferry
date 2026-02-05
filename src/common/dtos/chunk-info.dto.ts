import { ApiProperty } from '@nestjs/swagger';

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
