import { 
  S3Client, 
  GetObjectCommand 
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import * as path from 'path';

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});

const { BUCKET_NAME, TABLE_NAME, COUNSELOR_PROFILES_TABLE } = process.env;

if (!BUCKET_NAME || !TABLE_NAME || !COUNSELOR_PROFILES_TABLE) {
  throw new Error('Required environment variables BUCKET_NAME, TABLE_NAME, and COUNSELOR_PROFILES_TABLE must be set');
}

// Input from Step Functions
interface StepFunctionsEvent {
  bucket: string;
  key: string;
  fileName: string;
  fileNameWithoutExt: string;
  timestamp: number;
  formattedKey: string;
  resultKey: string;
  aggregatedKey: string;
  counselorId?: string;
  counselorName?: string;
}

interface AggregatedScores {
  categories: {
    [key: string]: {
      rawScore: number;
      multipliedScore: number;
      criteria: {
        [key: string]: {
          score: number;
          label: string;
          observation: string;
          evidence: string;
        };
      };
    };
  };
  totalRawScore: number;
  totalMultipliedScore: number;
  totalPossibleScore: number;
  percentageScore: number;
  criteria: string;
  processingError?: string;
}

export const handler = async (event: StepFunctionsEvent): Promise<StepFunctionsEvent> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  // Validate required fields are present
  if (!event.bucket) {
    throw new Error('Missing required field: bucket');
  }
  
  if (!event.aggregatedKey) {
    throw new Error('Missing required field: aggregatedKey');
  }
  
  // Extract filename from the key if fileNameWithoutExt is not provided
  let fileNameWithoutExt = event.fileNameWithoutExt;
  let fileName = event.fileName;
  
  if (!fileNameWithoutExt || !fileName) {
    console.log('fileNameWithoutExt or fileName not provided, extracting from key');
    
    // If we have the original key, extract the filename from it
    if (event.key) {
      const keyParts = event.key.split('/');
      fileName = keyParts[keyParts.length - 1];
      fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      console.log(`Extracted fileName: ${fileName}, fileNameWithoutExt: ${fileNameWithoutExt}`);
    } else {
      // If we don't have the key either, try to extract from aggregatedKey
      const aggregatedKeyParts = event.aggregatedKey.split('/');
      const aggregatedFileName = aggregatedKeyParts[aggregatedKeyParts.length - 1];
      // Remove 'aggregated_' prefix and extension
      fileNameWithoutExt = aggregatedFileName.replace('aggregated_', '').replace(/\.[^/.]+$/, '');
      fileName = `${fileNameWithoutExt}.wav`; // Assume .wav extension
      console.log(`Reconstructed fileName: ${fileName}, fileNameWithoutExt: ${fileNameWithoutExt}`);
    }
  }
  
  // Use timestamp from event or generate a new one
  const timestamp = event.timestamp || Date.now();
  
  const { bucket, aggregatedKey } = event;
  
  try {
    // Get the aggregated scores from S3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: aggregatedKey
    });
    
    const response = await s3Client.send(getCommand);
    const body = await response.Body?.transformToString();
    
    if (!body) {
      throw new Error(`Empty response body for ${aggregatedKey}`);
    }
    
    // Parse the aggregated scores
    const aggregatedScores: AggregatedScores = JSON.parse(body);
    
    // Extract counselor name from the filename
    // Expected format: FirstName_LastName_UniqueNumbers.wav
    let counselorId = 'unknown';
    let counselorName = 'Unknown Counselor';
    
    try {
      if (fileNameWithoutExt) {
        const fileNameParts = fileNameWithoutExt.split('_');
        
        if (fileNameParts.length >= 2) {
          const firstName = fileNameParts[0];
          const lastName = fileNameParts[1];
          counselorId = `${firstName.toLowerCase()}_${lastName.toLowerCase()}`;
          counselorName = `${firstName} ${lastName}`;
          console.log(`Extracted counselor info - ID: ${counselorId}, Name: ${counselorName}`);
        } else {
          console.warn(`Filename does not match expected format: ${fileNameWithoutExt}`);
        }
      } else {
        console.warn('fileNameWithoutExt is undefined or empty');
      }
    } catch (error) {
      console.error(`Error extracting counselor name from filename: ${fileNameWithoutExt}`, error);
      // Continue with default values
    }

    // Ensure counselor profile exists
    await ensureCounselorProfile(counselorId, counselorName);
    
    // Create a unique evaluation ID
    const evaluationId = `eval_${timestamp}`;
    
    // Create the evaluation date (ISO format for easy sorting)
    const evaluationDate = new Date().toISOString();
    
    // Create the DynamoDB item
    const item = {
      CounselorId: counselorId,
      EvaluationId: evaluationId,
      CounselorName: counselorName,
      AudioFileName: fileName,
      EvaluationDate: evaluationDate,
      CategoryScores: {
        RapportSkills: aggregatedScores.categories['RAPPORT SKILLS']?.multipliedScore || 0,
        CounselingSkills: aggregatedScores.categories['COUNSELING SKILLS']?.multipliedScore || 0,
        OrganizationalSkills: aggregatedScores.categories['ORGANIZATIONAL SKILLS']?.multipliedScore || 0,
        TechnicalSkills: aggregatedScores.categories['TECHNICAL SKILLS']?.multipliedScore || 0
      },
      TotalScore: aggregatedScores.totalMultipliedScore,
      PercentageScore: aggregatedScores.percentageScore,
      Criteria: aggregatedScores.criteria,
      S3ResultPath: `s3://${bucket}/${aggregatedKey}`
    };
    
    // Save the item to DynamoDB
    const putCommand = new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item)
    });
    
    await dynamoClient.send(putCommand);
    console.log(`Successfully saved evaluation to DynamoDB for counselor: ${counselorName}`);
    
    // Return the updated event
    return {
      ...event,
      counselorId,
      counselorName
    };
  } catch (error) {
    console.error(`Error updating counselor records for ${aggregatedKey}:`, error);
    throw error;
  }
};

async function ensureCounselorProfile(counselorId: string, counselorName: string): Promise<void> {
  try {
    // Check if profile exists
    const getCommand = new GetItemCommand({
      TableName: COUNSELOR_PROFILES_TABLE!,
      Key: marshall({ CounselorId: counselorId })
    });

    const response = await dynamoClient.send(getCommand);
    
    if (!response.Item) {
      // Create new profile with default program
      const profileItem = {
        CounselorId: counselorId,
        CounselorName: counselorName,
        ProgramType: ['National Hotline Program'], // Default program
        IsActive: true,
        CreatedDate: new Date().toISOString(),
        LastUpdated: new Date().toISOString(),
        UpdatedBy: 'system'
      };
      
      const putCommand = new PutItemCommand({
        TableName: COUNSELOR_PROFILES_TABLE!,
        Item: marshall(profileItem)
      });

      await dynamoClient.send(putCommand);
      console.log(`Created new counselor profile for: ${counselorName}`);
    }
  } catch (error) {
    console.error(`Error ensuring counselor profile for ${counselorId}:`, error);
    // Don't throw - evaluation should still proceed even if profile creation fails
  }
}
