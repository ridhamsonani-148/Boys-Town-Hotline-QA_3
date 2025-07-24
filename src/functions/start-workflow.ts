import { S3Event } from 'aws-lambda';
import { 
  SFNClient, 
  StartExecutionCommand 
} from '@aws-sdk/client-sfn';
import * as path from 'path';

const sfnClient = new SFNClient({});
const { STATE_MACHINE_ARN, BUCKET_NAME } = process.env;

if (!STATE_MACHINE_ARN || !BUCKET_NAME) {
  throw new Error('Required environment variables STATE_MACHINE_ARN and BUCKET_NAME must be set');
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    // Only process files in the records folder
    if (!key.startsWith('records/')) {
      console.log(`Skipping file not in records/ folder: ${key}`);
      continue;
    }

    try {
      // Extract the original filename without extension
      const fileName = path.basename(key);
      const fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      
      // Create a unique execution name
      const timestamp = Date.now();
      const executionName = `${fileNameWithoutExt}-${timestamp}`;
      
      // Prepare input for the state machine
      const input = {
        bucket: BUCKET_NAME,
        key: key,
        fileName: fileName,
        fileNameWithoutExt: fileNameWithoutExt,
        timestamp: timestamp
      };
      
      // Start the state machine execution
      const command = new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: executionName,
        input: JSON.stringify(input)
      });
      
      await sfnClient.send(command);
      console.log(`Started Step Functions execution: ${executionName} for file: ${key}`);
    } catch (error) {
      console.error(`Error starting Step Functions execution for ${key}:`, error);
      throw error;
    }
  }
};
