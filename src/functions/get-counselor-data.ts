import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamoClient = new DynamoDBClient({});
const { EVALUATIONS_TABLE } = process.env;

if (!EVALUATIONS_TABLE) {
  throw new Error('Required environment variable EVALUATIONS_TABLE must be set');
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

    console.log(`Scanning evaluations table: ${EVALUATIONS_TABLE}`);

    // Scan the evaluations table to get all counselor data
    const scanCommand = new ScanCommand({
      TableName: EVALUATIONS_TABLE
    });

    const result = await dynamoClient.send(scanCommand);
    
    if (!result.Items) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify([])
      };
    }

    // Convert DynamoDB items to regular objects
    const evaluations = result.Items.map(item => unmarshall(item));
    
    console.log(`Retrieved ${evaluations.length} evaluations`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(evaluations)
    };

  } catch (error) {
    console.error('Error fetching counselor data:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to fetch counselor data',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
