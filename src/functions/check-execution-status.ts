import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, ListExecutionsCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

const sfnClient = new SFNClient({});
const { STATE_MACHINE_ARN } = process.env;

if (!STATE_MACHINE_ARN) {
  throw new Error('Required environment variable STATE_MACHINE_ARN must be set');
}

// Input validation functions
function validateFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('fileName must be a string');
  }
  
  const sanitized = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
  
  if (sanitized.length === 0) {
    throw new Error('Invalid fileName format');
  }
  
  if (sanitized.length > 100) {
    throw new Error('fileName must be less than 100 characters');
  }
  
  return sanitized;
}

function validateExecutionArn(executionArn: string): string {
  if (!executionArn || typeof executionArn !== 'string') {
    throw new Error('executionArn must be a string');
  }
  
  // Basic validation for AWS ARN format
  if (!executionArn.startsWith('arn:aws:states:') || executionArn.split(':').length < 7) {
    throw new Error('Invalid executionArn format');
  }
  
  return executionArn;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
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
    const executionArn = event.queryStringParameters?.executionArn;

    if (!fileName && !executionArn) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Either fileName or executionArn query parameter is required' 
        })
      };
    }

    let targetExecutionArn = executionArn;

    // If fileName is provided, find the execution for that file
    if (fileName && !executionArn) {
      try {
        const validatedFileName = validateFileName(fileName);
        console.log(`Looking for execution for file: ${validatedFileName}`);
        
        const listCommand = new ListExecutionsCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          maxResults: 50 // Get recent executions
        });

        const listResponse = await sfnClient.send(listCommand);
        
        // Find execution that matches the fileName
        const matchingExecution = listResponse.executions?.find(execution => {
          // The execution name typically contains the file name or we can check the input
          return execution.name?.includes(validatedFileName.replace('.wav', '')) || 
                 execution.name?.includes(validatedFileName);
        });

        if (!matchingExecution) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ 
              error: 'No execution found for the specified file',
              fileName: validatedFileName,
              status: 'NOT_FOUND'
            })
          };
        }

        targetExecutionArn = matchingExecution.executionArn;
      } catch (validationError) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: validationError instanceof Error ? validationError.message : 'Invalid fileName' })
        };
      }
    }

    if (executionArn) {
      try {
        targetExecutionArn = validateExecutionArn(executionArn);
      } catch (validationError) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: validationError instanceof Error ? validationError.message : 'Invalid executionArn' })
        };
      }
    }

    // Get detailed execution status
    console.log(`Checking status for execution: ${targetExecutionArn}`);
    
    const describeCommand = new DescribeExecutionCommand({
      executionArn: targetExecutionArn
    });

    const execution = await sfnClient.send(describeCommand);

    const response = {
      status: execution.status, // RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED
      startDate: execution.startDate?.toISOString(),
      stopDate: execution.stopDate?.toISOString(),
      isComplete: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status || ''),
      isSuccessful: execution.status === 'SUCCEEDED',
      error: execution.status === 'FAILED' ? execution.error : undefined,
      fileName: fileName
    };

    console.log(`Execution status: ${execution.status}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error checking execution status:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to check execution status',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};