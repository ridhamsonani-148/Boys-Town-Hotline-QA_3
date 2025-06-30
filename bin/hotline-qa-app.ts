#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HotlineQaStack } from '../lib/hotline-qa-stack';

const app = new cdk.App();

// Get environment variables or use defaults
const envName = app.node.tryGetContext('envName') || 'dev';
const bucketNamePrefix = app.node.tryGetContext('bucketNamePrefix');

// Create the stack with focused parameterized properties
new HotlineQaStack(app, `HotlineQaStack-${envName}`, {
  envName,
  bucketNamePrefix,
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  description: 'Boys Town Hotline QA Analysis Pipeline',
});
