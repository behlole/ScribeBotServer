import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Response } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';

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

      console.log(userInfo, tokens);
      // Create JWT with user info and tokens
      const jwt = await this.authService.createToken({
        ...userInfo,
        accessToken: tokens?.access_token,
        refreshToken: tokens?.refresh_token,
      });

      // Redirect to frontend with JWT
      res.redirect(`http://localhost:4200/auth/callback?token=${jwt.access_token}`);
    } catch (error) {
      console.error('Auth callback error:', error);
      res.redirect('http://localhost:4200/login?error=authentication_failed');
    }
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req, @Res() res: Response) {
    try {
      await this.authService.logout(req.user);
      res.clearCookie('token'); // Clear any auth cookies if you're using them
      return res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
      console.error('Logout error:', error);
      return res.status(200).json({ message: 'Logged out with warnings' });
    }
  }

}
