import { Controller, Get, Query, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {
  }

  @Get('google')
  async googleAuth(@Res() res: Response) {
    const authUrl = await this.authService.getGoogleAuthUrl();
    res.redirect(authUrl);
  }

  @Get('google/callback')
  async handleCallback(
    @Query('code') code: string,
    @Res() res: Response,
  ) {
    try {
      // Get tokens from code
      const tokens = await this.authService.getTokensFromCode(code);

      // Get user info using access token
      const userInfo = await this.authService.getUserInfo(tokens.access_token);

      // Create JWT with user info and tokens
      const jwt = await this.authService.createToken({
        ...userInfo,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      });

      // Redirect to frontend with JWT
      res.redirect(`http://localhost:4200/dashboard?token=${jwt.access_token}`);
    } catch (error) {
      console.error('Auth callback error:', error);
      res.redirect('http://localhost:4200/login?error=authentication_failed');
    }
  }
}
