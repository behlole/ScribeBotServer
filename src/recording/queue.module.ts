import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TranscriptionProcessor } from './transcription-processor.service';
import { RecordingService } from './recording.service';
import { CacheService } from './cache.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return {
          redis: {
            host: configService.get('REDIS_HOST', 'localhost'),
            port: configService.get('REDIS_PORT', 6379),
            password: configService.get('REDIS_PASSWORD', ''),
            db: configService.get('REDIS_QUEUE_DB', 1),
          },
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          },
          limiter: {
            max: 5,
            duration: 1000,
          },
        } as any; // Type assertion to bypass the type check
      },
    }),
    BullModule.registerQueue({
      name: 'transcription',
    }),
  ],
  providers: [
    TranscriptionProcessor,
    RecordingService,
    CacheService,
  ],
  exports: [BullModule],
})
export class QueueModule {}
