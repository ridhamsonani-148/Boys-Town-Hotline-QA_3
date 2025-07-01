import { 
  TranscribeClient, 
  GetCallAnalyticsJobCommand,
  CallAnalyticsJobStatus
} from '@aws-sdk/client-transcribe';

const transcribeClient = new TranscribeClient({});

// Input from Step Functions
interface StepFunctionsEvent {
  bucket: string;
  key: string;
  fileName: string;
  fileNameWithoutExt: string;
  timestamp: number;
  jobName: string;
  transcriptKey?: string;
}

export const handler = async (event: StepFunctionsEvent): Promise<StepFunctionsEvent> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const { jobName } = event;
  
  try {
    // Check the status of the transcription job
    const command = new GetCallAnalyticsJobCommand({
      CallAnalyticsJobName: jobName
    });

    const response = await transcribeClient.send(command);
    const job = response.CallAnalyticsJob;
    
    if (!job) {
      throw new Error(`Job ${jobName} not found`);
    }
    
    console.log(`Job status: ${job.CallAnalyticsJobStatus}`);
    
    // If the job is complete, return the transcript key
    if (job.CallAnalyticsJobStatus === CallAnalyticsJobStatus.COMPLETED) {
      // The transcript will be in the analytics folder under the output location
      const transcriptKey = `transcripts/analytics/${jobName}.json`;
      
      return {
        ...event,
        transcriptKey
      };
    }
    
    // If the job failed, throw an error
    if (job.CallAnalyticsJobStatus === CallAnalyticsJobStatus.FAILED) {
      throw new Error(`Transcription job ${jobName} failed: ${job.FailureReason}`);
    }
    
    // If the job is still in progress, return the current event
    // This will cause Step Functions to wait and retry
    return event;
  } catch (error) {
    console.error(`Error checking Call Analytics job status for ${jobName}:`, error);
    throw error;
  }
};
