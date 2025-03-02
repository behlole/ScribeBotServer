import { BadRequestException, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { VertexAI } from '@google-cloud/vertexai';
import * as serviceAccount from './scribe-bot.json';

@Injectable()
export class RecordingService {
  vertexAi: VertexAI;

  constructor(private configService: ConfigService) {
    console.log(this.configService.get('GOOGLE_PROJECT_ID'));
    this.vertexAi = new VertexAI({
      project: this.configService.get('GOOGLE_PROJECT_ID'),
      location: 'us-central1',
      googleAuthOptions: {
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
  }

  async startRecording(accessToken: string, patientInfo?: { name: string, id?: string, type?: string }): Promise<{
    recordingId: string;
    message: string;
    folderPath: string
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      // Get or create the root 'scribe-bot' folder
      const rootFolderId = await this.getOrCreateScribeBotFolder(drive);

      // Format patient name for folder name or use default if not provided
      const patientName = patientInfo?.name ? this.sanitizeFileName(patientInfo.name) : 'Unknown-Patient';
      const patientId = patientInfo?.id ? `-${patientInfo.id}` : '';
      const type = patientInfo?.type ? `-${patientInfo.type}` : '';

      // Create a folder for the recording with timestamp and patient info
      const currentDate = new Date();
      const dateString = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD
      const timeString = currentDate.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS

      const folderName = `${patientName}${patientId}_${type}_${dateString}_${timeString}`;

      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootFolderId],
      };

      const folder = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id, name',
      });

      // Create a metadata file with session info
      const metadataContent = JSON.stringify({
        patientName: patientInfo?.name || 'Unknown Patient',
        patientId: patientInfo?.id || 'N/A',
        type: type || 'N/A',
        recordingDate: currentDate.toISOString(),
        createdBy: 'Scribe Bot Medical Recording System',
      }, null, 2);

      await this.createTextFile(
        drive,
        folder.data.id!,
        'session-info.json',
        metadataContent,
        'application/json',
      );

      // Create a temporary chunks folder that will be deleted after processing
      await this.getOrCreateSubfolder(drive, folder.data.id!, 'temp-chunks');

      return {
        recordingId: folder.data.id!,
        message: `Recording initialized for patient ${patientName} in your Google Drive`,
        folderPath: `scribe-bot/${folderName}`,
      };
    } catch (error) {
      console.error('Start recording error:', error);
      throw new BadRequestException('Failed to initialize recording in your Google Drive');
    }
  }

  // Helper method to sanitize file names
  private sanitizeFileName(fileName: string): string {
    // Replace invalid characters with underscores
    return fileName
      .replace(/[\\/:*?"<>|]/g, '_') // Remove invalid filename characters
      .replace(/\s+/g, '_'); // Replace spaces with underscores
  }

  // Helper method to get or create the root scribe-bot folder
  private async getOrCreateScribeBotFolder(drive: drive_v3.Drive): Promise<string> {
    try {
      // Check if the scribe-bot folder already exists
      const response = await drive.files.list({
        q: 'name=\'scribe-bot\' and mimeType=\'application/vnd.google-apps.folder\' and trashed=false',
        spaces: 'drive',
        fields: 'files(id, name)',
      });

      if (response.data.files && response.data.files.length > 0) {
        // Folder exists, return its ID
        return response.data.files[0].id!;
      } else {
        // Create the folder if it doesn't exist
        const folderMetadata = {
          name: 'scribe-bot',
          mimeType: 'application/vnd.google-apps.folder',
        };

        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id',
        });

        return folder.data.id!;
      }
    } catch (error) {
      console.error('Error getting or creating scribe-bot folder:', error);
      throw new BadRequestException('Failed to access or create scribe-bot folder');
    }
  }

  // Helper method to create a text file
  private async createTextFile(
    drive: drive_v3.Drive,
    folderId: string,
    fileName: string,
    content: string,
    mimeType: string = 'text/plain',
  ): Promise<string> {
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: content,
      },
      fields: 'id',
    });

    return file.data.id!;
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

      // Store in temporary chunks folder instead of permanent audio-chunks folder
      const chunksFolder = await this.getOrCreateSubfolder(drive, recordingId, 'temp-chunks');

      const fileMetadata = {
        name: `chunk-${chunkNumber.toString().padStart(3, '0')}.wav`,
        parents: [chunksFolder],
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

  // Helper method to get or create a subfolder
  private async getOrCreateSubfolder(
    drive: drive_v3.Drive,
    parentId: string,
    folderName: string,
    createIfNotExist: boolean = true
  ): Promise<string | null> {
    try {
      // Check if the subfolder already exists
      const response = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        spaces: 'drive',
        fields: 'files(id, name)',
      });

      if (response.data.files && response.data.files.length > 0) {
        // Folder exists, return its ID
        return response.data.files[0].id!;
      } else if (createIfNotExist) {
        // Create the folder if it doesn't exist and we're asked to create it
        const folderMetadata = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        };

        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id',
        });

        return folder.data.id!;
      } else {
        // Folder doesn't exist and we're not creating it
        return null;
      }
    } catch (error) {
      console.error(`Error getting or creating ${folderName} subfolder:`, error);
      if (createIfNotExist) {
        throw new BadRequestException(`Failed to access or create ${folderName} subfolder`);
      }
      return null;
    }
  }

  async stopRecording(recordingId: string, accessToken: string): Promise<{
    transcript: string;
    summary: string;
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      // Get all audio chunks from the temporary chunks folder
      const tempChunksFolder = await this.getOrCreateSubfolder(drive, recordingId, 'temp-chunks');

      const chunks = await drive.files.list({
        q: `'${tempChunksFolder}' in parents and mimeType='audio/wav'`,
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

      // Save the combined audio file to the recording folder
      await this.saveCombinedAudioFile(recordingId, combinedAudio, accessToken);

      // Transcribe using user's Speech-to-Text
      const transcript = await this.transcribeAudio(combinedAudio, accessToken);

      // Summarize using user's Vertex AI
      const summary = await this.summarizeTranscript(transcript);

      // Save results back to user's Drive in the main recording folder
      await this.saveResultsToDrive(recordingId, transcript, JSON.stringify(summary), accessToken);

      // Update session metadata with completion info
      const sessionMetadata = {
        status: 'completed',
        completedAt: new Date().toISOString(),
        transcriptLength: transcript.length,
        audioChunks: chunks.data.files.length,
      };

      await this.updateSessionMetadata(drive, recordingId, sessionMetadata);

      // Delete the temporary chunks folder and all its contents after processing
      await this.deleteFolder(drive, tempChunksFolder);

      return { transcript, summary };
    } catch (error) {
      console.error('Stop recording error:', error);
      throw new BadRequestException('Failed to process recording');
    }
  }

  // Helper method to save the combined audio file
  private async saveCombinedAudioFile(
    recordingId: string,
    audioBuffer: Buffer,
    accessToken: string,
  ): Promise<string> {
    try {
      const drive = this.getDriveService(accessToken);

      // Create an audio folder to store the combined file
      const audioFolder = await this.getOrCreateSubfolder(drive, recordingId, 'audio');

      // Add timestamp to filename for organization
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `complete-recording-${timestamp}.wav`;

      const fileMetadata = {
        name: fileName,
        parents: [audioFolder],
      };

      // Convert Buffer to Readable stream
      const mediaStream = this.bufferToStream(audioBuffer);

      const file = await drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: 'audio/wav',
          body: mediaStream,
        },
        fields: 'id',
      });

      console.log(`Saved combined audio file: ${fileName}`);
      return file.data.id!;
    } catch (error) {
      console.error('Error saving combined audio file:', error);
      throw new BadRequestException('Failed to save combined audio file');
    }
  }

  // Helper method to delete a folder and all its contents
  private async deleteFolder(drive: drive_v3.Drive, folderId: string): Promise<void> {
    try {
      // First, ensure this is a folder (safety check)
      const folderCheck = await drive.files.get({
        fileId: folderId,
        fields: 'mimeType',
      });

      if (folderCheck.data.mimeType !== 'application/vnd.google-apps.folder') {
        console.error('Not a folder. Delete operation cancelled for safety.');
        return;
      }

      // Option 1: Delete the folder directly, which will also delete its contents
      await drive.files.delete({
        fileId: folderId,
      });

      console.log(`Successfully deleted folder ${folderId} and its contents`);
    } catch (error) {
      console.error('Error deleting folder:', error);
      // Log but don't throw, as this is cleanup
    }
  }

  // Helper method to update session metadata
  private async updateSessionMetadata(drive: drive_v3.Drive, folderId: string, newMetadata: any): Promise<void> {
    try {
      // Find the metadata file
      const response = await drive.files.list({
        q: `name='session-info.json' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
      });

      if (!response.data.files || response.data.files.length === 0) {
        // Create new metadata file if it doesn't exist
        await this.createTextFile(
          drive,
          folderId,
          'session-info.json',
          JSON.stringify(newMetadata, null, 2),
          'application/json',
        );
        return;
      }

      const metadataFileId = response.data.files[0].id!;

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
      console.error('Error updating session metadata:', error);
      // Just log the error without throwing since this is non-critical
    }
  }

  private async transcribeAudio(audioBuffer: Buffer, accessToken: string): Promise<string> {
    try {
      console.log('Starting transcription...');
      console.log('Audio buffer size:', audioBuffer.length);

      // Import the Speech client library
      const { SpeechClient } = require('@google-cloud/speech');

      // Create a speech client using service account
      const speechClient = new SpeechClient({
        credentials: serviceAccount,
        projectId: this.configService.get('GOOGLE_PROJECT_ID'),
      });

      // Upload to Google Cloud Storage first
      const bucketName = this.configService.get('GOOGLE_BUCKET_NAME');
      const fileName = `recording-${Date.now()}.webm`;
      const gcsUri = `gs://${bucketName}/${fileName}`;

      // Upload the audio buffer to GCS
      await this.uploadToGCS(audioBuffer, bucketName, fileName, accessToken);
      console.log(`Uploaded audio to ${gcsUri}`);

      // Configure the request
      const request = {
        audio: {
          uri: gcsUri,
        },
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'default',
          useEnhanced: true,
          audioChannelCount: 1,
        },
      };

      console.log('Initiating long-running transcription...');

      // Start the long-running operation
      const [operation] = await speechClient.longRunningRecognize(request);

      // Wait for the operation to complete
      console.log('Waiting for operation to complete...');
      const [response] = await operation.promise();

      console.log('Transcription complete');

      // Extract transcript from response
      if (!response.results || response.results.length === 0) {
        throw new Error('No speech detected in the audio');
      }

      const transcript = response.results
        .map(result => result.alternatives[0].transcript)
        .join(' ');

      console.log('Transcript generated successfully');

      // Clean up: Delete the temporary file from GCS
      await this.deleteFromGCS(bucketName, fileName, accessToken);
      console.log('Temporary audio file deleted from GCS');

      return transcript;
    } catch (error) {
      console.error('Transcription error:', error);
      throw new BadRequestException(`Transcription failed: ${error.message}`);
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

    // Create a results subfolder
    const resultsFolder = await this.getOrCreateSubfolder(drive, folderId, 'results');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const files = [
      { name: `transcript-${timestamp}.txt`, content: transcript, mimeType: 'text/plain' },
      { name: `summary-${timestamp}.txt`, content: summary, mimeType: 'text/plain' },
      // Also save a formatted HTML version for better readability
      {
        name: `transcript-${timestamp}.html`,
        content: this.formatTranscriptAsHtml(transcript),
        mimeType: 'text/html',
      },
      {
        name: `summary-${timestamp}.html`,
        content: this.formatSummaryAsHtml(summary),
        mimeType: 'text/html',
      },
    ];

    for (const file of files) {
      const fileMetadata = {
        name: file.name,
        parents: [resultsFolder],
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
  }

  // Helper methods to format content as HTML for better readability
  private formatTranscriptAsHtml(transcript: string): string {
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Medical Consultation Transcript</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; margin: 40px; }
        h1 { color: #2c3e50; }
        .transcript { background-color: #f9f9f9; padding: 20px; border-radius: 5px; }
        .timestamp { color: #888; font-size: 0.8em; }
        footer { margin-top: 30px; font-size: 0.8em; color: #7f8c8d; }
      </style>
    </head>
    <body>
      <h1>Medical Consultation Transcript</h1>
      <p class="timestamp">Generated on: ${new Date().toLocaleString()}</p>
      <div class="transcript">
        ${transcript.split('\n').map(para => `<p>${para}</p>`).join('')}
      </div>
      <footer>
        Generated by Scribe Bot Medical Recording System
      </footer>
    </body>
    </html>
    `;
  }

  private formatSummaryAsHtml(summaryJson: string): string {
    try {
      // Parse the summary JSON or use as plain text if parsing fails
      let summaryContent = '';
      try {
        const summary = JSON.parse(summaryJson);
        summaryContent = summary;
      } catch {
        summaryContent = summaryJson;
      }

      return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Medical Consultation Summary</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; margin: 40px; }
          h1 { color: #2c3e50; }
          h2 { color: #3498db; margin-top: 20px; }
          .summary { background-color: #f9f9f9; padding: 20px; border-radius: 5px; }
          .timestamp { color: #888; font-size: 0.8em; }
          footer { margin-top: 30px; font-size: 0.8em; color: #7f8c8d; }
          ul { margin-left: 20px; }
        </style>
      </head>
      <body>
        <h1>Medical Consultation Summary</h1>
        <p class="timestamp">Generated on: ${new Date().toLocaleString()}</p>
        <div class="summary">
          ${typeof summaryContent === 'string' ? summaryContent : JSON.stringify(summaryContent, null, 2)}
        </div>
        <footer>
          Generated by Scribe Bot Medical Recording System
        </footer>
      </body>
      </html>
      `;
    } catch (error) {
      // Fallback to basic formatting if there's an error
      return `
      <!DOCTYPE html>
      <html>
      <head><title>Summary</title></head>
      <body>
        <h1>Medical Consultation Summary</h1>
        <pre>${summaryJson}</pre>
      </body>
      </html>
      `;
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

      // Get the results subfolder
      const resultsFolder = await this.getOrCreateSubfolder(drive, recordingId, 'results');

      // Look for the latest files based on timestamp in filename
      const files = await drive.files.list({
        q: `'${resultsFolder}' in parents and (name contains 'transcript' or name contains 'summary') and name ends with '.txt'`,
        fields: 'files(id, name)',
        orderBy: 'name desc',
      });

      if (!files.data.files?.length) {
        throw new BadRequestException('Results not found');
      }

      const results: { transcript: string; summary: string } = {
        transcript: '',
        summary: '',
      };

      // Group files by type and get the latest of each
      const transcriptFiles = files.data.files.filter(file => file.name!.includes('transcript'));
      const summaryFiles = files.data.files.filter(file => file.name!.includes('summary'));

      if (transcriptFiles.length > 0) {
        const latestTranscript = transcriptFiles[0]; // First file is latest due to orderBy
        const response = await drive.files.get(
          { fileId: latestTranscript.id!, alt: 'media' },
          { responseType: 'text' },
        );
        results.transcript = typeof response.data === 'string' ? response.data : '';
      }

      if (summaryFiles.length > 0) {
        const latestSummary = summaryFiles[0]; // First file is latest due to orderBy
        const response = await drive.files.get(
          { fileId: latestSummary.id!, alt: 'media' },
          { responseType: 'text' },
        );
        results.summary = typeof response.data === 'string' ? response.data : '';
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
    patientInfo?: any;
    audioFileId?: string;
  }> {
    try {
      const drive = this.getDriveService(accessToken);

      // Initialize the results
      const results: { transcript: string; summary: string; patientInfo?: any; audioFileId?: string } = {
        transcript: '',
        summary: '',
      };

      // 1. Try to get patient info from session metadata
      try {
        // Get all files in the recording folder
        const allFiles = await drive.files.list({
          q: `'${recordingId}' in parents and trashed=false`,
          fields: 'files(id, name, mimeType)',
        });

        // Find the session-info.json file
        const metadataFile = allFiles.data.files?.find(file => file.name === 'session-info.json');

        if (metadataFile) {
          const metadataContent: any = await drive.files.get(
            { fileId: metadataFile.id!, alt: 'media' },
            { responseType: 'json' },
          );
          results.patientInfo = metadataContent.data;
        }

        // 2. Find the audio folder and get the audio file
        const audioFolder = allFiles.data.files?.find(
          file => file.name === 'audio' && file.mimeType === 'application/vnd.google-apps.folder'
        );

        if (audioFolder) {
          // Get audio files in the audio folder
          const audioFiles = await drive.files.list({
            q: `'${audioFolder.id}' in parents and trashed=false`,
            fields: 'files(id, name)',
          });

          // Find complete recording file
          const audioFile = audioFiles.data.files?.find(file => file.name.includes('complete-recording'));

          if (audioFile) {
            results.audioFileId = audioFile.id;
          }
        }

        // 3. Find the results folder
        const resultsFolder = allFiles.data.files?.find(
          file => file.name === 'results' && file.mimeType === 'application/vnd.google-apps.folder'
        );

        if (resultsFolder) {
          // Get all files in the results folder
          const resultFiles = await drive.files.list({
            q: `'${resultsFolder.id}' in parents and trashed=false`,
            fields: 'files(id, name)',
          });

          let transcriptFile = null;
          let summaryFile = null;

          // Find latest transcript and summary files (assume newer files have longer names with timestamps)
          for (const file of resultFiles.data.files || []) {
            if (file.name.includes('transcript') && file.name.endsWith('.txt')) {
              if (!transcriptFile || file.name.length > transcriptFile.name.length) {
                transcriptFile = file;
              }
            } else if (file.name.includes('summary') && file.name.endsWith('.txt')) {
              if (!summaryFile || file.name.length > summaryFile.name.length) {
                summaryFile = file;
              }
            }
          }

          // Get transcript content
          if (transcriptFile) {
            const response = await drive.files.get(
              { fileId: transcriptFile.id, alt: 'media' },
              { responseType: 'text' },
            );
            results.transcript = typeof response.data === 'string' ? response.data : '';
          }

          // Get summary content
          if (summaryFile) {
            const response = await drive.files.get(
              { fileId: summaryFile.id, alt: 'media' },
              { responseType: 'text' },
            );
            results.summary = typeof response.data === 'string' ? response.data : '';
          }
        }

        // 4. If we didn't get results from results folder, look for legacy files
        if (!results.transcript || !results.summary) {
          // Look for transcript.txt and summary.txt directly in the main folder
          const transcriptFile = allFiles.data.files?.find(file => file.name === 'transcript.txt');
          const summaryFile = allFiles.data.files?.find(file => file.name === 'summary.txt');

          if (transcriptFile && !results.transcript) {
            const response = await drive.files.get(
              { fileId: transcriptFile.id, alt: 'media' },
              { responseType: 'text' },
            );
            results.transcript = typeof response.data === 'string' ? response.data : '';
          }

          if (summaryFile && !results.summary) {
            const response = await drive.files.get(
              { fileId: summaryFile.id, alt: 'media' },
              { responseType: 'text' },
            );
            results.summary = typeof response.data === 'string' ? response.data : '';
          }
        }
      } catch (error) {
        console.error('Error retrieving recording data:', error);
      }

      // Check if we have found any results
      if (!results.transcript && !results.summary) {
        throw new BadRequestException('Results not found');
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

  // Helper method to upload to Google Cloud Storage
  private async uploadToGCS(buffer: Buffer, bucketName: string, fileName: string, accessToken: string): Promise<void> {
    try {
      const storage = google.storage('v1');
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: accessToken });

      // Create a readable stream from buffer
      const mediaStream = this.bufferToStream(buffer);

      await storage.objects.insert({
        auth,
        bucket: bucketName,
        name: fileName,
        media: {
          mimeType: 'audio/webm',
          body: mediaStream,
        },
      });

      console.log(`Successfully uploaded ${fileName} to bucket ${bucketName}`);
    } catch (error) {
      console.error('Error uploading to GCS:', error);
      throw new BadRequestException(`Failed to upload audio: ${error.message}`);
    }
  }

  // Similarly, update the delete method
  private async deleteFromGCS(bucketName: string, fileName: string, accessToken: string): Promise<void> {
    try {
      const storage = google.storage('v1');
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: accessToken });

      await storage.objects.delete({
        auth,
        bucket: bucketName,
        object: fileName,
      });

      console.log(`Successfully deleted ${fileName} from bucket ${bucketName}`);
    } catch (error) {
      console.error('Error deleting from GCS:', error);
      // Just log the error without throwing since this is cleanup
    }
  }


  /**
   * Get a list of all recordings
   * @param accessToken The user's access token
   * @param filters Optional filters for the recording list
   * @returns Promise containing the list of recordings
   */
  async getAllRecordings(
    accessToken: string,
    filters?: { patientName?: string; type?: string }
  ): Promise<Array<{
    id: string;
    folderName: string;
    patientName?: string;
    patientId?: string;
    type?: string;
    date: string;
    status: string;
    audioFileId?: string;
    thumbnailLink?: string;
  }>> {
    try {
      const drive = this.getDriveService(accessToken);

      // First, get the scribe-bot folder
      const rootFolderId = await this.getOrCreateScribeBotFolder(drive);

      // Build query to find all recording folders inside the scribe-bot folder
      let query = `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

      // Add patient name filter if provided
      if (filters?.patientName) {
        const sanitizedName = this.sanitizeFileName(filters.patientName);
        query += ` and name contains '${sanitizedName}'`;
      }

      // Add type filter if provided
      if (filters?.type) {
        query += ` and name contains '-${filters.type}_'`;
      }

      // Get all recording folders
      const response = await drive.files.list({
        q: query,
        fields: 'files(id, name, createdTime, thumbnailLink)',
        orderBy: 'createdTime desc',
      });

      if (!response.data.files || response.data.files.length === 0) {
        return [];
      }

      // Process each folder to extract metadata
      const recordings = await Promise.all(
        response.data.files.map(async (folder) => {
          // Parse folder name to extract basic info
          const folderParts = folder.name!.split('_');
          const patientInfo = folderParts[0] || '';
          const type = folderParts.length > 1 ? folderParts[1] : '';

          // Default recording info with data extracted from folder name
          const recordingInfo: any = {
            id: folder.id!,
            folderName: folder.name!,
            patientName: patientInfo.split('-')[0] || 'Unknown',
            date: folder.createdTime || '',
            status: 'unknown',
            thumbnailLink: folder.thumbnailLink || '',
          };

          try {
            // Try to get metadata file for more detailed information
            const metadataResponse = await drive.files.list({
              q: `name='session-info.json' and '${folder.id}' in parents and trashed=false`,
              fields: 'files(id)',
            });

            if (metadataResponse.data.files && metadataResponse.data.files.length > 0) {
              // Get the content of the metadata file
              const metadataFileId = metadataResponse.data.files[0].id!;
              const metadataContent: any = await drive.files.get(
                { fileId: metadataFileId, alt: 'media' },
                { responseType: 'json' },
              );

              // Add metadata info to the recording
              if (metadataContent.data) {
                recordingInfo.patientName = metadataContent.data.patientName || recordingInfo.patientName;
                recordingInfo.patientId = metadataContent.data.patientId || '';
                recordingInfo.type = metadataContent.data.type || type;
                recordingInfo.status = metadataContent.data.status || 'incomplete';
                recordingInfo.recordingDate = metadataContent.data.recordingDate || recordingInfo.date;
              }
            }

            // Check for audio file
            try {
              const audioFolder = await this.getOrCreateSubfolder(drive, folder.id!, 'audio', false);
              if (audioFolder) {
                const audioFiles = await drive.files.list({
                  q: `'${audioFolder}' in parents and name contains 'complete-recording' and trashed=false`,
                  fields: 'files(id)',
                  orderBy: 'createdTime desc',
                });

                if (audioFiles.data.files && audioFiles.data.files.length > 0) {
                  recordingInfo.audioFileId = audioFiles.data.files[0].id;
                }
              }
            } catch (error) {
              // Audio file not found, not critical
            }
          } catch (error) {
            console.error('Error getting recording metadata:', error);
          }

          return recordingInfo;
        })
      );

      return recordings;
    } catch (error) {
      console.error('Error getting recordings list:', error);
      throw new BadRequestException('Failed to retrieve recordings list');
    }
  }

}
