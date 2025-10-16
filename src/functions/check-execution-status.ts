import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, ListExecutionsCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

const sfnClient = new SFNClient({});
const { STATE_MACHINE_ARN, ALLOWED_ORIGIN } = process.env;

if (!STATE_MACHINE_ARN) {
  throw new Error('Required environment variable STATE_MACHINE_ARN must be set');
}

// Input validation functions
function validateFileId(fileId: string): string {
  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId must be a string');
  }

  // UUID validation pattern
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(fileId)) {
    throw new Error('Invalid fileId format - must be a valid UUID');
  }
  
  return fileId;
}

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
    const fileId = event.queryStringParameters?.fileId;
    const executionArn = event.queryStringParameters?.executionArn;

    if (!fileName && !fileId && !executionArn) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Either fileName, fileId, or executionArn query parameter is required' 
        })
      };
    }

    let targetExecutionArn = executionArn;

    // If fileId is provided, find the execution for that file (PREFERRED)
    if (fileId && !executionArn) {
      try {
        const validatedFileId = validateFileId(fileId);
        console.log(`Looking for execution for fileId: ${validatedFileId}`);
        
        const listCommand = new ListExecutionsCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          maxResults: 50 // Get recent executions
        });

        const listResponse = await sfnClient.send(listCommand);
        
        // Find execution that matches the fileId
        const matchingExecution = listResponse.executions?.find(execution => {
          // The execution name should contain the fileId (UUID)
          return execution.name?.includes(validatedFileId);
        });

        if (!matchingExecution) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ 
              error: 'No execution found for the specified fileId',
              fileId: validatedFileId,
              status: 'NOT_FOUND'
            })
          };
        }

        targetExecutionArn = matchingExecution.executionArn;
      } catch (validationError) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: validationError instanceof Error ? validationError.message : 'Invalid fileId' })
        };
      }
    }
    // If fileName is provided (for backward compatibility)
    else if (fileName && !executionArn) {
      try {
        const validatedFileName = validateFileName(fileName);
        console.log(`Looking for execution for file: ${validatedFileName}`);
        
        const listCommand = new ListExecutionsCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          maxResults: 50
        });

        const listResponse = await sfnClient.send(listCommand);
        
        // Find execution that matches the fileName
        const matchingExecution = listResponse.executions?.find(execution => {
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
      fileName: fileName,
      fileId: fileId
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