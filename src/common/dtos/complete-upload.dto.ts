import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

import { PartDto } from './part.dto';

export class CompleteUploadDto {
  @ApiProperty({ description: 'Upload ID from initiate response' })
  @IsString()
  @IsNotEmpty()
  uploadId!: string;

  @ApiProperty({ description: 'Object name from initiate response' })
  @IsString()
  @IsNotEmpty()
  objectName!: string;

  @ApiProperty({
    description: 'Array of uploaded parts with ETags',
    type: [PartDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartDto)
  parts!: PartDto[];
}
