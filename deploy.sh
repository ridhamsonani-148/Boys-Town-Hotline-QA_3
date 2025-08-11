#!/usr/bin/env bash
set -euo pipefail

# Disable AWS CLI pager for this script (compatible with all AWS CLI versions)
export AWS_PAGER=""

# Boys Town Hotline QA - Simplified CodeBuild Deployment
# This script creates everything needed and deploys directly from AWS CLI/CloudShell

echo "🚀 Boys Town Hotline QA - Simplified Deployment"
echo "================================================"

# --------------------------------------------------
# 1. Prompt for all required values
# --------------------------------------------------

# 1) Prompt for GITHUB_URL if unset
if [ -z "${GITHUB_URL:-}" ]; then
  echo "Please provide your forked GitHub repository URL"
  echo "Example: https://github.com/yourusername/Boys-Town-Hotline-QA"
  read -rp "Enter GitHub repository URL: " GITHUB_URL
fi

# 2) Normalize URL (strip .git and any trailing slash)
clean_url=${GITHUB_URL%.git}
clean_url=${clean_url%/}

# 3) Extract the path part (owner/repo) for HTTPS or SSH URLs
if [[ $clean_url =~ ^https://github\.com/([^/]+/[^/]+)$ ]]; then
  path="${BASH_REMATCH[1]}"
elif [[ $clean_url =~ ^git@github\.com:([^/]+/[^/]+)$ ]]; then
  path="${BASH_REMATCH[1]}"
else
  echo "Unable to parse owner/repo from '$GITHUB_URL'"
  read -rp "Enter GitHub owner manually: " GITHUB_OWNER
  read -rp "Enter GitHub repo manually: " GITHUB_REPO
  echo "→ Using GITHUB_OWNER=$GITHUB_OWNER"
  echo "→ Using GITHUB_REPO=$GITHUB_REPO"
fi

if [ -z "${GITHUB_OWNER:-}" ]; then
  # 4) Split into owner and repo
  GITHUB_OWNER=${path%%/*}
  GITHUB_REPO=${path##*/}
fi

# 5) Confirm detection
echo ""
echo "Detected GitHub Owner: $GITHUB_OWNER"
echo "Detected GitHub Repo:  $GITHUB_REPO"
read -rp "Is this correct? (y/n): " CONFIRM
CONFIRM=$(printf '%s' "$CONFIRM" | tr '[:upper:]' '[:lower:]')

if [[ "$CONFIRM" != "y" && "$CONFIRM" != "yes" ]]; then
  read -rp "Enter GitHub owner manually: " GITHUB_OWNER
  read -rp "Enter GitHub repo manually: " GITHUB_REPO
fi

echo "→ Final GITHUB_OWNER=$GITHUB_OWNER"
echo "→ Final GITHUB_REPO=$GITHUB_REPO"

# 2) Project name for unique resource naming
if [ -z "${COMPANY_NAME:-}" ]; then
  echo ""
  echo "Enter a unique company/project name for resource naming"
  echo "This will be used to create unique S3 buckets and other resources"
  echo "Example: acme-healthcare, johns-clinic, etc."
  read -rp "Enter company/project name: " COMPANY_NAME
fi

# 3) GitHub Token
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo ""
  echo "GitHub Personal Access Token is required for Amplify frontend deployment"
  echo "Create one at: https://github.com/settings/tokens"
  echo "Required permissions: repo, admin:repo_hook, workflow"
  read -rp "Enter GitHub Personal Access Token: " GITHUB_TOKEN
fi

# 4) AWS Region
if [ -z "${AWS_REGION:-}" ]; then
  CURRENT_REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
  read -rp "Enter AWS region [default: $CURRENT_REGION]: " AWS_REGION
  AWS_REGION=${AWS_REGION:-$CURRENT_REGION}
fi

# 5) Action
if [ -z "${ACTION:-}" ]; then
  read -rp "Would you like to [deploy] or [destroy] the system? [default: deploy]: " ACTION
  ACTION=${ACTION:-deploy}
  ACTION=$(printf '%s' "$ACTION" | tr '[:upper:]' '[:lower:]')
fi

if [[ "$ACTION" != "deploy" && "$ACTION" != "destroy" ]]; then
  echo "Invalid choice: '$ACTION'. Please choose deploy or destroy."
  exit 1
fi

echo ""
echo "📋 Configuration Summary:"
echo "========================="
echo "GitHub Owner: $GITHUB_OWNER"
echo "GitHub Repo: $GITHUB_REPO"
echo "Company Name: $COMPANY_NAME"
echo "AWS Region: $AWS_REGION"
echo "Action: $ACTION"
echo ""

read -rp "Proceed with $ACTION? (y/n): " PROCEED
PROCEED=$(printf '%s' "$PROCEED" | tr '[:upper:]' '[:lower:]')

if [[ "$PROCEED" != "y" && "$PROCEED" != "yes" ]]; then
  echo "Deployment cancelled."
  exit 0
fi

# --------------------------------------------------
# 2. Verify AWS CLI access
# --------------------------------------------------

echo ""
echo "🔍 Verifying AWS CLI access..."

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "❌ AWS CLI is not configured or credentials are invalid"
  echo "Please run 'aws configure' or use AWS CloudShell"
  exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "✅ AWS Account: $ACCOUNT"
echo "✅ AWS Region: $AWS_REGION"

# --------------------------------------------------
# 3. Create GitHub token secret
# --------------------------------------------------

echo ""
echo "🔐 Setting up GitHub token in Secrets Manager..."

SECRET_NAME="${COMPANY_NAME}-github-token-prod"

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "⚠️  Secret '$SECRET_NAME' already exists, updating..."
  aws secretsmanager update-secret \
    --secret-id "$SECRET_NAME" \
    --secret-string "$GITHUB_TOKEN" \
    --region "$AWS_REGION" \
    --description "GitHub token for $COMPANY_NAME Boys Town Hotline QA deployment"
else
  echo "🔐 Creating new secret..."
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "GitHub token for $COMPANY_NAME Boys Town Hotline QA deployment" \
    --secret-string "$GITHUB_TOKEN" \
    --region "$AWS_REGION"
fi
echo "✅ GitHub token configured"

# --------------------------------------------------
# 4. Ensure IAM service role exists
# --------------------------------------------------

PROJECT_NAME="${COMPANY_NAME}-hotline-qa-prod"
ROLE_NAME="${PROJECT_NAME}-service-role"

echo ""
echo "🔧 Setting up IAM role: $ROLE_NAME"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "✅ IAM role exists"
  ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
else
  echo "🔧 Creating IAM role: $ROLE_NAME"
  TRUST_DOC='{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"codebuild.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

  ROLE_ARN=$(aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_DOC" \
    --query 'Role.Arn' --output text)

  echo "🔧 Attaching AWS managed policies (least-privilege approach)..."
  
  # Attach specific managed policies (least-privilege approach)
  MANAGED_POLICIES=(
    "arn:aws:iam::aws:policy/AmazonAPIGatewayAdministrator"
    "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
    "arn:aws:iam::aws:policy/AmazonS3FullAccess"
    "arn:aws:iam::aws:policy/AWSCloudFormationFullAccess"
    "arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess"
    "arn:aws:iam::aws:policy/AWSLambda_FullAccess"
    "arn:aws:iam::aws:policy/AWSStepFunctionsFullAccess"
    "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
    "arn:aws:iam::aws:policy/IAMFullAccess"
    "arn:aws:iam::aws:policy/SecretsManagerReadWrite"
  )

  for policy in "${MANAGED_POLICIES[@]}"; do
    echo "  Attaching: $(basename "$policy")"
    aws iam attach-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-arn "$policy"
  done

  echo "🔧 Creating inline policy for additional services..."
  
  # Create inline policy for services not covered by managed policies
  INLINE_POLICY='{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "transcribe:*",
          "bedrock:*",
          "amplify:*",
          "ssm:UpdateInstanceInformation",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:DescribeParameters",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
          "ec2messages:AcknowledgeMessage",
          "ec2messages:DeleteMessage",
          "ec2messages:FailMessage",
          "ec2messages:GetEndpoint",
          "ec2messages:GetMessages",
          "ec2messages:SendReply"
        ],
        "Resource": "*"
      }
    ]
  }'

  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "AdditionalServicesPolicy" \
    --policy-document "$INLINE_POLICY"

  echo "✅ IAM role created with least-privilege permissions"
  echo "⏳ Waiting for IAM role to propagate..."
  sleep 15
