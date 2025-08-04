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
  processingError?: string;
  processingWarning?: string;
}

// Helper function to recover truncated JSON
function recoverTruncatedJSON(jsonString: string): LLMOutput {
  console.log('Attempting to recover truncated JSON');
  
  // Find the last complete field before truncation
  const lines = jsonString.split('\n');
  let validJson = '';
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
      }
    }
    
    validJson += line + '\n';
    
    // If we have balanced braces, try to parse
    if (braceCount === 0 && validJson.trim().endsWith('}')) {
      try {
        return JSON.parse(validJson);
      } catch (e) {
        // Continue building
      }
    }
  }
  
  // If we couldn't balance braces, try to close the JSON properly
  if (braceCount > 0) {
    // Remove any incomplete field at the end
    const lastCommaIndex = validJson.lastIndexOf(',');
    if (lastCommaIndex > 0) {
      validJson = validJson.substring(0, lastCommaIndex);
    }
    
    // Add closing braces
    for (let i = 0; i < braceCount; i++) {
      validJson += '\n}';
    }
    
    try {
      return JSON.parse(validJson);
    } catch (e) {
      throw new Error(`Could not recover truncated JSON: ${e}`);
    }
  }
  
  throw new Error('Could not recover truncated JSON');
}

// Helper function to fix common JSON issues
function fixCommonJSONIssues(jsonString: string): string {
  console.log('Fixing common JSON issues');
  
  let fixed = jsonString;
  
  // Fix trailing commas
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix unescaped quotes in strings
  fixed = fixed.replace(/"([^"]*)"([^"]*)"([^"]*)":/g, '"$1\\"$2\\"$3":');
  
  // Fix missing quotes around property names
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_\s]*)\s*:/g, '$1"$2":');
  
  // Fix single quotes to double quotes
  fixed = fixed.replace(/'/g, '"');
  
  // Remove any trailing incomplete content after the last complete object
  const lastBraceIndex = fixed.lastIndexOf('}');
  if (lastBraceIndex > 0) {
    fixed = fixed.substring(0, lastBraceIndex + 1);
  }
  
  return fixed;
}

// Helper function to extract partial JSON data
function extractPartialJSON(jsonString: string): LLMOutput {
  console.log('Extracting partial JSON data');
  
  const result: LLMOutput = {};
  
  // Extract individual field patterns
  const fieldPatterns = [
    /"Tone"\s*:\s*\{[^}]*\}/g,
    /"Professional"\s*:\s*\{[^}]*\}/g,
    /"Conversational Style"\s*:\s*\{[^}]*\}/g,
    /"Supportive Initial Statement"\s*:\s*\{[^}]*\}/g,
    /"Affirmation and Praise"\s*:\s*\{[^}]*\}/g,
    /"Reflection of Feelings"\s*:\s*\{[^}]*\}/g,
    /"Explores Problem\(s\)"\s*:\s*\{[^}]*\}/g,
    /"Values the Person"\s*:\s*\{[^}]*\}/g,
    /"Non-Judgmental"\s*:\s*\{[^}]*\}/g,
    /"Clarifies Non-Suicidal Safety"\s*:\s*\{[^}]*\}/g,
    /"Suicide Safety Assessment-SSA Initiation and Completion"\s*:\s*\{[^}]*\}/g,
    /"Exploration of Buffers"\s*:\s*\{[^}]*\}/g,
    /"Restates then Collaborates Options"\s*:\s*\{[^}]*\}/g,
    /"Identifies a Concrete Plan of Safety and Well-being"\s*:\s*\{[^}]*\}/g,
    /"Appropriate Termination"\s*:\s*\{[^}]*\}/g,
    /"POP Model - does not rush"\s*:\s*\{[^}]*\}/g,
    /"POP Model - does not dwell"\s*:\s*\{[^}]*\}/g,
    /"Greeting"\s*:\s*\{[^}]*\}/g
  ];
  
  for (const pattern of fieldPatterns) {
    const matches = jsonString.match(pattern);
    if (matches) {
      for (const match of matches) {
        try {
          const fieldObj = JSON.parse(`{${match}}`);
          Object.assign(result, fieldObj);
        } catch (e) {
          console.log(`Could not parse field: ${match}`);
        }
      }
    }
  }
  
  if (Object.keys(result).length === 0) {
    throw new Error('Could not extract any valid fields');
  }
  
  return result;
}

