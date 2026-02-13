import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as promClient from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry: promClient.Registry;

  // Custom metrics
  public readonly httpRequestDuration: promClient.Histogram;
  public readonly httpRequestTotal: promClient.Counter;
  public readonly uploadTotal: promClient.Counter;
  public readonly uploadDuration: promClient.Histogram;
  public readonly validationTotal: promClient.Counter;
  public readonly fileTransferTotal: promClient.Counter;

  constructor() {
    // Create a new registry
    this.registry = new promClient.Registry();

    // Add default metrics (CPU, memory, event loop, etc.)
    promClient.collectDefaultMetrics({
      register: this.registry,
      prefix: 's3_ferry_',
    });

    // HTTP request duration histogram
    this.httpRequestDuration = new promClient.Histogram({
      name: 's3_ferry_http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    // HTTP request counter
    this.httpRequestTotal = new promClient.Counter({
      name: 's3_ferry_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // Upload operations counter
    this.uploadTotal = new promClient.Counter({
      name: 's3_ferry_uploads_total',
      help: 'Total number of upload operations',
      labelNames: ['status'], // 'initiated', 'completed', 'failed'
      registers: [this.registry],
    });

    // Upload duration histogram
    this.uploadDuration = new promClient.Histogram({
      name: 's3_ferry_upload_duration_seconds',
      help: 'Duration of upload operations in seconds',
      labelNames: ['status'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });

    // Validation counter
    this.validationTotal = new promClient.Counter({
      name: 's3_ferry_validations_total',
      help: 'Total number of file validations',
      labelNames: ['validator', 'status'], // validator: 'base', 'clamav'; status: 'passed', 'failed'
      registers: [this.registry],
    });

    // File transfer counter
    this.fileTransferTotal = new promClient.Counter({
      name: 's3_ferry_file_transfers_total',
      help: 'Total number of file transfers between buckets',
      labelNames: ['destination'], // 'validated', 'flagged', 'deleted'
      registers: [this.registry],
    });
  }

  onModuleInit() {
    this.logger.log('Metrics service initialized with Prometheus registry');
  }

  /**
   * Get all metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get the registry (useful for custom metrics)
   */
  getRegistry(): promClient.Registry {
    return this.registry;
  }

  /**
   * Record HTTP request metrics
   */
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
  ) {
    this.httpRequestTotal.inc({ method, route, status_code: statusCode });
    this.httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      duration,
    );
  }

  /**
   * Record upload operation
   */
  recordUpload(
    status: 'initiated' | 'completed' | 'failed',
    duration?: number,
  ) {
    this.uploadTotal.inc({ status });
    if (duration !== undefined) {
      this.uploadDuration.observe({ status }, duration);
    }
  }

  /**
   * Record validation result
   */
  recordValidation(validator: 'base' | 'clamav', status: 'passed' | 'failed') {
    this.validationTotal.inc({ validator, status });
  }

  /**
   * Record file transfer
   */
  recordFileTransfer(destination: 'validated' | 'flagged' | 'deleted') {
    this.fileTransferTotal.inc({ destination });
  }
}