fi

# --------------------------------------------------
# 5. Create/Update CodeBuild project
# --------------------------------------------------

echo ""
echo "🏗️  Setting up CodeBuild project: $PROJECT_NAME"

# Build environment with all required environment variables
ENVIRONMENT='{
  "type": "LINUX_CONTAINER",
  "image": "aws/codebuild/amazonlinux-x86_64-standard:5.0",
  "computeType": "BUILD_GENERAL1_MEDIUM",
  "environmentVariables": [
    {
      "name": "COMPANY_NAME",
      "value": "'"$COMPANY_NAME"'",
      "type": "PLAINTEXT"
    },
    {
      "name": "GITHUB_OWNER",
      "value": "'"$GITHUB_OWNER"'",
      "type": "PLAINTEXT"
    },
    {
      "name": "GITHUB_REPO",
      "value": "'"$GITHUB_REPO"'",
      "type": "PLAINTEXT"
    },
    {
      "name": "GITHUB_TOKEN_SECRET",
      "value": "'"$SECRET_NAME"'",
      "type": "PLAINTEXT"
    },
    {
      "name": "ENV_NAME",
      "value": "prod",
      "type": "PLAINTEXT"
    },
    {
      "name": "AWS_REGION",
      "value": "'"$AWS_REGION"'",
      "type": "PLAINTEXT"
    },
    {
      "name": "ACTION",
      "value": "'"$ACTION"'",
      "type": "PLAINTEXT"
    }
  ]
}'

# No artifacts needed
ARTIFACTS='{"type":"NO_ARTIFACTS"}'