// Helper function to create fallback structure with default scores
function createFallbackStructure(): LLMOutput {
  console.log('Creating fallback structure with default scores');
  
  const fallback: LLMOutput = {};
  
  // Create default entries for all expected fields
  const allCriteria = [
    ...CATEGORIES.RAPPORT_SKILLS,
    ...CATEGORIES.COUNSELING_SKILLS,
    ...CATEGORIES.ORGANIZATIONAL_SKILLS,
    ...CATEGORIES.TECHNICAL_SKILLS
  ];
  
  for (const criteria of allCriteria) {
    fallback[criteria] = {
      score: 0, // Default to 0 to indicate missing data
      label: "N/A",
      observation: "Unable to analyze due to malformed LLM output",
      evidence: "N/A"
    };
  }
  
  return fallback;
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
    
    let llmOutput: LLMOutput;
    let processingError: string | null = null;
    
    try {
      // First attempt to parse as-is
      const parsedBody = JSON.parse(body);
      
      // Case 1: Standard JSON format with expected fields
      if (Object.keys(parsedBody).includes('Tone') || 
          Object.keys(parsedBody).includes('Professional')) {
        console.log('Found standard JSON format with expected fields');
        llmOutput = parsedBody;
      }
      // Case 2: Wrapped in raw_analysis
      else if (parsedBody.raw_analysis) {
        console.log('Found raw_analysis wrapper, extracting JSON');
        let jsonString = parsedBody.raw_analysis;
        // Remove markdown code block markers if present
        jsonString = jsonString.replace(/```json\n/, '').replace(/```/g, '');
        
        try {
          llmOutput = JSON.parse(jsonString);
          console.log('Successfully parsed JSON from raw_analysis field');
        } catch (parseError) {
          console.log('Failed to parse raw_analysis directly, trying advanced recovery methods');
          
          // Method 1: Try to extract and fix truncated JSON
          try {
            llmOutput = recoverTruncatedJSON(jsonString);
            console.log('Successfully recovered truncated JSON');
          } catch (recoveryError) {
            console.log('Truncated JSON recovery failed, trying regex extraction');
            
            // Method 2: Try to extract JSON using regex if parsing fails
            const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                // Try to fix common JSON issues before parsing
                let cleanedJson = fixCommonJSONIssues(jsonMatch[0]);
                llmOutput = JSON.parse(cleanedJson);
                console.log('Successfully extracted and cleaned JSON using regex');
              } catch (e) {
                // Method 3: Try partial JSON extraction
                try {
                  llmOutput = extractPartialJSON(jsonString);
                  console.log('Successfully extracted partial JSON data');
                } catch (partialError) {
                  throw new Error(`All JSON recovery methods failed: ${e}`);
                }
              }
            } else {
              throw new Error(`No JSON pattern found in raw_analysis`);
            }
          }
        }
      }
      // Case 3: Other unexpected structure - try to find JSON anywhere in the response
      else {
        console.log('Unrecognized format, searching for JSON pattern');
        const stringBody = JSON.stringify(parsedBody);
        // Look for a pattern that likely contains our scoring JSON
        const jsonMatch = stringBody.match(/\{[\s\S]*"Tone"[\s\S]*"Professional"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            let cleanedJson = fixCommonJSONIssues(jsonMatch[0]);
            llmOutput = JSON.parse(cleanedJson);
            console.log('Found and parsed JSON pattern in unrecognized format');
          } catch (e) {
            throw new Error(`Found JSON-like pattern but failed to parse: ${e}`);
          }
        } else {
          throw new Error(`Unrecognized response format`);
        }
      }
    } catch (error: any) {
      console.error(`Error processing LLM output: ${error}`);
      processingError = `Error processing LLM output: ${error.message}`;
      
      // Final fallback: Create a minimal structure with default scores
      console.log('Creating fallback structure with default scores');
      llmOutput = createFallbackStructure();
    }
    
    // Normalize field names to handle variations
    const normalizedOutput: LLMOutput = {};
    const fieldMappings: {[key: string]: string} = {
      'Suicidal Safety Assessment': 'Suicide Safety Assessment-SSA Initiation and Completion',
      'Suicide Assessment': 'Suicide Safety Assessment-SSA Initiation and Completion',
      'SSA': 'Suicide Safety Assessment-SSA Initiation and Completion',
      'Suicidal Safety': 'Suicide Safety Assessment-SSA Initiation and Completion',
      'Buffers': 'Exploration of Buffers',
      'Protective Factors': 'Exploration of Buffers',
      'Exploration of Protective Factors': 'Exploration of Buffers',
      'Concrete Plan': 'Identifies a Concrete Plan of Safety and Well-being',
      'Safety Plan': 'Identifies a Concrete Plan of Safety and Well-being',
      'Identifies Concrete Plan': 'Identifies a Concrete Plan of Safety and Well-being',
      'Termination': 'Appropriate Termination',
      'Follow Up': 'Appropriate Termination',
      'POP Model - No Rush': 'POP Model - does not rush',
      'POP Model - No Dwell': 'POP Model - does not dwell',
      'Conversational': 'Conversational Style',
      'Initial Statement': 'Supportive Initial Statement',
      'Supportive Statement': 'Supportive Initial Statement',
      'Affirmation': 'Affirmation and Praise',
      'Reflection': 'Reflection of Feelings',
      'Explores Problems': 'Explores Problem(s)',
      'Values Person': 'Values the Person',
      'Non Judgmental': 'Non-Judgmental',
      'Non-judgmental': 'Non-Judgmental',
      'Clarifies Safety': 'Clarifies Non-Suicidal Safety',
      'Collaborates Options': 'Restates then Collaborates Options',
      'Restates Options': 'Restates then Collaborates Options'
    };
    
    // Copy fields with normalization
    for (const [key, value] of Object.entries(llmOutput)) {
      const normalizedKey = fieldMappings[key] || key;
      normalizedOutput[normalizedKey] = value;
    }
    
    // Aggregate scores by category
    const aggregatedScores = aggregateScores(normalizedOutput);
    
    // Add processing error information if any
    if (processingError) {
      aggregatedScores.processingError = processingError;
      console.error(`Processing error: ${processingError}`);
    }
    
    // Check if all criteria fields are empty and fail the execution if so
    let hasAnyCriteria = false;
    let hasAnyNonZeroScores = false;
    
    for (const categoryKey in aggregatedScores.categories) {
      if (Object.keys(aggregatedScores.categories[categoryKey].criteria).length > 0) {
        hasAnyCriteria = true;
        
        // Check if we have any non-zero scores (indicating real data vs fallback)
        for (const criteriaKey in aggregatedScores.categories[categoryKey].criteria) {
          const criteria = aggregatedScores.categories[categoryKey].criteria[criteriaKey];
          if (criteria.score > 0) {
            hasAnyNonZeroScores = true;
            break;
          }
        }
      }
      if (hasAnyNonZeroScores) break;
    }
    
    if (!hasAnyCriteria) {
      const errorMessage = "CRITICAL ERROR: Failed to extract any criteria from LLM output. All criteria fields are empty.";
      console.error(errorMessage);
      
      // Throw an error to fail the Step Function execution
      throw new Error(errorMessage);
    }
    
    // If we only have fallback data (all zeros), add a warning but don't fail
    if (!hasAnyNonZeroScores && processingError) {
      console.warn("WARNING: Using fallback structure due to malformed LLM output. All scores are set to 0.");
      aggregatedScores.processingWarning = "Analysis completed using fallback structure due to malformed LLM output. Manual review recommended.";
    }
    
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
  
  // Determine criteria based on actual score out of 92
  // Calculate thresholds: 80% and 70% of total possible score
  const meetsThreshold = result.totalPossibleScore * 0.80; // 73.6 out of 92
  const improvementThreshold = result.totalPossibleScore * 0.70; // 64.4 out of 92
  
  if (result.totalMultipliedScore >= meetsThreshold) {
    result.criteria = "Meets Criteria";
  } else if (result.totalMultipliedScore >= improvementThreshold) {
    result.criteria = "Improvement Needed";
  } else {
    result.criteria = "Not at Criteria";
  }
  
  return result;
}
