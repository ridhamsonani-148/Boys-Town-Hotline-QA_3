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

// Validation functions
function validateBucketName(bucket: string): string {
  if (!bucket || typeof bucket !== 'string') {
    throw new Error('Invalid bucket name');
  }
  
  // AWS bucket name validation rules
  if (bucket.length < 3 || bucket.length > 63) {
    throw new Error('Bucket name must be between 3 and 63 characters');
  }
  
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    throw new Error('Invalid bucket name format');
  }
  
  return bucket;
}

function validateS3Key(key: string): string {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid S3 key');
  }
  
  // Prevent path traversal
  if (key.includes('..') || key.includes('//') || key.includes('\\')) {
    throw new Error('Invalid characters in S3 key');
  }
  
  // Limit key length
  if (key.length > 1024) {
    throw new Error('S3 key too long');
  }
  
  return key;
}

function validateFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Invalid file name');
  }
  
  // Only allow safe filename characters and prevent path traversal
  const sanitized = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
  
  if (sanitized.length === 0 || sanitized !== fileName) {
    throw new Error('Invalid file name format');
  }
  
  // Prevent path traversal
  if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
    throw new Error('Path traversal detected in file name');
  }
  
  if (sanitized.length > 255) {
    throw new Error('File name too long');
  }
  
  return sanitized;
}

