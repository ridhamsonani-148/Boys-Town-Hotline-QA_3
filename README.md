# Boys Town Hotline QA Analysis Pipeline

This project implements an automated quality assessment system for Boys Town's National Hotline call recordings using AWS services and AI.

## Architecture

The solution uses:
- S3 for storage of recordings, transcripts, and analysis results
- AWS Transcribe Call Analytics for speech-to-text conversion with advanced features
- AWS Bedrock (Amazon Nova Lite) for call quality assessment
- Step Functions for workflow orchestration
- Lambda for processing

## Features

### Transcribe Call Analytics
- Automatic speaker separation (agent vs customer)
- Call summarization
- Sentiment analysis
- Issue detection
- PII redaction
- IVR/prompt detection

### Quality Assessment
- Automated evaluation against Boys Town's QA rubric
- Actionable insights for counselor training
- Consistent scoring across all calls

## Workflow

1. Upload call recordings to the `records/` folder in the S3 bucket
2. The system automatically:
   - Transcribes the audio using Call Analytics and saves to `transcripts/analytics/`
   - Formats the transcript to extract just the summary and conversation, saving to `transcripts/formatted/`
   - Analyzes the transcript against Boys Town's QA rubric using AWS Bedrock (Amazon Nova Lite) and stores results in `results/`

## Deployment Instructions

### Prerequisites

- Node.js (v14.x or later)
- AWS CDK (v2.x)
- AWS CLI configured with appropriate credentials

### Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Bootstrap your AWS environment (if not already done):
   ```
   cdk bootstrap
   ```

3. Deploy the stack:
   ```
   cdk deploy
   ```

### Deployment Parameters

You can customize the deployment with the following parameters:

- `envName`: Environment name (dev, test, prod)
- `bucketNamePrefix`: Custom prefix for the S3 bucket name

Example:
```
cdk deploy --context envName=prod --context bucketNamePrefix=my-company-hotline-qa
```

## Folder Structure

- `records/`: Upload call recordings here (.mp3 or .wav format)
- `transcripts/analytics/`: Contains full transcription outputs (automatically generated)
- `transcripts/formatted/`: Contains simplified transcription outputs (automatically generated)
- `results/`: Contains quality assessment results (automatically generated)
