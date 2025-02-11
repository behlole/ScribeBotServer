import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(private configService: ConfigService) {
    let clientID=configService.get<string>('GOOGLE_CLIENT_ID');
    let clientSecret=configService.get<string>('GOOGLE_CLIENT_SECRET');
    const options = {
      clientID: configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: 'http://localhost:3000/auth/google/callback',
      scope: [
        'email',
        'profile',
        'openid',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/cloud-translation',
        'https://www.googleapis.com/auth/cloud-vision',
        'https://www.googleapis.com/auth/cloud-speech',
      ],
      access_type: 'offline',
      prompt: 'consent',
    };
    console.log('Client ID:', clientID?.substring(0, 8) + '...');
    console.log('Client Secret first chars:', clientSecret?.substring(0, 4) + '...');
    console.log('Full callback URL:', 'http://localhost:3000/auth/google/callback');
    super(options);
  }

  async validate(
    accessToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    try {
      this.logger.debug('Received profile from Google:', profile);
      this.logger.debug('Access Token:', accessToken?.substring(0, 8) + '...');
      const user = {
        email: profile?.emails[0].value,
        firstName: profile?.name.givenName,
        lastName: profile?.name.familyName,
        picture: profile?.photos[0].value,
        accessToken,
      };
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  }
}
