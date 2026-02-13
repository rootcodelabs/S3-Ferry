import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class PartDto {
  @ApiProperty({ description: 'Part number (1-indexed)', example: 1 })
  @IsNumber()
  partNumber!: number;

  @ApiProperty({
    description: 'ETag from chunk upload response',
    example: '"abc123"',
  })
  @IsString()
  @IsNotEmpty()
  etag!: string;

  @ApiProperty({ description: 'Part size (bytes)', example: 5242880 })
  @IsNumber()
  partSize!: number;
}
