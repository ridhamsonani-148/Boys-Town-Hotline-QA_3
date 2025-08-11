# Boys Town Hotline QA Analysis Pipeline

A comprehensive, enterprise-grade automated quality assessment system for Boys Town's National Hotline call recordings. This solution leverages AWS serverless architecture and advanced AI services to provide consistent, scalable, and actionable quality evaluations for counselor training and performance improvement.

## Architecture Overview

![Boys Town Hotline QA Architecture](docs/images/Architecture.png)

### Core AWS Services
- **Amazon S3**: Secure storage for recordings, transcripts, and analysis results
- **AWS Transcribe Call Analytics**: Advanced speech-to-text with speaker separation and call insights
- **Amazon Bedrock (Nova Pro)**: AI-powered quality assessment against Boys Town's QA rubric
- **AWS Step Functions**: Orchestrates the complete processing workflow
- **AWS Lambda**: 13 specialized functions handling different processing stages
- **Amazon DynamoDB**: Stores counselor evaluations and profile data with indexing
- **Amazon API Gateway**: RESTful API for frontend integration
- **AWS Amplify**: Hosts React frontend with automated CI/CD
- **AWS CodeBuild**: Production deployment automation

### System Architecture
```
Audio Upload (S3) → Step Functions Workflow → Transcribe → Format → AI Analysis → Score Aggregation → DynamoDB Storage → Frontend Display
```

## Key Features

### Automated Quality Assessment
- **AI-Powered Analysis**: Uses Amazon Nova Pro for consistent evaluation against Boys Town's specific QA rubric
- **Multi-Category Scoring**: Evaluates Rapport Skills, Counseling Skills, Crisis Intervention, and more
- **Actionable Insights**: Provides specific feedback for counselor training and improvement
- **Consistent Standards**: Eliminates human bias and ensures uniform evaluation criteria

### Comprehensive Counselor Management
- **Individual Tracking**: Links evaluations to counselors via filename pattern (`FirstName_LastName_ID.wav`)
- **Performance Trends**: Historical analysis of counselor performance over time
- **Program-Based Organization**: Groups counselors by program type for targeted analysis
- **Profile Management**: Complete CRUD operations for counselor data and assignments

### Intelligent Workflow Orchestration
- **Event-Driven Processing**: Automatic workflow initiation on file upload
- **Status Monitoring**: Real-time tracking of processing stages
- **Error Handling**: Robust retry logic and failure notifications
- **Scalable Processing**: Handles multiple concurrent evaluations

### Modern Web Interface
- **React Frontend**: Intuitive interface for uploading files and viewing results
- **Real-Time Updates**: Live status tracking of processing workflows
- **Data Visualization**: Charts and graphs for performance analysis
- **Responsive Design**: Works seamlessly across desktop and mobile devices

## Data Organization

### S3 Bucket Structure
```
your-bucket-name/
├── records/                    # Upload audio files here (.wav format)
├── transcripts/
│   ├── analytics/             # Full Transcribe Call Analytics output
│   └── formatted/             # Simplified transcript format
└── results/
    ├── llmOutput/             # Raw AI analysis results
    └── aggregated/            # Final scores and evaluations
```

### Database Schema

#### Counselor Evaluations Table
- **Primary Key**: CounselorId (Partition) + EvaluationId (Sort)
- **Global Secondary Index**: EvaluationDateIndex for time-based queries
- **Attributes**: Scores, percentages, criteria ratings, S3 result links

#### Counselor Profiles Table
- **Primary Key**: CounselorId
- **Global Secondary Index**: ProgramTypeIndex for program-based queries
- **Attributes**: Personal info, program assignments, contact details

## Production Deployment

### Prerequisites

#### Required Software

