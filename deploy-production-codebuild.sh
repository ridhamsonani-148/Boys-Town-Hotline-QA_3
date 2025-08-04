#!/bin/bash

# Complete Production Deployment Script using CodeBuild
# This script deploys a unique, production-ready Boys Town Hotline QA system

set -e

# Configuration - NO DEFAULTS for GitHub parameters
COMPANY_NAME=""                       # REQUIRED: Your company name
GITHUB_OWNER=""                       # REQUIRED: Your GitHub username/organization  
GITHUB_REPO=""                        # REQUIRED: Your forked repository name
GITHUB_TOKEN=""                       # REQUIRED: Your GitHub personal access token
AWS_REGION="us-east-1"               # Your preferred AWS region

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --company-name)
      COMPANY_NAME="$2"
      shift 2
      ;;
    --github-owner)
      GITHUB_OWNER="$2"
      shift 2
      ;;
    --github-repo)
      GITHUB_REPO="$2"
      shift 2
      ;;
    --github-token)
      GITHUB_TOKEN="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Deploy a complete production Boys Town Hotline QA system using CodeBuild"
      echo ""
      echo "Required Options:"
      echo "  --company-name NAME       Your company name (for unique resource naming)"
      echo "  --github-owner OWNER      Your GitHub username/organization"
      echo "  --github-repo REPO        Your forked repository name"
      echo "  --github-token TOKEN      Your GitHub personal access token"
      echo ""
      echo "Optional:"
      echo "  --region REGION           AWS region (default: us-east-1)"
      echo "  --help                    Show this help message"
      echo ""
      echo "Example:"
      echo "  $0 --company-name acme-healthcare \\"
      echo "     --github-owner acmecorp \\"
      echo "     --github-repo Acme-Hotline-QA \\"
      echo "     --github-token ghp_xxxxxxxxxxxx \\"
      echo "     --region us-west-2"
      echo ""
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

# Validate required parameters
if [ -z "$COMPANY_NAME" ] || [ -z "$GITHUB_OWNER" ] || [ -z "$GITHUB_REPO" ] || [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ Missing required parameters"
    echo "Run '$0 --help' for usage information"
    exit 1
fi

# Clean up parameters (remove quotes if present)
COMPANY_NAME=${COMPANY_NAME//\"/}
GITHUB_OWNER=${GITHUB_OWNER//\"/}
GITHUB_REPO=${GITHUB_REPO//\"/}
AWS_REGION=${AWS_REGION//\"/}

echo "🚀 Starting Complete Production Deployment"
echo "=========================================="
echo "Company: $COMPANY_NAME"
echo "GitHub Owner: $GITHUB_OWNER"
echo "GitHub Repo: $GITHUB_REPO"
echo "AWS Region: $AWS_REGION"
echo "Environment: prod"
echo ""

# Check AWS CLI configuration
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "❌ AWS CLI is not configured or credentials are invalid"
    echo "Please run 'aws configure' or set up your AWS credentials"
    exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "✅ AWS Account: $ACCOUNT"
echo "✅ AWS Region: $AWS_REGION"

# Step 1: Setup GitHub Token
echo ""
echo "🔐 Step 1: Setting up GitHub token..."
SECRET_NAME="${COMPANY_NAME}-github-token"

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" > /dev/null 2>&1; then
    echo "⚠️  Secret '$SECRET_NAME' already exists, updating..."
    aws secretsmanager update-secret \
        --secret-id "$SECRET_NAME" \
        --secret-string "$GITHUB_TOKEN" \
        --description "GitHub token for $COMPANY_NAME Hotline QA deployment"
else
    echo "🔐 Creating new secret..."
    aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --description "GitHub token for $COMPANY_NAME Hotline QA deployment" \
        --secret-string "$GITHUB_TOKEN"
fi
echo "✅ GitHub token configured"

# Step 2: Build project
echo ""
echo "📦 Step 2: Building TypeScript project..."
npm install
npm run build
echo "✅ Project built successfully"

# Step 3: Setup CodeBuild
echo ""
echo "🔧 Step 3: Setting up CodeBuild project..."

# Bootstrap CDK if needed
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region $AWS_REGION > /dev/null 2>&1; then
    echo "🔧 Bootstrapping CDK..."
    cdk bootstrap aws://$ACCOUNT/$AWS_REGION
fi

# Deploy CodeBuild stack
cdk deploy CodeBuildDeploymentStack-prod \
    --app "npx ts-node --prefer-ts-exts bin/codebuild-app.ts" \
    --context envName=prod \
    --context githubOwner=$GITHUB_OWNER \
    --context githubRepo=$GITHUB_REPO \
    --context githubTokenSecretName=$SECRET_NAME \
    --require-approval never

echo "✅ CodeBuild project created"

# Step 3.5: Import GitHub credentials into CodeBuild
echo ""
echo "🔐 Step 3.5: Setting up CodeBuild GitHub authentication..."
echo "Retrieving GitHub token from Secrets Manager..."
GITHUB_TOKEN_VALUE=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --query SecretString --output text)

echo "Importing GitHub credentials into CodeBuild..."
aws codebuild import-source-credentials \
    --server-type GITHUB \
    --auth-type PERSONAL_ACCESS_TOKEN \
    --token "$GITHUB_TOKEN_VALUE" > /dev/null 2>&1 || echo "Note: Credentials may already be imported"

echo "✅ GitHub authentication configured for CodeBuild"

# Step 4: Deploy Production System
echo ""
echo "🚀 Step 4: Deploying complete production system..."
echo "This will take 10-15 minutes..."

BUILD_ID=$(aws codebuild start-build \
    --project-name boys-town-hotline-qa-deployment-prod \
    --environment-variables-override \
    name=ENV_NAME,value=prod \
    name=BUCKET_PREFIX,value=${COMPANY_NAME}-hotline-qa \
    name=DEPLOY_FRONTEND,value=true \
    name=GITHUB_OWNER,value=$GITHUB_OWNER \
    name=GITHUB_REPO,value=$GITHUB_REPO \
    name=GITHUB_TOKEN_SECRET,value=$SECRET_NAME \
    --query 'build.id' --output text)

echo "✅ Build started with ID: $BUILD_ID"
echo ""
echo "📊 Monitoring deployment progress..."

# Monitor build progress
while true; do
    BUILD_STATUS=$(aws codebuild batch-get-builds --ids $BUILD_ID --query 'builds[0].buildStatus' --output text)
    
    case $BUILD_STATUS in
        "SUCCEEDED")
            echo "✅ Deployment completed successfully!"
            break
            ;;
        "FAILED"|"FAULT"|"STOPPED"|"TIMED_OUT")
            echo "❌ Deployment failed with status: $BUILD_STATUS"
            echo "Check build logs: https://console.aws.amazon.com/codesuite/codebuild/projects/boys-town-hotline-qa-deployment-prod/build/$BUILD_ID"
            exit 1
            ;;
        "IN_PROGRESS")
            echo "⏳ Build in progress... ($(date))"
            sleep 30
            ;;
        *)
            echo "📋 Build status: $BUILD_STATUS"
            sleep 30
            ;;
    esac
