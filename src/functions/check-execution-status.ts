import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, ListExecutionsCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

const sfnClient = new SFNClient({});
const { STATE_MACHINE_ARN } = process.env;

if (!STATE_MACHINE_ARN) {
  throw new Error('Required environment variable STATE_MACHINE_ARN must be set');
}

// Updated IAM permissions to fix access issues

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
      console.log(`Looking for execution for file: ${fileName}`);
      
      const listCommand = new ListExecutionsCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        maxResults: 50 // Get recent executions
      });

      const listResponse = await sfnClient.send(listCommand);
      
      // Find execution that matches the fileName
      const matchingExecution = listResponse.executions?.find(execution => {
        // The execution name typically contains the file name or we can check the input
        return execution.name?.includes(fileName.replace('.wav', '')) || 
               execution.name?.includes(fileName);
      });

      if (!matchingExecution) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ 
            error: 'No execution found for the specified file',
            fileName,
            status: 'NOT_FOUND'
          })
        };
      }

      targetExecutionArn = matchingExecution.executionArn;
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
