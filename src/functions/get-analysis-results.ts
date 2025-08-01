import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

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

    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const fileId = event.pathParameters?.fileId;

    if (!fileId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'fileId path parameter is required' })
      };
    }

    // Try to find the analysis results in different possible locations
    const possibleKeys = [
      `results/llmOutput/analysis_${fileId}.json`,
      `results/aggregated_${fileId}.json`,
      `results/${fileId}.json`
    ];

    console.log(`Looking for analysis results for fileId: ${fileId}`);

    for (const key of possibleKeys) {
      try {
        console.log(`Trying key: ${key}`);
        
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key
        });

        const response = await s3Client.send(command);
        const body = await response.Body?.transformToString();

        if (body) {
          const results = JSON.parse(body);
          console.log(`Successfully retrieved analysis results from ${key}`);

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(results)
          };
        }

      } catch (s3Error: any) {
        if (s3Error.name === 'NoSuchKey') {
          console.log(`Key not found: ${key}, trying next...`);
          continue;
        }
        throw s3Error;
      }
    }

    // If we get here, none of the keys were found
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ 
        error: 'Analysis results not found',
        message: 'The analysis results are not yet available. Please try again later.',
        fileId
      })
    };

  } catch (error) {
    console.error('Error fetching analysis results:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to fetch analysis results',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
