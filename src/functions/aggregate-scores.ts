import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand 
} from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const { BUCKET_NAME } = process.env;

if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

// Define the categories and their criteria
const CATEGORIES = {
  RAPPORT_SKILLS: [
    'Tone',
    'Professional',
    'Conversational Style',
    'Supportive Initial Statement',
    'Affirmation and Praise',
    'Reflection of Feelings',
    'Explores Problem(s)',
    'Values the Person',
    'Non-Judgmental'
  ],
  COUNSELING_SKILLS: [
    'Clarifies Non-Suicidal Safety',
    'Suicide Safety Assessment-SSA Initiation and Completion',
    'Exploration of Buffers',
    'Restates then Collaborates Options',
    'Identifies a Concrete Plan of Safety and Well-being',
    'Appropriate Termination'
  ],
  ORGANIZATIONAL_SKILLS: [
    'POP Model - does not rush',
    'POP Model - does not dwell'
  ],
  TECHNICAL_SKILLS: [
    'Greeting'
  ]
};

// Multiplication factor for each category
const MULTIPLICATION_FACTOR = 4;

// Input from Step Functions
interface StepFunctionsEvent {
  bucket: string;
  formattedKey: string;
  resultKey: string;
  status: string;
  aggregatedKey?: string;
}

interface ScoreItem {
  score: number;
  label: string;
  observation: string;
  evidence: string;
}

interface LLMOutput {
  [key: string]: ScoreItem;
}

interface CategoryScore {
  rawScore: number;
  multipliedScore: number;
  criteria: {
    [key: string]: ScoreItem;
  };
}

interface AggregatedScores {
  categories: {
    [key: string]: CategoryScore;
  };
  totalRawScore: number;
  totalMultipliedScore: number;
  totalPossibleScore: number;
  percentageScore: number;
  criteria: string;
}

export const handler = async (event: StepFunctionsEvent): Promise<StepFunctionsEvent> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  const { bucket, resultKey } = event;
  
  try {
    // Get the LLM output from S3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: resultKey
    });
    
    const response = await s3Client.send(getCommand);
    const body = await response.Body?.transformToString();
    
    if (!body) {
      throw new Error(`Empty response body for ${resultKey}`);
    }
    
    // Parse the LLM output
    const llmOutput: LLMOutput = JSON.parse(body);
    
    // Aggregate scores by category
    const aggregatedScores = aggregateScores(llmOutput);
    
    // Create the aggregated result key in the results folder
    const aggregatedKey = resultKey.replace('llmOutput/', '').replace('analysis_', 'aggregated_');
    
    // Save the aggregated scores to S3
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: aggregatedKey,
      Body: JSON.stringify(aggregatedScores, null, 2),
      ContentType: 'application/json'
    });
    
    await s3Client.send(putCommand);
    console.log(`Successfully aggregated scores and saved to ${aggregatedKey}`);
    
    // Return the updated event with the aggregated key
    return {
      ...event,
      aggregatedKey
    };
  } catch (error) {
    console.error(`Error aggregating scores for ${resultKey}:`, error);
    throw error;
  }
};

function aggregateScores(llmOutput: LLMOutput): AggregatedScores {
  const result: AggregatedScores = {
    categories: {},
    totalRawScore: 0,
    totalMultipliedScore: 0,
    totalPossibleScore: 92, // Total possible score is 92
    percentageScore: 0,
    criteria: ""
  };
  
  // Process each category
  for (const [categoryName, criteriaList] of Object.entries(CATEGORIES)) {
    const categoryKey = categoryName.replace(/_/g, ' ');
    
    // Initialize category score
    result.categories[categoryKey] = {
      rawScore: 0,
      multipliedScore: 0,
      criteria: {}
    };
    
    // Sum up scores for each criterion in the category
    for (const criterion of criteriaList) {
      if (llmOutput[criterion]) {
        // Add the criterion to the category
        result.categories[categoryKey].criteria[criterion] = llmOutput[criterion];
        
        // Add the score to the category raw score
        result.categories[categoryKey].rawScore += llmOutput[criterion].score;
      }
    }
    
    // Calculate multiplied score for the category
    result.categories[categoryKey].multipliedScore = 
      result.categories[categoryKey].rawScore * MULTIPLICATION_FACTOR;
    
    // Add to totals
    result.totalRawScore += result.categories[categoryKey].rawScore;
    result.totalMultipliedScore += result.categories[categoryKey].multipliedScore;
  }
  
  // Calculate percentage score
  result.percentageScore = (result.totalMultipliedScore / result.totalPossibleScore) * 100;
  
  // Determine criteria based on percentage score
  if (result.percentageScore >= 80) {
    result.criteria = "Meets Criteria";
  } else if (result.percentageScore >= 70 && result.percentageScore <= 79) {
    result.criteria = "Improvement Needed";
  } else {
    result.criteria = "Not at Criteria";
  }
  
  return result;
}
