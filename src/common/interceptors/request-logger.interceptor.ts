import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';

import { MetricsService } from '../../health/services';

@Injectable()
export class RequestLogger implements NestInterceptor {
  private readonly logger = new Logger(RequestLogger.name);

  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const { originalUrl, method, params, query, body } = request;
    const response = context.switchToHttp().getResponse();
    
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          const duration = (Date.now() - startTime) / 1000; // Convert to seconds
          const statusCode = response.statusCode;
          
          // Extract route pattern (remove query params)
          const route = originalUrl.split('?')[0];

          // Record metrics
          this.metricsService.recordHttpRequest(
            method,
            route,
            statusCode,
            duration,
          );

          this.logger.log(
            `Request: {method: ${method}, url: ${originalUrl}, params: ${JSON.stringify(params)}, query: ${JSON.stringify(query)}, body: ${JSON.stringify(body)}}`,
          );

          this.logger.log(
            `Response: {statusCode: ${statusCode}, responseData: ${JSON.stringify(data ?? {})}, duration: ${duration}s}`,
          );
        },
        error: (error) => {
          const duration = (Date.now() - startTime) / 1000;
          const statusCode = error.status || 500;
          const route = originalUrl.split('?')[0];

          // Record error metrics
          this.metricsService.recordHttpRequest(
            method,
            route,
            statusCode,
            duration,
          );

          this.logger.error(
            `Request failed: {method: ${method}, url: ${originalUrl}, statusCode: ${statusCode}, duration: ${duration}s, error: ${error.message}}`,
          );
        },
      }),
    );
  }
}
