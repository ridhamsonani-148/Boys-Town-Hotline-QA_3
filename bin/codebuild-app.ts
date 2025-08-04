#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CodeBuildDeploymentStack } from '../lib/codebuild-deployment-stack';

const app = new cdk.App();

// Get environment variables - GitHub parameters are REQUIRED
const envName = app.node.tryGetContext('envName') || 'dev';
const githubOwner = app.node.tryGetContext('githubOwner');
const githubRepo = app.node.tryGetContext('githubRepo');
const githubTokenSecretName = app.node.tryGetContext('githubTokenSecretName');

// Validate required parameters
if (!githubOwner || !githubRepo || !githubTokenSecretName) {
  throw new Error('Required context parameters missing: githubOwner, githubRepo, and githubTokenSecretName must be provided');
}

// Create the CodeBuild deployment stack
new CodeBuildDeploymentStack(app, `CodeBuildDeploymentStack-${envName}`, {
  envName,
  githubOwner,
  githubRepo,
  githubTokenSecretName,
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  description: `CodeBuild project for automated Boys Town Hotline QA deployment (${envName})`,
});
