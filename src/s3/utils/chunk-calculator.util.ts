export interface ChunkInfo {
  chunkNumber: number;
  size: number;
  startByte: number;
  endByte: number;
}

export interface ChunkCalculationResult {
  totalChunks: number;
  chunkSize: number;
  lastChunkSize: number;
  chunks: ChunkInfo[];
}

/**
 * Calculate chunks for multipart upload
 * @param fileSize Total size of the file in bytes
 * @param maxChunkSize Maximum size of each chunk in bytes
 * @returns Chunk calculation result with metadata
 */
export function calculateChunks(
  fileSize: number,
  maxChunkSize: number,
): ChunkCalculationResult {
  const totalChunks = Math.ceil(fileSize / maxChunkSize);
  const chunkSize = maxChunkSize;
  const lastChunkSize = fileSize % maxChunkSize || maxChunkSize;

  const chunks: ChunkInfo[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const startByte = i * chunkSize;
    const endByte = Math.min(startByte + chunkSize - 1, fileSize - 1);
    const size = endByte - startByte + 1;

    chunks.push({
      chunkNumber: i + 1,
      size,
      startByte,
      endByte,
    });
  }

  return {
    totalChunks,
    chunkSize,
    lastChunkSize,
    chunks,
  };
}
