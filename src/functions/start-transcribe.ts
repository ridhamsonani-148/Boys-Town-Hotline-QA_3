import { S3Event } from 'aws-lambda';
import { 
  TranscribeClient, 
  StartCallAnalyticsJobCommand
} from '@aws-sdk/client-transcribe';
import * as path from 'path';

const transcribeClient = new TranscribeClient({});
const { BUCKET_NAME, TRANSCRIBE_ROLE_ARN } = process.env;

if (!BUCKET_NAME || !TRANSCRIBE_ROLE_ARN) {
  throw new Error('Required environment variables BUCKET_NAME and TRANSCRIBE_ROLE_ARN must be set');
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    if (!key.startsWith('records/')) {
      console.log(`Skipping file not in records/ folder: ${key}`);
      continue;
    }

    // Extract the original filename without extension
    const fileName = path.basename(key);
    const fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
    
    // Always append a timestamp to ensure unique job names
    // This prevents "job already exists" errors when reprocessing files
    const timestamp = Date.now();
    const jobName = `${fileNameWithoutExt}-${timestamp}`;
    
    try {
      // Start the transcription job
      const command = new StartCallAnalyticsJobCommand({
        CallAnalyticsJobName: jobName,
        Media: {
          MediaFileUri: `s3://${BUCKET_NAME}/${key}`
        },
        Settings: {
          LanguageOptions: ['en-US'],
          Summarization: {
            GenerateAbstractiveSummary: true
          }
        },
        ChannelDefinitions: [
          {
            ChannelId: 1,
            ParticipantRole: 'AGENT'
          },
          {
            ChannelId: 0,
            ParticipantRole: 'CUSTOMER'
          }
        ],
        DataAccessRoleArn: TRANSCRIBE_ROLE_ARN,
        OutputLocation: `s3://${BUCKET_NAME}/transcripts/analytics/`
      });

      await transcribeClient.send(command);
      
      // Store the original filename in the output path for the format function to use
      // This ensures we can map back to the original filename regardless of the job name
      const outputKey = `transcripts/analytics/filename-mapping/${fileNameWithoutExt}.txt`;
      
      console.log(`Started Call Analytics job: ${jobName} for file: ${key}`);
    } catch (error) {
      console.error(`Error starting Call Analytics job for ${key}:`, error);
      throw error;
    }
  }
};