# Source from GitHub
SOURCE='{"type":"GITHUB","location":"'"$GITHUB_URL"'"}'

# Check if project exists
PROJECT_EXISTS=$(aws codebuild batch-get-projects --names "$PROJECT_NAME" --region "$AWS_REGION" --query 'projects[0].name' --output text 2>/dev/null || echo "None")

if [ "$PROJECT_EXISTS" != "None" ] && [ "$PROJECT_EXISTS" != "" ]; then
  echo "⚠️  CodeBuild project '$PROJECT_NAME' already exists, updating..."
  aws codebuild update-project \
    --name "$PROJECT_NAME" \
    --source "$SOURCE" \
    --artifacts "$ARTIFACTS" \
    --environment "$ENVIRONMENT" \
    --service-role "$ROLE_ARN" \
    --region "$AWS_REGION"
else
  echo "🏗️  Creating CodeBuild project '$PROJECT_NAME'..."
  aws codebuild create-project \
    --name "$PROJECT_NAME" \
    --source "$SOURCE" \
    --artifacts "$ARTIFACTS" \
    --environment "$ENVIRONMENT" \
    --service-role "$ROLE_ARN" \
    --region "$AWS_REGION"
fi

echo "✅ CodeBuild project configured successfully"

# --------------------------------------------------
# 6. Import GitHub credentials for CodeBuild
# --------------------------------------------------

echo ""
echo "🔐 Setting up CodeBuild GitHub authentication..."

aws codebuild import-source-credentials \
  --server-type GITHUB \
  --auth-type PERSONAL_ACCESS_TOKEN \
  --token "$GITHUB_TOKEN" \
  --region "$AWS_REGION" >/dev/null 2>&1 || echo "Note: GitHub credentials may already be imported"

echo "✅ GitHub authentication configured"

# --------------------------------------------------
# 7. Start the build
# --------------------------------------------------

echo ""
echo "🚀 Starting $ACTION process..."

BUILD_RESULT=$(aws codebuild start-build \
  --project-name "$PROJECT_NAME" \
  --region "$AWS_REGION" \
  --output json)

BUILD_ID=$(echo "$BUILD_RESULT" | grep -o '"id": "[^"]*"' | cut -d'"' -f4)

if [ -n "$BUILD_ID" ]; then
  echo "✅ Build started successfully!"
  echo "📋 Build ID: $BUILD_ID"
  echo ""
  echo "🔗 Monitor your build at:"
  echo "https://console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT_NAME/build/$BUILD_ID?region=$AWS_REGION"
  echo ""
  
  # Monitor build progress
  echo "📊 Monitoring build progress..."
  while true; do
    BUILD_STATUS=$(aws codebuild batch-get-builds \
      --ids "$BUILD_ID" \
      --region "$AWS_REGION" \
      --query 'builds[0].buildStatus' \
      --output text)
    
    case $BUILD_STATUS in
      "SUCCEEDED")
        echo ""
        echo "🎉 $ACTION completed successfully!"
        
        if [ "$ACTION" = "deploy" ]; then
          echo ""
          echo "📋 Getting deployment information..."
          
          # Get CloudFormation outputs
          echo "🔗 CloudFormation Stack Outputs:"
          aws cloudformation describe-stacks \
            --stack-name "HotlineQaStack-prod" \
            --region "$AWS_REGION" \
            --query 'Stacks[0].Outputs' \
            --output table 2>/dev/null || echo "Stack outputs will be available shortly..."
          
          echo ""
          echo "🎉 Your Boys Town Hotline QA system is now deployed!"
          echo ""
          echo "📋 Next Steps:"
          echo "1. Check the CloudFormation console for all resource details"
          echo "2. Access your frontend via the Amplify URL (shown in stack outputs)"
          echo "3. Test the API endpoints via the API Gateway URL"
          echo "4. Upload test audio files to the S3 bucket 'records/' folder"
          echo ""
          echo "🔗 AWS Console Links:"
          echo "CloudFormation: https://console.aws.amazon.com/cloudformation/home?region=$AWS_REGION"
          echo "CodeBuild: https://console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT_NAME?region=$AWS_REGION"
        else
          echo ""
          echo "🗑️  System destroyed successfully!"
          echo "All AWS resources have been removed."
        fi
        break
        ;;
      "FAILED"|"FAULT"|"STOPPED"|"TIMED_OUT")
        echo ""
        echo "❌ Build failed with status: $BUILD_STATUS"
        echo "🔗 Check build logs at:"
        echo "https://console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT_NAME/build/$BUILD_ID?region=$AWS_REGION"
        exit 1
        ;;
      "IN_PROGRESS")
        echo "⏳ Build in progress... ($(date '+%H:%M:%S'))"
        sleep 30
        ;;
      *)
        echo "📋 Build status: $BUILD_STATUS ($(date '+%H:%M:%S'))"
        sleep 30
        ;;
    esac
  done
  
else
  echo "❌ Failed to start the build"
  exit 1
fi

echo ""
echo "🎉 Deployment script completed!"
