import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  QueryCommand
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const { COUNSELOR_PROFILES_TABLE, EVALUATIONS_TABLE } = process.env;

if (!COUNSELOR_PROFILES_TABLE || !EVALUATIONS_TABLE) {
  throw new Error('Required environment variables COUNSELOR_PROFILES_TABLE and EVALUATIONS_TABLE must be set');
}

interface CounselorProfile {
  CounselorId: string;
  CounselorName: string;
  ProgramType: string[];
  IsActive: boolean;
  CreatedDate: string;
  LastUpdated: string;
  UpdatedBy: string;
}

interface CounselorWithEvaluations extends CounselorProfile {
  EvaluationCount: number;
  LastEvaluationDate?: string;
}

function validateCounselorId(counselorId: string): string {
  if (!counselorId || typeof counselorId !== 'string') {
    throw new Error('CounselorId is required and must be a string');
  }
  
  // Check for malicious patterns BEFORE sanitization
  if (counselorId !== counselorId.replace(/[^a-zA-Z0-9_-]/g, '')) {
    console.error('SECURITY ALERT: Invalid characters in CounselorId', { counselorId });
    throw new Error('CounselorId contains invalid characters - only alphanumeric, underscore, and hyphen allowed');
  }
  
  if (counselorId.length < 2 || counselorId.length > 50) {
    throw new Error('CounselorId must be between 2 and 50 characters');
  }
  
  return counselorId;
}

function validateCounselorName(counselorName: string): string {
  if (!counselorName || typeof counselorName !== 'string') {
    throw new Error('CounselorName is required and must be a string');
  }
  
  // Check for malicious patterns BEFORE sanitization
  const cleanName = counselorName.replace(/[^a-zA-Z\s'-]/g, '').trim();
  if (cleanName !== counselorName.trim()) {
    console.error('SECURITY ALERT: Invalid characters in CounselorName', { counselorName });
    throw new Error('CounselorName contains invalid characters - only letters, spaces, hyphens, and apostrophes allowed');
  }
  
  if (cleanName.length < 2 || cleanName.length > 100) {
    throw new Error('CounselorName must be between 2 and 100 characters');
  }
  
  return cleanName;
}

function validateProgramType(programType: any): string[] {
  if (!programType) {
    return ['National Hotline Program'];
  }
  
  if (!Array.isArray(programType)) {
    throw new Error('ProgramType must be an array');
  }
  
  const validPrograms = ['National Hotline Program', '988 Nebraska', 'Other Program'];
  const sanitizedPrograms = programType
    .filter((program: any) => typeof program === 'string')
    .map((program: string) => program.slice(0, 50).replace(/[<>]/g, ''))
    .filter((program: string) => validPrograms.includes(program) || program.length > 0);
  
  return sanitizedPrograms.length > 0 ? sanitizedPrograms : ['National Hotline Program'];
}

function validateBoolean(value: any, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  throw new Error(`${fieldName} must be a boolean value`);
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
    const httpMethod = event.httpMethod;
    const pathParameters = event.pathParameters || {};
    const queryStringParameters = event.queryStringParameters || {};

    switch (httpMethod) {
      case 'OPTIONS':
        return {
          statusCode: 200,
          headers,
          body: ''
        };

      case 'GET':
        if (pathParameters.counselorId) {
          // Get specific counselor profile
          return await getCounselorProfile(pathParameters.counselorId, headers);
        } else {
          // Get all counselor profiles with evaluation counts
          return await getAllCounselorProfiles(headers);
        }

      case 'POST':
        // Create new counselor profile
        const createData = JSON.parse(event.body || '{}');
        return await createCounselorProfile(createData, headers);

      case 'PUT':
        if (!pathParameters.counselorId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'CounselorId is required for PUT operations' })
          };
        }
        // Update existing counselor profile
        const updateData = JSON.parse(event.body || '{}');
        return await updateCounselorProfile(pathParameters.counselorId, updateData, headers);

      default:
        return {
          statusCode: 405,
          headers,
          body: JSON.stringify({ error: 'Method not allowed' })
        };
    }
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};

async function getCounselorProfile(counselorId: string, headers: any): Promise<APIGatewayProxyResult> {
  try {
    const getCommand = new GetItemCommand({
      TableName: COUNSELOR_PROFILES_TABLE,
      Key: marshall({ CounselorId: counselorId })
    });

    const response = await dynamoClient.send(getCommand);
    
    if (!response.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Counselor profile not found' })
      };
    }

    const profile = unmarshall(response.Item) as CounselorProfile;
    
    // Get evaluation count for this counselor
    const evaluationCount = await getEvaluationCount(counselorId);
    const lastEvaluationDate = await getLastEvaluationDate(counselorId);

    const result: CounselorWithEvaluations = {
      ...profile,
      EvaluationCount: evaluationCount,
      LastEvaluationDate: lastEvaluationDate
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('Error getting counselor profile:', error);
    throw error;
  }
}

