#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HotlineQaStack } from '../lib/hotline-qa-stack';

const app = new cdk.App();

// Get environment variables - NO DEFAULTS for GitHub parameters
const envName = app.node.tryGetContext('envName') || 'dev';
const bucketNamePrefix = app.node.tryGetContext('bucketNamePrefix');
const deployFrontend = app.node.tryGetContext('deployFrontend') !== 'false'; // Deploy by default
const githubOwner = app.node.tryGetContext('githubOwner');
const githubRepo = app.node.tryGetContext('githubRepo');
const githubTokenSecretName = app.node.tryGetContext('githubTokenSecretName');

// Validate GitHub parameters if frontend deployment is enabled
if (deployFrontend && (!githubOwner || !githubRepo || !githubTokenSecretName)) {
  throw new Error('GitHub parameters (githubOwner, githubRepo, githubTokenSecretName) are required when deployFrontend is true');
}

// Create the complete stack with both backend and optional frontend
new HotlineQaStack(app, `HotlineQaStack-${envName}`, {
  envName,
  bucketNamePrefix,
  deployFrontend,
  githubOwner,
  githubRepo,
  githubTokenSecretName,
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  description: `Boys Town Hotline QA Analysis Pipeline - Complete Stack (${envName})`,
});