done

# Step 5: Get deployment outputs
echo ""
echo "📋 Step 5: Getting deployment information..."

echo ""
echo "🎉 PRODUCTION DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "=============================================="

# Get CloudFormation outputs
aws cloudformation describe-stacks \
    --stack-name HotlineQaStack-prod \
    --query 'Stacks[0].Outputs' \
    --output table

echo ""
echo "🔗 Important URLs:"
echo "=================="

# Get API Gateway URL
API_URL=$(aws cloudformation describe-stacks \
    --stack-name HotlineQaStack-prod \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayUrl`].OutputValue' \
    --output text)
echo "API Gateway: $API_URL"

# Get Amplify URL
AMPLIFY_APP_ID=$(aws cloudformation describe-stacks \
    --stack-name HotlineQaStack-prod \
    --query 'Stacks[0].Outputs[?OutputKey==`AmplifyAppId`].OutputValue' \
    --output text)
if [ "$AMPLIFY_APP_ID" != "None" ] && [ -n "$AMPLIFY_APP_ID" ]; then
    echo "Frontend App: https://main.${AMPLIFY_APP_ID}.amplifyapp.com"
    echo "Amplify Console: https://console.aws.amazon.com/amplify/home?region=${AWS_REGION}#/${AMPLIFY_APP_ID}"
fi

# Get S3 bucket name
BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name HotlineQaStack-prod \
    --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
    --output text)
echo "S3 Bucket: $BUCKET_NAME"

echo ""
echo "📋 Next Steps:"
echo "=============="
echo "1. Access your frontend application at the Amplify URL above"
echo "2. Test the API endpoints using the API Gateway URL"
echo "3. Upload test audio files to the S3 bucket in the 'records/' folder"
echo "4. Monitor processing in the AWS Step Functions console"
echo "5. View results in the DynamoDB tables and S3 results folder"
echo ""
echo "🔧 Management URLs:"
echo "=================="
echo "CloudFormation: https://console.aws.amazon.com/cloudformation/home?region=${AWS_REGION}#/stacks/stackinfo?stackId=HotlineQaStack-prod"
echo "CodeBuild: https://console.aws.amazon.com/codesuite/codebuild/projects/boys-town-hotline-qa-deployment-prod/history?region=${AWS_REGION}"
echo "S3 Console: https://s3.console.aws.amazon.com/s3/buckets/${BUCKET_NAME}?region=${AWS_REGION}"
echo ""
echo "🎉 Your production Boys Town Hotline QA system is now live!"
