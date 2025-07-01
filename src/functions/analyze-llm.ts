import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand 
} from '@aws-sdk/client-s3';
import { 
  BedrockRuntimeClient, 
  ConverseCommand,
  ConversationRole,
  ContentBlock,
  SystemContentBlock
} from '@aws-sdk/client-bedrock-runtime';

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});
const { BUCKET_NAME } = process.env;

if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

// Model ID for Amazon Nova Lite
const MODEL_ID = 'amazon.nova-lite-v1:0';

// Input from Step Functions or S3 event
interface AnalyzeEvent {
  bucket?: string;
  formattedKey?: string;
  // For S3 events
  Records?: Array<{
    s3: {
      bucket: {
        name: string;
      };
      object: {
        key: string;
      };
    };
  }>;
}

interface FormattedTranscript {
  summary: string;
  transcript: Array<{
    speaker: string;
    text: string;
  }>;
}

export const handler = async (event: AnalyzeEvent): Promise<any> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  // Determine bucket and key from either Step Functions input or S3 event
  let bucket = event.bucket || '';
  let formattedKey = event.formattedKey || '';
  
  // If this is an S3 event, extract bucket and key
  if (event.Records && event.Records.length > 0) {
    const record = event.Records[0];
    bucket = record.s3.bucket.name;
    formattedKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  }
  
  // Use environment variable if bucket is not provided
  if (!bucket) {
    bucket = BUCKET_NAME;
  }
  
  if (!formattedKey) {
    throw new Error('No formatted transcript key provided');
  }
  
  try {
    // Get the formatted transcript from S3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: formattedKey
    });
    
    const response = await s3Client.send(getCommand);
    const body = await response.Body?.transformToString();
    
    if (!body) {
      throw new Error(`Empty response body for ${formattedKey}`);
    }
    
    // Parse the formatted transcript
    const formattedTranscript: FormattedTranscript = JSON.parse(body);
    
    // Create the result key in the results folder
    const resultKey = formattedKey.replace('formatted/', 'results/').replace('formatted_', 'analysis_');
    
    // Analyze the transcript using Bedrock
    const analysisResult = await analyzeTranscript(formattedTranscript);
    
    // Save the analysis result to S3
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: resultKey,
      Body: JSON.stringify(analysisResult, null, 2),
      ContentType: 'application/json'
    });
    
    await s3Client.send(putCommand);
    console.log(`Successfully analyzed transcript and saved results to ${resultKey}`);
    
    // Return the result for Step Functions
    return {
      bucket,
      formattedKey,
      resultKey,
      status: 'SUCCESS'
    };
  } catch (error) {
    console.error(`Error analyzing transcript ${formattedKey}:`, error);
    throw error;
  }
};

async function analyzeTranscript(formattedTranscript: FormattedTranscript): Promise<any> {
  // Prepare the transcript for the LLM
  const transcriptText = formattedTranscript.transcript
    .map(item => `${item.speaker}: ${item.text}`)
    .join('\n\n');
  
  // Create the system message
  const systemMessage = `You are an expert quality assurance analyst for Boys Town's National Hotline. 
Your task is to evaluate call transcripts between counselors and callers according to Boys Town's QA rubric.

Analyze the transcript carefully and provide a comprehensive assessment covering these key areas:

1. GREETING AND INTRODUCTION (10 points)
   - Proper greeting and introduction
   - Clear explanation of services
   - Appropriate tone and professionalism

2. RAPPORT BUILDING (15 points)
   - Active listening techniques
   - Empathy and understanding
   - Creating a safe, non-judgmental space

3. PROBLEM IDENTIFICATION (20 points)
   - Effective questioning techniques
   - Clarifying the caller's concerns
   - Identifying underlying issues

4. SOLUTION DEVELOPMENT (20 points)
   - Collaborative approach to solutions
   - Appropriate resources provided
   - Realistic and actionable steps

5. CRISIS ASSESSMENT (15 points)
   - Safety assessment when appropriate
   - Recognition of crisis indicators
   - Appropriate escalation procedures

6. CALL CLOSURE (10 points)
   - Proper summarization
   - Clear next steps
   - Professional closing

7. OVERALL EFFECTIVENESS (10 points)
   - Overall call management
   - Adherence to protocols
   - Professionalism throughout

For each area, provide:
1. A score (out of the maximum points for that section)
2. Specific examples from the transcript supporting your assessment
3. Constructive feedback for improvement

Then provide an overall score (out of 100) and summary assessment.

Format your response as a structured JSON object with these sections clearly labeled.`;

  // Create the user message with the transcript
  const userMessage = `Here is the call transcript to evaluate. The transcript includes a summary followed by the conversation between the AGENT (counselor) and CUSTOMER (caller).

SUMMARY:
${formattedTranscript.summary}

TRANSCRIPT:
${transcriptText}

Please analyze this transcript according to Boys Town's QA rubric and provide a detailed assessment.`;

  try {
    // Use the Conversational API with the correct structure
    // Move system prompt to top-level system field, not in messages array
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      
      // Top-level system prompt as an array of SystemContentBlock
      system: [{ text: systemMessage }] as SystemContentBlock[],
      
      // Only user role in messages array
      messages: [
        { 
          role: 'user' as ConversationRole, 
          content: [{ text: userMessage }] as ContentBlock[]
        }
      ],
      
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.2,
        topP: 0.9
      }
    });
    
    const response = await bedrockClient.send(command);
    
    // Extract the content from the response
    // Bedrock returns the chat response under response.output?.message?.content
    let content = '';
    if (response.output?.message?.content && response.output.message.content.length > 0) {
      content = response.output.message.content[0].text || '';
    }
    
    // Try to parse the content as JSON if it's in JSON format
    try {
      return JSON.parse(content);
    } catch (e) {
      // If parsing fails, return the raw content
      return { 
        raw_analysis: content,
        summary: formattedTranscript.summary
      };
    }
  } catch (error) {
    console.error('Error calling Bedrock:', error);
    throw new Error(`Failed to analyze transcript: ${error}`);
  }
}
