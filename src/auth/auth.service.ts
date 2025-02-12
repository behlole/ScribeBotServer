import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { Credentials } from 'google-auth-library';

@Injectable()
export class AuthService {
  private oauth2Client;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = 'http://localhost:3000/auth/google/callback';

    console.log('Initializing OAuth2 client with:');
    console.log('Client ID:', clientId);
    console.log('Redirect URI:', redirectUri);

    if (!clientId || !clientSecret) {
      throw new Error('Missing Google OAuth credentials');
    }

    this.oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri,
    );
  }

  async getGoogleAuthUrl(): Promise<string> {
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/cloud-translation',
      'https://www.googleapis.com/auth/cloud-vision',
      'https://www.googleapis.com/auth/cloud-speech',
      'https://www.googleapis.com/auth/devstorage.full_control',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/drive.appfolder',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.resource',
      'https://www.googleapis.com/auth/drive',

    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      include_granted_scopes: true,
    });
  }

  async getTokensFromCode(code: string) {
    try {
      console.log('Starting token exchange...');
      console.log('Authorization code:', code);

      // Log the exact configuration being used
      console.log('OAuth2 Client config:', {
        clientId: this.oauth2Client._clientId,
        redirectUri: this.oauth2Client.redirectUri,
        // Don't log the client secret
      });

      const { tokens } = await this.oauth2Client.getToken(code);

      console.log('Token exchange successful');
      console.log('Access token received:', tokens.access_token ? 'Yes' : 'No');
      console.log('Refresh token received:', tokens.refresh_token ? 'Yes' : 'No');

      if (!tokens.access_token) {
        throw new UnauthorizedException('No access token received');
      }

      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
      };
    } catch (error) {
      console.error('Detailed error information:');
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      if (error.response) {
        console.error('Error response:', error.response.data);
      }
      throw new UnauthorizedException('Failed to get tokens: ' + error.message);
    }
  }

  async getUserInfo(accessToken: string) {
    const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
    this.oauth2Client.setCredentials({ access_token: accessToken });

    const { data } = await oauth2.userinfo.get();
    return data;
  }

  async createToken(user: any) {
    const payload = {
      email: user.email,
      sub: user.id,
      name: user.name,
      picture: user.picture,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
    };

    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async refreshGoogleToken(refreshToken: string): Promise<Credentials> {
    try {
      console.log('Attempting to refresh token...');

      // Set the refresh token in the client
      this.oauth2Client.setCredentials({
        refresh_token: refreshToken,
      });

      // Request new tokens
      const { credentials } = await this.oauth2Client.refreshAccessToken();

      console.log('Token refresh successful');
      console.log('New access token received:', credentials.access_token ? 'Yes' : 'No');
      console.log('New expiry date:', credentials.expiry_date);

      return {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token || refreshToken, // Keep old refresh token if new one isn't provided
        expiry_date: credentials.expiry_date,
        token_type: credentials.token_type,
        id_token: credentials.id_token,
        scope: credentials.scope,
      };
    } catch (error) {
      console.error('Token refresh error:', error);
      throw new UnauthorizedException('Failed to refresh token');
    }
  }


  async validateUser(payload: any) {
    return payload;
  }

  private async revokeGoogleToken(token: string): Promise<void> {
    try {
      await this.oauth2Client.revokeToken(token);
    } catch (error) {
      console.error('Token revocation error:', error);
    }
  }

  async logout(user: any): Promise<void> {
    try {
      // If user has refresh token, revoke it with Google
      if (user.refreshToken) {
        await this.revokeGoogleToken(user.refreshToken);
      }

      // If user has access token, revoke it too
      if (user.accessToken) {
        await this.revokeGoogleToken(user.accessToken);
      }
    } catch (error) {
      console.error('Logout process error:', error);
      // Don't throw - we want the logout to complete even with partial failures
    }
  }
}
