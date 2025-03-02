import { Process, Processor } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { protos, SpeechClient } from '@google-cloud/speech';
import { RecordingService } from './recording.service';
import { VertexAI } from '@google-cloud/vertexai';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';
import * as serviceAccount from './scribe-bot.json';
import { CacheService } from './cache.service';
import { google as protoGoogle} from '@google-cloud/speech/build/protos/protos';

interface TranscriptionJob {
  recordingId: string;
  accessToken: string;
  sessionInfo?: {
    duration?: string;
    patientInfo?: {
      name: string;
      id?: string;
      type?: string;
    };
  };
}

@Injectable()
@Processor('transcription')
export class TranscriptionProcessor {
  private readonly logger = new Logger(TranscriptionProcessor.name);
  private readonly speechClient: SpeechClient;
  private readonly storage: Storage;
  private readonly vertexAi: VertexAI;
  private readonly bucketName: string;

  // Medical terminology and phrases for custom speech recognition context
  private readonly medicalPhrases = [
    // Common medical terms
    'hypertension', 'hyperlipidemia', 'diabetes mellitus', 'cardiovascular', 'endocrinology',
    'hematology', 'neurology', 'oncology', 'rheumatology', 'gastroenterology',
    'pulmonary', 'dermatology', 'nephrology', 'urology', 'orthopedics',

    // Common medications
    'metformin', 'atorvastatin', 'lisinopril', 'amlodipine', 'levothyroxine',
    'albuterol', 'insulin', 'hydrochlorothiazide', 'metoprolol', 'omeprazole',

    // Diagnostic terms
    'echocardiogram', 'electrocardiogram', 'magnetic resonance imaging', 'computed tomography',
    'ultrasound', 'endoscopy', 'colonoscopy', 'biopsy', 'pathology', 'laboratory',

    // Common medical phrases
    'chief complaint', 'past medical history', 'review of systems', 'vital signs',
    'family history', 'social history', 'allergies', 'medications', 'diagnosis',
    'treatment plan', 'follow up', 'side effects', 'adverse reaction'
  ];

