import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { RecordingModule } from './recording/recording.module';
import { ConfigModule } from '@nestjs/config';
import { GoogleStrategy } from './auth/google.strategy';

@Module({
  imports: [AuthModule, RecordingModule, ConfigModule.forRoot({
    isGlobal: true, // Makes ConfigService available everywhere
    envFilePath: `.env`,
  })],
  controllers: [AppController],
  providers: [AppService, GoogleStrategy],
})
export class AppModule {
}
