import { InitiateUploadDto } from '../../common/dtos';

/**
 * Prepare S3-specific metadata with AWS headers
 * @param dto Upload initiation DTO containing file information
 * @returns S3 metadata object with standard and custom headers
 */
export function prepareMetadata(
  dto: InitiateUploadDto,
): Record<string, string> {
  return {
    'content-type': dto.mimeType, // Standard S3 header
    'x-amz-meta-original-filename': dto.fileName, // Custom metadata with AWS prefix
    'x-amz-meta-file-size': dto.fileSize.toString(),
    'x-amz-meta-upload-timestamp': new Date().toISOString(),
  };
}
