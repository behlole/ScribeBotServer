import { Controller, Delete, Get, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RecordingService } from './recording.service';
import { AuthGuard } from '@nestjs/passport';

@Controller('recording')
@UseGuards(AuthGuard('jwt'))
export class RecordingController {
  constructor(private recordingService: RecordingService) {
  }

  @Post('start')
  async startRecording(@Req() req) {
    return this.recordingService.startRecording(
      req.user.accessToken,
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
  ) {
    return this.recordingService.stopRecording(
      recordingId,
      req.user.accessToken,
    );
  }

  @Get(':recordingId')
  async getResults(@Param('recordingId') recordingId: string, @Req() req: any) {
    return this.recordingService.getRecordingResults(recordingId, req.user.accessToken);
  }

  @Delete(':recordingId')
  async deleteRecording(@Param('recordingId') recordingId: string,@Req() req: any) {
    return this.recordingService.deleteRecording(recordingId,req.user.accessToken);
  }
}
