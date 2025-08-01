#!/bin/bash

# Boys Town Hotline QA Deployment Script
# This script deploys the complete backend stack with API Gateway and optional Amplify frontend

set -e

# Default values
ENV_NAME="dev"
BUCKET_PREFIX="boys-town-hotline-qa"
GITHUB_OWNER="ASUCICREPO"
GITHUB_REPO="Boys-Town-Hotline-QA"
GITHUB_TOKEN_SECRET="github-token"
DEPLOY_FRONTEND="true"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENV_NAME="$2"
      shift 2
      ;;
    --bucket-prefix)
      BUCKET_PREFIX="$2"
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
    --github-token-secret)
      GITHUB_TOKEN_SECRET="$2"
      shift 2
      ;;
    --backend-only)
      DEPLOY_FRONTEND="false"
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --env ENV_NAME                Environment name (default: dev)"
      echo "  --bucket-prefix PREFIX        S3 bucket prefix (default: boys-town-hotline-qa)"
      echo "  --github-owner OWNER          GitHub repository owner (default: ASUCICREPO)"
      echo "  --github-repo REPO            GitHub repository name (default: Boys-Town-Hotline-QA)"
      echo "  --github-token-secret SECRET  AWS Secrets Manager secret name for GitHub token (default: github-token)"
      echo "  --backend-only                Deploy only backend (skip Amplify frontend)"
      echo "  --help                        Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                                    # Deploy with defaults (includes frontend)"
      echo "  $0 --env prod                         # Deploy for production with frontend"
      echo "  $0 --backend-only                     # Deploy only backend components"
      echo "  $0 --env staging --bucket-prefix my-company-qa"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

echo "🚀 Starting Boys Town Hotline QA Deployment"
echo "Environment: $ENV_NAME"
echo "Bucket Prefix: $BUCKET_PREFIX"
echo "Deploy Frontend: $DEPLOY_FRONTEND"
if [ "$DEPLOY_FRONTEND" = "true" ]; then
    echo "GitHub Owner: $GITHUB_OWNER"
    echo "GitHub Repo: $GITHUB_REPO"
    echo "GitHub Token Secret: $GITHUB_TOKEN_SECRET"
fi
echo ""

# Check if AWS CLI is configured
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "❌ AWS CLI is not configured or credentials are invalid"
    echo "Please run 'aws configure' or set up your AWS credentials"
    exit 1
fi

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo "❌ AWS CDK is not installed"
    echo "Please install CDK: npm install -g aws-cdk"
    exit 1
fi

# Check GitHub token secret if deploying frontend
if [ "$DEPLOY_FRONTEND" = "true" ]; then
    echo "🔐 Checking GitHub token secret..."
    if ! aws secretsmanager describe-secret --secret-id "$GITHUB_TOKEN_SECRET" > /dev/null 2>&1; then
        echo "⚠️  GitHub token secret '$GITHUB_TOKEN_SECRET' not found in AWS Secrets Manager"
        echo "Please create the secret with your GitHub personal access token:"
        echo "aws secretsmanager create-secret --name '$GITHUB_TOKEN_SECRET' --description 'GitHub token for Amplify' --secret-string 'your-github-token'"
        echo ""
        echo "Or deploy backend only with: $0 --backend-only"
        exit 1
    fi
    echo "✅ GitHub token secret found"
fi

# Build the project
echo "📦 Building TypeScript project..."
npm run build

# Bootstrap CDK if needed
echo "🔧 Checking CDK bootstrap..."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region $REGION > /dev/null 2>&1; then
    echo "🔧 Bootstrapping CDK..."
    cdk bootstrap aws://$ACCOUNT/$REGION
fi

# Deploy the stack
echo "🚀 Deploying complete stack..."
cdk deploy HotlineQaStack-$ENV_NAME \
    --context envName=$ENV_NAME \
    --context bucketNamePrefix=$BUCKET_PREFIX \
    --context deployFrontend=$DEPLOY_FRONTEND \
    --context githubOwner=$GITHUB_OWNER \
    --context githubRepo=$GITHUB_REPO \
    --context githubTokenSecretName=$GITHUB_TOKEN_SECRET \
    --require-approval never

echo ""
echo "✅ Deployment completed successfully!"
echo ""
echo "📋 What was deployed:"
echo "✅ Backend processing pipeline (S3, Lambda, Step Functions, DynamoDB)"
echo "✅ API Gateway with all required endpoints"
if [ "$DEPLOY_FRONTEND" = "true" ]; then
    echo "✅ Amplify frontend app with automatic GitHub integration"
fi
echo ""
echo "📋 Next Steps:"
echo "1. Check the CloudFormation outputs for important URLs and resource names"
if [ "$DEPLOY_FRONTEND" = "true" ]; then
    echo "2. Access your frontend at the Amplify URL shown in the outputs"
    echo "3. The frontend will automatically rebuild when you push to the main branch"
fi
echo "4. Upload test audio files to the 'records/' folder in the S3 bucket to test the pipeline"
echo ""
echo "🔗 API Gateway endpoints available:"
echo "   POST /generate-url        - Generate S3 presigned URLs for file upload"
echo "   GET  /get-results         - Get analysis results by filename"
echo "   GET  /get-data            - Get all counselor evaluation data"
echo "   GET  /analysis/{fileId}   - Get specific analysis results"
echo "   GET  /execution-status    - Check Step Functions execution status by fileName"
echo "   GET  /profiles            - Get all counselor profiles"
echo "   POST /profiles            - Create new counselor profile"
echo "   GET  /profiles/{id}       - Get specific counselor profile"
echo "   PUT  /profiles/{id}       - Update counselor profile (including programs)"
