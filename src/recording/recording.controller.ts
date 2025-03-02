import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req, Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RecordingService } from './recording.service';
import { AuthGuard } from '@nestjs/passport';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { Response as ExpressResponse } from 'express'; // Import the correct type

interface PatientInfo {
  name: string;
  id?: string;
  type?: string;
}

interface SessionInfo {
  duration?: string;
  patientInfo?: PatientInfo;
}

@Controller('recording')
@UseGuards(AuthGuard('jwt'))
export class RecordingController {
  constructor(private recordingService: RecordingService) {
  }
  @Get('audio/:fileId')
  async getAudioFile(
    @Param('fileId') fileId: string,
    @Req() req,
    @Res() res: ExpressResponse
  ) {
    try {
      // Get an authorized Drive client
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: req.user.accessToken });
      const drive = google.drive({ version: 'v3', auth });

      // Get file metadata to check MIME type and get filename
      const fileMetadata = await drive.files.get({
        fileId: fileId,
        fields: 'name,mimeType'
      });

      // Set appropriate headers
      res.setHeader('Content-Type', fileMetadata.data.mimeType || 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${fileMetadata.data.name}"`);

      // Get the file and pipe it directly to the response
      const response = await drive.files.get(
        {
          fileId: fileId,
          alt: 'media'
        },
        { responseType: 'stream' }
      );

      // Pipe the file stream to the response
      response.data
        .on('error', error => {
          console.error('Error streaming file:', error);
          if (!res.headersSent) {
            res.status(500).send('Error streaming file');
          }
        })
        .pipe(res);

    } catch (error) {
      console.error('Error serving audio file:', error);
      if (!res.headersSent) {
        res.status(500).send('Error serving audio file');
      }
    }
  }

  @Get('list')
  async getAllRecordings(@Req() req: any, @Body() query: { patientName?: string, type?: string }) {
    try {
      let patientName = query.patientName || '';
      let type = query.type || '';
      const filters = {
        patientName,
        type
      };
      return this.recordingService.getAllRecordings(req.user.accessToken, filters);
      return [];
    } catch (error) {
      console.error('Error getting recordings list:', error);
      throw new Error('Failed to retrieve recordings list');
    }
  }
  @Post('start')
  async startRecording(
    @Req() req,
    @Body() body: { patientInfo?: PatientInfo },
  ) {
    // Extract patient info from request body if provided
    const patientInfo = body.patientInfo;

    return this.recordingService.startRecording(
      req.user.accessToken,
      patientInfo,
    );
  }

  @Post('chunk/:recordingId/:chunkNumber')
  @UseInterceptors(FileInterceptor('audio'))
  async uploadChunk(
    @Param('recordingId') recordingId: string,
    @Param('chunkNumber') chunkNumber: number,
    @UploadedFile() file: Express.Multer.File,
    @Req() req,
  ) {
    return this.recordingService.processAudioChunk(
      recordingId,
      file.buffer,
      chunkNumber,
      req.user.accessToken,
    );
  }

  @Post('stop/:recordingId')
  async stopRecording(
    @Param('recordingId') recordingId: string,
    @Req() req,
    @Body() sessionInfo?: SessionInfo,
  ) {
    // Stop recording and get basic results
    const results = await this.recordingService.stopRecording(
      recordingId,
      req.user.accessToken,
    );

    // Add session information if provided
    if (sessionInfo) {
      if (sessionInfo.duration) {
        results['duration'] = sessionInfo.duration;
      }

      if (sessionInfo.patientInfo) {
        results['patientInfo'] = sessionInfo.patientInfo;
      }
    }

    return results;
  }

  @Get(':recordingId')
  async getResults(@Param('recordingId') recordingId: string, @Req() req: any) {
    // Use the getRecordingResults method which already returns patient info
    return this.recordingService.getRecordingResults(
      recordingId,
      req.user.accessToken,
    );
  }

  @Delete(':recordingId')
  async deleteRecording(@Param('recordingId') recordingId: string, @Req() req: any) {
    return this.recordingService.deleteRecording(
      recordingId,
      req.user.accessToken,
    );
  }
}
