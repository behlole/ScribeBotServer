import { BadRequestException, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { VertexAI } from '@google-cloud/vertexai';
import * as serviceAccount from './scribe-bot.json';
import * as path from 'node:path';
import * as fs from 'node:fs';

@Injectable()
export class RecordingService {
  vertexAi: VertexAI;

  constructor(private configService: ConfigService) {
    this.vertexAi = new VertexAI({
      project: this.configService.get('GOOGLE_PROJECT_ID'),
      location: 'us-central1',
      googleAuthOptions: {
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
  }

  async startRecording(accessToken: string): Promise<{ recordingId: string; message: string }> {
    try {
      const drive = this.getDriveService(accessToken);

      // Create a folder for the recording
      const folderMetadata = {
        name: `Medical-Recording-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.folder',
      };

      const folder = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id, name',
      });

      return {
        recordingId: folder.data.id!,
        message: `Recording initialized in your Google Drive: ${folder.data.name}`,
      };
    } catch (error) {
      console.error('Start recording error:', error);
      throw new BadRequestException('Failed to initialize recording in your Google Drive');
    }
  }

  bufferToStream(buffer: Buffer): any {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
  }

  async processAudioChunk(
    recordingId: string,
    chunk: Buffer,
    chunkNumber: number,
    accessToken: string,
  ): Promise<{ message: string; chunkNumber: number }> {
    try {
      const drive = this.getDriveService(accessToken);

      const fileMetadata = {
        name: `chunk-${chunkNumber}.wav`,
        parents: [recordingId],
      };

      // Convert Buffer to Readable stream
      const mediaStream = this.bufferToStream(chunk);

      await drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: 'audio/wav',
          body: mediaStream,
        },
        fields: 'id',
      });

      return {
        message: 'Audio chunk saved to your Drive',
        chunkNumber,
      };
    } catch (error) {
      console.error('Process chunk error:', error.message);
      // Add more detailed error information
      throw new BadRequestException(`Failed to save audio chunk: ${error.message}`);
    }
  }

  async stopRecording(recordingId: string, accessToken: string): Promise<{
    transcript: string;
    summary: string;
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      // Get all audio chunks
      const chunks = await drive.files.list({
        q: `'${recordingId}' in parents and mimeType='audio/wav'`,
        orderBy: 'name',
        fields: 'files(id, name)',
      });


      if (!chunks.data.files?.length) {
        throw new BadRequestException('No audio chunks found');
      }

      // Combine audio chunks
      const audioBuffers: Buffer[] = [];
      for (const file of chunks.data.files) {
        const response: any = await drive.files.get(
          { fileId: file.id!, alt: 'media' },
          { responseType: 'arraybuffer' },
        );
        audioBuffers.push(Buffer.from(response.data));
      }
      const combinedAudio = Buffer.concat(audioBuffers);
      console.log(combinedAudio);
      // Transcribe using user's Speech-to-Text
      const transcript = await this.transcribeAudio(combinedAudio, accessToken);

      // Summarize using user's Vertex AI
      const summary = await this.summarizeTranscript(transcript);
      console.log(summary);
      // Save results back to user's Drive
      await this.saveResultsToDrive(recordingId, transcript, JSON.stringify(summary), accessToken);

      return { transcript, summary };
    } catch (error) {
      console.error('Stop recording error:', error);
      throw new BadRequestException('Failed to process recording');
    }
  }



  private async transcribeAudio(audioBuffer: Buffer, accessToken: string): Promise<string> {
    try {
      console.log('Starting transcription...');
      console.log('Audio buffer size:', audioBuffer.length);

      const speech = google.speech('v1').speech;
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: accessToken });

      // Configure for WebM audio
      const config = {
        encoding: 'WEBM_OPUS', // Changed to WebM format
        sampleRateHertz: 48000,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
        model: 'default',
        useEnhanced: true,
        audioChannelCount: 1,
      };

      console.log('Speech-to-Text config:', config);

      const request = {
        auth,
        requestBody: {
          audio: {
            content: audioBuffer.toString('base64')
          },
          config,
        },
      };

      // Save audio for debugging

      const response = await speech.recognize(request);
      console.log('API Response:', JSON.stringify(response.data, null, 2));

      if (!response?.data?.results || response.data.results.length === 0) {
        throw new Error('No speech detected in the audio');
      }

      const transcript = response.data.results
        .map(result => result.alternatives?.[0]?.transcript || '')
        .join(' ');

      console.log('Transcript:', transcript);
      return transcript;

    } catch (error) {
      console.error('Transcription error:', error);
      throw error;
    }
  }

  private async summarizeTranscript(transcript: string): Promise<any> {
    try {
      const model = this.vertexAi.preview.getGenerativeModel({
        model: 'gemini-pro',
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.2,
          topP: 0.8,
          topK: 40,
        },
      });

      const prompt = `Summarize this medical conversation, highlighting key points, diagnoses, and follow-up actions:

${transcript}

Format the summary with these sections:
- Key Points
- Medical Observations
- Follow-up Actions`;

      const result = await model.generateContent(prompt);
      return result.response.candidates[0].content.parts[0].text;
    } catch (error) {
      console.error('Summarization error:', error);

      if (error.message?.includes('permission denied') || error.message?.includes('unauthorized')) {
        throw new BadRequestException('Vertex AI access denied. Please check service account configuration.');
      }

      throw new BadRequestException(`Failed to summarize transcript: ${error.message}`);
    }
  }

  private async saveResultsToDrive(
    folderId: string,
    transcript: string,
    summary: string,
    accessToken: string,
  ): Promise<void> {
    const drive = this.getDriveService(accessToken);

    const files = [
      { name: 'transcript.txt', content: transcript },
      { name: 'summary.txt', content: summary },
    ];

    for (const file of files) {
      const fileMetadata = {
        name: file.name,
        parents: [folderId],
      };

      await drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: 'text/plain',
          body: file.content,
        },
        fields: 'id',
      });
    }
  }

  private getDriveService(accessToken: string): drive_v3.Drive {
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    return google.drive({ version: 'v3', auth });
  }

  async getResults(recordingId: string, accessToken: string): Promise<{
    transcript: string;
    summary: string;
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      const files = await drive.files.list({
        q: `'${recordingId}' in parents and (name='transcript.txt' or name='summary.txt')`,
        fields: 'files(id, name)',
      });

      if (!files.data.files?.length) {
        throw new BadRequestException('Results not found');
      }

      const results: { transcript: string; summary: string } = {
        transcript: '',
        summary: '',
      };

      for (const file of files.data.files) {
        const response = await drive.files.get(
          { fileId: file.id!, alt: 'media' },
          { responseType: 'text' },
        );

        // Fix for Schema$File type error
        if (typeof response.data === 'string') {
          if (file.name === 'transcript.txt') {
            results.transcript = response.data;
          } else if (file.name === 'summary.txt') {
            results.summary = response.data;
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Get results error:', error);
      throw new BadRequestException('Failed to retrieve results');
    }
  }

  async getRecordingResults(recordingId: string, accessToken: string): Promise<{
    transcript: string;
    summary: string;
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      const files = await drive.files.list({
        q: `'${recordingId}' in parents and (name='transcript.txt' or name='summary.txt')`,
        fields: 'files(id, name)',
      });

      if (!files.data.files?.length) {
        throw new BadRequestException('Results not found');
      }

      const results: { transcript: string; summary: string } = {
        transcript: '',
        summary: '',
      };

      for (const file of files.data.files) {
        const response = await drive.files.get(
          { fileId: file.id!, alt: 'media' },
          { responseType: 'text' },
        );

        // Ensure response.data is a string
        const content = response.data?.toString() || '';

        if (file.name === 'transcript.txt') {
          results.transcript = content;
        } else if (file.name === 'summary.txt') {
          results.summary = content;
        }
      }

      return results;
    } catch (error) {
      console.error('Get results error:', error);
      throw new BadRequestException('Failed to retrieve results');
    }
  }

  async deleteRecording(recordingId: string, accessToken: string): Promise<void> {
    try {
      const drive = this.getDriveService(accessToken);
      await drive.files.delete({ fileId: recordingId });
    } catch (error) {
      console.error('Delete recording error:', error);
      throw new BadRequestException('Failed to delete recording');
    }
  }
}
