import { v4 as uuidv4 } from 'uuid';

export interface ObjectNamingConfig {
  strategy: 'unique' | 'filename';
  replaceOnUpload: boolean;
  includeDatePath: boolean;
}

/**
 * Generate S3 object name based on configuration strategy
 * @param fileName Original file name
 * @param config Object naming configuration from DSL
 * @returns Generated object name
 */
export function generateObjectName(
  fileName: string,
  config?: ObjectNamingConfig,
): string {
  // Default configuration (backward compatibility)
  const strategy = config?.strategy || 'unique';
  const includeDatePath =
    config?.includeDatePath !== undefined ? config.includeDatePath : true;

  // Sanitize filename (remove dangerous characters)
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');

  // Build date path if enabled
  let basePath = 'uploads';
  if (includeDatePath) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    basePath = `uploads/${year}/${month}/${day}`;
  }

  // Generate object name based on strategy
  if (strategy === 'filename') {
    // Use original filename (sanitized)
    return `${basePath}/${sanitizedFileName}`;
  } else {
    // Default: unique strategy with UUID prefix
    const uniqueId = uuidv4();
    return `${basePath}/${uniqueId}-${sanitizedFileName}`;
  }
}

/**
 * Sanitize filename for safe storage
 * @param fileName Original filename
 * @returns Sanitized filename
 */
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
}