  constructor(
    private configService: ConfigService,
    private recordingService: RecordingService,
    private cacheService: CacheService
  ) {
    // Initialize Speech-to-Text client with proper authentication
    this.speechClient = new SpeechClient({
      credentials: serviceAccount,
      projectId: this.configService.get('GOOGLE_PROJECT_ID'),
    });

    // Initialize Storage for handling large audio files more efficiently
    this.storage = new Storage({
      credentials: serviceAccount,
      projectId: this.configService.get('GOOGLE_PROJECT_ID'),
    });

    this.bucketName = this.configService.get('GOOGLE_BUCKET_NAME');

    // Initialize Vertex AI for improved summarization
    this.vertexAi = new VertexAI({
      project: this.configService.get('GOOGLE_PROJECT_ID'),
      location: 'us-central1',
      googleAuthOptions: {
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
  }

  @Process('process')
  async processTranscription(job: Job<TranscriptionJob>) {
    const { recordingId, accessToken, sessionInfo } = job.data;

    try {
      this.logger.log(`Starting transcription job for recording ${recordingId}`);
      job.progress(5);

      // Step 1: Get the audio data from Google Drive
      this.logger.log('Retrieving audio data from Google Drive');
      const combinedAudio = await this.getCombinedAudioFromDrive(recordingId, accessToken);
      job.progress(20);

      // Step 2: Optimize audio for transcription
      const optimizedAudioPath = await this.optimizeAudioForTranscription(combinedAudio);
      job.progress(30);

      // Step 3: Upload to GCS for Speech-to-Text processing
      const gcsUri = await this.uploadToGCS(optimizedAudioPath, recordingId);
      job.progress(40);

      // Step 4: Transcribe using enhanced Speech-to-Text with medical context
      this.logger.log('Starting transcription with medical context');
      const transcript = await this.transcribeAudioWithMedicalContext(gcsUri);
      job.progress(70);

      // Step 5: Generate an enhanced medical summary using Vertex AI
      this.logger.log('Generating enhanced medical summary');
      const summary = await this.generateMedicalSummary(transcript, sessionInfo);
      job.progress(90);

      // Step 6: Save results back to Google Drive
      this.logger.log('Saving results to Google Drive');
      await this.saveResultsToDrive(recordingId, transcript, summary, accessToken, sessionInfo);

      // Step 7: Clean up temporary files
      await this.cleanupTempFiles(optimizedAudioPath);

      // Step 8: Cache results for faster retrieval
      await this.cacheService.set(`recording:${recordingId}`, {
        transcript,
        summary,
        patientInfo: sessionInfo?.patientInfo,
        duration: sessionInfo?.duration
      }, 3600);

      job.progress(100);
      this.logger.log(`Completed transcription job for recording ${recordingId}`);

      return { transcript, summary };
    } catch (error) {
      this.logger.error(`Error processing transcription for recording ${recordingId}`, error.stack);
      throw error;
    }
  }

  private async getCombinedAudioFromDrive(recordingId: string, accessToken: string): Promise<Buffer> {
    try {
      const drive = this.getDriveService(accessToken);

      // Find audio folder in the recording
      const folderResponse = await drive.files.list({
        q: `name='audio' and mimeType='application/vnd.google-apps.folder' and '${recordingId}' in parents and trashed=false`,
        fields: 'files(id)',
      });

      if (!folderResponse.data.files || folderResponse.data.files.length === 0) {
        throw new Error('Audio folder not found');
      }

      const audioFolderId = folderResponse.data.files[0].id;

      // Get all audio chunks from the audio folder
      const chunksResponse = await drive.files.list({
        q: `'${audioFolderId}' in parents and name contains 'complete-recording' and trashed=false`,
        orderBy: 'name',
        fields: 'files(id, name)',
      });

      if (!chunksResponse.data.files || chunksResponse.data.files.length === 0) {
        throw new Error('No audio files found');
      }

      // Get the combined audio file (usually there's just one "complete-recording" file)
      const combinedAudioFileId = chunksResponse.data.files[0].id;

      // Download the audio file
      const response: any = await drive.files.get(
        { fileId: combinedAudioFileId, alt: 'media' },
        { responseType: 'arraybuffer' },
      );

      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error('Error retrieving audio from Drive:', error);
      throw new Error(`Failed to retrieve audio: ${error.message}`);
    }
  }

  private async optimizeAudioForTranscription(audioBuffer: Buffer): Promise<string> {
    try {
      // Create a temporary file for the input audio
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `input-${Date.now()}.wav`);
      const outputPath = path.join(tempDir, `optimized-${Date.now()}.flac`);

      // Write the buffer to a temporary file
      await fs.promises.writeFile(inputPath, audioBuffer);

      // Use FFmpeg to optimize the audio for transcription
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .audioChannels(1) // Mono audio for better speech recognition
          .audioFrequency(16000) // 16kHz sample rate optimal for speech
          .audioFilters([
            'highpass=f=200', // Remove low frequency noise
            'lowpass=f=3000', // Focus on speech frequencies
            'volume=1.5', // Increase volume a bit
            'silenceremove=1:0:-50dB' // Remove silence
          ])
          .format('flac') // FLAC format for lossless compression
          .on('end', () => {
            // Remove the input file
            fs.unlink(inputPath, (err) => {
              if (err) this.logger.warn(`Failed to delete temporary input file: ${err.message}`);
            });
            resolve(outputPath);
          })
          .on('error', (err) => {
            this.logger.error(`FFmpeg error: ${err.message}`);
            reject(new Error(`Failed to optimize audio: ${err.message}`));
          })
          .save(outputPath);
      });
    } catch (error) {
      this.logger.error('Error optimizing audio:', error);
      throw new Error(`Failed to optimize audio: ${error.message}`);
    }
  }

  private async uploadToGCS(audioFilePath: string, recordingId: string): Promise<string> {
    try {
      const fileName = `transcription-${recordingId}-${Date.now()}.flac`;
      const gcsUri = `gs://${this.bucketName}/${fileName}`;

      await this.storage.bucket(this.bucketName).upload(audioFilePath, {
        destination: fileName,
        metadata: {
          contentType: 'audio/flac',
        },
      });

      this.logger.log(`Uploaded audio to ${gcsUri}`);
      return gcsUri;
    } catch (error) {
      this.logger.error('Error uploading to GCS:', error);
      throw new Error(`Failed to upload audio: ${error.message}`);
    }
  }

