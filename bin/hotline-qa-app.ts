#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HotlineQaStack } from '../lib/hotline-qa-stack';

const app = new cdk.App();

// Get environment variables or use defaults
const envName = app.node.tryGetContext('envName') || 'dev';
const bucketNamePrefix = app.node.tryGetContext('bucketNamePrefix');
const deployFrontend = app.node.tryGetContext('deployFrontend') !== 'false'; // Deploy by default
const githubOwner = app.node.tryGetContext('githubOwner') || 'ASUCICREPO';
const githubRepo = app.node.tryGetContext('githubRepo') || 'Boys-Town-Hotline-QA';
const githubTokenSecretName = app.node.tryGetContext('githubTokenSecretName') || 'github-token';

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
