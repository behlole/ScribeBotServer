import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { protos, SpeechClient } from '@google-cloud/speech';
import { VertexAI } from '@google-cloud/vertexai';
import { Storage } from '@google-cloud/storage';
import { AuthService } from '../auth/auth.service';
import * as path from 'path';
import * as process from 'node:process';
import { Buffer } from 'node:buffer';
import { GoogleAuth } from 'google-auth-library';

export interface TranscriptionResult {
  transcript: string;
  confidence: number;
  words: {
    word: string;
    startTime: number;
    endTime: number;
  }[];
}


@Injectable()
export class RecordingService {
  private speechClient: SpeechClient;
  private storage: Storage;
  private vertexAI: VertexAI;

  constructor(private authService: AuthService) {
    this.storage = new Storage();
    this.vertexAI = new VertexAI({ project: process.env.GOOGLE_PROJECT_ID });
  }

  async startRecording(userId: string) {
    try {
      const recordingId = `recording-${userId}-${Date.now()}`;

      // Create a folder in Google Cloud Storage for this recording
      const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
      await bucket.file(`${recordingId}/`).save('');

      return {
        recordingId,
        message: 'Recording session initialized successfully',
      };
    } catch (error) {
      throw new BadRequestException('Failed to initialize recording session');
    }
  }

  async processAudioChunk(
    recordingId: string,
    chunk: Buffer,
    chunkNumber: number,
    userId: string,
    refreshToken: string,
  ) {
    try {
      // Get fresh access token
      const credentials = await this.authService.refreshGoogleToken(refreshToken);

      // Save chunk to Cloud Storage
      const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
      const chunkFileName = `${recordingId}/chunk-${chunkNumber}.wav`;
      const file = bucket.file(chunkFileName);


      await file.save(chunk, {
        resumable: false,
        validation: false,
        contentType: 'audio/wav',
      });

      return {
        message: 'Audio chunk processed successfully',
        chunkNumber,
      };
    } catch (error) {
      throw new BadRequestException('Failed to process audio chunk');
    }
  }

  async stopRecording(
    recordingId: string,
    userId: string,
    refreshToken: string,
  ) {
    try {
      // Get fresh access token
      const credentials = await this.authService.refreshGoogleToken(refreshToken);

      // Combine all chunks
      const combinedAudio = await this.combineAudioChunks(recordingId);

      // Transcribe the combined audio
      const transcription = await this.transcribeAudio(
        combinedAudio,
        credentials.access_token,
      );

      // Summarize the transcription
      const summary = await this.summarizeTranscript(
        transcription.transcript,
        credentials.refresh_token,
      );

      // Save results
      await this.saveResults(recordingId, {
        transcription,
        summary,
      });

      return {
        recordingId,
        transcript: transcription.transcript,
        summary,
        confidence: transcription.confidence,
        words: transcription.words,
      };
    } catch (error) {
      throw new BadRequestException('Failed to complete recording processing');
    }
  }

  private async combineAudioChunks(recordingId: string): Promise<Buffer> {
    const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
    const [files] = await bucket.getFiles({
      prefix: `${recordingId}/chunk-`,
    });

    // Sort files by chunk number
    files.sort((a, b) => {
      const aNum = parseInt(path.basename(a.name).split('-')[1]);
      const bNum = parseInt(path.basename(b.name).split('-')[1]);
      return aNum - bNum;
    });

    // Combine audio chunks
    const chunks: Buffer[] = [];
    for (const file of files) {
      const [data] = await file.download();
      chunks.push(<Buffer>data);
    }

    return Buffer.concat(chunks);
  }

  async transcribeAudio(
    audioData: Buffer,
    accessToken: string,
  ): Promise<any> {
    try {
      const auth = new GoogleAuth({
        credentials: {},
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });

      this.speechClient = new SpeechClient({
        credentials: {},
        auth: auth,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const request: protos.google.cloud.speech.v1.IRecognizeRequest = {
        audio: {
          content: audioData.toString('base64'),
        },
        config: {
          encoding: protos.google.cloud.speech.v1.RecognitionConfig.AudioEncoding.LINEAR16,
          sampleRateHertz: 16000,
          languageCode: 'en-US',
          enableWordTimeOffsets: true,
          enableAutomaticPunctuation: true,
          model: 'latest_long',
          useEnhanced: true,
        },
      };

      const [response] = await this.speechClient.recognize(request);
      const result = response.results?.[0];

      if (!result?.alternatives?.[0]) {
        throw new Error('No transcription results available');
      }

      return {
        transcript: result.alternatives[0].transcript ?? '',
        confidence: result.alternatives[0].confidence ?? 0,
        words: result.alternatives[0].words?.map(word => ({
          word: word.word ?? '',
          startTime: Number(word.startTime?.seconds ?? 0),
          endTime: Number(word.endTime?.seconds ?? 0),
        })) ?? [],
      };
    } catch (error) {
      throw new UnauthorizedException('Failed to transcribe audio');
    }
  }

  private async summarizeTranscript(
    transcript: string,
    accessToken: string,
  ): Promise<string> {
    try {
      // Initialize Vertex AI with authentication
      this.vertexAI = new VertexAI({
        project: process.env.GOOGLE_PROJECT_ID,
        location: 'us-central1',
        googleAuthOptions: {
          credentials: {
            refresh_token: accessToken,
          },
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      });

      const model = this.vertexAI.preview.getGenerativeModel({
        model: 'gemini-pro',
      });

      const prompt = `Please provide a concise summary of this meeting transcript, 
      highlighting the main points discussed, any decisions made, and action items:
      
      ${transcript}
      
      Format the summary with the following sections:
      - Key Points
      - Decisions Made
      - Action Items`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.promptFeedback.blockReasonMessage ?? 'No summary generated';
    } catch (error) {
      console.log('Summarization error:', error);
      throw new UnauthorizedException('Failed to summarize transcript');
    }
  }

  private async saveResults(
    recordingId: string,
    results: {
      transcription: TranscriptionResult;
      summary: string;
    },
  ) {
    try {
      const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
      const resultsFile = bucket.file(`${recordingId}/results.json`);

      await resultsFile.save(JSON.stringify(results), {
        resumable: false,
        contentType: 'audio/wav',
      });
    } catch (error) {
      console.error('Failed to save results:', error);
      throw new BadRequestException('Failed to save recording results');
    }
  }

  async getRecordingResults(recordingId: string): Promise<{
    transcription: TranscriptionResult;
    summary: string;
  }> {
    try {
      const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
      const resultsFile = bucket.file(`${recordingId}/results.json`);

      const [data] = await resultsFile.download();
      return JSON.parse(data.toString());
    } catch (error) {
      throw new BadRequestException('Failed to retrieve recording results');
    }
  }

  async deleteRecording(recordingId: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(process.env.GOOGLE_STORAGE_BUCKET!);
      await bucket.deleteFiles({
        prefix: `${recordingId}/`,
      });
    } catch (error) {
      throw new BadRequestException('Failed to delete recording');
    }
  }
}
