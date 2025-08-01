import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({});
const { BUCKET_NAME } = process.env;

if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
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

    // Ensure the file goes to the records/ folder
    const key = `records/${fileName}`;

    // Create the presigned URL for PUT operation
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: fileType || 'audio/wav',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour expiry

    console.log(`Generated presigned URL for ${key}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        uploadUrl,
        key,
        fileName
      })
    };

  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to generate presigned URL',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
