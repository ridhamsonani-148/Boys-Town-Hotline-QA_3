import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const { BUCKET_NAME, ALLOWED_ORIGIN } = process.env;

if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

function validateFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('fileName is required and must be a string');
  }
  
  // Only allow safe filename characters
  const sanitized = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
  
  if (sanitized.length === 0) {
    throw new Error('Invalid fileName format');
  }
  
  // Limit length
  if (sanitized.length > 100) {
    throw new Error('fileName must be less than 100 characters');
  }
  
  return sanitized;
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

    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const fileName = event.queryStringParameters?.fileName;

    if (!fileName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'fileName query parameter is required' })
      };
    }

    try{
      // Validate and sanitize fileName
      const validatedFileName = validateFileName(fileName);
      
      // The results are stored in the results/ folder
      const key = `results/${validatedFileName}`;
  
      console.log(`Fetching results from S3: ${key}`);

      try {
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key
        });

        const response = await s3Client.send(command);
        const body = await response.Body?.transformToString();

        if (!body) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Results not found or empty' })
          };
        }

        // Parse and return the results
        const results = JSON.parse(body);
        console.log(`Successfully retrieved results for ${fileName}`);

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(results)
        };

      } catch (s3Error: any) {
        if (s3Error.name === 'NoSuchKey') {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ 
              error: 'Results not found',
              message: 'The analysis results are not yet available. Please try again later.'
            })
          };
        }
        throw s3Error;
      }
      
    } catch (validationError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: validationError instanceof Error ? validationError.message : 'Invalid fileName' })
      };
    }
  
  } catch (error) {
    console.error('Error fetching results:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to fetch results',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