**Node.js (v18.x or later)**
- **macOS**: `brew install node` or download from [nodejs.org](https://nodejs.org/)
- **Windows**: Download installer from [nodejs.org](https://nodejs.org/) or use `winget install OpenJS.NodeJS`

**AWS CLI (v2.x)**
- **macOS**: `brew install awscli` or download from [AWS CLI Install Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **Windows**: Download MSI installer from [AWS CLI Install Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

**AWS CDK (v2.87.0)**
```bash
npm install -g aws-cdk@2.87.0
```

**Git**
- **macOS**: `brew install git` or use Xcode Command Line Tools
- **Windows**: Download from [git-scm.com](https://git-scm.com/download/win)

#### AWS Account Setup

1. **Configure AWS CLI**:
   ```bash
   aws configure
   ```
   Provide your AWS Access Key ID, Secret Access Key, default region, and output format.

2. **Verify Configuration**:
   ```bash
   aws sts get-caller-identity
   ```

3. **Required AWS Permissions**:
   Your AWS user/role needs permissions for:
   - CloudFormation (full access)
   - IAM (full access)
   - S3, Lambda, API Gateway, DynamoDB, Step Functions
   - Transcribe, Bedrock, Amplify, CodeBuild
   - Secrets Manager (for GitHub token)

### Production Deployment Process

#### Step 1: Repository Setup

1. **Fork the Repository**:
   Fork this repository to your GitHub account or organization.

2. **Clone Your Fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Boys-Town-Hotline-QA.git
   cd Boys-Town-Hotline-QA
   ```

3. **Install Dependencies**:
   ```bash
   npm install
   ```

#### Step 2: GitHub Token Configuration

1. **Create GitHub Personal Access Token**:
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate new token with `repo` and `admin:repo_hook`, `project`, `workflow permissions`
   - Copy the token (starts with `ghp_`)

#### Step 3: Production Deployment

Run the automated production deployment script:

```bash
./deploy-production-codebuild.sh \
  --company-name "your-company-name" \
  --github-owner "your-github-username" \
  --github-repo "your-repo-name" \
  --github-token "your-github-token" \
  --region "us-east-1"
```

**Parameters Explained**:
- `--company-name`: Used for unique resource naming (e.g., "acme-healthcare")
- `--github-owner`: Your GitHub username or organization
- `--github-repo`: Name of your forked repository
- `--github-token`: GitHub personal access token
- `--region`: AWS region for deployment (optional, defaults to us-east-1)

#### Step 4: Deployment Process

The script will:
1. Validate AWS credentials and GitHub token
2. Store GitHub token in AWS Secrets Manager
3. Build the TypeScript project
4. Create CodeBuild project for automated deployments
5. Deploy the complete production system (10-15 minutes)
6. Display deployment results and important URLs

#### Step 5: Post-Deployment

After successful deployment, you'll receive:

- **Frontend URL**: `https://main.{app-id}.amplifyapp.com`
- **API Gateway URL**: For backend API access
- **S3 Bucket Name**: For file uploads
- **Management Console URLs**: For monitoring and administration

## Development Deployment

For development and testing purposes, you can use the local deployment script:

```bash
# Basic development deployment
./deploy.sh

# Custom environment
./deploy.sh --env staging --bucket-prefix my-company-qa

# Backend only (no frontend)
./deploy.sh --backend-only
```

## API Reference

### Authentication
All API endpoints are publicly accessible. In production, consider adding authentication via API Gateway authorizers.

### Endpoints

#### File Management
- `POST /generate-url` - Generate S3 presigned URLs for file uploads
- `GET /get-results?fileName={name}` - Get analysis results by filename
- `GET /execution-status?fileName={name}` - Check processing status

#### Analysis Results
- `GET /analysis/{fileId}` - Get specific analysis results
- `GET /get-data` - Get all counselor evaluation data

#### Counselor Management
- `GET /profiles` - List all counselor profiles
- `POST /profiles` - Create new counselor profile
- `GET /profiles/{counselorId}` - Get specific counselor profile
- `PUT /profiles/{counselorId}` - Update counselor profile
- `DELETE /profiles/{counselorId}` - Delete counselor profile

## Monitoring and Observability

### CloudWatch Integration
- **Lambda Metrics**: Function duration, error rates, and invocation counts
- **Step Functions**: Workflow execution tracking and failure analysis
- **API Gateway**: Request/response logging and performance metrics
- **Custom Dashboards**: Real-time system health monitoring

## Troubleshooting

### Common Issues

**Deployment Failures**:
- Verify AWS CLI configuration: `aws sts get-caller-identity`
- Check IAM permissions for CloudFormation and service creation
- Ensure GitHub token has correct permissions

**Processing Failures**:
- Check Step Functions execution logs in AWS Console
- Verify audio file format (.wav) and location (records/ folder)
- Monitor Lambda function logs in CloudWatch

**Frontend Issues**:
- Verify Amplify build logs in AWS Console
- Check environment variables in Amplify app settings
- Ensure API Gateway CORS configuration

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push to branch: `git push origin feature/new-feature`
5. Submit a Pull Request

## Support

For technical support or questions:
- Create an issue in the GitHub repository
- Check the troubleshooting section above
- Review AWS CloudWatch logs for detailed error information

---