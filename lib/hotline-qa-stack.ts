import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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
}

export class HotlineQaStack extends cdk.Stack {
  /**
   * The S3 bucket that will store call recordings, transcripts, and results
   */
  public readonly storageBucket: s3.Bucket;
  
  constructor(scope: Construct, id: string, props: HotlineQaStackProps) {
    super(scope, id, props);
    
    // Set default values
    const envName = props.envName || 'dev';
    const bucketNamePrefix = props.bucketNamePrefix || 'boys-town-hotline-qa';
    
    // Create the S3 bucket with focused parameterization
    this.storageBucket = new s3.Bucket(this, 'StorageBucket', {
      bucketName: `${bucketNamePrefix}-${envName}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Protect against accidental deletion
      lifecycleRules: [
        {
          id: 'ExpireObjects',
          enabled: true,
          expiration: cdk.Duration.days(30),
        }
      ],
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
          ],
          allowedOrigins: ['*'], // You might want to restrict this in production
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
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
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      description: 'Starts the Step Functions workflow for processing call recordings',
    });

    // Create Lambda function to start transcription jobs
    const transcribeFunction = new lambdaNodejs.NodejsFunction(this, 'TranscribeFunction', {
      entry: path.join(__dirname, '../src/functions/start-transcribe.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
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
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      description: 'Checks the status of Transcribe Call Analytics jobs',
    });

    // Create Lambda function to format transcription output
    const formatFunction = new lambdaNodejs.NodejsFunction(this, 'FormatFunction', {
      entry: path.join(__dirname, '../src/functions/format-transcript.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
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
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(15), // Maximum Lambda timeout for long-running LLM calls
      memorySize: 1024, // Increased memory for handling large transcripts
      environment: {
        BUCKET_NAME: this.storageBucket.bucketName,
      },
      description: 'Analyzes transcripts using Amazon Nova Lite',
    });

    // Grant Lambda permissions to use Transcribe and PassRole
    transcribeFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartCallAnalyticsJob',
        'transcribe:GetCallAnalyticsJob',
        'iam:PassRole',
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

    // Grant LLM analysis function permission to use Bedrock
    analyzeLLMFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
      ],
      resources: ['*'], // You can scope this down to specific model ARNs if needed
    }));

    // Grant Lambda access to S3
    this.storageBucket.grantReadWrite(transcribeFunction);
    this.storageBucket.grantReadWrite(checkTranscribeStatusFunction);
    this.storageBucket.grantReadWrite(formatFunction);
    this.storageBucket.grantReadWrite(analyzeLLMFunction);
    
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
          .otherwise(formatTranscriptTask.next(analyzeLLMTask))
      );

    const stateMachine = new sfn.StateMachine(this, 'HotlineQAWorkflow', {
      definition,
      timeout: cdk.Duration.minutes(30),
    });

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
      value: 'formatted/',
      description: 'S3 prefix for formatted transcription outputs',
    });
    
    new cdk.CfnOutput(this, 'ResultsPrefix', {
      value: 'results/',
      description: 'S3 prefix for analysis results',
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
    
    // Output the state machine ARN for reference
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the Step Functions state machine',
    });
  }
}
