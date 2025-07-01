import { 
  TranscribeClient, 
  StartCallAnalyticsJobCommand,
  GetCallAnalyticsJobCommand
} from '@aws-sdk/client-transcribe';

const transcribeClient = new TranscribeClient({});
const { BUCKET_NAME, TRANSCRIBE_ROLE_ARN } = process.env;

if (!BUCKET_NAME || !TRANSCRIBE_ROLE_ARN) {
  throw new Error('Required environment variables BUCKET_NAME and TRANSCRIBE_ROLE_ARN must be set');
}

// Input from Step Functions
interface StepFunctionsEvent {
  bucket: string;
  key: string;
  fileName: string;
  fileNameWithoutExt: string;
  timestamp: number;
  jobName?: string;
}

export const handler = async (event: StepFunctionsEvent): Promise<StepFunctionsEvent> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const { bucket, key, fileNameWithoutExt, timestamp } = event;
  
  // Create a unique job name
  const jobName = `${fileNameWithoutExt}-${timestamp}`;
  
  try {
    // Start the transcription job
    const command = new StartCallAnalyticsJobCommand({
      CallAnalyticsJobName: jobName,
      Media: {
        MediaFileUri: `s3://${bucket}/${key}`
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
      OutputLocation: `s3://${bucket}/transcripts/`
    });

    await transcribeClient.send(command);
    console.log(`Started Call Analytics job: ${jobName} for file: ${key}`);
    
    // Return the updated event with the job name
    return {
      ...event,
      jobName
    };
  } catch (error) {
    console.error(`Error starting Call Analytics job for ${key}:`, error);
    throw error;
  }
};