  private async transcribeAudioWithMedicalContext(gcsUri: string): Promise<string> {
    try {
      this.logger.log('Starting transcription with medical context...');

      // Create speech recognition context with medical phrases
      const speechContext = {
        phrases: this.medicalPhrases,
        boost: 20 // Boost the likelihood of recognizing these phrases
      };
      const AudioEncoding = protos.google.cloud.speech.v1.RecognitionConfig.AudioEncoding;

      // Configure the request with enhanced settings for medical transcription
      const request = {
        audio: {
          uri: gcsUri,
        },
        config: {
          encoding: AudioEncoding.FLAC, // Use the enum instead of string
          sampleRateHertz: 16000,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'medical_conversation',
          useEnhanced: true,
          speechContexts: [speechContext],
          enableWordTimeOffsets: true,
          enableWordConfidence: true,
          maxAlternatives: 1,
          profanityFilter: false,
          enableSpeakerDiarization: true,
          diarizationSpeakerCount: 2,
          audioChannelCount: 1,
        },
      };

      // Start the long-running recognition operation
// Replace the problematic code with this approach:
      const operationResponse = await this.speechClient.longRunningRecognize(request);
      const operation = operationResponse[0];

// Then continue with:
      const [response] = await operation.promise();

      if (!response.results || response.results.length === 0) {
        throw new Error('No transcription results returned');
      }

      // Process the transcription with speaker information
      let transcript = '';
      let currentSpeaker = null;

      response.results.forEach(result => {
        if (result.alternatives && result.alternatives[0]) {
          const words = result.alternatives[0].words || [];

          for (const word of words) {
            // Handle speaker changes
            if (word.speakerTag && word.speakerTag !== currentSpeaker) {
              if (currentSpeaker !== null) {
                transcript += '\n';
              }
              // Label speakers as "Doctor" and "Patient" for clarity
              const speakerLabel = word.speakerTag === 1 ? 'Doctor' : 'Patient';
              transcript += `${speakerLabel}: `;
              currentSpeaker = word.speakerTag;
            }

            transcript += `${word.word} `;
          }

          // Add a new line after each result
          if (words.length > 0) {
            transcript += '\n';
          }
        }
      });

      // Clean up transcription
      transcript = transcript
        .replace(/\s+/g, ' ') // Remove extra spaces
        .replace(/\n\s*\n/g, '\n') // Remove extra line breaks
        .trim();

      return transcript;
    } catch (error) {
      this.logger.error('Transcription error:', error);
      throw new Error(`Transcription failed: ${error.message}`);
    } finally {
      // Clean up: Delete the temporary file from GCS
      try {
        const fileName = gcsUri.replace(`gs://${this.bucketName}/`, '');
        await this.storage.bucket(this.bucketName).file(fileName).delete();
        this.logger.log('Temporary audio file deleted from GCS');
      } catch (cleanupError) {
        this.logger.warn('Failed to delete temporary GCS file:', cleanupError);
      }
    }
  }

