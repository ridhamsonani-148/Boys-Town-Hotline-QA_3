# Boys Town Frontend

## Environment Configuration

The application uses environment variables for configuration. These are stored in a `.env` file in the root directory.

### Setup Instructions

1. Create a `.env` file in the frontend directory if it doesn't exist
2. Add the following variables with your actual values:

```
# AWS API Gateway Configuration
REACT_APP_API_URL=https://your-api-id.execute-api.your-region.amazonaws.com/stage

# AWS Configuration
REACT_APP_AWS_REGION=us-east-1

# File Upload Settings
REACT_APP_MAX_FILE_SIZE=10485760  # 10MB in bytes
REACT_APP_ALLOWED_FILE_TYPES=pdf,docx,xlsx,csv
```

3. Restart your development server to apply the changes

### Important Notes

- Never commit the `.env` file to version control
- Make sure to add `.env` to your `.gitignore` file
- For production deployment, set these environment variables in your hosting environment