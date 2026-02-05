process.env.NODE_ENV = process.env.NODE_ENV || 'development';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { appConfigFactory } from './common/config';

async function bootstrap() {
  try {
    console.log('Creating NestJS app...');
    const app = await NestFactory.create(AppModule);
    console.log('App created, getting config...');
    const apiConfig = app.get(appConfigFactory.KEY);
    console.log('Config retrieved:', apiConfig);

    // Enable CORS - handle both wildcard and specific origins
    if (apiConfig.corsOrigin === '*') {
      app.enableCors();
    } else if (apiConfig.corsOrigin) {
      app.enableCors({ origin: apiConfig.corsOrigin });
    }

    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    app.enableVersioning({ type: VersioningType.URI });

    if (apiConfig.documentationEnabled) {
      const config = new DocumentBuilder()
        .addBearerAuth({ in: 'header', type: 'http' })
        .setTitle('API Documentation')
        .setVersion('1.0.0')
        .build();
      const document = SwaggerModule.createDocument(app, config);
      SwaggerModule.setup('documentation', app, document, {
        swaggerOptions: {
          operationsSorter: 'alpha',
          persistAuthorization: true,
          tagsSorter: 'alpha',
        },
      });
    }

    await app.listen(3000);
    console.log('✓ Server listening on http://localhost:3000');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