async function getAllCounselorProfiles(headers: any): Promise<APIGatewayProxyResult> {
  try {
    const scanCommand = new ScanCommand({
      TableName: COUNSELOR_PROFILES_TABLE
    });

    const response = await dynamoClient.send(scanCommand);
    const profiles = (response.Items || []).map(item => unmarshall(item) as CounselorProfile);

    // Get evaluation counts for all counselors
    const profilesWithCounts: CounselorWithEvaluations[] = await Promise.all(
      profiles.map(async (profile) => {
        const evaluationCount = await getEvaluationCount(profile.CounselorId);
        const lastEvaluationDate = await getLastEvaluationDate(profile.CounselorId);
        
        return {
          ...profile,
          EvaluationCount: evaluationCount,
          LastEvaluationDate: lastEvaluationDate
        };
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(profilesWithCounts)
    };
  } catch (error) {
    console.error('Error getting all counselor profiles:', error);
    throw error;
  }
}

async function createCounselorProfile(data: any, headers: any): Promise<APIGatewayProxyResult> {
  try {
    // Validate and sanitize input
    const counselorId = validateCounselorId(data.counselorId);
    const counselorName = validateCounselorName(data.counselorName);
    const programType = validateProgramType(data.programType);

    // Check if profile already exists
    const existingProfile = await dynamoClient.send(new GetItemCommand({
      TableName: COUNSELOR_PROFILES_TABLE,
      Key: marshall({ CounselorId: counselorId })
    }));

    if (existingProfile.Item) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Counselor profile already exists' })
      };
    }

    const profile: CounselorProfile = {
      CounselorId: counselorId,
      CounselorName: counselorName,
      ProgramType: programType,
      IsActive: true,
      CreatedDate: new Date().toISOString(),
      LastUpdated: new Date().toISOString(),
      UpdatedBy: 'api'
    };

    const putCommand = new PutItemCommand({
      TableName: COUNSELOR_PROFILES_TABLE,
      Item: marshall(profile)
    });

    await dynamoClient.send(putCommand);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(profile)
    };
  } catch (error) {
    console.error('Error creating counselor profile:', error);
    
    if (error instanceof Error && error.message.includes('must be')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: error.message })
      };
    }
    
    throw error;
  }
}

async function updateCounselorProfile(counselorId: string, data: any, headers: any): Promise<APIGatewayProxyResult> {
  try {
    // Validate counselorId first
    const validatedCounselorId = validateCounselorId(counselorId);

    // Build update expression dynamically with validation
    const updateExpressions: string[] = [];
    const expressionAttributeValues: any = {};
    const expressionAttributeNames: any = {};

    if (data.counselorName !== undefined) {
      const validatedName = validateCounselorName(data.counselorName);
      updateExpressions.push('#cn = :counselorName');
      expressionAttributeNames['#cn'] = 'CounselorName';
      expressionAttributeValues[':counselorName'] = validatedName;
    }

    if (data.programType !== undefined) {
      const validatedProgramType = validateProgramType(data.programType);
      updateExpressions.push('#pt = :programType');
      expressionAttributeNames['#pt'] = 'ProgramType';
      expressionAttributeValues[':programType'] = validatedProgramType;
    }

    if (data.isActive !== undefined) {
      const validatedIsActive = validateBoolean(data.isActive, 'IsActive');
      updateExpressions.push('#ia = :isActive');
      expressionAttributeNames['#ia'] = 'IsActive';
      expressionAttributeValues[':isActive'] = validatedIsActive;
    }

    // Always update LastUpdated
    updateExpressions.push('#lu = :lastUpdated');
    expressionAttributeNames['#lu'] = 'LastUpdated';
    expressionAttributeValues[':lastUpdated'] = new Date().toISOString();

    updateExpressions.push('#ub = :updatedBy');
    expressionAttributeNames['#ub'] = 'UpdatedBy';
    expressionAttributeValues[':updatedBy'] = 'api';

    if (updateExpressions.length === 2) { // Only LastUpdated and UpdatedBy
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }

    const updateCommand = new UpdateItemCommand({
      TableName: COUNSELOR_PROFILES_TABLE,
      Key: marshall({ CounselorId: validatedCounselorId }),
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
      ReturnValues: 'ALL_NEW'
    });

    const response = await dynamoClient.send(updateCommand);
    
    if (!response.Attributes) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Counselor profile not found' })
      };
    }

    const updatedProfile = unmarshall(response.Attributes) as CounselorProfile;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(updatedProfile)
    };
  } catch (error) {
    console.error('Error updating counselor profile:', error);
    
    if (error instanceof Error && error.message.includes('must be')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: error.message })
      };
    }
    
    throw error;
  }
}

async function getEvaluationCount(counselorId: string): Promise<number> {
  try {
    const queryCommand = new QueryCommand({
      TableName: EVALUATIONS_TABLE,
      KeyConditionExpression: 'CounselorId = :counselorId',
      ExpressionAttributeValues: marshall({
        ':counselorId': counselorId
      }),
      Select: 'COUNT'
    });

    const response = await dynamoClient.send(queryCommand);
    return response.Count || 0;
  } catch (error) {
    console.error(`Error getting evaluation count for ${counselorId}:`, error);
    return 0;
  }
}

async function getLastEvaluationDate(counselorId: string): Promise<string | undefined> {
  try {
    const queryCommand = new QueryCommand({
      TableName: EVALUATIONS_TABLE,
      IndexName: 'EvaluationDateIndex',
      KeyConditionExpression: 'CounselorId = :counselorId',
      ExpressionAttributeValues: marshall({
        ':counselorId': counselorId
      }),
      ScanIndexForward: false, // Sort in descending order
      Limit: 1,
      ProjectionExpression: 'EvaluationDate'
    });

    const response = await dynamoClient.send(queryCommand);
    
    if (response.Items && response.Items.length > 0) {
      const item = unmarshall(response.Items[0]);
      return item.EvaluationDate;
    }
    
    return undefined;
  } catch (error) {
    console.error(`Error getting last evaluation date for ${counselorId}:`, error);
    return undefined;
  }
}
