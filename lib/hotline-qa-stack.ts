import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as amplify from '@aws-cdk/aws-amplify-alpha';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as path from 'path';


export interface HotlineQaStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g., 'dev', 'test', 'prod')
   * @default 'dev'
   */
  envName?: string;
  
  /**
   * Optional bucket name prefix. If not provided, a default will be used.
   * @default 'boys-town-hotline-qa'
   */
  bucketNamePrefix?: string;
  
  /**
   * Whether to deploy the Amplify frontend app
   * @default true
   */
  deployFrontend?: boolean;
  
  /**
   * GitHub repository owner for Amplify deployment - REQUIRED if deployFrontend is true
   */
  githubOwner?: string;
  
  /**
   * GitHub repository name for Amplify deployment - REQUIRED if deployFrontend is true
   */
  githubRepo?: string;
  
  /**
   * AWS Secrets Manager secret name containing GitHub personal access token - REQUIRED if deployFrontend is true
   */
  githubTokenSecretName?: string;
}

export class HotlineQaStack extends cdk.Stack {
  /**
   * The S3 bucket that will store call recordings, transcripts, and results
   */
  public readonly storageBucket: s3.Bucket;
  
  /**
   * The DynamoDB table that will store counselor evaluation results
   */
  public readonly counselorEvaluationsTable: dynamodb.Table;
  
  /**
   * The DynamoDB table that will store counselor metadata/profiles
   */
  public readonly counselorProfilesTable: dynamodb.Table;
  
  /**
   * The API Gateway URL for frontend integration
   */
  public readonly apiUrl: string;
  
  /**
   * The Amplify app for frontend hosting (optional)
   */
  public readonly amplifyApp?: amplify.App;
  
