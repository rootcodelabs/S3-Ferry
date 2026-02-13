export interface NatsConfig {
  servers: string[];
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
  streams: {
    fileValidation: {
      name: string;
      subjects: string[];
    };
    validationResults: {
      name: string;
      subjects: string[];
    };
  };
}
