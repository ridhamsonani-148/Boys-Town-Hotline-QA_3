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
   - Analyzes the transcript against Boys Town's QA rubric using AWS Bedrock (Amazon Nova Lite) and stores results in `results/llmOutput/`
   - Aggregates scores by category and calculates final scores, saving to `results/`
   - Updates counselor evaluation records in DynamoDB for tracking and analysis

## Counselor Tracking

The system automatically tracks counselor evaluations in a DynamoDB table. Each evaluation is linked to a counselor based on the audio filename pattern:

```
FirstName_LastName_UniqueIdentifier.wav
```

For example, `John_Smith_20230615.wav` would be associated with counselor "John Smith".

The DynamoDB table stores:
- Counselor ID and name
- Evaluation date and audio filename
- Category scores (Rapport Skills, Counseling Skills, etc.)
- Total score and percentage
- Criteria rating (Meets Criteria, Improvement Needed, Not at Criteria)
- Link to the full evaluation results in S3

You can query the DynamoDB table to:
- View all evaluations for a specific counselor
- Track performance trends over time
- Generate reports by counselor or evaluation criteria

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
- `results/llmOutput/`: Contains quality assessment results (automatically generated)