  constructor(scope: Construct, id: string, props: HotlineQaStackProps) {
    super(scope, id, props);
    
    // Set default values
    const envName = props.envName || 'dev';
    const bucketNamePrefix = props.bucketNamePrefix || 'boys-town-hotline-qa';
    
    // Get AWS account ID to ensure globally unique names
    const accountId = cdk.Stack.of(this).account;
    
    // Create the S3 bucket with focused parameterization and unique name
    this.storageBucket = new s3.Bucket(this, 'StorageBucket', {
      bucketName: `${bucketNamePrefix}-${envName}-${accountId}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect against accidental deletion
      lifecycleRules: [
        {
          // Rule for audio recordings - move to Glacier after 7 days, delete after 90 days
          id: 'AudioRecordingsRule',
          enabled: true,
          prefix: 'records/', // Only apply to audio files in records/ folder
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(7) // Move to Glacier after 7 days
            }
          ],
          expiration: cdk.Duration.days(90) // Delete after 90 days total
        }
      ],
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
          ],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });
    
    // Create DynamoDB table for counselor evaluations
    this.counselorEvaluationsTable = new dynamodb.Table(this, 'CounselorEvaluationsTable', {
      tableName: `${bucketNamePrefix}-counselor-evaluations-${envName}-${accountId}`,
      partitionKey: { name: 'CounselorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'EvaluationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // On-demand capacity
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect against accidental deletion
      pointInTimeRecovery: true, // Enable point-in-time recovery for data protection
    });
    
    // Add Global Secondary Index for querying by date
    this.counselorEvaluationsTable.addGlobalSecondaryIndex({
      indexName: 'EvaluationDateIndex',
      partitionKey: { name: 'CounselorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'EvaluationDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    
    // Create DynamoDB table for counselor profiles/metadata
    this.counselorProfilesTable = new dynamodb.Table(this, 'CounselorProfilesTable', {
      tableName: `${bucketNamePrefix}-counselor-profiles-${envName}-${accountId}`,
      partitionKey: { name: 'CounselorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // On-demand capacity
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect against accidental deletion
      pointInTimeRecovery: true, // Enable point-in-time recovery for data protection
    });
    
    // Add Global Secondary Index for querying by program type
    this.counselorProfilesTable.addGlobalSecondaryIndex({
      indexName: 'ProgramTypeIndex',
      partitionKey: { name: 'ProgramType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'CounselorName', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Create DynamoDB table for file mappings (UUID to original filename mapping)
    const fileMappingsTable = new dynamodb.Table(this, 'FileMappingsTable', {
      tableName: `${bucketNamePrefix}-file-mappings-${envName}-${accountId}`,
      partitionKey: { name: 'FileId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ExpirationTime',
    });

    // Add Global Secondary Index for querying by original filename
    fileMappingsTable.addGlobalSecondaryIndex({
      indexName: 'OriginalFileNameIndex',
      partitionKey: { name: 'OriginalFileName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'UploadTime', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    
    
    // Create IAM role for Transcribe with proper permissions
    const transcribeRole = new iam.Role(this, 'TranscribeRole', {
      assumedBy: new iam.ServicePrincipal('transcribe.amazonaws.com'),
      description: 'Role for Transcribe Call Analytics',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess') // Give full S3 access to Transcribe
      ]
    });

    // Create Lambda function to start the workflow
    const startWorkflowFunction = new lambdaNodejs.NodejsFunction(this, 'StartWorkflowFunction', {
      entry: path.join(__dirname, '../src/functions/start-workflow.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      description: 'Starts the Step Functions workflow for processing call recordings',
    });

    // Create Lambda function to start transcription jobs
    const transcribeFunction = new lambdaNodejs.NodejsFunction(this, 'TranscribeFunction', {
      entry: path.join(__dirname, '../src/functions/start-transcribe.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
        TRANSCRIBE_ROLE_ARN: transcribeRole.roleArn,
      },
      description: 'Starts Transcribe Call Analytics jobs for uploaded recordings',
    });

    // Create Lambda function to check transcription job status
    const checkTranscribeStatusFunction = new lambdaNodejs.NodejsFunction(this, 'CheckTranscribeStatusFunction', {
      entry: path.join(__dirname, '../src/functions/check-transcribe-status.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      description: 'Checks the status of Transcribe Call Analytics jobs',
    });

    // Create Lambda function to format transcription output
    const formatFunction = new lambdaNodejs.NodejsFunction(this, 'FormatFunction', {
      entry: path.join(__dirname, '../src/functions/format-transcript.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Formats transcription output into a simplified format',
    });

    // Create Lambda function for LLM analysis using Bedrock
    const analyzeLLMFunction = new lambdaNodejs.NodejsFunction(this, 'AnalyzeLLMFunction', {
      entry: path.join(__dirname, '../src/functions/analyze-llm.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(15), // Maximum Lambda timeout for long-running LLM calls
      memorySize: 1024, // Increased memory for handling large transcripts
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Analyzes transcripts using Amazon Nova Lite',
    });
    
    // Create Lambda function for aggregating scores
    const aggregateScoresFunction = new lambdaNodejs.NodejsFunction(this, 'AggregateScoresFunction', {
      entry: path.join(__dirname, '../src/functions/aggregate-scores.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Aggregates scores from LLM analysis and calculates final scores',
    });
    
    // Create Lambda function for updating counselor records in DynamoDB
    const updateCounselorRecordsFunction = new lambdaNodejs.NodejsFunction(this, 'UpdateCounselorRecordsFunction', {
      entry: path.join(__dirname, '../src/functions/update-counselor-records.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
        TABLE_NAME: this.counselorEvaluationsTable.tableName,
        COUNSELOR_PROFILES_TABLE: this.counselorProfilesTable.tableName,
        FILE_MAPPING_TABLE: fileMappingsTable.tableName,
      },
      description: 'Updates counselor evaluation records in DynamoDB',
    });

    // Create Lambda function for managing counselor profiles (API operations)
    const manageCounselorProfilesFunction = new lambdaNodejs.NodejsFunction(this, 'ManageCounselorProfilesFunction', {
      entry: path.join(__dirname, '../src/functions/manage-counselor-profiles.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        COUNSELOR_PROFILES_TABLE: this.counselorProfilesTable.tableName,
        EVALUATIONS_TABLE: this.counselorEvaluationsTable.tableName,
      },
      description: 'Manages counselor profiles via API (GET, PUT, POST operations)',
    });

    // Create Lambda function for generating presigned URLs
    const generatePresignedUrlFunction = new lambdaNodejs.NodejsFunction(this, 'GeneratePresignedUrlFunction', {
      entry: path.join(__dirname, '../src/functions/generate-presigned-url.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
        FILE_MAPPING_TABLE: fileMappingsTable.tableName
      },
      description: 'Generates presigned URLs for S3 file uploads',
    });

    // Create Lambda function for getting analysis results
    const getResultsFunction = new lambdaNodejs.NodejsFunction(this, 'GetResultsFunction', {
      entry: path.join(__dirname, '../src/functions/get-results.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Gets analysis results from S3',
    });

    // Create Lambda function for getting counselor data
    const getCounselorDataFunction = new lambdaNodejs.NodejsFunction(this, 'GetCounselorDataFunction', {
      entry: path.join(__dirname, '../src/functions/get-counselor-data.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        EVALUATIONS_TABLE: this.counselorEvaluationsTable.tableName,
      },
      description: 'Gets all counselor evaluation data from DynamoDB',
    });

    // Create Lambda function for getting specific analysis results
    const getAnalysisResultsFunction = new lambdaNodejs.NodejsFunction(this, 'GetAnalysisResultsFunction', {
      entry: path.join(__dirname, '../src/functions/get-analysis-results.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Gets specific analysis results by file ID',
    });

    // Create Lambda function for checking Step Functions execution status
    const checkExecutionStatusFunction = new lambdaNodejs.NodejsFunction(this, 'CheckExecutionStatusFunction', {
      entry: path.join(__dirname, '../src/functions/check-execution-status.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        STATE_MACHINE_ARN: '', // Will be set after state machine is created
      },
      description: 'Checks Step Functions execution status for uploaded files',
    });

    // Grant Lambda permissions to use Transcribe and PassRole
    transcribeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartCallAnalyticsJob',
        'transcribe:GetCallAnalyticsJob',
      ],
      resources: ['*'],
    }));

    // Add specific PassRole permission for the Transcribe role
    transcribeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [transcribeRole.roleArn],
    }));

    // Grant check status function permission to use Transcribe
    checkTranscribeStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:GetCallAnalyticsJob',
      ],
      resources: ['*'],
    }));

    const bedrockModelArn = `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.nova-pro-v1:0`;

    // Grant LLM analysis function permission to use Bedrock
    analyzeLLMFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
      ],
      resources: [bedrockModelArn], // You can scope this down to specific model ARNs if needed
    }));

    // Grant Lambda access to S3
    this.storageBucket.grantReadWrite(transcribeFunction);
    this.storageBucket.grantReadWrite(checkTranscribeStatusFunction);
    this.storageBucket.grantReadWrite(formatFunction);
    this.storageBucket.grantReadWrite(analyzeLLMFunction);
    this.storageBucket.grantReadWrite(aggregateScoresFunction);
    this.storageBucket.grantRead(updateCounselorRecordsFunction);
    this.storageBucket.grantReadWrite(generatePresignedUrlFunction);
    this.storageBucket.grantRead(getResultsFunction);
    this.storageBucket.grantRead(getAnalysisResultsFunction);
    
    // Grant Lambda access to DynamoDB
    this.counselorEvaluationsTable.grantWriteData(updateCounselorRecordsFunction);
    this.counselorProfilesTable.grantReadWriteData(updateCounselorRecordsFunction);
    this.counselorProfilesTable.grantReadWriteData(manageCounselorProfilesFunction);
    this.counselorEvaluationsTable.grantReadData(manageCounselorProfilesFunction);
    this.counselorEvaluationsTable.grantReadData(getCounselorDataFunction);

    // Grant generate presigned URL function access to file mappings table
    fileMappingsTable.grantReadWriteData(generatePresignedUrlFunction); 
    fileMappingsTable.grantReadData(updateCounselorRecordsFunction);
    
    // Create Step Functions tasks
    const startTranscribeTask = new tasks.LambdaInvoke(this, 'StartTranscribeJob', {
      lambdaFunction: transcribeFunction,
      outputPath: '$.Payload',
    });

    const checkTranscribeStatusTask = new tasks.LambdaInvoke(this, 'CheckTranscribeStatus', {
      lambdaFunction: checkTranscribeStatusFunction,
      outputPath: '$.Payload',
    });

    const formatTranscriptTask = new tasks.LambdaInvoke(this, 'FormatTranscript', {
      lambdaFunction: formatFunction,
      outputPath: '$.Payload',
    });

    const analyzeLLMTask = new tasks.LambdaInvoke(this, 'AnalyzeLLM', {
      lambdaFunction: analyzeLLMFunction,
      outputPath: '$.Payload',
    });
    
    const aggregateScoresTask = new tasks.LambdaInvoke(this, 'AggregateScores', {
      lambdaFunction: aggregateScoresFunction,
      outputPath: '$.Payload',
    });
    
    const updateCounselorRecordsTask = new tasks.LambdaInvoke(this, 'UpdateCounselorRecords', {
      lambdaFunction: updateCounselorRecordsFunction,
      outputPath: '$.Payload',
    });

    // Create Step Functions workflow
    const waitX = new sfn.Wait(this, 'Wait 30 Seconds', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const checkJobComplete = new sfn.Choice(this, 'Job Complete?');
    const jobFailed = new sfn.Fail(this, 'Job Failed', {
      cause: 'Transcribe job failed',
      error: 'TranscribeJobFailed',
    });

    const definition = startTranscribeTask
      .next(checkTranscribeStatusTask)
      .next(
        checkJobComplete
          .when(sfn.Condition.isNotPresent('$.transcriptKey'), waitX.next(checkTranscribeStatusTask))
          .otherwise(formatTranscriptTask.next(analyzeLLMTask.next(aggregateScoresTask.next(updateCounselorRecordsTask))))
      );

    const stateMachine = new sfn.StateMachine(this, 'HotlineQAWorkflow', {
      definition,
      timeout: cdk.Duration.minutes(30),
    });

    // Update the check execution status function with the state machine ARN
    checkExecutionStatusFunction.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);

    // Grant the check execution status function permission to describe executions
    checkExecutionStatusFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'states:ListExecutions',
        'states:DescribeExecution',
      ],
      resources: [
        stateMachine.stateMachineArn,
        // Allow access to all executions of this state machine using explicit pattern
        `arn:aws:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:execution:${stateMachine.stateMachineName}:*`,
      ],
    }));

    // Grant start workflow function permission to start executions
    startWorkflowFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [stateMachine.stateMachineArn],
    }));

    // Set the state machine ARN in the start workflow function
    startWorkflowFunction.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);
    startWorkflowFunction.addEnvironment('BUCKET_NAME', this.storageBucket.bucketName);

    // Grant start workflow function access to S3
    this.storageBucket.grantRead(startWorkflowFunction);
    
    // Add S3 event notification to trigger the workflow
    this.storageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(startWorkflowFunction),
      { prefix: 'records/', suffix: '.wav' }
    );

    // === CREATE API GATEWAY FOR FRONTEND ===
    const api = new apigateway.RestApi(this, 'HotlineQaApi', {
      restApiName: 'Boys Town Hotline QA API',
      description: 'API for Boys Town Hotline QA frontend application',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Amz-Security-Token'
        ],
      },
    });

    // Create API integrations
    const generateUrlIntegration = new apigateway.LambdaIntegration(generatePresignedUrlFunction);
    const getResultsIntegration = new apigateway.LambdaIntegration(getResultsFunction);
    const getCounselorDataIntegration = new apigateway.LambdaIntegration(getCounselorDataFunction);
    const getAnalysisResultsIntegration = new apigateway.LambdaIntegration(getAnalysisResultsFunction);
    const manageCounselorProfilesIntegration = new apigateway.LambdaIntegration(manageCounselorProfilesFunction);
    const checkExecutionStatusIntegration = new apigateway.LambdaIntegration(checkExecutionStatusFunction);

    // Add API routes
    api.root.addResource('generate-url').addMethod('POST', generateUrlIntegration);
    api.root.addResource('get-results').addMethod('GET', getResultsIntegration);
    api.root.addResource('get-data').addMethod('GET', getCounselorDataIntegration);
    api.root.addResource('execution-status').addMethod('GET', checkExecutionStatusIntegration);
    
    // Add analysis route with path parameter
    const analysisResource = api.root.addResource('analysis');
    analysisResource.addResource('{fileId}').addMethod('GET', getAnalysisResultsIntegration);
    
    // Add profiles route with proper path parameter support
    const profilesResource = api.root.addResource('profiles');
    profilesResource.addMethod('GET', manageCounselorProfilesIntegration); // GET /profiles - get all
    profilesResource.addMethod('POST', manageCounselorProfilesIntegration); // POST /profiles - create new
    
    // Add specific counselor profile route with path parameter
    const specificProfileResource = profilesResource.addResource('{counselorId}');
    specificProfileResource.addMethod('GET', manageCounselorProfilesIntegration); // GET /profiles/{counselorId}
    specificProfileResource.addMethod('PUT', manageCounselorProfilesIntegration); // PUT /profiles/{counselorId}
    specificProfileResource.addMethod('DELETE', manageCounselorProfilesIntegration); // DELETE /profiles/{counselorId}

    // Store API URL for frontend stack
    this.apiUrl = api.url;
    
    // === CREATE AMPLIFY APP FOR FRONTEND (OPTIONAL) ===
    const deployFrontend = props.deployFrontend !== false; // Deploy by default
    
    if (deployFrontend) {
      const githubOwner = props.githubOwner;
      const githubRepo = props.githubRepo;
      const githubTokenSecretName = props.githubTokenSecretName;
      
      // Validate required GitHub parameters for frontend deployment
      if (!githubOwner || !githubRepo || !githubTokenSecretName) {
        throw new Error('GitHub parameters (githubOwner, githubRepo, githubTokenSecretName) are required when deployFrontend is true');
      }
      
      this.amplifyApp = new amplify.App(this, 'HotlineFrontendApp', {
        sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
          owner: githubOwner,
          repository: githubRepo,
          oauthToken: cdk.SecretValue.secretsManager(githubTokenSecretName),
        }),
        environmentVariables: {
          REACT_APP_API_BASE_URL: this.apiUrl,
          REACT_APP_API_URL: this.apiUrl,
          REACT_APP_AWS_REGION: cdk.Stack.of(this).region,
          REACT_APP_BUCKET_NAME: this.storageBucket.bucketName,
        },
        buildSpec: codebuild.BuildSpec.fromObjectToYaml({
          version: '1.0',
          frontend: {
            phases: {
              preBuild: {
                commands: [
                  'cd frontend',
                  'npm ci'
                ],
              },
              build: {
                commands: [
                  'npm run build'
                ],
              },
            },
            artifacts: {
              baseDirectory: 'frontend/build',
              files: ['**/*'],
            },
            cache: {
              paths: ['frontend/node_modules/**/*'],
            },
          },
        }),
        description: `Boys Town Hotline QA Frontend - ${envName}`,
      });

      // Add main branch for deployment
      this.amplifyApp.addBranch('main', {
        branchName: 'main',
        stage: 'PRODUCTION',
      });
    }
    
    // Output the bucket name for reference
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.storageBucket.bucketName,
      description: 'Name of the S3 bucket for hotline QA',
    });
    
    // Output the folder prefixes for reference
    new cdk.CfnOutput(this, 'RecordingsPrefix', {
      value: 'records/',
      description: 'S3 prefix for call recordings',
    });
    
    new cdk.CfnOutput(this, 'TranscriptsAnalyticsPrefix', {
      value: 'transcripts/analytics/',
      description: 'S3 prefix for full transcription outputs (automatically created by AWS Transcribe)',
    });
    
    new cdk.CfnOutput(this, 'FormattedPrefix', {
      value: 'transcripts/formatted/',
      description: 'S3 prefix for formatted transcription outputs',
    });
    
    new cdk.CfnOutput(this, 'ResultsPrefix', {
      value: 'results/',
      description: 'S3 prefix for analysis results',
    });
    
    new cdk.CfnOutput(this, 'LLMOutputPrefix', {
      value: 'results/llmOutput/',
      description: 'S3 prefix for LLM analysis results',
    });
    
    // Output the Lambda function names for easier testing
    new cdk.CfnOutput(this, 'StartWorkflowFunctionName', {
      value: startWorkflowFunction.functionName,
      description: 'Name of the Lambda function that starts the workflow',
    });
    
    new cdk.CfnOutput(this, 'TranscribeFunctionName', {
      value: transcribeFunction.functionName,
      description: 'Name of the Lambda function that starts transcription jobs',
    });
    
    new cdk.CfnOutput(this, 'CheckTranscribeStatusFunctionName', {
      value: checkTranscribeStatusFunction.functionName,
      description: 'Name of the Lambda function that checks transcription job status',
    });
    
    new cdk.CfnOutput(this, 'FormatFunctionName', {
      value: formatFunction.functionName,
      description: 'Name of the Lambda function that formats transcription outputs',
    });
    
    new cdk.CfnOutput(this, 'AnalyzeLLMFunctionName', {
      value: analyzeLLMFunction.functionName,
      description: 'Name of the Lambda function that analyzes transcripts using Bedrock',
    });
    
    new cdk.CfnOutput(this, 'AggregateScoresFunctionName', {
      value: aggregateScoresFunction.functionName,
      description: 'Name of the Lambda function that aggregates scores from LLM analysis',
    });
    
    new cdk.CfnOutput(this, 'UpdateCounselorRecordsFunctionName', {
      value: updateCounselorRecordsFunction.functionName,
      description: 'Name of the Lambda function that updates counselor records in DynamoDB',
    });
    
    new cdk.CfnOutput(this, 'ManageCounselorProfilesFunctionName', {
      value: manageCounselorProfilesFunction.functionName,
      description: 'Name of the Lambda function that manages counselor profiles via API',
    });
    
    new cdk.CfnOutput(this, 'GeneratePresignedUrlFunctionName', {
      value: generatePresignedUrlFunction.functionName,
      description: 'Name of the Lambda function that generates presigned URLs',
    });
    
    new cdk.CfnOutput(this, 'GetResultsFunctionName', {
      value: getResultsFunction.functionName,
      description: 'Name of the Lambda function that gets analysis results',
    });
    
    new cdk.CfnOutput(this, 'GetCounselorDataFunctionName', {
      value: getCounselorDataFunction.functionName,
      description: 'Name of the Lambda function that gets counselor data',
    });
    
    new cdk.CfnOutput(this, 'GetAnalysisResultsFunctionName', {
      value: getAnalysisResultsFunction.functionName,
      description: 'Name of the Lambda function that gets specific analysis results',
    });
    
    new cdk.CfnOutput(this, 'CheckExecutionStatusFunctionName', {
      value: checkExecutionStatusFunction.functionName,
      description: 'Name of the Lambda function that checks Step Functions execution status',
    });
    
    // Output the DynamoDB table names
    new cdk.CfnOutput(this, 'CounselorEvaluationsTableName', {
      value: this.counselorEvaluationsTable.tableName,
      description: 'Name of the DynamoDB table for counselor evaluations',
    });
    
    new cdk.CfnOutput(this, 'CounselorProfilesTableName', {
      value: this.counselorProfilesTable.tableName,
      description: 'Name of the DynamoDB table for counselor profiles/metadata',
    });

    new cdk.CfnOutput(this, 'FileMappingsTableName', {
      value: fileMappingsTable.tableName,
      description: 'Name of the DynamoDB table for file UUID mappings',
    });
    
    // Output the state machine ARN for reference
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the Step Functions state machine',
    });
    
    // Output the API Gateway URL for frontend integration
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: this.apiUrl,
      description: 'API Gateway URL - Frontend should use this as base URL for all API calls',
    });
    
    // Output Amplify app information if deployed
    if (this.amplifyApp) {
      new cdk.CfnOutput(this, 'AmplifyAppUrl', {
        value: `https://main.${this.amplifyApp.appId}.amplifyapp.com`,
        description: 'Amplify app URL - Access your deployed frontend application here',
      });
      
      new cdk.CfnOutput(this, 'AmplifyAppId', {
        value: this.amplifyApp.appId,
        description: 'Amplify app ID for management and configuration',
      });
      
      new cdk.CfnOutput(this, 'AmplifyConsoleUrl', {
        value: `https://console.aws.amazon.com/amplify/home?region=${cdk.Stack.of(this).region}#/${this.amplifyApp.appId}`,
        description: 'AWS Amplify Console URL for managing deployments and settings',
      });
    }
  }
}