function validateCounselorInfo(counselorId: string, counselorName: string): { counselorId: string; counselorName: string } {
  if (!counselorId || typeof counselorId !== 'string') {
    throw new Error('Invalid counselor ID');
  }
  
  if (!counselorName || typeof counselorName !== 'string') {
    throw new Error('Invalid counselor name');
  }
  
  // Validate counselor ID format (alphanumeric and underscore only)
  const validCounselorId = counselorId.replace(/[^a-zA-Z0-9_]/g, '');
  if (validCounselorId.length < 2 || validCounselorId.length > 50) {
    throw new Error('Counselor ID must be between 2 and 50 characters');
  }
  
  // Validate counselor name format
  const validCounselorName = counselorName.replace(/[^a-zA-Z\s'-]/g, '').trim();
  if (validCounselorName.length < 2 || validCounselorName.length > 100) {
    throw new Error('Counselor name must be between 2 and 100 characters');
  }
  
  return {
    counselorId: validCounselorId,
    counselorName: validCounselorName
  };
}

interface EvaluationItem {
  CounselorId: string;
  EvaluationId: string;
  CounselorName: string;
  AudioFileName: string;
  EvaluationDate: string;
  CategoryScores: {
    RapportSkills: number;
    CounselingSkills: number;
    OrganizationalSkills: number;
    TechnicalSkills: number;
  };
  TotalScore: number;
  PercentageScore: number;
  Criteria: string;
  S3ResultPath: string;
}

function validateEvaluationItem(item: any): EvaluationItem {
  const {
    CounselorId,
    EvaluationId,
    CounselorName,
    AudioFileName,
    EvaluationDate,
    CategoryScores,
    TotalScore,
    PercentageScore,
    Criteria,
    S3ResultPath
  } = item;

  // Validate required fields
  if (!CounselorId || typeof CounselorId !== 'string') {
    throw new Error('Invalid CounselorId');
  }
  if (!EvaluationId || typeof EvaluationId !== 'string') {
    throw new Error('Invalid EvaluationId');
  }
  if (!CounselorName || typeof CounselorName !== 'string') {
    throw new Error('Invalid CounselorName');
  }
  if (!AudioFileName || typeof AudioFileName !== 'string') {
    throw new Error('Invalid AudioFileName');
  }
  if (!EvaluationDate || typeof EvaluationDate !== 'string') {
    throw new Error('Invalid EvaluationDate');
  }

  // Validate file name to prevent path traversal
  validateFileName(AudioFileName);

  // Validate CategoryScores structure
  if (!CategoryScores || typeof CategoryScores !== 'object') {
    throw new Error('Invalid CategoryScores');
  }

  const validScores = ['RapportSkills', 'CounselingSkills', 'OrganizationalSkills', 'TechnicalSkills'];
  for (const score of validScores) {
    if (typeof CategoryScores[score] !== 'number' || CategoryScores[score] < 0) {
      throw new Error(`Invalid ${score} value`);
    }
  }

  // Validate numeric scores
  if (typeof TotalScore !== 'number' || TotalScore < 0) {
    throw new Error('Invalid TotalScore');
  }
  if (typeof PercentageScore !== 'number' || PercentageScore < 0 || PercentageScore > 100) {
    throw new Error('Invalid PercentageScore');
  }

  // Validate string fields
  if (!Criteria || typeof Criteria !== 'string') {
    throw new Error('Invalid Criteria');
  }
  if (!S3ResultPath || typeof S3ResultPath !== 'string') {
    throw new Error('Invalid S3ResultPath');
  }

  // Sanitize string inputs to prevent injection
  const sanitizedItem: EvaluationItem = {
    CounselorId: CounselorId.replace(/[^a-zA-Z0-9_]/g, ''),
    EvaluationId: EvaluationId.replace(/[^a-zA-Z0-9_-]/g, ''),
    CounselorName: CounselorName.slice(0, 100).replace(/[<>]/g, ''),
    AudioFileName: AudioFileName.replace(/[^a-zA-Z0-9_.-]/g, ''),
    EvaluationDate: EvaluationDate,
    CategoryScores: {
      RapportSkills: Math.max(0, Math.min(CategoryScores.RapportSkills, 100)),
      CounselingSkills: Math.max(0, Math.min(CategoryScores.CounselingSkills, 100)),
      OrganizationalSkills: Math.max(0, Math.min(CategoryScores.OrganizationalSkills, 100)),
      TechnicalSkills: Math.max(0, Math.min(CategoryScores.TechnicalSkills, 100))
    },
    TotalScore: Math.max(0, TotalScore),
    PercentageScore: Math.max(0, Math.min(PercentageScore, 100)),
    Criteria: Criteria.slice(0, 500).replace(/[<>]/g, ''),
    S3ResultPath: S3ResultPath.slice(0, 500)
  };

  return sanitizedItem;
}

export const handler = async (event: StepFunctionsEvent): Promise<StepFunctionsEvent> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  try {
    // Validate required fields are present and properly formatted
    if (!event.bucket) {
      throw new Error('Missing required field: bucket');
    }
    
    if (!event.aggregatedKey) {
      throw new Error('Missing required field: aggregatedKey');
    }

    // Validate bucket and key inputs
    const bucket = validateBucketName(event.bucket);
    const aggregatedKey = validateS3Key(event.aggregatedKey);
    
    // Extract filename from the key if fileNameWithoutExt is not provided
    let fileNameWithoutExt = event.fileNameWithoutExt;
    let fileName = event.fileName;
    
    if (!fileNameWithoutExt || !fileName) {
      console.log('fileNameWithoutExt or fileName not provided, extracting from key');
      
      // If we have the original key, extract the filename from it
      if (event.key) {
        const validatedKey = validateS3Key(event.key);
        const keyParts = validatedKey.split('/');
        fileName = keyParts[keyParts.length - 1];
        fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
        console.log(`Extracted fileName: ${fileName}, fileNameWithoutExt: ${fileNameWithoutExt}`);
      } else {
        // If we don't have the key either, try to extract from aggregatedKey
        const aggregatedKeyParts = aggregatedKey.split('/');
        const aggregatedFileName = aggregatedKeyParts[aggregatedKeyParts.length - 1];
        // Remove 'aggregated_' prefix and extension
        fileNameWithoutExt = aggregatedFileName.replace('aggregated_', '').replace(/\.[^/.]+$/, '');
        fileName = `${fileNameWithoutExt}.wav`; // Assume .wav extension
        console.log(`Reconstructed fileName: ${fileName}, fileNameWithoutExt: ${fileNameWithoutExt}`);
      }
    }

    // Validate file names
    fileName = validateFileName(fileName);
    fileNameWithoutExt = validateFileName(fileNameWithoutExt);

    // Use timestamp from event or generate a new one
    const timestamp = event.timestamp || Date.now();
    
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
            
            // Validate extracted counselor info
            const validatedCounselorInfo = validateCounselorInfo(counselorId, counselorName);
            counselorId = validatedCounselorInfo.counselorId;
            counselorName = validatedCounselorInfo.counselorName;
            
            console.log(`Extracted counselor info - ID: ${counselorId}, Name: ${counselorName}`);
          } else {
            console.warn(`Filename does not match expected format: ${fileNameWithoutExt}`);
          }
        } else {
          console.warn('fileNameWithoutExt is undefined or empty');
        }
      } catch (error) {
        console.error(`Error extracting counselor name from filename: ${fileNameWithoutExt}`, error);
        // Continue with default values but validate them
        const validatedCounselorInfo = validateCounselorInfo(counselorId, counselorName);
        counselorId = validatedCounselorInfo.counselorId;
        counselorName = validatedCounselorInfo.counselorName;
      }

      // Ensure counselor profile exists
      await ensureCounselorProfile(counselorId, counselorName);
      
      // Create a unique evaluation ID
      const evaluationId = `eval_${timestamp}`;
      
      // Create the evaluation date (ISO format for easy sorting)
      const evaluationDate = new Date().toISOString();
      
      // Create and validate the DynamoDB item
      const item = validateEvaluationItem({
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
      });
      
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
  } catch (validationError) {
    console.error('Input validation error:', validationError);
    throw validationError;
  }
};

async function ensureCounselorProfile(counselorId: string, counselorName: string): Promise<void> {
  try {
    // Validate inputs first
    const validatedInfo = validateCounselorInfo(counselorId, counselorName);
    counselorId = validatedInfo.counselorId;
    counselorName = validatedInfo.counselorName;

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