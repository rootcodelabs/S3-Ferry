import { ApiProperty } from '@nestjs/swagger';

export class DeleteS3ObjectResponseDto {
  @ApiProperty({ description: 'Object name that was deleted' })
  objectName!: string;

  @ApiProperty({ description: 'Bucket name where the object was deleted' })
  bucketName!: string;

  @ApiProperty({ description: 'Status of the deletion operation' })
  status!: string;

  @ApiProperty({ description: 'Success message' })
  message!: string;

  @ApiProperty({ description: 'Timestamp when deletion completed' })
  deletedAt!: string;
}
