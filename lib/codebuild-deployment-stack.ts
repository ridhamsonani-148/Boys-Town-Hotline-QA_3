import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface CodeBuildDeploymentStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g., 'dev', 'test', 'prod')
   * @default 'dev'
   */
  envName?: string;
  
  /**
   * GitHub repository owner - REQUIRED
   */
  githubOwner: string;
  
  /**
   * GitHub repository name - REQUIRED
   */
  githubRepo: string;
  
  /**
   * GitHub token secret name in AWS Secrets Manager - REQUIRED
   */
  githubTokenSecretName: string;
}

export class CodeBuildDeploymentStack extends cdk.Stack {
  /**
   * The CodeBuild project for automated deployment
   */
  public readonly buildProject: codebuild.Project;
  
  constructor(scope: Construct, id: string, props: CodeBuildDeploymentStackProps) {
    super(scope, id, props);
    
    const envName = props.envName || 'dev';
    const githubOwner = props.githubOwner;
    const githubRepo = props.githubRepo;
    const githubTokenSecretName = props.githubTokenSecretName;
    
    // Validate required GitHub parameters
    if (!githubOwner || !githubRepo || !githubTokenSecretName) {
      throw new Error('GitHub parameters (githubOwner, githubRepo, githubTokenSecretName) are required');
    }
    
    // Create CloudWatch Log Group for build logs
    const logGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: `/aws/codebuild/boys-town-hotline-qa-${envName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    
    // Create IAM role for CodeBuild with comprehensive permissions
    const buildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'IAM role for Boys Town Hotline QA CodeBuild project',
      managedPolicies: [
        // Basic CodeBuild permissions
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
      ],
      inlinePolicies: {
        CDKDeploymentPolicy: new iam.PolicyDocument({
          statements: [
            // CDK and CloudFormation permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'cloudformation:*',
                'sts:AssumeRole',
                'iam:*',
                's3:*',
                'lambda:*',
                'apigateway:*',
                'dynamodb:*',
                'stepfunctions:*',
                'transcribe:*',
                'bedrock:*',
                'amplify:*',
                'codebuild:*',
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
              ],
              resources: ['*'],
            }),
            // CDK bootstrap permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'sts:GetCallerIdentity',
                'sts:AssumeRole',
              ],
              resources: ['*'],
            }),
            // ECR permissions for CDK assets
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    
    // Create the CodeBuild project - SIMPLE VERSION that just runs deploy.sh
    this.buildProject = new codebuild.Project(this, 'DeploymentProject', {
      projectName: `boys-town-hotline-qa-deployment-${envName}`,
      description: `Automated deployment for Boys Town Hotline QA - ${envName} environment`,
      
      // Source configuration - Use GitHub source (credentials will be imported separately)
      source: codebuild.Source.gitHub({
        owner: githubOwner,
        repo: githubRepo,
        webhook: false, // No webhooks to avoid complexity
      }),
      
      // Build environment
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Includes Node.js 18
        computeType: codebuild.ComputeType.SMALL, // 3 GB memory, 2 vCPUs
        privileged: false, // Not needed for this project
      },
      
      // Build specification - Use the existing deploy.sh script!
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '20'
            },
            commands: [
              'echo "Installing dependencies..."',
              'npm install -g aws-cdk@2.87.0',
              'npm install'
            ]
          },
          'pre_build': {
            commands: [
              'echo "Pre-build phase started on `date`"',
              'echo "Checking AWS CLI configuration..."',
              'aws sts get-caller-identity --query Account --output text > /dev/null 2>&1 && echo "✅ AWS CLI configured" || (echo "❌ AWS CLI not configured" && exit 1)',
              'echo "Environment variables:"',
              'echo "ENV_NAME=${ENV_NAME:-dev}"',
              'echo "BUCKET_PREFIX=${BUCKET_PREFIX:-boys-town-hotline-qa}"',
              'echo "DEPLOY_FRONTEND=${DEPLOY_FRONTEND:-true}"',
              'echo "GITHUB_OWNER=[CONFIGURED]"',
              'echo "GITHUB_REPO=[CONFIGURED]"',
              'echo "GITHUB_TOKEN_SECRET=[REDACTED]"'
            ]
          },
          build: {
            commands: [
              'echo "Build phase started on `date`"',
              'echo "Running the existing deploy.sh script..."',
              'chmod +x ./deploy.sh',
              // Run deploy.sh with parameters from environment variables
              './deploy.sh --env ${ENV_NAME:-dev} --bucket-prefix ${BUCKET_PREFIX:-boys-town-hotline-qa} --github-owner ${GITHUB_OWNER} --github-repo ${GITHUB_REPO} --github-token-secret ${GITHUB_TOKEN_SECRET}'
            ]
          },
          'post_build': {
            commands: [
              'echo "Post-build phase started on `date`"',
              'echo "Deployment completed successfully!"'
            ]
          }
        },
        artifacts: {
          files: ['**/*'],
          'base-directory': 'cdk.out'
        },
        cache: {
          paths: [
            'node_modules/**/*',
            'frontend/node_modules/**/*'
          ]
        }
      }),
      
      // Environment variables (can be overridden at build time)
      environmentVariables: {
        ENV_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: envName,
        },
        BUCKET_PREFIX: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'boys-town-hotline-qa',
        },
        DEPLOY_FRONTEND: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'true',
        },
        GITHUB_OWNER: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubOwner,
        },
        GITHUB_REPO: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubRepo,
        },
        GITHUB_TOKEN_SECRET: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubTokenSecretName,
        },
      },
      
      // Logging configuration
      logging: {
        cloudWatch: {
          logGroup: logGroup,
        },
      },
      
      // Build timeout
      timeout: cdk.Duration.minutes(30),
      
      // Cache configuration for faster builds
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
      
      // Service role
      role: buildRole,
    });
    
    // Output the project information
    new cdk.CfnOutput(this, 'CodeBuildProjectName', {
      value: this.buildProject.projectName,
      description: 'Name of the CodeBuild project for automated deployment',
    });
    
    new cdk.CfnOutput(this, 'CodeBuildProjectArn', {
      value: this.buildProject.projectArn,
      description: 'ARN of the CodeBuild project',
    });
    
    new cdk.CfnOutput(this, 'CodeBuildConsoleUrl', {
      value: `https://console.aws.amazon.com/codesuite/codebuild/projects/${this.buildProject.projectName}/history?region=${cdk.Stack.of(this).region}`,
      description: 'AWS CodeBuild Console URL for monitoring builds',
    });
    
    new cdk.CfnOutput(this, 'StartBuildCommand', {
      value: `aws codebuild start-build --project-name ${this.buildProject.projectName}`,
      description: 'AWS CLI command to start a build manually',
    });
    
    new cdk.CfnOutput(this, 'StartBuildWithCustomEnv', {
      value: `aws codebuild start-build --project-name ${this.buildProject.projectName} --environment-variables-override name=ENV_NAME,value=prod name=DEPLOY_FRONTEND,value=false`,
      description: 'Example: Start build with custom environment variables',
    });
  }
}
