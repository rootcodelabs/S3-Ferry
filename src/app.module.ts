import { join } from 'path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigModule as NestConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AzureModule } from './azure';
import { appConfigFactory } from './common/config';
import { configuration } from './config';
import { FsModule } from './fs';
import { HealthModule } from './health';
import { NatsModule } from './nats';
import { S3Module } from './s3';
import { AppService } from './services';
import { ValidatorsModule } from './validators';
import { WebhooksModule } from './webhooks';

@Module({
  imports: [
    // Load YAML configuration first
    NestConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: join(
        process.cwd(),
        'config',
        `${process.env.NODE_ENV || 'development'}.env`,
      ),
      expandVariables: true,
    }),
    ConfigModule.forFeature(appConfigFactory),
    AzureModule,
    FsModule,
    S3Module,
    NatsModule,
    ValidatorsModule,
    WebhooksModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
