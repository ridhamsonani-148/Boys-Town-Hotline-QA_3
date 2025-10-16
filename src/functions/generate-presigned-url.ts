import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';


const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const { BUCKET_NAME, FILE_MAPPING_TABLE, ALLOWED_ORIGIN } = process.env;


if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

if (!FILE_MAPPING_TABLE) {
  throw new Error('Required environment variable FILE_MAPPING_TABLE must be set');
}

// Validation functions
function validateFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('fileName is required and must be a string');
  }
  
  // Only allow safe filename characters
  const sanitized = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
  
  if (sanitized.length === 0 || sanitized !== fileName) {
    throw new Error('Invalid fileName format');
  }
  
  // Explicit path traversal checks
  if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
    throw new Error('Path traversal detected in fileName');
  }
  
  // Additional security: ensure it doesn't start with dot and has reasonable length
  if (sanitized.startsWith('.') || sanitized.startsWith('-')) {
    throw new Error('fileName cannot start with . or -');
  }
  
  // Limit length
  if (sanitized.length > 100) {
    throw new Error('fileName must be less than 100 characters');
  }
  
  // Ensure it has a valid extension
  if (!sanitized.toLowerCase().endsWith('.wav')) {
    throw new Error('Only .wav files are allowed');
  }
  
  return sanitized;
}

function validateFileType(fileType: string): string {
  if (!fileType || typeof fileType !== 'string') {
    return 'audio/wav'; // Default to wav if not provided
  }
  
  // Whitelist of allowed MIME types
  const allowedMimeTypes = [
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/x-pn-wav'
  ];
  
  if (!allowedMimeTypes.includes(fileType.toLowerCase())) {
    throw new Error('Invalid file type. Only WAV audio files are allowed');
  }
  
  return fileType;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const allowedOrigin = ALLOWED_ORIGIN || '*';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };

  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'CORS preflight' })
      };
    }

    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const { fileName, fileType } = body;

    if (!fileName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'fileName is required' })
      };
    }

    try {
      // Validate and sanitize inputs
      const validatedFileName = validateFileName(fileName);
      const validatedFileType = validateFileType(fileType);
      
      // Generate UUID for the S3 key
      const fileId = uuidv4();
      const key = `records/${fileId}.wav`;

      // Additional security: double-check the final key doesn't contain path traversal
      if (key.includes('..') || key.includes('//') || key.includes('\\')) {
        throw new Error('Path traversal detected in generated key');
      }

      // Store filename mapping in DynamoDB
      const mappingItem = {
        FileId: fileId,
        OriginalFileName: validatedFileName,
        UploadTime: new Date().toISOString(),
        FileType: validatedFileType,
        Status: 'upload_pending',
        S3Key: key,
        ExpirationTime: Math.floor(Date.now() / 1000) + 7200 // 2 hours from now
      };

      const putMappingCommand = new PutItemCommand({
        TableName: FILE_MAPPING_TABLE,
        Item: marshall(mappingItem),
        ConditionExpression: 'attribute_not_exists(FileId)' // Prevent overwrites
      });

      await dynamoClient.send(putMappingCommand);
      console.log(`Stored file mapping for ${fileId}: ${validatedFileName}`);

      // Create the presigned URL for PUT operation
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: validatedFileType,
        // Additional security: metadata to track original filename
        Metadata: {
          'original-filename': Buffer.from(validatedFileName).toString('base64'), // Base64 encode to handle special chars
          'file-id': fileId,
          'upload-time': new Date().toISOString()
        }
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour expiry

      console.log(`Generated presigned URL for ${key} (original: ${validatedFileName})`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          uploadUrl,
          key,
          fileId,
          originalFileName: validatedFileName,
          expiresIn: 3600,
        })
      };

    } catch (validationError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: validationError instanceof Error ? validationError.message : 'Invalid input' })
      };
    }

  } catch (error) {
    console.error('Error generating presigned URL:', error);
    // Handle specific DynamoDB errors
    if (error instanceof Error) {
      if (error.name === 'ConditionalCheckFailedException') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ 
            error: 'File ID already exists',
            code: 'DUPLICATE_FILE_ID'
          })
        };
      }
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to generate presigned URL',
        details: error instanceof Error ? error.message : 'Unknown error',
        code: 'INTERNAL_ERROR'
      })
    };
  }
};