  private async generateMedicalSummary(transcript: string, sessionInfo?: any): Promise<string> {
    try {
      // Get patient info for more personalized summary
      const patientName = sessionInfo?.patientInfo?.name || 'the patient';
      const patientId = sessionInfo?.patientInfo?.id || '';
      const visitType = sessionInfo?.patientInfo?.type || 'consultation';

      // Use Vertex AI Gemini Pro model for higher quality medical summarization
      const model = this.vertexAi.preview.getGenerativeModel({
        model: 'gemini-pro',
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.2,
          topP: 0.8,
          topK: 40,
        },
      });

      const prompt = `You are a medical scribe assistant. Analyze this medical consultation transcript and create a detailed, structured medical summary.

Patient Name: ${patientName}${patientId ? ` (ID: ${patientId})` : ''}
Visit Type: ${visitType}

CONSULTATION TRANSCRIPT:
${transcript}

Create a comprehensive medical summary with these sections:
1. Chief Complaint: Summarize the main reasons for the visit
2. History of Present Illness: Key details about the current medical issues
3. Past Medical History: Relevant medical history mentioned
4. Medications: Current medications and any changes discussed
5. Physical Examination: Findings from any examinations performed
6. Assessment: The doctor's assessment or diagnosis
7. Plan: Treatment plan, prescriptions, follow-up recommendations
8. Patient Education: Any instructions or education provided to the patient

Format each section with appropriate headers and bullet points for clarity. Maintain medical accuracy and use proper medical terminology.`;

      const result = await model.generateContent(prompt);
      const summary = result.response.candidates[0].content.parts[0].text;

      return summary;
    } catch (error) {
      this.logger.error('Summarization error:', error);

      // Fallback to a simpler summary if advanced summarization fails
      try {
        return this.generateFallbackSummary(transcript);
      } catch (fallbackError) {
        return `Summary generation failed. Please review the transcript directly.`;
      }
    }
  }

  private async generateFallbackSummary(transcript: string): Promise<string> {
    // Simple rule-based extraction of key points
    const sections = {
      'Chief Complaint': this.extractSection(transcript, ['chief complaint', 'reason for visit', 'what brings you']),
      'Assessment': this.extractSection(transcript, ['assessment', 'diagnosis', 'condition']),
      'Plan': this.extractSection(transcript, ['plan', 'recommendation', 'follow up', 'prescription'])
    };

    let summary = '# Medical Consultation Summary\n\n';

    for (const [title, content] of Object.entries(sections)) {
      summary += `## ${title}\n${content || 'Not specified'}\n\n`;
    }

    return summary;
  }

  private extractSection(transcript: string, keywords: string[]): string {
    // Find sentences containing keywords
    const sentences = transcript.split(/[.!?]\s/).filter(s => s.length > 10);
    const matchingSentences = sentences.filter(sentence =>
      keywords.some(keyword =>
        sentence.toLowerCase().includes(keyword.toLowerCase())
      )
    );

    return matchingSentences.join('. ');
  }

  private async saveResultsToDrive(
    recordingId: string,
    transcript: string,
    summary: string,
    accessToken: string,
    sessionInfo?: any
  ): Promise<void> {
    try {
      const drive = this.getDriveService(accessToken);

      // Create a results subfolder if it doesn't exist
      const resultsFolder = await this.getOrCreateSubfolder(drive, recordingId, 'results');

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // Create and upload result files
      const files = [
        { name: `transcript-${timestamp}.txt`, content: transcript, mimeType: 'text/plain' },
        { name: `summary-${timestamp}.txt`, content: summary, mimeType: 'text/plain' },
        {
          name: `transcript-${timestamp}.html`,
          content: this.formatTranscriptAsHtml(transcript, sessionInfo),
          mimeType: 'text/html',
        },
        {
          name: `summary-${timestamp}.html`,
          content: this.formatSummaryAsHtml(summary, sessionInfo),
          mimeType: 'text/html',
        },
      ];

      // Use Promise.all for parallel uploads
      await Promise.all(files.map(file => this.uploadFileToDrive(drive, resultsFolder, file)));

      // Update session metadata with completion info
      const sessionMetadata = {
        status: 'completed',
        completedAt: new Date().toISOString(),
        transcriptLength: transcript.length,
        summaryAvailable: true
      };

      await this.updateSessionMetadata(drive, recordingId, sessionMetadata);
    } catch (error) {
      this.logger.error('Error saving results to Drive:', error);
      throw new Error(`Failed to save results: ${error.message}`);
    }
  }

  private async uploadFileToDrive(drive: any, folderId: string, file: { name: string; content: string; mimeType: string }): Promise<void> {
    const fileMetadata = {
      name: file.name,
      parents: [folderId],
    };

    await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: file.mimeType,
        body: file.content,
      },
      fields: 'id',
    });
  }

  private formatTranscriptAsHtml(transcript: string, sessionInfo?: any): string {
    // Create patient information section
    const patientInfo = sessionInfo?.patientInfo || {};
    const patientInfoHtml = `
    <div class="patient-info">
      <h2>Patient Information</h2>
      <table>
        <tr><td><strong>Name:</strong></td><td>${patientInfo.name || 'Not specified'}</td></tr>
        ${patientInfo.id ? `<tr><td><strong>ID:</strong></td><td>${patientInfo.id}</td></tr>` : ''}
        <tr><td><strong>Visit Type:</strong></td><td>${patientInfo.type || 'Not specified'}</td></tr>
        <tr><td><strong>Date:</strong></td><td>${new Date().toLocaleDateString()}</td></tr>
        ${sessionInfo?.duration ? `<tr><td><strong>Duration:</strong></td><td>${sessionInfo.duration}</td></tr>` : ''}
      </table>
    </div>`;

    // Format the transcript with speaker highlighting
    let formattedTranscript = '';
    const lines = transcript.split('\n');

    for (const line of lines) {
      if (line.startsWith('Doctor:')) {
        formattedTranscript += `<p class="doctor-speech">${line}</p>`;
      } else if (line.startsWith('Patient:')) {
        formattedTranscript += `<p class="patient-speech">${line}</p>`;
      } else if (line.trim()) {
        formattedTranscript += `<p>${line}</p>`;
      }
    }

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Medical Consultation Transcript</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; margin: 40px; color: #333; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #2980b9; margin-top: 20px; }
        .patient-info { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .patient-info table { width: 100%; border-collapse: collapse; }
        .patient-info td { padding: 8px; border-bottom: 1px solid #ddd; }
        .transcript { background-color: #fff; padding: 20px; border-radius: 5px; border: 1px solid #e9ecef; }
        .doctor-speech { color: #2980b9; background-color: #e3f2fd; padding: 10px; border-radius: 5px; margin: 5px 0; }
        .patient-speech { color: #16a085; background-color: #e8f5e9; padding: 10px; border-radius: 5px; margin: 5px 0; }
        .timestamp { color: #7f8c8d; font-size: 0.8em; text-align: right; margin-top: 30px; }
        footer { margin-top: 30px; font-size: 0.8em; color: #7f8c8d; text-align: center; }
      </style>
    </head>
    <body>
      <h1>Medical Consultation Transcript</h1>
      ${patientInfoHtml}
      <div class="transcript">
        ${formattedTranscript}
      </div>
      <div class="timestamp">Generated on: ${new Date().toLocaleString()}</div>
      <footer>
        Generated by Medical Consultation Recording System
      </footer>
    </body>
    </html>
    `;
  }

  private formatSummaryAsHtml(summary: string, sessionInfo?: any): string {
    // Create patient information section
    const patientInfo = sessionInfo?.patientInfo || {};
    const patientInfoHtml = `
    <div class="patient-info">
      <h2>Patient Information</h2>
      <table>
        <tr><td><strong>Name:</strong></td><td>${patientInfo.name || 'Not specified'}</td></tr>
        ${patientInfo.id ? `<tr><td><strong>ID:</strong></td><td>${patientInfo.id}</td></tr>` : ''}
        <tr><td><strong>Visit Type:</strong></td><td>${patientInfo.type || 'Not specified'}</td></tr>
        <tr><td><strong>Date:</strong></td><td>${new Date().toLocaleDateString()}</td></tr>
        ${sessionInfo?.duration ? `<tr><td><strong>Duration:</strong></td><td>${sessionInfo.duration}</td></tr>` : ''}
      </table>
    </div>`;

    // Convert markdown-style headers to HTML
    let formattedSummary = summary
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^#### (.*$)/gm, '<h4>$1</h4>')
      .replace(/^##### (.*$)/gm, '<h5>$1</h5>')
      .replace(/^###### (.*$)/gm, '<h6>$1</h6>');

    // Convert bullet points
    formattedSummary = formattedSummary
      .replace(/^\* (.*$)/gm, '<li>$1</li>')
      .replace(/^- (.*$)/gm, '<li>$1</li>');

    // Wrap lists in <ul> tags
    formattedSummary = formattedSummary
      .replace(/(<li>.*<\/li>)(\n)(?!<li>)/g, '$1</ul>$2')
      .replace(/(?<!<\/ul>\n)(<li>)/g, '<ul>$1');

    // Convert paragraphs
    formattedSummary = formattedSummary
      .replace(/(?<!\n<\/ul>)(?<!\n<\/li>)(?<!\n<\/h[1-6]>)\n\n/g, '</p><p>')
      .replace(/(.+?)(?=<h[1-6]|<ul|<\/p>|$)/gs, (match) => {
        if (match.trim() && !match.trim().startsWith('<')) {
          return `<p>${match.trim()}</p>`;
        }
        return match;
      });

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Medical Consultation Summary</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; margin: 40px; color: #333; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #2980b9; margin-top: 20px; border-bottom: 1px solid #bdc3c7; padding-bottom: 5px; }
        h3 { color: #3498db; }
        .patient-info { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .patient-info table { width: 100%; border-collapse: collapse; }
        .patient-info td { padding: 8px; border-bottom: 1px solid #ddd; }
        .summary { background-color: #fff; padding: 20px; border-radius: 5px; border: 1px solid #e9ecef; }
        section { margin-bottom: 20px; }
        ul { margin-left: 20px; }
        li { margin-bottom: 5px; }
        .timestamp { color: #7f8c8d; font-size: 0.8em; text-align: right; margin-top: 30px; }
        footer { margin-top: 30px; font-size: 0.8em; color: #7f8c8d; text-align: center; }
      </style>
    </head>
    <body>
      <h1>Medical Consultation Summary</h1>
      ${patientInfoHtml}
      <div class="summary">
        ${formattedSummary}
      </div>
      <div class="timestamp">Generated on: ${new Date().toLocaleString()}</div>
      <footer>
        Generated by Medical Consultation Recording System
      </footer>
    </body>
    </html>
    `;
  }

  private async cleanupTempFiles(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        this.logger.log(`Deleted temporary file: ${filePath}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to delete temporary file: ${error.message}`);
    }
  }

  // Helper methods
  private getDriveService(accessToken: string): any {
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: accessToken });
    return google.drive({ version: 'v3', auth });
  }

  private async getOrCreateSubfolder(drive: any, parentId: string, folderName: string): Promise<string> {
    try {
      // Check if the subfolder already exists
      const response = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        spaces: 'drive',
        fields: 'files(id, name)',
      });

      if (response.data.files && response.data.files.length > 0) {
        // Folder exists, return its ID
        return response.data.files[0].id;
      } else {
        // Create the folder if it doesn't exist
        const folderMetadata = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        };

        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id',
        });

        return folder.data.id;
      }
    } catch (error) {
      this.logger.error(`Error getting or creating ${folderName} subfolder:`, error);
      throw new Error(`Failed to access or create folder: ${error.message}`);
    }
  }

  private async updateSessionMetadata(drive: any, folderId: string, newMetadata: any): Promise<void> {
    try {
      // Find the metadata file
      const response = await drive.files.list({
        q: `name='session-info.json' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
      });

      if (!response.data.files || response.data.files.length === 0) {
        // Create new metadata file if it doesn't exist
        const metadataContent = JSON.stringify(newMetadata, null, 2);
        await this.uploadFileToDrive(drive, folderId, {
          name: 'session-info.json',
          content: metadataContent,
          mimeType: 'application/json'
        });
        return;
      }

      const metadataFileId = response.data.files[0].id;

      // Get current content
      const currentFile: any = await drive.files.get(
        { fileId: metadataFileId, alt: 'media' },
        { responseType: 'json' },
      );

      // Merge existing and new metadata
      const updatedMetadata = { ...currentFile.data, ...newMetadata };

      // Update the file
      await drive.files.update({
        fileId: metadataFileId,
        media: {
          mimeType: 'application/json',
          body: JSON.stringify(updatedMetadata, null, 2),
        },
      });
    } catch (error) {
      this.logger.error('Error updating session metadata:', error);
      // Just log the error without throwing since this is non-critical
    }
  }
}
