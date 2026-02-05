import { IsOptional, IsString } from 'class-validator';

export class DeleteS3ObjectDto {
  @IsString()
  objectName!: string;

  @IsString()
  @IsOptional()
  bucketName?: string;
}
