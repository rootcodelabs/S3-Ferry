import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { natsConfigFactory, natsConfigSchema } from './config';
import { NatsService } from './services';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [natsConfigFactory],
      validationSchema: natsConfigSchema,
    }),
  ],
  providers: [NatsService],
  exports: [NatsService],
})
export class NatsModule {}
