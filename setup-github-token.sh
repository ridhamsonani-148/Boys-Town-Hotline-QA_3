#!/bin/bash

# Setup script for GitHub token in AWS Secrets Manager
# This is required for Amplify to access your GitHub repository

set -e

SECRET_NAME="github-token"
GITHUB_TOKEN=""

echo "🔐 GitHub Token Setup for Amplify Deployment"
echo "============================================="
echo ""
echo "This script will help you store your GitHub personal access token in AWS Secrets Manager."
echo "This token is required for Amplify to access your GitHub repository and deploy the frontend."
echo ""

# Check if AWS CLI is configured
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "❌ AWS CLI is not configured or credentials are invalid"
    echo "Please run 'aws configure' or set up your AWS credentials first"
    exit 1
fi

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --token)
      GITHUB_TOKEN="$2"
      shift 2
      ;;
    --secret-name)
      SECRET_NAME="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --token TOKEN         GitHub personal access token"
      echo "  --secret-name NAME    AWS Secrets Manager secret name (default: github-token)"
      echo "  --help               Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                                    # Interactive mode"
      echo "  $0 --token ghp_xxxxxxxxxxxx          # Non-interactive mode"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

# Get GitHub token if not provided
if [ -z "$GITHUB_TOKEN" ]; then
    echo "📝 Instructions for creating a GitHub Personal Access Token:"
    echo "1. Go to https://github.com/settings/tokens"
    echo "2. Click 'Generate new token' → 'Generate new token (classic)'"
    echo "3. Give it a name like 'Amplify Deployment'"
    echo "4. Select the 'repo' scope (full control of private repositories)"
    echo "5. Click 'Generate token' and copy the token"
    echo ""
    echo -n "Please enter your GitHub personal access token: "
    read -s GITHUB_TOKEN
    echo ""
fi

if [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ GitHub token is required"
    exit 1
fi

# Check if secret already exists
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" > /dev/null 2>&1; then
    echo "⚠️  Secret '$SECRET_NAME' already exists"
    echo -n "Do you want to update it? (y/N): "
    read -r CONFIRM
    if [[ $CONFIRM =~ ^[Yy]$ ]]; then
        echo "🔄 Updating existing secret..."
        aws secretsmanager update-secret \
            --secret-id "$SECRET_NAME" \
            --secret-string "$GITHUB_TOKEN" \
            --description "GitHub personal access token for Amplify deployment"
        echo "✅ Secret updated successfully!"
    else
        echo "ℹ️  Using existing secret"
    fi
else
    echo "🔐 Creating new secret in AWS Secrets Manager..."
    aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --description "GitHub personal access token for Amplify deployment" \
        --secret-string "$GITHUB_TOKEN"
    echo "✅ Secret created successfully!"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "You can now deploy the full stack with frontend:"
echo "  ./deploy.sh"
echo ""
echo "Or deploy with custom settings:"
echo "  ./deploy.sh --env prod --github-owner your-org --github-repo your-repo"
echo ""
echo "To deploy backend only (skip frontend):"
echo "  ./deploy.sh --backend-only"
