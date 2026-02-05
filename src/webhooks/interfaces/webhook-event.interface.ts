export enum WebhookEventType {
  UploadCompleted = 'upload_completed',
  MimeValidationPassed = 'mime_validation_passed',
  MimeValidationFailed = 'mime_validation_failed',
  ClamAvScanPassed = 'clam_av_scan_passed',
  ClamAvScanFailed = 'clam_av_scan_failed',
  FileValidated = 'file_validated',
  FileFlagged = 'file_flagged',
  FileDeleted = 'file_deleted',
}

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: {
    uploadId: string;
    objectName: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    details?: Record<string, any>;
  };
  signature?: string; // HMAC signature for verification
}
