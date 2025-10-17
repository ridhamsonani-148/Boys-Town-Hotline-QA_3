import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConversationRole,
  ContentBlock,
  SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION});
const { BUCKET_NAME } = process.env;

if (!BUCKET_NAME) {
  throw new Error("Required environment variable BUCKET_NAME must be set");
}

// Model IDs for Amazon Nova Pro - try foundation model first, then inference profile
const MODEL_IDS = [
  "amazon.nova-pro-v1:0", // Foundation model (works in us-east-1)
  "us.amazon.nova-pro-v1:0" // Inference profile (works in us-west-2 and other regions)
];

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
    beginTime: string;
    endTime: string;
  }>;
}

// Validation functions for formatted transcript
function validateFormattedTranscript(data: any): FormattedTranscript {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid formatted transcript structure");
  }

  // Validate summary
  if (typeof data.summary !== "string") {
    throw new Error("Summary must be a string");
  }

  // Check for malicious content in summary
  const hasMaliciousSummary =
    /<script[^>]*>/gi.test(data.summary) ||
    /<iframe[^>]*>/gi.test(data.summary) ||
    /javascript:/gi.test(data.summary) ||
    /on\w+\s*=/gi.test(data.summary);

  if (hasMaliciousSummary) {
    console.error("SECURITY ALERT: Malicious content detected in summary");
    throw new Error(
      "Malicious content detected in summary - possible tampering"
    );
  }

  if (data.summary.length > 5000) {
    throw new Error("Summary exceeds maximum length of 5000 characters");
  }

  // Validate transcript array
  if (!Array.isArray(data.transcript)) {
    throw new Error("Transcript must be an array");
  }
  if (data.transcript.length === 0) {
    throw new Error("Transcript array is empty");
  }
  if (data.transcript.length > 10000) {
    throw new Error("Transcript array too large");
  }

  // Validate each transcript entry
  const validatedTranscript = data.transcript.map(
    (item: any, index: number) => {
      if (!item || typeof item !== "object") {
        throw new Error(`Invalid transcript item at index ${index}`);
      }

      // Validate speaker
      if (typeof item.speaker !== "string") {
        throw new Error(`Invalid speaker at index ${index}`);
      }
      const sanitizedSpeaker = item.speaker
        .slice(0, 20)
        .replace(/[^A-Z_]/g, "");

      // Validate text
      if (typeof item.text !== "string") {
        throw new Error(`Invalid text at index ${index}`);
      }

      // Check for malicious content patterns
      const hasMaliciousText =
        /<script[^>]*>/gi.test(item.text) ||
        /<iframe[^>]*>/gi.test(item.text) ||
        /javascript:/gi.test(item.text) ||
        /on\w+\s*=/gi.test(item.text);

      if (hasMaliciousText) {
        console.error(
          "SECURITY ALERT: Malicious content detected in transcript",
          {
            index,
            speaker: item.speaker,
            textPreview: item.text.slice(0, 100),
          }
        );
        throw new Error(
          `Malicious content detected at transcript index ${index} - possible tampering`
        );
      }

      if (item.text.length > 10000) {
        throw new Error(
          `Text at index ${index} exceeds maximum length of 10000 characters`
        );
      }

      // Validate timestamps (format: MM:SS.mmm)
      const timeRegex = /^\d{2}:\d{2}\.\d{3}$/;
      if (
        typeof item.beginTime !== "string" ||
        !timeRegex.test(item.beginTime)
      ) {
        throw new Error(`Invalid beginTime format at index ${index}`);
      }
      if (typeof item.endTime !== "string" || !timeRegex.test(item.endTime)) {
        throw new Error(`Invalid endTime format at index ${index}`);
      }

      // If we reach here, all validation passed - return validated data as-is
      return {
        speaker: sanitizedSpeaker,
        text: item.text, // Validated (not sanitized) - passed all checks above
        beginTime: item.beginTime,
        endTime: item.endTime,
      };
    }
  );

  // All validation passed - return validated data
  return {
    summary: data.summary, // Validated (not sanitized) - passed all checks above
    transcript: validatedTranscript,
  };
}

export const handler = async (event: AnalyzeEvent): Promise<any> => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Determine bucket and key from either Step Functions input or S3 event
  let bucket = event.bucket || "";
  let formattedKey = event.formattedKey || "";

  // If this is an S3 event, extract bucket and key
  if (event.Records && event.Records.length > 0) {
    const record = event.Records[0];
    bucket = record.s3.bucket.name;
    formattedKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  }

  // Use environment variable if bucket is not provided
  if (!bucket) {
    bucket = BUCKET_NAME;
  }

  if (!formattedKey) {
    throw new Error("No formatted transcript key provided");
  }

  try {
    // Get the formatted transcript from S3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: formattedKey,
    });

    const response = await s3Client.send(getCommand);
    const body = await response.Body?.transformToString();

    if (!body) {
      throw new Error(`Empty response body for ${formattedKey}`);
    }

    // Parse the formatted transcript
    const rawData = JSON.parse(body);

    // Validate the formatted transcript before processing
    const formattedTranscript = validateFormattedTranscript(rawData);

    // Create the result key in the results/llmOutput folder
    const resultKey = formattedKey
      .replace("transcripts/formatted/", "results/llmOutput/")
      .replace("formatted_", "analysis_");

    // Analyze the transcript using Bedrock
    const analysisResult = await analyzeTranscript(formattedTranscript);

    // Save the analysis result to S3
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: resultKey,
      Body: JSON.stringify(analysisResult, null, 2),
      ContentType: "application/json",
    });

    await s3Client.send(putCommand);
    console.log(
      `Successfully analyzed transcript and saved results to ${resultKey}`
    );

    // Return the result for Step Functions
    return {
      bucket,
      formattedKey,
      resultKey,
      status: "SUCCESS",
    };
  } catch (error) {
    console.error(`Error analyzing transcript ${formattedKey}:`, error);
    throw error;
  }
};

async function analyzeTranscript(
  formattedTranscript: FormattedTranscript
): Promise<any> {
  // Prepare the transcript for the LLM
  const transcriptText = formattedTranscript.transcript
    .map((item) => `${item.beginTime} ${item.speaker}: ${item.text}`)
    .join("\n\n");

  // Try each model ID in sequence until one works
  let lastError: Error | null = null;
  
  for (const modelId of MODEL_IDS) {
    try {
      console.log(`Attempting to use model: ${modelId}`);
      return await callBedrockModel(modelId, formattedTranscript, transcriptText);
    } catch (error: any) {
      console.warn(`Failed to use model ${modelId}:`, error.message);
      lastError = error;
      // Continue to next model
    }
  }
  
  // If all models failed, throw the last error
  throw new Error(`All model attempts failed. Last error: ${lastError?.message}`);
}

async function callBedrockModel(
  modelId: string,
  formattedTranscript: FormattedTranscript,
  transcriptText: string
): Promise<any> {
  // Create the system message
  const systemMessage = `You are an expert QA evaluator for Boys Town National Hotline, a crisis counseling service that helps people in distress. 
  Your task is to objectively evaluate counselor performance based on call transcripts using the Boys Town evaluation rubric.

  **EVALUATION APPROACH:**
  1. First, read the entire transcript to understand the full context and flow of the conversation
  2. For each rubric item, search for specific evidence that meets or fails to meet the criteria
  3. Apply a strict, consistent scoring standard across all evaluations
  4. Provide precise evidence with timestamps for each score
  5. Include a brief, factual observation explaining your scoring decision

  **SCORING PRINCIPLES:**
  - Score based ONLY on evidence present in the transcript
  - Default to the lower score when criteria are partially met
  - Require clear, unambiguous evidence for full points
  - Do not make assumptions about what might have happened off-transcript
  - Consider the full context of the conversation when evaluating specific moments

  For **every** score you assign:
  - Pick exactly one checkbox value.
  - Cite the exact transcript line(s) that triggered that score.
  - If you can't find evidence, set evidence to "N/A".

  **Do NOT** give full marks by default. If a criterion isn't explicitly met, deduct points.  

  **Strict Scoring Rules**  
  1. Review the rubric definition for each item.  
  2. If it only partially meets it, score the middle option (e.g., “Somewhat”).  
  3. Only score “1”/“2”/“4” etc. when you find unambiguous, on-point evidence.  
  4. Always include a one-sentence rationale under “observation” explaining the deduction.

  **OUTPUT FORMAT:**
  - After you evaluate, output **only** valid JSON—no free text, no markdown, no checkboxes.
  - **DO NOT wrap the JSON in triple backticks or quotes.**
  - Your JSON must be an object whose keys are the exact rubric question names (e.g. "Tone", "Professional", etc.).
  - For each item, the value must be an object with:
      "score": <0|1|2|…>,
      "label": "<Yes/No/Somewhat>",
      "observation": "<your concise rationale>",
      "evidence": "<timestamp> <speaker>: <exact transcript line>" (IMPORTANT: Always include the timestamp)
  - **Only** use lines provided in the user transcript for evidence. Do **not** invent or paraphrase. If no line matches, set evidence to "N/A".

  **Example**
    {
      "Tone": {
        "score": 1,
        "label": "Yes",
        "observation": "Calm and supportive tone.",
        "evidence": "00:24.500 AGENT: It's great that you're reaching out."
      }
    }

  **VERIFICATION CHECKLIST:**
  Before finalizing your evaluation:
  1. Confirm each score has supporting evidence from the transcript
  2. Verify all required rubric items are scored
  3. Check that observations are factual and not interpretive
  4. Ensure JSON structure is valid and complete

  Below is the Master Evaluation Form rubric you must follow:

  ==============================
  RAPPORT SKILLS / HOW WE TREAT PEOPLE
  ==============================
  1. Tone: Was the CC pleasant, helpful, calm, patient, and genuine?  
    ☐ 0  No  - Tone is aggressive, agitated, unkind, impatient, indifferent, or apathetic.  
    ☐ 1  Yes  - CC is kind. Tone is warm, natural, welcoming, interested, calm, and patient.  
    "Observations - Tone": 

    Note: Do not give any points if tone is aggressive, agitated, unkind, impatient, indifferent, or apathetic. Provide timestamps in evidence of moments when tone is aggressive, agitated,
    unkind, impatient, indifferent, or apathetic. One point given if CC’s tone is warm, natural, welcoming, interested, calm, and patient. One point given if immediate intervention is required regardless of the CC’s tone, in these
    instances evidence states “Immediate intervention required.”

  2. Professional: Was the CC professional during the contact?  
    ☐ 0  No  - CC encourages inappropriate or unsuitable conversation. CC uses slang, makes bodily noises or is sleepy. CC's conversation does not follow Boys Town policy.  
    ☐ 1  Yes  - Conversation is appropriate and suitable for a Boys Town Crisis Counselor.  
    "Observations - Professional": 

    Note: Do not give any points if CC encourages inappropriate or unsuitable conversation, if CC uses slang, makes bodily noises or is sleepy, or if the conversation does not follow Boys Town policy.
    Provide timestamps in evidence of slang used, violations of policy such as oversharing of personal information, or bodily noises by CC. One point given if conversation is appropriate and suitable for a Boys Town Crisis Counselor.

  3. Conversational Style: The CC engaged in a conversational dialogue with the contact.  
    ☐ 0  No  - The CC either spoke/texted far more than the contact or rarely spoke/texted; the rate of the conversation did not match contact.  
    ☐ 1  Yes  - Conversation is balanced - there is back and forth dialog between CC and the contact. CC is responsive to the contact's statements, matching conversational style.  
    "Observations - Conversational Style": 

    Note: No points given if CC either spoke far more than the contact or rarely spoke; the rate of the conversation did not match contact. Evidence provided with further explanation of why point was not given.
    One point given if conversation is balanced and there is back and forth dialogue between CC and the contact. CC is responsive to the contact’s statements, matches conversational style.
    One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  4. Supportive Initial Statement: Within the first few minutes, CC assures the contact.  
    ☐ 0  No  - The CC does not assure the contact that the hotline is here to help or that they did the right thing by reaching out.  
    ☐ 1  Yes  - CC assures the contact that the hotline is here to help, that they did the right thing by reaching out (i.e. “Thanks for reaching out today” or “We are here to help” or something similar that assures contact that they did the right thing reaching out and they will be helped).  
    "Observations - Supportive Initial Statement": 

    Note: No points given if the CC does not assure the contact that the hotline is here to help or that they did the right thing by reaching out. One point given if the CC assures the contact that the hotline is here to help, that they did the
    right thing by reaching out. One point also given if the contact immediately begins to explain their problem to the CC without invitation. Evidence provides a timestamp and transcript of statement
    or says “Contact immediately began discussing problem, no opportunity to provide supportive initial statement” when appropriate. One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required."

  5. Affirmation and Praise: The CC provides quality affirmations throughout the contact.  
    ☐ 0  No  - CC misses opportunities to provide affirmations to contact.  
    ☐ 1  Yes  - CC provides affirmations throughout the contact when opportunities to do so arise (i.e. “I'm so glad you're willing to share your story, this is a lot to process on your own”).  
    "Observations - Affirmation and Praise": 

    Note: No points give if CC misses opportunities to provide affirmations to contact. Point given if CC provides affirmations during the contact when opportunities to do so arise (i.e.
    I'm so glad you’re willing to share your story, this a lot to process on your own). Evidence provides a timestamp and transcript of affirmation or praise given. One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  6. Reflection of Feelings: The CC provides quality feeling reflections throughout the contact, naming specific emotions.  
    ☐ 0  No  - The CC does not reflect the feelings of the contact.  
    ☐ 1  Somewhat  - The CC provides only basic/shallow reflections to contact (i.e. “That sounds hard” or “That is understandable”).  
    ☐ 2  Yes  - The CC provides deep/meaningful feeling reflections throughout the contact; CC names the feeling and connects it with the person's story (i.e. “That sounds incredibly lonely; having your family so far away is difficult.” “I can see why it would be really frustrating to hear that from your teacher.”).  
    "Observations - Reflection of Feelings": 

    Note: No points given if the CC does not utilize reflections within the conversation with the contact. One point given if the CC provides only basic/shallow reflections to contact (i.e. &#39;That sounds hard’ or ‘That is understandable’). Evidence provides a timestamp and transcript of basic/shallow reflections of CC.
    Two points given if the CC provides deep/meaningful reflections throughout the contact connecting it with the person’s story (i.e. "That sounds incredibly lonely, having your family so far away is difficult."; "I can see why it would be really frustrating to hear that from your teacher.";)
    Evidence provides a timestamp and transcript of deep/meaningful reflections of CC. Two points given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  7. Explores Problem(s): Encourages the contact to explain their Problem(s), does not interrupt. CC asks open ended questions to prompt for additional information as needed.  
    ☐ 0  No  - CC interrupts or cuts the contact off while they are explaining their Problem(s) and/or seems disinterested in what the contact is sharing. CC asks yes/no questions, discouraging further sharing.  
    ☐ 1  Yes  - CC encourages contacts to fully express their feelings and explain their Problem(s). If the contact does not share details of their Problem(s), CC asks open-ended questions to prompt for additional information as needed.  
    "Observations - Explores Problem(s)": 

    Note: No points given if CC interrupts or cuts the contact off while they are explaining their Problem(s) and/or does not engage in problem exploration. CC only asks yes/no questions. One point given if the CC encourages contacts to fully express their feelings and explain their Problem(s). If the contact does not share details of their Problem(s), CC asks open-ended
    questions to prompt for additional problem exploration. Evidence provides a timestamp and transcript of open-ended question asked by CC to understand the problem. One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  8. Values the Person: The CC provides unconditional positive regard to the contact.  
    ☐ 0  No - The CC demonstrates contempt or resentment to a contact (i.e. blames the contact for their own problems, dismisses a contact's emotions as irrational, invalidates a contact's experience).  
    ☐ 1  Yes  - The CC demonstrates unconditional positive regard by accepting the contact's feelings and thoughts without judgement. (“Your feelings are valid,” “You deserve to be heard”)
    "Observations - Values the Person": 

    Note: No points given if the CC expresses contempt or resentment to a contact (i.e. blames the contact for their own problems, dismisses a contact's emotions as irrational, invalidates a contact's experience). Evidence provides a timestamp and transcript of times where contempt or resentment are expressed.
    One point given if the CC demonstrates unconditional positive regard by accepting the contact's feelings and thoughts without judgement.

  9. Non-Judgmental: The CC refrains from statements of judgement or from offering personal opinions regarding the contact's values, their situation, or any people connected to them.  
    ☐ 0  No  - The CC is judgmental or offers personal opinions about the contact's situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend).  
    ☐ 1  Yes  - The CC refrains from offering any judgement statements or personal opinions about the contact's situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend).  
    "Observations - Non-judgmental": 

    Note: No points given if the CC is judgmental or offers personal opinions about the contact’s situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend). Evidence provides a timestamp and transcript of times where personal opinions are expressed or unsolicited advice is given.
    One point given if the CC refrains from offering any judgement statements or personal opinions about the contact’s situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend).


  ==============================
  COUNSELING SKILLS / THE PROCESS WE USE
  ==============================
  10. Clarifies Non-Suicidal Safety: CC asks clarifying questions to identify any non-suicidal safety concerns that must be addressed to effectively guide the direction of the contact.  
      ☐ 0  No  - CC fails to ask important clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.).  
      ☐ 1  Yes  - CC asks appropriate clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.). Default to 1 if non-suicidal safety concern were not present.  
      "Observations - Clarifies Non-Suicidal Safety": 

    Note: No points given CC fails to ask important clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.). Evidence provides a timestamp and transcript of times where non-suicidal safety concerns were expressed and no clarifying follow up questions were asked.
    One point given if CC asks appropriate clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.). One point given if if non-suicidal safety concerns were not present.

  11. Suicide Safety Assessment-SSA (Lethality Risk Assessment-LRA) Initiation and Completion: The CC assesses for suicidal ideation. (YLYV Text and 988 Chat/Text scoring reflects the protocols listed in One Note).  
      ☐ 0  No  - CC does not assess for suicide or assesses in an ineffective way (i.e. “You're not feeling suicidal today, are you?”).  
      ☐ 1  No  - The contact tells the CC they are not suicidal, but the CC does not clarify the statement and does not ask any other questions regarding suicidality. Third party contact, no assessment made. CC asks the contact if they are having “thoughts” or “a plan” but does not use the word “suicide” or the phrase “to end your life.”  
      ☐ 2  Yes  - CC initiates SSA but misses 2 or more of the required questions as listed in CMS based on the contact's answers.  
      ☐ 3  Yes  - CC initiates SSA but misses 1 of the required questions as listed in CMS based on the contact's answers.  
      ☐ 4  Yes  - CC conversationally asks the required SSA questions as listed in CMS or clarifies/restates understanding with contacts who volunteer that they are not suicidal.  
      "Observations - Suicidal Safety Assessment-SSA Initiation and Completion": 

    Note: No points given if CC does not assess for suicide or assesses in an ineffective way. (i.e. “You're not feeling suicidal today, are you?”). 
    One point given if the contact tells the CC they are not suicidal, but the CC does not clarify the statement and does not ask any other questions regarding suicidality. Third party contact, no assessment made. CC asks the contact if they are having “thoughts” or “a plan” but does not us the word “suicide” or the phrase “to end your life.” Evidence provides timestamp and transcript of contact stating they are suicidal and CC response.
    Two points given if CC initiates SSA but misses 2 or more of the required questions as listed in CMS based on the contact’s answers. Required questions logic model is below. Evidence provides timestamp and transcript of dialogue regarding suicidality and notes missed questions.
    Three points given if CC initiates SSA but misses 1 of the required questions as listed in CMS based on the contact’s answers. Evidence provides timestamp and transcript of dialogue regarding suicidality and notes missed question.
    Four points given if CC asks the required SSA questions as listed in CMS or clarifies/restates understanding with contacts who volunteer that they are not suicidal. Evidence provides timestamp and transcript of dialogue during suicide assessment.
    SSA Logic Model: LRA
    Question 1: Sometimes people in similar situations to yours have thoughts of suicide. Are you thinking of ending your life?
    Additional Questions: 
      If Yes to Question 1, all below are required: 
        Have you done something today to end your life? (In general, within past 48 hours)
        Do you have a plan to end your life?
        Have you ever attempted to end your life before?
      If No to Question 1:
        In the last 2 months have you thought about suicide? 
        If Yes to above: Have you ever attempted to end your life before?
        If No to above: No additional questions

  12. Exploration of Buffers (Protective Factors): CC works with the contact to understand their Buffers against suicidal thoughts and other non-suicidal safety concerns as listed in CMS.  
      ☐ 0  No  - CC does not explore Buffers and/or does not record the answers in CMS. Default to 1 if the contact does not have any suicidal safety or non-suicidal safety concerns.  
      ☐ 1  Yes  - CC asks questions to understand the Buffers and accurately records the answers in CMS. Default to 1 if the contact does not have any suicidal safety or non-suicidal safety concerns.  
      "Observations - Exploration of Buffers": 

    Note: No points given if CC does not identify and explore identified Buffers.
    One point given if CC asks questions to understand identified Buffers. One point given if the contact does not have any suicidal safety or non-suicidal safety concerns. Evidence provided lists buffers explored with contact or states “No suicidal or non-suicidal safety concerns.” One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  13. Restates then Collaborates Options: Restates the contact's primary concern and the type of support they are seeking; then collaborates with the individual to develop Options to address their situation. Empowers the individual to brainstorm coping skills and action steps.  
      ☐ 0  No  - The CC tells the contact what they should do/what's best for their situation without seeking input.  
      ☐ 1  Yes  - The CC works with the caller by asking questions about how they would like to handle the situation. If the CC provides suggestions, they ask the callers for input on the suggestions. Default to 1 if the contact’s situation requires immediate intervention without collaboration.  
      "Observations - Restates then Collaborates Options":   

    Note: No points given if the CC tells the contact what they should do/what’s best for their situation without seeking input. Evidence provides timestamp and transcript of these questions. 
    One point given if the CC works with the caller by asking questions about how they would like to handle the situation If the CC provides suggestions, they ask the callers for input on the suggestions. One point given if the contact’s situation requires immediate intervention. Evidence provides timestamp and transcript of these collaborative questions or states “Immediate intervention required”.

  14. Identifies a Concrete Plan of Safety and Well-being: The CC helps the contact to create a solid Plan building on Buffers (Protective Factors) as identified previously (this applies for both suicidal and non-suicidal calls).  
      ☐ 0  No  - The CC does not establish a concrete plan.  
      ☐ 1  Yes  - In conjunction with the contact, the CC develops a concrete plan for right now (restricting means, utilizing immediately available support, etc.) or establishes what they will do if in crisis or feeling unsafe in the future.  
      ☐ 2  Yes  - In conjunction with the contact, the CC develops a concrete plan for right now and establishes what they will do if in crisis or feeling unsafe in the future. Default to 2 if the contact’s situation requires immediate intervention without safety planning.  
      "Observations - Identifies Concrete Plan":   

      Note: No points given if the CC does not establish a concrete plan with the caller.
      One point given if in conjunction with the contact, the CC develops a concrete plan for right now (restricting means, utilizing immediately available support, etc.) or establishes what they will do if in crisis or feeling unsafe in the future. Evidence provides timestamp and transcription of the plan and notes whether present planning or future crisis planning were omitted.
      Two points given if in conjunction with the contact, the CC develops a concrete plan for right now and establishes what they will do if in crisis or feeling unsafe in the future. Two points given if the contact’s situation requires immediate intervention without safety planning. Evidence provides timestamp and transcription of each of these plans or states “Immediate intervention required”.

  15. Appropriate Termination (Follow Up Offered): The CC ends the contact appropriately and offers a Follow Up as needed.  
      ☐ 0  No  - The CC hung up on the caller/texter or ended the call prematurely; CC does not use an appropriate Closing Statement OR terminates call without offering a follow up call as needed for 988 and BTNHL contacts.  
      ☐ 1  Yes  - The CC ended the contact in a timely manner with an appropriate Closing Statement and offers the required follow up to 988 and BTNHL contacts.  
      "Observations - Appropriate Termination": 
    
      Note: No points given if the CC hung up on the caller/texter or ended the call prematurely, CC does not use an appropriate Closing Statement OR terminates call without offering a follow up call as needed for 988 and BTNHL contacts. Follow up calls must be offered to any caller who is suicidal or is struggling with parenting. 
      One point given if the CC ended the contact in a timely manner with an appropriate Closing Statement and offers the required follow up to 988 and BTNHL contacts. One point given if the contact’s situation requires immediate intervention. Evidence provides timestamp and transcription of follow up call offerings or states “No Follow Up Required” or states “Immediate intervention required”.

  ==============================
  ORGANIZATIONAL SKILLS OF THE CALL/TEXT AS A WHOLE
  ==============================

  For “POP Model - Does Not Rush” and “POP Model – Does not Dwell”: 
  THE POP MODEL 
    Step 1: PROBLEM
      -Encourage caller to fully express feelings & explain their problem
      -Complete suicide safety assessment 
      -Clarify non-suicidal safety concerns 

    Step 2: OPTIONS 
      -Restate the caller’s primary concern
      -Explore buffers (protective factors) 
      -Collaborate to come up with options for moving forward 

    Step 3: PLAN
      -Identify and restate a concrete building on buffers for 
      -Now 
      -In the future 
      -Encourage Future Callbacks + Offer Follow-up call

  16. POP Model - does not rush:  
      ☐ 0  No  - CC rushes to Options and Plan before working to understand and explore the problem in a meaningful way.  
          Score as a 0 on both POP Model components if contact lacks organization and CC does not guide the conversation, just letting the contact talk.  
      ☐ 1  Yes - CC sufficiently explores and understands the problem prior to moving to Options and Plan. Gives time to each element of the POP Model.  
      "Observations - POP Model - does not rush": 
    
    Note: No points given if CC rushes to options and plan before working to understand and explore the problem in a meaningful way within the first 1/3 of the call. No points given if the CC does not follow the steps to the POP model. Evidence provides timestamp and transcript of problem-solving statements completed too early in the call or states “POP Model not followed.”
    One point given if CC sufficiently explores and understands the problem prior to moving to Options and Plan. Gives time to each element of the POP Model. One point given if immediate intervention is required, in these instances evidence states “Immediate intervention required.”

  17. POP Model - does not dwell:  
      ☐ 0  No  - CC allows caller to ruminate and fails to move to Options and Plan after the Problem has been sufficiently explored.  
          Score as a 0 on both POP Model components if contact lacks organization and CC does not guide the conversation, just letting the contact talk.  
      ☐ 1  Yes - The CC moves the call/text from Problem to Options and Plan smoothly, efficiently, and effectively. Gives time to each element of the POP Model.  
      "Observations - POP Model - does not dwell": 
    
    Note: No points given if CC allows caller to ruminate and fails to move to options and plan within the final 1/3 of the call. No points given if the CC does not follow the steps to the POP model. Evidence provides timestamps and transcript of exploratory statements which are repeated or late in the call or states “POP Model not followed.”
    One point given if CC moves the call/text from Problem to Options and Plan smoothly, efficiently, and effectively. Gives time to each element of the POP Model.

  ==============================
  TECHNICAL SKILLS
  ==============================
  18. Greeting: The call is answered pleasantly and correctly.  
      ☐ 0  No  - Greeting is incorrect, incomplete or unpleasant. There is a significant delay in answering contact.  
      ☐ 1  Yes  - Greeting is correct and pleasant. CC uses the correct call gate and phrasing (i.e. “Boys Town National Hotline, how may I help you?” “988 Nebraska, how may I help you?”). Answers calls in a timely manner (answers 988 calls within the first 2 prompts).  
      "Observations - Greeting": 

  (Sometimes in the transcript, it might seems like Agent said "Voicetown" instead of "Boystown", or something similar. It is correct, no points needs to be deducted for that.)
  Note: No point given if greeting is incorrect, incomplete or unpleasant. There is a significant delay in answering contact.
  One point given if greeting is correct and pleasant. CC uses the correct call gate and phrasing (i.e. ‘Boys Town National Hotline, how may I help you?’ ‘988 Nebraska, how may I help you?’) Answers calls in a timely manner (answers 988 calls within the first 2 prompts).

  ==============================
  END OF RUBRIC
  ==============================

  ==============================
  IMPORTANT EXAMPLES FOR EACH RUBRIC ITEM
  ==============================

  **These examples include references from the scoring sheet of a human grader from thier past call. It is important for you to go through these examples in detail and understand why was marks given or deducted for a particular metric based on evidence. This is very important for you to make correct judgement.**
  1. Tone: 0 - no marks were given for these cases:
    Talks quickly, somewhat over caller. 15:23 I know (kind of dismissive) also below - 17:52/termination.
    Did not participate in conversation, disinterested and apathetic
    Frustrated with the caller for not agreeing with provided suggestions
    Dismissed caller and seemed agitated after caller was not interested in problem solving
    CC dominated the conversation, debated with caller frequently
    CC sounded like a teacher throughout the call
    Spoke to adult caller like they were a child
    CC approached call as if they were a parent
    Babied the caller
    CC did not reflect feelings or provide affirmations, did not engaged in collaboration
    Used elevated, inaccessible language throughout the call
    Very academic tone

  2. Professional: 0 - no marks were given for these cases:
    8:34 Hun 16:48, 16:51 Dear, 17:02 Hun
    6:49 I have had that when I have eaten spicy food. 11:57 Honey
    8:41: "Yeah, I get why you were like WTF…"
    3:01 - CC said "dude"
    4:55: CC-"bro, I don't know."
    10:54- "Sweetie…"
    21:11: "Oh my god!" - Repeated
    CC swore in the call
    CC spoke in acronyms 3:45-"LOL"
    16:21: "Damn…"
    CC provided too much personal information, full name
    CC said what neighborhood they lived in
    CC stated that they had previously been in a DV relationship
    CC disclosed their own abuse history
    CC shared extensively about their abusive childhood.

  3. Conversational Style: 0 - no marks were given for these cases:
    7:12 States name out of context. Changes subject instead of prompting for answer. Uses the phrase "a lot" a lot.
    Awkward sequence asks for name (0:17), phone number (1:12), age (1:18) without building rapport.
    Several pauses, yeahs, lots of caller speaking without reply from cc. 15:23-15:36 13 second pause - may have been intentional to allow caller to process their feelings.
    Several pauses, yeahs, caller does nearly all of the talking. 
    Talks far more than the caller - caller does not talk much after sharing story due to CC talking and asking yes/no questions.
    CC speaks a lot, however caller is not very talkative. Resolve this by asking more open ended questions.
    says "mm-hmm, okay" repeatedly throughout call
    CC was halting and abrupt throughout call
    Conversational style has pauses/is choppy - Is CC doing something else while on the call?
    I'm sorry, oh goodness, mm-hmm, uhh, right, interesting. There is not a balance of the conversation.
    1:51, 2:31, 7:00, 7:31 I'm sorry Many repeats of the same words.
    5:32, 21:32 I'm sorry Many repeats of the same words.
    Lots of caller talking
    Interrupted caller frequently
    Engage more in the call. Ask more questions like the one below (2:23).

  4. Supportive Initial Statement: 1 - marks were GIVEN for these cases:
    1:23 I'm so glad you called - how did you find our number today?
    1:23 I'm so glad you called - how did you find our number today?
    0:35 I'm so glad you called for support.
    0:10 Thank you so much for calling for support.
    0:13 Thank you for giving us a call, what is going on?
    0:15 Thank you for giving us a call, this is a good place to talk about it, what's going on? What happened?
    0:22 Take your time. 3:24 You did a good job calling us today (first break in the conversation).
    3:10 I'm so glad that you reached out.
    4:34 I am so glad you reached out
    0:26 ok, alright. 1:58 I'm really glad that you reached out for some support tonight.
    10:43 Thanks for reaching out.
    1:13 I'm glad that you decided to call.
    0:29 You did the right thing to reach out, we're certainly here to support you.
    0:30 How did you find our number. Ok well good, yeah. My name is Sharon. 1:08 I'm here to listen to try to help.
    0:34 I can give you some information, yes, you called the right place.
    0:17 Sure, I can talk to you. This should be more assuring - Thank you for calling, I'm glad you're talking about this, I am here to help.
    0:23 I want to commend you for reaching out for some support.
    0:16 Sure we can talk. 0:24 I'm glad that you're calling.
    0:22 I'm glad that you called, can you tell me what's going on?
    1:01 I'm proud of you for calling.

  5. Affirmation and Praise: 1 - marks were GIVEN for these cases:
    8:19 I'm glad you called the hotline for some support.
    7:26 Thank you for your honesty. 8:02 Glad you are reaching out today and wanting to take care of your mental health.
    8:01 I appreciate you answering these questions.
    5:11 Congratulations on your sobriety. 6:34 Thank you for sharing that and answering those safety questions. 18:41 Thank you for sharing that.
    0:35 Thank you for being so transparent. 3:35 I'm so glad that you called for support.
    2:23 Good that you are voicing these things out.
    24:19 Absolutely, keep moving forward.
    14:05 That is what we are here for, you did what you're supposed to do. 14:25 I'm glad that you have that appointment.
    23:50 You're doing those one steps. 25:52 I'm glad you called.
    4:38 You did such a brave thing to reach out to talk about this. 4:42 Thank you for being so open to share about this. 4:51 You are brave to talk about your feelings, they are important. 5:37 You are really advocating for yourself right now, and that is very courageous. 
    1:32 I suppose that it is always good to look at things after a break up and that's normal… it's a combination of reasons… you reflect back on it. 
    10:07 I'm so proud of you for calling when you were anxious like that and I'm really, really proud of you for your  3 months without self-harming, that's a huge step. 12:14 I'm really glad that you called, it was really brave of you to call tonight.
    12:08 Be proud of yourself for raising 3 boys all on your own. 17:08 I'm really glad that you called tonight and I know that was difficult. 19:40 I love that you have them active in stuff.
    13:28 You are trying your best as a mom to provide her those resources and reassure her that you do have the best interest in her care.
    3:26 I'm glad that you do have that supportive space to want to reach out and talk to us about that too.
    5:08 Good to know that you have support. 13:48 Thank you for being honest with me about that.
    10:50 You've already taken a big step, though, by reaching out for support. 11:46 Thanks for your honesty.
    6:06 Thank you for answering that question for me. 10:20 Good for you, that you're doing those things to help yourself. 13:56 Good for you that you have all those family supports. 15:34 I appreciate you answering those questions for me. 18:01 I'm glad that helped to talk a little bit.
    0:35 If you're in any kind of crisis it's a good thing that you're reaching out, I know that can take a lot of courage. 2:18 It's great that you have taken the initiative to have mental health services though. 3:33 You called the right place. 12:40 Good, talking apparently helps to not feel so all alone. 14:40 Congratulations 14:49 Sounds like you came a long ways. 15:43 I appreciate all that information.

  6. Reflection of feelings: 1 mark was given for these cases:
    3:53 It can feel that way at times as we grow older and try to make better choices. 11:41 To get back behind the wheel and drive, they can get nervous, it could be because of the test rating.
    3:26 At this point he is at the age where he is if you don't buy me this…and at this point you have exhausted your resources.
    7:08 Sounds like you are coping with a lot of different feelings. 7:19 Sounds like you have a lot going on, and it has been going on for a long time. 7:26 Feeling stressed and having suicidal thoughts sounds like a lot.
    5:04 I can understand how this can be upsetting for you. 5:19 I also realize that you're noticing that because he is smoking marijuana he is missing out on the small details that he wasn't before and it is making you sad, you feel uncomfortable with the changes that you see. 15:48 I can understand, I have an overview of what is going on. Based on what you are saying, that he does not like to take accountability for what is wrong and prefers to deflect and put you as blame, I can understand that being frustrating. CC uses a lot of "I" statements.
    0:57 I'm sorry to hear that you lost your mom. 1:13 I know that it is hard going through the stages of grief, I can hear it for sure. 1:55 I know that it is hard to see it that way. 12:27 You could have good days or have bad days depending on how you process the grief. Limited reflection due to the seriousness of the situation. CC uses a  lot of "I" statements.
    2:19 That's unfortunate. It makes it difficult. It is good that you are voicing these feelings out. 7:18 That would be stressful. 9:17 That's another layer making it difficult.
    1:51 Definitely good that she is seeing someone, talking to someone but when she is making those accusations that can be you know that piece of that she does need to see someone else. 5:33 And that difficulties of trying to you know get her engaged and active is good that the younger siblings at least kind of bring that side out but as a parent wanting to engage and have those conversations too especially with those kind of remarks that she are is making to therapist. Name the emotion that is heard.
    4:54 A lot of work it sounds like to try to manage her behavior. 7:08 I'm glad that she is okay, it was a lot of stress I'm sure.
    7:34 It's a lot to bear, it sounds like you have been going through it. 7:57 It sounds like you've got to get to a shelter so you can slowly start to rebuild.
    1:37 Sounds like it is pretty stressful.
    0:52 I'm sorry to hear that. 3:46 It's just the way that she says things that it comes across like she is not supportive (better). 4:33 I'm sorry that I didn't understand what you're saying, I know that you're upset, you're very upset that is (better). I'm sorry that's happening to you right now. 5:06 Wow, sorry to hear that. 5:23 Wow, I'm so sorry. 9:57 I'm so sorry that you're dealing with this right now. 10:24 I know that this is very hurtful for you (better). Refrain from saying I'm sorry - instead use meaningful reflections.
    5:04 Definitely 6:20 Sounds like there is a lot on your mind. 6:56 It sounds like you've you've been dealing with a lot and you know everyone is human and you know people can only deal with so much before it gets to this point where you know, it really starts affecting them. 20:11 I hear you.
    1:28 Sounds like you've gone through a lot. 3:55 That's a lot. 5:54 That's a hard situation. 9:10 Makes sense, but you need help, you can't do it on your own. 
    1:21 Sounds like you're going through a lot of emotions. 4:05 Absolutely, you're going through a lot right now. 
    1:25 Yeah, that makes sense especially when your mom is kind of putting screen time controls on you? 2:46 It's understandable that you feel frustrated with limits. 3:22 It's understandable that you would feel that way because it is kind of like your lifeline. 3:50 I definately understand why that would frustrate you...having someone control what you do with your time. 6:13 I can understand how you would feel frustrated about that (mom not giving her credit for leaving her phone alone). 10:58 I can understand how that would be frustrating.
    1:39 That really makes sense especially when you see other people who are not having to study as hard and they're making the grade. 6:24 That makes sense, a lot of us do put emphasis on our performance. 12:04 That makes sense, most of us are very critical of ourselves…if you have failure after failure... you can lose motivation.
    1:09 (Nice recap) Let me just get a little clarification… 3:48 I can hear the concern in your voice. 7:21 So kind of just out of touch with reality.

    2 marks were given for these cases:
    "4:34 It sounds like you are facing a lot right now. 4:38 I can hear that you are in a lot of pain right now. 4:47 those are such deep pains to hold, having your father pass away a few years ago can still feel very painful. everyone can process that differently as well.
    it sounds like you have gone through a lot of change in your life."
    3:50 I'm hearing you say that it has been difficult. 7:02 There is a lot of complexity that happens when you separate. 8:50 You're going through some changes right now.
    3:24 It sounds like you have a lot going on.  6:27 I understand that that's some pretty intense feeling and thoughts at times.  9:16 It becomes challenging when you are having all of these thoughts and feelings.
    2:21 It does sound very complicated that she already has a child and has to have a connection with this person. Yeah, that would be stressful. 7:32 Your concerns are very valid. 8:30 It's messy and unfortunate, you got to think about you.
    6:26 That can be really overwhelming to think about so often and confusing to not know why you're experiencing this. 6:42 Experiencing trauma can definitely make things difficult for you. 6:47 That is incredibly heartbreaking to go through It makes sense that thinking about him would upset you so much. It can be really lonely to go through that. 7:01 It can be really confusing to have him come in and out like that unannounced.  7:21 That sounds really isolating.
    4:05 It makes sense for you to be so frustrated and so upset. 4:17 It's really hard when you are physically feeling unwell and for so long. 4:26 Feeling dismissed by others, like no one cares, it's no surprise that you 're feeling so hurt right now. 13:15 I hear how much pain you're in.
    0:45 You're going through a break up which is really difficult. 3:24 I think you're going through a heartache, breakups are difficult. It is what it is. To feel upset about it is normal.
    1:13 Sounds like you have a whole lot going on right now, a lot of stuff stressing you. 1:25 All of those things are really, really important and I understand why you're upset by that. 2:32 I know a breakup can be really really difficult sometimes.
    2:05 I would imagine that can be difficult every day. 2:12 Going through the divorce wasn't easy and probably everyone's lives were turned upside down. 8:06 It sounds like there is not very good communication between you and their dad?
    1:09 That's understandable. 1:44 Yeah, definitely, that last push. 2:14 Sounds like it's that last little count down to push through for you…kind of that overwhelming feeling of anticipation. 3:13 That is definitely understandable with changes happening it can make you anxious not knowing the future. 4:47 I understand that new adjustment and having that new normal of having to adjust and adapt to everything, it can be overwhelming. 10:52 Sounds like some of things are out of your control, that can be hard.
    0:57 Yeah, that has got to be tough. Has to do a recap due to interruptions (point taken off above). 1:29 You said you feel like you're always sad, when you're around your loved ones you're still feeling alone. 3:24 Oh my gosh, yeah, that sounds so overwhelming. 4:35 Dealing with all of this for the last 6 months can definitely feel overwhelming or exhausting. It sounds like you have been doing this a lot on your own. 7:26 Sounds like everything has been piling up and now it just bursted out and that's why you feel emotional.
    10:43 Sounds like a tough thing to have to deal with. 10:50 That sounds so overwhelming. So sorry about your brother passing and your childhood dog, those are huge life events and it can be hard to heal from all that. 11:11 sounds like you have carried all these emotions for a while and they are starting to feel heavy.
    3:27 Maybe you're going to miss the child, that you're not going to be able to see the child as much. 4:31 Change can be difficult too. 5:15 The holidays are tough when you are missing people. 5:20 Sounds like you are feeling a bit sad with the holidays and missing people. 11:58 It's hard not to worry.
    4:31 Oh boy, having medical issues can be very stressful. 4:58 That can hurt (people talking sympathetically to him). 7:55 Feeling like you wish you weren't here, those are certainly some painful feelings to have.
    8:10 This is someone who you love, this such a traumatic thing and it's still so fresh and new, and your family is far away. 8:29 There are so many emotions going through your mind but it does sound like that he was hiding it and when people hide things it's hard for us to catch things. 12:34 Loss is hard regardless how old we are. 12:58 To go to work and come home to that, that's a lot. 14:56 These are valid concerns and emotions to have.
    2:20 It can be for sure (depressing). 3:51 It's difficult when you lose somebody that you really care about and they are not involved in your life anymore because you get into routines with that person… and the holidays can be particularly difficult…relationships are very complicated. 7:13 Sounds like you spend a lot of time by yourself…and that can be hard. 
    8:53 Yeah, that has got to be very triggering. 10:05 It sounds like your assault is an ongoing issue that comes up between you and your partner. 11:06 That is a tough one too, sounds like she wants to be a support, but on the other hand, if she has not gone through this situation, she is not going to understand your feelings because she has not been where  you have been.
    0:25 You said you were feeling depressed and also have some anxiety. 3:49 Sounds like you have been through a lot and you are trying your best to navigate your way. 3:58 Looking for a job, not having support...can make things a lot harder to navigate. That's when we come in for some support. 5:41 Mentally this can be a lot. Not only are you trying to pick up the peices in your life for you, you are also trying to make sure your children are taken care of and safe as well. That's enough to cause anyone to spiral and put so much stress on you. 10:44 Somestimes it is the fear that overtakes you.
    2:10 It kind of sounds that you're wanting a way to not express your feelings. 2:48 It sounds like you're kind of walking on egg shells. 

  7. Explores Problem: 0 - no marks were given for these cases:
    0:22 Oh, has this been going on for a while? Caller is trying to tell CC how this affected their relationship with their mom - CC goes to the fix.
    4:08 Is there anything else that you want to share with us? Need more than this.
    11:45 What are you sorry for? 15:30 Asks about college - shows interest. 18:45 Asks about the caller's family.
    CC does not ask any questions or explore the problem - -the caller also stated that they did not want to get too much into it but CC could have at least guided the conversation/asked about the statements a little bit.
    Does not seem to understand the problem (especially the daycare situation). Does ask questions - 4:27, 6:24 (below) Ask open ended questions. Go deeper. Ask the caller how they are feeling in the present.
    2:21 How does it feel when you can't use the cars? 3:51 Were you arguing with your parents? Parents make noise intentionally. Go deeper - focus on how would you like this to look, what do you think you could do to improve this situation?
    4:46 That has been going on since he was 4 years old? Go deeper to further understand the story. Get curious.
    3:55 Recaps the conversation, did I hear you right? 10:49 Caller reveals that he is fearful of the girl's ex.
    2:58 Do you think that he would talk with me? Straight to problem solving
    3:56 When you feel sad, do you feel sad at school, at home, everywhere? Ask more open ended questions.
    1:16 What's going on, what made you call. 2:41 What's the medication for? Go deeper - what caused the panic tonight (at times she started talking about something online)?

    1 mark / full score was given for these cases:
    2:02 You said the MCR was providing therapy services? 5:12 Is he the only child in the home?
    2:01 What would be the consequences or ramifications if you didn't go (to school)?
    7:02 Can you explain more what you are dealing with? 7:08 Can you explain more about what you mean by episodes?
    1:37 Just to get clarity, you said marijuana?
    Asks caller when her mom passed away.
    1:05 2:51 4:18 Like without you? (Many hm-hmm, rights and yeahs).
    3:56 Are you in process of divorcing? 5:17 She is going to change the locks? No the rent man. 9:58 Why can't you stay where you are now? (Not following)
    1:18 Why do you say that? Why do you say there is something wrong with you? 2:55 What do you mean, what's normal? Invite the caller to explore more.
    1:33 Of all those things that you told be about what is the one thing that is the most upsetting to you right now? This is great - do more. 3:07 Tell me about the necklace that you lost.
    0:34 How old are your boys? 0:53 All three of them fight with each other? 1:25 And dad is active in their lives? 2:31You said when the time to go to dad's gets closer, the anger starts, is that your anger or theirs? Do they not want to go to dad's? 4:09 How are the kids doing in school?
    1:37 You said that she is currently going to a therapist as well? 2:06 Does she has a history of kind of many behavioral problems or lying or anything like that? 3:25 Is dad helpful with redirecting her with those accusations? 5:02 When she is at your house, how does that interaction happen between the two of you? 10:11 Does she primarily live between the two of you?
    1:48 How long have you been feeling this way? 1:56 Do these people know how you feel? (kind of with story) 5:15 Has anything happened in your life that has triggered these feelings? 6:39 Why do you feel tonight is tough for you? Did everything just hit? Or did something happen today? 11:09 Do you have a relationship with your dad?
    11:04 What seems to be making today so tough for you?
    3:41 What are your concerns? 8:41 When were you diagnosed? 
    1:07 What kind of thoughts that you've never had before? 4:36 What disease were you diagnosed with? 8:10 Would that describe the way you're feeling? Depressed? 11:32 What would moving accomplish for you?
    2:58 What other supports do you have for him? 3:33 How do you feel about it? (taking him to a group home)
    2:00 So you're trying to organize your house and get it cleaned up? 2:47 So you are going through a break up right now?
    0:38 Did someone give you our number? 1:10 How old is she? 1:18 Is she still in high school? 1:38 Has she been doing home school? 2:18 Does she have anyone that she currently works with there? (part of the story) 4:05 Did she tell you where she was?
    1:58 Can you tell me a little bit about what you were thinking about before you were feeling anxious and panicky? 7:15 Has she been supportive to you in other situations? 7:24 In this situation…she is not blaming her, is that correct?
    0:55 Help me out here - how old are you? How old is your girlfriend? 4:26 Oh…she's mad at you? 5:19 Were you able to graduate from high school? 7:15 Do you have some kind of diagnosis that is making them worried about your ability to make decisions for yourself? 8:15 How long have you been dating? 14:02 What do you think a mama's boy is? 15:12 Have your parents met her? 15:19 Did they like her?
    4:57 Are you still in school? 5:13 What are your plans? Are you planning to go to college?
    1:54 What happened with the relationship? 2:09 Have you talked to her since? 2:21 What have those conversations been like? 2:43 Can you tell me about the content, what she's saying? 3:11 Why did she kick you out? 3:44 So was it that the relationship that you were struggling anyway?  14:35 What do you mean take her back?
    0:57 How old are you now? 1:48 So tell me what's been going on that's making you sad. 3:52 So tonight, what happened that made you sad? 13:21 What do you think triggered these feelings tonight?
    0:51 Tell me what's going on. Caller offers a lot of details.
    1:23 What triggered you today? 4:26 Is this a common occurrence when you go about 3 days without engaging with other people?
    0:45 Do you know each other only on SM or in person as well? 0:53 Did your friend say why they were disconnecting their socials? 1:22 May I ask how you know each other? 1:30 What do you mean by "it was a lot of fun"? 2:00 What do you mean by "it was a lot of fun"? 2:20 How long have you been friends? 2:40 How long have you been feeling this way? 3:00 Do you think that your friend is going through something similar? 3:20 Do you think that your friend is going through something similar? 3:40 Do you think that your friend is going through something similar? 4:00 Do you think that your friend is going through something similar? 4:20 Do you think that your friend is going through something similar? 4:40 Do you think that your friend is going through something similar? 5:00 Do you think that your friend is going through something similar? 5:20 Do you think that your friend is going through something similar? 5:40 Do you think that your friend is going through something similar? 6:00 Do you think that your friend is going through something similar? 6:20 Do you think that your friend is going through something similar? 6:40 Do you think that your friend is going through something similar? 7:00 Do you think that your friend is going through something similar? 7:20 Do you think that your friend is going through something similar? 7:40 Do you think that your friend is going through something similar? 8:00 Do you think that your friend is going through something similar? 8:20 Do you think that your friend is going through something similar? 8:40 Do you think that your friend is going through something similar? 9:00 Do you think that your friend is going through something similar? 9:20 Do you think that your friend is going through something similar? 9:40 Do you think that your friend is going through something similar? 10:00 Do you think that your friend is going through something similar?

  8. Values the person: 0 - no marks were given for these cases:
    17:39 Just know that doesn't mean that their's not anybody who would make you feel this way, I know it's hard to see or think about that.
    Loses track of the story multiple times - caller is a bit difficult to track but CC seems to have an extra difficult time, making the caller repeat and clarify.
    7:06 Daniel, you have to do what you're going to do (dismissive). 17:05 Does it sound like I'm being annoying right now or saying the same thing over and over?
    10:45-17:14 Talks over caller and tells them what to do about their situation (below). 10:35 I'm going to be really honest with you... you are literally homeless and you're choosing to be homeless and unstable as you wait for a yes or no from her. 
    5:45 I know you're going through a lot right now but those feelings can pass, who knows what you'll feel in an hour? 5:58 We don't want something to happen to you. 9:07 I want to make sure that you're safe, because that's what you deserve. Just cause you're going through a lot right now and feeling a lot right now does not mean that you need to hurt yourself. 13:05 You deserve to live. 13:16 You can get through this, I know you can. Caller: I don't. 13:22 Yes you do, you proved tonight that you do, that you want to live.  13:44 I know that you feel that way, but I do know. 14:52 But you do (belong). 16:11 You have to give yourself a chance. You have to keep doing that, you have to keep pushing forward. You're only 11. 16:33 You're life hasn't even began yet. Caller Yep, and that's my reason. 16:47 But it will. It will get better. Instead of telling the caller that things will get better, reflect on their current feelings and then provide hope without making an absolute statement - Hopefully in time things will get better. Be careful about speaking of the caller's age, this can feel minimizing to the caller.
    12:07 I just want someone to listen to me for a few minutes (CC does not seem to be listening at this point).
    9:31 Part of figuring it out is utilizing resources available. 15:32 Everyone knows different things, sometimes you just got to reach out to an expert. Kind of advice giving instead of supporting.
    At 13:39, CC seemed resentful of the caller's opinions 
    At 7:45, CC showed contempt for the caller's emotions. Did not seem to believe the caller was in crisis.
    CC didn’t agree with the caller's emotional experience of abuse. 11:29: Told them they should feel grateful to have survived.

  9. Non-Judgmental: 0 - no marks were given for these cases:
    4:12 We have to just make better choices in the future (rephrase). 5:30 We live and we learn from our mistakes (rephrase). 9:05 No it's just a matter of just learning (caller asked if there was something that was making her not a functioning adult). 14:53 Pretty sure that she wants you to have friends (we don't know this)
    2:45 He is at that age, as much as you try, there is the defiance (rephrase) 7:06 He's going to make your life hard. 21:15 Next thing you know, he is 25 and living in your house and still doing the same thing.
    1:51 I'm sure that you mom would want you to live your best life even though she is not here anymore (rephrase). 1:57 I'm sure your mom wants what is best for you.
    5:28 That doesn't sound right, a therapist shouldn't say those things…I would walk out of their office and find a new one (therapist). That is discarding. (rephrase) 7:14 IDK we can't do therapy on the phone, it could be that you have to look at your mom and maybe find out that she was wounded. 10:01 Doesn't sound like you had the best therapist years ago and you deserve that (to have a supportive therapist).
    1:57 I know that it's heart breaking right now but it's a good thing that he finally told you about it and was honest with you and that lets you heal from that and move to somebody who is going to treat you right and be upfront with you and make you a priority because you deserve that (careful with this wording). 2:43 You deserve to be somebody's priority and someone who is going to give you all their attention (rephrase).
    5:44 Great, because you don't find that often anymore (not wanting to be on their device). 10:27 The oldest one saw so much and now he is taking on the role of protector. It may take time. 14:15 This is just a temporary situation, it isn't the final chapter in your story, things will progressively start to get better as the kids start to heal (we don't know this).
    5:52 Sometimes they don't realize that can be taken very seriously and especially with her making those remarks as well. 9:58 That is unfortunate that dad is teaching her those ways and behaviors as she is getting older. 10:22 That is that difficulty of not knowing what he is communicating with her before she comes over.
    4:47 I'm guessing you also don't want to be the type of partner who tries to control what your partner thinks, right? Because that's not healthy.
    1:44 And you don't want to lie on any forms if you're not married…you could get in legal trouble. 4:58 So what if your parents get mad? What are they going to do? 6:09 Your parents can't stop you from doing what you want to do as an adult. They don't have any say over what you do. You get that, right? You can do whatever you want,  you're an adult. They can't control what you do. 7:33 Even if you're on the Autism spectrum doesn't mean that you can't have whatever life you want. The richest man in the world is on the Autism Spectrum, Elon Musk, he does whatever he wants. 15:28 They may be upset but they don't sound like the kind of people would hold it against you. Maybe once they get over the shock, they will be fine. 15:42 Maybe they don't see you as somebody who would get married, but that's what you want. 

  10. Clarifies non-suicidal safety: 0 - no marks were given for these cases:
    10:40 Caller mentioned DV issues - living separately, 11:26 husband is not mentally stable (safety needs to be discussed before providing this option).
    Her ex slit her throat and her wrist. Other son beat her up and choked her. Seems in the past - does not clarify that the caller is now safe from this.
    5:23 Is a rape victim. Not reported. 5:55 Happened when 15. 9:35 Has thoughts of self harm.
    7:42 Her father's dad takes her and brings her back with her lip busted. Asked caller about this but then let it drop. Should have educated caller on what to do with concerns. 9:05 Changes subject back to finding job.
    Should have asked about the injuring statement.
    0:44 When was the last time you self-harmed? In the last month, tiny bit a couple days ago. Does not talk about means restriction.
    2:31 States that she smacked his arm, he scratched her.
    2:38 If you feel that you are unsafe or at that level, that is the route to go. Checks if there are other children in the home. Checks if there are people to reach out to from their Family Support Agency. 11:17 Caller mentions that he might have a weapon...but then says that it is just a crew? CC does not ask about this.
    1:57 Was abused by his mom's ex-boyfriend. 7:46 Was sexually assaulted in his house (by the ex-boyfriend). 10:23 Admits his dad physically assaulted him and threatened to kill him 2 years ago and earlier in life put him in dangerous situations. 
    1:23 I'm not really thinking about self-harm. 2:08 When younger thought about sexual relationships with kids. 3:01 Exposed to it (being gay) when young. Is now desensitized. 3:29 Haven't seen real life. 5:55 No thoughts of self-harm.
    "10:41 Friend's dad acted weird around her. Her mom threatened to call the police. 10:53 When it comes to your friend and her dad, how are you feeling about the whole situation? Idrk cause I feel he's just a nice person but my friend has told me some weird stuff about him Plus his wife constantly says he's a pedo and stuff And ig my has a point because he has done some questionable stuff 11:09 If her dad has to go to jail or gets into big trouble because of me 
    It would ruin their family cause he makes all the money Did something happen?"
    0:41 Are you actively bleeding right now, like how bad did you cut yourself? Not anymore, still red but , not actively dripping anymore. 1:05 I just want to make sure that while we are talking you don't need medical attention or anything. Caller: No, I'm alright, thank you though. 19:51 Caller comments that he is bleeding. CC: 20:03 Did you say that you're bleeding? Caller: Yeah, bumped a scab. Where is the instrument that was used to cut? 16:37 A couple of years ago on July 4th, his dad launched into him, he got slammed into walls, choked (this is not in the notes).
    Have they done anything to injure self? Do they have means with them?
    0:54 I want to hurt myself - does not ask more about this. 1:22 Took Lorazepam hoping that would help. 1:28 When did you take that? An hour ago. Feels that her meds are not working.
    3:17 Is in a program for self-harm. 4:47 Mom was trying to take her to the hospital. Did they self-harm?
    Was chased by 3 people. Safe now. 13:57 Girlfriend stabbed him in the stomach. 19:37 Can I tell you one last thing before you hang up? I think there is someone in the store looking for me 20:31 Oh my god no - may have been laughing (both of these were brought up while CC was trying to wrap up the call).
    1:31 They are not my parents. 1:48 When I was 5 she fell off the bed while her dad tickled her. Her dad dealt with drinking. Mom dealt with depression. They did not do parental things. 7:05 Grew up in a household with a sex offender. Did not ask if this was still happening.

  11. SSA: 0 - no marks were given for these cases:
    9:46 Caller: I'm ready to give up on myself and I can't for my kids. CC does not respond to this or acknowledge.
    0:22 I'm not thinking, or I haven't done it, haven't done any abuse or anything along the line of that. (CC does not acknowledge). Very vague - is he talking about suicide?
    Does not assess.
    0:15 Caller: I have a huge knife - 12 inches long, just indulged in another incident of desperately slashing my arm. I need to know why I shouldn't just finish the job. 14:42 Caller: I can't keep doing this. Something has to change.  I have to find something worth living for. 17:57 Caller: mentioned suicidal thoughts to his mom, she thinks that he is just being dramatic. I kind of want to do it, just to see what her reaction would be, not that I would ever live to see it. Like is this proof enough for you mom? 20:27 Were you cutting yourself as a coping mechanism or to end your life? I have tested multiple different ones, even if I really wanted to, like dead set on it, there is not a knife in this house sharp enough to actually do it. But, the plan for ending my life was just to drive a knife straight into my chest, that they can do. I do it to cope with life. Caller mentioned plan - Are they having suicidal thoughts tonight? Have they attempted before? Told CC answers to LRA - did not ask.

    SSA 1 mark was given for these cases:
    Did not complete SSA. - 3rd party
    1:10 Your friend didn't mention suicide, right? Due to the seriousness of the situation - focused on friend's safety. Caller is with her mother. Does not ask caller about suicide - caller is safe, is with mother. 13:36 Mother states that she sees her daugther that she looks so sad and that she is concerned about her.
    Third party - no assessment made.
    0:28 I'm not necessarily considering suicide, I'm just stressed. 9:37 Caller states that they have an extensive psychiatric history, has been inpatient 7-8 times (mostly in high school). CC does not acknowledge or clarify.
    Did not assess for lethality. 3rd party.
    0:36 Caller: really scared that I am going to hurt myself. 0:42 When you say hurt yourself, do you mean as a coping mechanism or to end your life? Just to cope, I don't want to die. Does not ask about the past.
    9:06 Are you having any thoughts of suicide? Umm..I've really been through a lot with her, I have no feelings towards her anymore. She is why I feel so numb. Does not answer the question.
    12:06: You're not thinking about ending your life, are you?
    13:50: Are you thinking about hurting yourself? Does not use the word "suicide".

    SSA 2 marks were given for these cases:
    0:25 Caller volunteers she is not suicidal. 0:36 CC acknowledges (above). Should have confirmed understanding of  Suicidal Safety and asked about Past attempts.
    Failed to ask about past attempts and plan.
    Caller was suicidal but did not ask about past attempts or current plan.

    SSA 3 marks were given for these cases:
    4:03 He is not suicidal, he has the same ideology as me, killing yourself doesn't make sense. 14:26 How are you doing today? I know some parents in your situation have some thoughts of suicide, how are you doing? I am good, I don't get that. Does not ask about the past.
    3:51 Is that a suicidal thought? I was not thinking about killing myself. 4:10 Do you have thoughts of suicide today? Only in kind of way that people are tired. Does not ask about the past 2 mo.
    7:28 I'm not going to kill myself. 8:09 CC clarifies - not having suicidal thoughts? No Does not ask about past thoughts.
    15:52 Have not had thoughts of hurting myself but thoughts of wanting to die. 16:38 Have you had any suicidal thoughts? No, not really, just in my head. Not want to take my life but losing my motivation. Does not ask about past.
    6:12 I don't want to do anything but wants a reason for her death. 8:44 Are you having thoughts of ending your life too? It's a mixture. While driving, she had thoughts of driving off, but can't do that. 9:32 Getting really scary because she really considered, didn't do it because she did not have notes for her family and their feelings. 11:41 Does not see the good in herself. Is sitting in her car pulled over. 27:03 Didn't have intentions until today. Did not clarify/ask about past attempts.
    8:54 Are you having any thoughts of suicide at all? Not tonight. Always has thoughts. Does not ask about past.
    6:39 Any thoughts of suicide? Yes - no plan. Has both suicidal thoughts and thoughts of self-harm. Did not ask about past attempts.
    13:10 Are you having any kind of suicidal thoughts or anything like that? No, I'm fine. Does not ask about past attempts.
    7:38 Were you having any kind of suicidal thoughts or anything this evening? Not today but recently yes but not anything too serious, just wanting to get away. Wishes that he could get away - go somewhere. Does not ask about past attempts.
    13:44 Any thoughts of suicide? No Does not ask about past.
    8:56 Is this stress causing you to have any thoughts of ending your life? No Does not ask about past.
    6:01 Currently no thoughts of suicide? Or any thoughts of ending your life? No Does not ask about past. The ask is borderline telling. NOTE: Ask SSA (LRA) question as written in CMS.
    0:50 Thinking about injuring himself. 0:59 Are you having thoughts of suicide today? Not really today but the other day he was. 11:27 Be aware of that (stay on top of the feelings). Does not ask about past.
    0:11 States right away that she wants to hurt herself. 0:21 When you say hurt yourself, tell me a little bit more about those thoughts, are you thinking self-harm or suicide? Self-harm, does not want to stop existing. Does not ask about the past.
    7:48 Is this giving you or your wife any thoughts of suicide? Are you thinking of ending your life? Wife has ups and downs. 9:04 Are you yourself having any thoughts of suicide? No, don't have time for that nonsence. Did not ask about the past.
    5:06 Did you do this to end your life? No, I don't want to end my life, I'm not suicidal. I just wanted to punish myself. Does not ask about the past.
    2:58 Are you wanting to end your life by using at all? No Does not ask about the past.
    Texter: 8:50 I'm having thoughts of suicide and self-harm. 8:55 Do you have a specific plan for trying to end your life or self-harming tonight at all? No not tonight but if so I would be using a knife. 8:57 Do you have a knife that you can use already? 8:57 Is it with you right now? No but close to room. Does not ask about the past.
    0:14 Not suicidal or anything like that. 018 Uh-huh 11:44 Suicide, that's just terrible. CC: I know, I hear you. In the past his daughter was suicidal. Responds to statements but does not clarify. Caller prays at the end for JP's work. Does not ask about the past.
    11:16 Any thoughts of suicide? No 12:07 I'm suicidal, ideations in the past, but not something that I'd do. Does not clarity when the ideations were or clarify past safety from suicide.
    27:11 An hour ago - told a friend that she is going to kill herself.  27:36 CC you have worked so hard through all of this, you have worked and worked and worked. 20:32 Do you have a plan? I don't have a plan - tried 6 years ago, has always tried with pills. Does not ask  have you done anything to harm yourself today.
    6:10 As we talk today, are you having thoughts of suicide? A little bit 6:15 Would you say these are general thoughts of suicide? Or do you have a plan to end your life? Just general thoughts rn 6:48 I do want to check as we are talking, Aubrey...are you safe from suicide today? Yea Does not ask if they have done anything today.

    SSA 4 marks were given for these cases:
    8:08 With everything that your going through, any thoughts of suicide today? No 8:21 Have you had thoughts of suicide in the past 2 months? No
    7:22 Is this situation causing you to have thoughts of suicide? Yes, trying to avoid them, can't do that to friends and family. 7:46 Any attempts? Had one, 11 years old by almost slitting neck.
    5:40 Are you having any thoughts of suicide today? Previous attempts, do not have suicidal thoughts, but have always had the idea of suicide in my head. I don't want to do that. 6:14 In the last couple of months? No, a year since last attempt.
    Caller right away states that they are really suicidal. 0:12 Have you done anything in the last couple of days to try to end your life? Yes, tried to OD today. 0:36 Is there anyone there with you? Husband. He is aware that she is depressed. 9:32 Verified husband's current and past suicidal safety. Verifies that the caller's husband is able to take her to the hospital. Focused on the present due to lethality. Follows CMS prompts.
    0:23 I'm not suicidal. CC: ok 1:56 I hear you saying that this is not brining up thoughts of suicide right now. 7:40 In the past 2 months have you ever had those thoughts of ending your life? No - 10 years ago.
    4:34 Texter - I really just wanna end it all. 4:36 When you say you want to end it all, are you saying you are having thoughts of suicide today? 4:38 Do you have a plan for ending your life today? Soon, this month or next month. 4:51 I wanna kill myself I'm too scared to do it. 5:40 States that she had thoughts in 4th grade and in 6th grade. 5:48 No specific plan.
    12:13 Thoughts of suicide? No In the last couple of months? No
    3:06 No intention to harm myself. 5:28 Are you experiencing any thoughts of suicide today? No 6:15 Any of those thoughts in the past 2 months? No
    1:35 Are you having thoughts of suicide today? I don't want to hurt myself, I don't plan on it, and I never have but I feel like the world would be a better place without me sometimes. 2:02 Have you done anything today to try to end your life? No 2:55 Have you ever attempted to end your life before? No Dad committed suicide though and some other family members, I always thought it was really selfish. 6:07 It doesn't sounds like you have a plan (caller confirms). 6:45 Just making sure that I am on the same page, have you ever had thoughts of ending your own life? No
    Caller states right away that they are not suicidal. 18:28 Are you having any thoughts of wanting to end your life tonight? No  18:37 Caller: I have been passively suicidal for a long time, this isn't a new feeling. 18:52 But no attempts? No
    4:48 Suicidal thoughts? No just a lot weighing on my mind. 6:29 Last couple of months? No
    9:31 Any thoughts of wanting to end life? No 9:58 In the last 2 months? No
    6:36 Are you having any thoughts of suicide? Kind of 7:20 As far as having thoughts of suicide, you said kind of. Caller: It's nothing planned. 13:12 Have you ever attempted suicide before? Yes, 2020.
    5:03 Suicidal thoughts right now? Not right now. 6:17 Have you had suicidal thoughts in the last 2 months? Yeah, I've had them but never thought of them too hard because I don't want to make people sad. 
    3:01 Are you having thoughts of suicide today? A little bit Have you done something today to end your life? No Do you have a plan for ending your life? Not really Nothing I really planned out- just ideas. Have you ever ended your life before? No, I've threatened to but didn't. 7:45 Is able to stay safe and call back.
    7:51 Any suicidal thoughts today? No 8:04 Thoughts in the last 2 months? No
    0:32 Having the bad thoughts. 0:51 Are you having any thoughts of suicide? Is that what you mean by bad thoughts? Yeah 1:10 Have you done anything to try to take your life today? No 1:18 Do you have any plans to take your life or just thoughts? No plans, haven't done anything but the thoughts were bothering me. 6:25 Have you ever tried to take  your life in the past? No 6:33 Are these just recent thoughts? Here and there in the past. 14:35 Safe from suicide.
    0:31 Caller: Feeling suicidal. 0:51 Have you done anything already to try to end your life? No 0:55 Do you have any plans to take your life or just thoughts? Just thoughts. 3:47 Ever tried to take your life in the past? Never tried. 10:07 Are you able stay safe? Yes, invites to call back as needed. Caller agrees.
    8:50 Clearly you have been going through a lot of depression and stress. Have this been causing you to have any thoughts of suicide? Yes - thoughts 8:55 Have you done anything in an attempt to end your life today? No 8:56 Are they still just thoughts or do you have a plan to end your life tonight? Just thoughts, feels they could get worse if evicted.
    7:20 Any thoughts of ending your life or attempting to end your life? Sometimes 8:07 Any thoughts like that tonight? I feels she would be better off without me. Plan? Just thoughts. 11:58 Have you ever attempted on your life before? When 16.
    9:25 Sometimes people in your situation have thoughts of suicide, are you thinking of ending your life? Yeah 9:33 Have you done something today to end your life? No 9:35 Do you have a specific plan? No, something would have to happen. 9:55 Attempted? Yes, August, What was your method? Overdosing, no help. 10:40 Does anyone know about it? No 15:53 Asks about details of the overdose. 26:58 Do you have any meletonin or vitamins - talks about just putting out what she needs and then putting the rest away, caller agrees.
    2:01 Any thoughts of suicide today? No Did not ask about past - possibly inappropriate caller - good judgement in keeping call moving.

  12. Exploration of buffers: 1 full marks were given for these cases:
    Has some friends who were supportive. Is willing to call referrals. 
    5:49 Helps that I spoke with my priest.
    14:06 Going to therapy has been helpful. Goes to AA -is 6 months sober.
    has a friend, is trying to plan Uncle's funeral, has family that will be supportive.
    Has her best friend and her kids. 
    Note: More support in NE, motivated to find help.
    Girlfriend is sometimes supportive. Open to counseling. 
    Has a girlfriend. Wants his parents support. Talked to his uncle and grandfather.
    Lives with her mom. 
    Has a therapist
    Live with her parents, has friends, an aa sponsor, doctor, and therapist
    Mom, therapist,
    Has a job. Has lived with his dad. 15:41 Has been trying to be clean from smoking weed.
    Campus services, roommate, parents
    Mom is there with her.
    4:54 explores therapy, mom knows about thoughts. 5:26 Is there someone that you can talk with about this? 
    12:58 Asks about supports. Therapist, school
    Psychiatrist, 17:29 No family support. 18:01 Couple of friends. 
    With boyfriend who is supportive and with them.
    8:36 Is it just you or do other people live with you? 8:39 Do you have some people that are supportive of what you are going through? Son lives with her. 
    Husband is there but does not understand. Has a 7 y/o daughter. 8:51 Sounds like you love and care for her a lot - Oh I do. Tries to go to AA when she is able to. 
    10:58 A couple of friends know, they are being supportive. 11:31 What about your folks? Did not tell them. Parents don't know about attempt. 16:49 Has some old friends.
    Neighbor is there - mom is coming home. 
    Is there with her husband
    Oldest daughter is helping out.

  13. Restates then Collaborates: 0 - no marks were given for these cases:
    6:03 You can always do you and be an advocate for good, we have control of how we react. 8:38 What is the next step? Focus on college tests? Is home schooled. 10:15 Keep working on that though (classes). Tells caller what to do.
    2:33 I think being able to communicate would be best for all of you. You need to express what you think. 8:03 Being more open about it and being specific instead of holding it in. (Tells what to do - does not ask). 9:35 Caller states he has been studying his Bible. 10:00 Is worried that her feelings will get the best of her. 18:25 Try to be supportive, ask questions. 19:28 Not telling you what to do, these are just things to think about. Gives advice.
    9:17 How do you find yourself coping with this situation at hand? Waking up, waiting for the day to be over. 11:02 Encourages caller to find small wins. 12:37 Encourages caller to give self a quick break/check-in. 16:52 Any plans for the rest of the evening? Doing nothing, scrolling online. Not be productive. 17:44 Would like to watch a movie.
    11:34 She needs to show her that your love for her is stronger than your fear of your parents being upset with you. 12:22 If you are not interested in what they say, you can say, I love you and leave the room or go for a drive. 14:43 You can always get a divorce if the marriage doesn't work out. Tells caller what to do does not collaborate. Does not restate Primary Concern to guide into Collaboration.
    4:27 As far as jobs go - do you think that you would be comfortable working a job where you don't have to interact with people much? 6:24 Do you think maybe that is where you can start at (potty training)? 9:36 Talks to caller about setting short term goals for employment. 12:35 Talks about taking 20-30 minutes each day to take time for herself. 14:28 Talks about updating resume. Restate the Primary Concern to make sure that you are on the same page as the caller, invite them in to the Problem Solving Process. Should have offered the caller resources. Should have collaborated with caller it is all one sided. Tells caller what to do.
    9:27 I think what needs to happen at this point, is you need to get yourself in a shelter. Tells not collaborates. Get a job (has one). You're still the father (caller: IDK). 12:58 Do you think that you could look for a shelter today? 13:37 Let's look and see what we can find. Caller: IDK, I don't think I am ready for that. I can do that on my own if I want to.
    3:44 You definitely need to set some boundaries. 4:42 You really have to set those rules. Caller feels that he has to call the authorities. 7:54 If your intuition is telling you that, your intuition is always right. 12:05 parenting.org, Love & Logic - you take total control and put it all on them. Kind of funny how it works. 17:59 Recommends bringing child to the doctor. 19:02 Gives YLYV.
    4:40 Asks if there is a mutual person to help. 6:20 It's your life story - you have to think about how you feel. 9:07 Gives YLYV- tells about the dating topics. Ask the caller to collaborate with things that they could do, CC is too directive, telling the caller what to do.
    9:59 Is not in active therapy. 10:15 Caller: I needed to just get this out and not be talking to myself. 12:28 One thing that I was going to recommend is giving him some space, but if this is kind of a trend, you might just have to ask yourself if it is worth it if it is taking a mental tole on you. 12:45 I understand this is 20 years, so that is a lot to think about. 15:59 Talks to caller about taking a break and see if the distance improves things. Do things that he enjoys, take care self. Take things 10 min at a time. Needs to invite the caller into this process.
    37:20 Is not going to respond to the attorney. Stated talking helped.
    6:54 Do you ever talk to your school counselor? No 12:32 Do you feel like this is something that you want to tell your mother? Yes. I can help with that. 15:01 But you have to find those things that help you to feel like you belong there (ask instead of tell). You know like friends, activities. I have friends, but it's like nothing can stop me from feeling this way.
    9:47 Talks to caller about using resources. Caller is frustrated as she has reached out to many organizations and has not seen any results. Gave referral for Autism Center. 13:27 I would start there. Tells caller what to do - does not pay attention to what the caller is saying.
    Caller: Every morning takes a walk. 16:48 Encourages to take some breaths and relax. Collaborate more about the current situation. How are they going to handle their current fears?
    4:11 Have you been able to look into the resources for your school? 4:49 It's really good to communicate those struggles. 7:41 I think if you start finding some success in some of that. 8:10 I'm not saying that it is all the answer but it really could be something that could help. 8:33 How have you been coping with these feelings when your mind starts to overthink? Take a step back and pick self back up. 9:32 You might learn differently and having help to find that...would be something worth looking into. 13:38 What do you think  you will do with the rest of your morning to take a break from your thoughts? Is going to try to do something that distracts him. 14:18 Talks about how to look at what is in their control. 14:25 CC: Could get on school website and see what would help.

    Restate then Collaborates: 1 full marks were given for these cases:
    1:35 It's a matter of making sure that that person has your best interest in mind…you just got to get to know that person. Does that make sense? 2:59 Talks to caller about possibilities of getting caller back. 7:14 You could possibly ask your mom and your friend not to talk about politics.
    3:52 Sounds like you have exhausted all your resources, he's not following instructions. 5:42 Are you looking for a residential facility? 11:48 Might be best to meet with the principal to go over the legal aspects.
    4:42 Does anyone else know how you're feeling today? No Lives with her parents. 5:24 Does anyone else know about your self-harm? My cat. Used to work with a therapist. Doctor prescribed the medication, does not know about self-harm. 10:08 Do you have time to sit and think about what you can do for yourself?
    8:03 Provides YLYV links  - Waiting for the Storm to Pass, Your Safety. Texter has limited responses.
    7:21 Caller states that she writes things down. 17:15 Being friends and supporting each other is something that you can do if you want to continue. 17:23 With all of this going on, what are some coping skills that you have used in the past that have worked for you? Has always used drugs - stopped 2 months ago. Talks to herself. Is seeing a therapist. Goes into a trance. 19:05 I would like to suggest that you have been doing deep breathing, you could do that. Encourages caller in this. 21:41 Offers 99 Coping Skills - explains temporary escape.
    6:22 Caller states that she want CC to call the police. 6:41 Asks if she should get her husband up. 7:11 Encourages caller to be seen by a doctor. Default due to high, 3rd party.
    Seeing her therapist today - CC shows interest in this. 17:47 Helps the caller to see the little things. 18:16 Points out the positives with mom.
    9:01 What is going to be the most important focus for you? Find a place that is closer to his work. 10:58 How are you going to find an apartment? What method are you going to use? 15:36 Encourages caller to think about things one step at a time and think about the things that they can control.
    4:58 it sounds like you would like to be able to find ways to be more like your normal self, and have those goals and plans again. 5:07 Do you feel you have been able to say that to your mom? 5:21 Have you ever explored anything like grief counseling, or talked about that at all with your mom? Going back to counseling in January. Started talking to her school counselor today.  6:11 CC shares YLYV.
    4:18 Caller asked about therapy. CC: Yeah, we have referrals, that would probably be a great idea. 8:19 Gives Psychology Today.
    5:22 Talked to caller about writing out where she has been and doing some box breathing. 8:08 What do you like to do to distract your mind and lower your anxiety? Watch Netflix and read a book. CC: I love good mystery books. Going to school with her mom tomorrow. 9:50 Caller confirms that talking helped a lot.
    3:21 Do you have support from anyone outside of the house? No mom lives with her and it is sometimes not helpful. 5:02 Asks about routines - homework, wrestling, robotics. 6:41 What does the positive reinforcement look like at home? 7:12 If you could change one thing, what would that be? Be home more. 9:07 Tries to encourage her kids to have a positive relationship with their dad. 11:25 Is thinking about getting the kids into therapy. 11:46 Encourages the caller to take deep breath. 14:58 Encourages caller to reach out to their doctor and  school counselor. Gives parenting.org. Gives YLYV for the boys. Might have EAP resources. 17:36 Talks to caller about self-care.
    3:49 Have the two of you ever tried family therapy or counseling? 6:12 Encourages caller to seek a primary care physician or a psychologist as they can diagnose and see if there is something more kind of going on or if there is something that may have happened that is a trigger for her as to why she makes those accusations too as well. 11:31 If she is having those suicidal thoughts but she has stated that she has a plan to act on it or has done something to end her life definitely send her to the E.R. 
    3:26 Directs caller to take a deep breath. 4:29 Checks if this helped. 4:55 Shared this with her partner. 8:10 How have you been managing this in the last 6 months? Seeking fulfillment from other people. 11:20 This is the trick question, the million dollar question, did you ever talk to a therapist (strange wording). 13:54 Would you like to hear about this therapy that might be able to help? Explains shoe box therapy
    10:53 Best friend knows of her struggles. 11:24 Tells about shoebox therapy. 11:26 Loves to write/journal. Shares YLYV Coping Skills, Find Your Motivation

  14. Identifies Concrete Plans: 1 mark were given for these cases:
      13:36 Do you think that you will be able to keep safe? Need sleep. Does not talk about future safety/crisis.
      23:46 Maintain my happiness. 24:38 Is going to watch a movie/wash dishes.
      12:33 Keep an eye out on her, talk to her as much as possible, and  just letting her know too that you are there for that support for her emotionally…letting her know that you are there to take care of her and protect her…letting her know if she consistently making those statements you will have to take her to the E.R. to speak with someone about what is gong seeing if there is more that they can do to help. Caller agrees. Does not talk about ways the caller can take care of her own mental health.
      Is willing to try Shoebox therapy and YLYV links. Should have talked more about what to do if the crisis re-occurs.
      13:22 Is going to call the referrals.
      Should have focused on plans for tonight - what are they going to do right now? 18:34 Will be ok for tonight. Will call as needed.
      9:59 Is going to look up churches, get something to eat, try to get some rest. Should have planned more for the future if in crisis again, specifically related to the suicidal comments about future safety.
      27:19 Will try to be safe and call before doing anything, he will try his hardest to refrain from doing it. 29:10 I appreciate you talking to me and giving me advice. 30:51 I really do appreciate you and I will try to refrain. 32:52 Will think about the future. Be more concrete on what to do for right now.
      Talking helped, agreed to reach back out. What are they going to do right now?
      No plan. Caller hung up but was appreciative of being able to talk. 12:58 Thank you so much, I really appreciate it, bye.
      Is going to call resources. Thanks CC.
      26:01 Is going to try to sleep then go to work in the morning. 26:54 Do you feel like you'd be able to stay safe from ending your life tonight? If you have strong feelings come back do you think that you could give us a call back and talk? Sure. 27:21 I (can't) promise I am not going to harm myself, but I will definately do my best to stay see if it ever gets better. CC encourages caller to take it an hour at a time. Plan does not address means reduction.
      11:28 Caller: I'm going to be ok. Will turn on a movie and do make up. 14:05 Caller: I think that I am out of the manic part of this. 14:23 Thank you so much, I appreciate it. (this is in response to invitation to call back). Plan does not address means reduction.
      6:05 Of course, we are here to support you. 6:49 Caller: I do feel a lot better, getting that all off of my chest now. 6:56 CC: We are so glad that it is helpful to talk about it a little bit. We are happy to help with that also. 11:11 Caller: I can't express more gratitude for you just being here and for what you do and I appreciate you. 11:54 Caller: I feel so much better getting that all off of my chest and knowing that you guys are here for me is more than anything. Plan is somewhat implied. Make a more concrete plan for right now and in the future. Consider supporting the caller by telling them about YLYV.
      Is safe from suicide - will call back. What is she going to do now?
    
    Identifies Concrete plan: 2 marks were given for these cases:
    12:38 Will watch videos about ESL teaching, 13:15 Is going to go to church, 14:13 Gives YLYV, 16:08 Is going to talk to her mom.
    16:55 Gives referrals, is going to talk to the school about the situation. Invites to call back if needed, caller agrees.
    Agrees to reach back out, talking has helped. Will decide about school.
    7:44 Just took a shower, will look at YLYV, will reach out as needed.
    21:23 Open to deep breathing. Loves her mom. Has a doll from her mom that she talks to. 26:17 Is going to go to bed. 26:26 You sound a lot better after talking, caller agrees.
    CC speaks with the caller's husband. Default due to high, 3rd party. 13:12 Caller agrees to be safe while husband takes her to the hospital.
    Is thinking about getting something to eat (smoothie), getting some gas. Going to her counseling appointment, is going to tell her about her SI thoughts and call to 988. Feels a lot better after talking. Can keep herself safe. 28:10 "I want to thank you Claire, I was praying that someone could help me see the good in me and that person was you." Yes, will call before acting on any thoughts.
    16:31 Is going to call his brother after the call. 18:28 Is going to cook tonight. 21:04 Is going to move into his little room at his friend's house. 23:40 Is going to the bank tomorrow. 26:04 Will call back as needed for support or if thoughts of suicide.
    6:00 Watches Grey's Anatomy. 6:12 Will look at YLYV. 6:15 Will text again if not safe from suicide.
    Will check out referral, will call back.
    Agrees to call back if having thoughts of self-harm. Is going to search her room tonight and the car tomorrow. Will read or watch Netflix.
    Will try to take 5 minutes for herself per day. Is going to get back to work. Accepts follow up call. Agrees to reach back out as needed.
    16:33 You can always reach out to us. 19:27 Relax tonight. 19:40 Agrees to try to get out tomorrow. 19:55 Invites to reach back out - caller agrees. This should have been more concrete.
    19:08 Is going to work on shoebox therapy. Hoping to get back into counseling. 18:52 If it doesn't work then give us a call back and then we'll discuss other ways to help you. We'll get through this together. Caller: ok, I'm going to do it when I get home.
    15:03 Melanie, I appreciate you so much, thank you for your time. I'm not kidding when I say it, I feel 20x better. Going to AA, dinner with his brother, agrees to call back.
    18:31 Is going to Walmart, needs to mail some cards. Is looking forward to Christmas. Is going to keep working with her support system. Will call back as needed.

  15. Appropriate Termination: 0 - no marks were given for these cases:
    15:40 Reminds caller this number is here 24/7. Should have offered a Follow Up call.
    Did not offer follow up call
    CC stated "I'm going to have to let you go."
    17:02 - "I'm going to have to wrap up here in a few minutes."
    15:55 - "We're a short term crisis line so I can't talk much longer."
    No follow up call offered
    21:17 Assures caller that they can call anytime. 26:58 Assures that we will be there for him. Should have offered a follow up call.
    Invites to call back anytime. Should have offered a follow up call.
    28:04 We're always here to support you if you need it. Should have offered a follow up call. 
  
  16. POP Model - Does not RUSH: 0 - no marks were given for these cases:
    1:35 Tells caller what to do.
    5:42 Goes to the fix - no reflection
    2:34 Do you feel that you could reach out to the professor or teacher? 4:42 Jumps to Options before reflecting. 
    6:03 Rushes to Options before fully understanding the problem.
    2:33 Goes to the fix.
    3:49 Rushes to fix.
    4:44 Does anyone know how you feel? Lots of turns in Call Model.
    2:50 Does anyone else know how you feel?
    Goes to the fix. Very little direction to the call. Does provide referrals as the caller asked.
    Does not reflect - call escalates 
    4:27, 6:24 Asking but looking for the fix rather than providing support and resources.
    1:09 Rushes.
    2:35 Rushes
    4:54 Are you in therapy? He is calling us to help him.
    Rapport skills are only very late in the call after problem solving has occurred
    During Problem portion - reflect and explore.
    2:43, 5:44 Rushes to the fix.
    5:06 Rushes - turns towards others.
    0:51 Rushes - reflect, listen, explore.
    0:41 Rushes - does go back to Problem but this is led by caller.
    20:37 Explore more before asking about talking to others.
    3:09 Rushes - Asks about therapy.
    6:54 Asks about supports before understanding the problem.
    4:18 Rushes to supports.
    0:58/4:54 Jumps to PS before understanding the problem.
    4:14/6:09 Goes to Options (somewhat caller led). Asked SSA very late in the call.
    0:55 Goes to resources.
    2:04 Rushes to fix.
    Rushes (2:02, 2:43)
    Rushes (1:14)
  
  17. POP Model - Does not Dwell: 0 - no marks were given for these cases:
    CC could have guided call more effectively especially when caller mentioned things that would help his situation - going to work, staying with a friend, calling his brother who is a support and might know what to do (is in the military).
    Does not guide de-escalation
    Gets stuck because of lack of Collaboration, because of telling caller what to do loses energy from caller.
    Call drags on a bit - asked things more than once (different ways so it is not a values the person issue).  CC does not guide call to keep it moving.
    Let caller talk for over 20 min with minimal reflection.
    CC lets caller talk for too long before guiding call.
    Should have guided call more.

  18. Greeting: 1 full marks were given for these cases:
    (BTNHL means Boys Town National Hotline)
    Hello, BTNHL, how can I help you?
    Hello, BTNHL, how can I help you?
    BTNHL, how may I help you?
    BTNHL, how can I help you?
    BTNHL, this is Pablo, how can I help you?
    NE 988, how can I help you?
    988 NE, this is Brita, how may I help you?
    BTNHL, how may I help you?
    BTNHL, how may I help you?
    Boys Town Hotline, how can I help you?
    Boys Town Hotline, how can I help you?
    Hello this is 988 NE,  how can I help you?
    Hello this is 988 NE,  how can I help you?
    Thank you for calling BTNHL, how can I help?
    Good Morning, thank you for calling BTNHL, how can I help?
    Good afternoon, you have reached Boys Town Hotline, can I help you?
    Good afternoon, this is the Boys Town Hotline, can I help you?

  ==============================
  END OF IMPORTANT EXAMPLES FOR EACH RUBRIC ITEM
  ==============================

  ======================================
  IMPORTANT INFORMATION AND INSTRUCTIONS
  ======================================
  **Below mentioned are some very important RULES AND POLICIES that you need to take account of while grading transcripts based on the Rubric**
  Transcripts must follow these guidelines and grades will be given based on how accurately the guidelines are being followed. Give full score for a metric only 
  when all the requirements are met. If the requirements are not met, give the lower score based on the rubric. 

  ==============================
  Required Lethality Risk Assessment/Suicide Safety Assessment
  ==============================
  Questions:
  1. Sometimes people in similar situations to yours have thoughts of suicide. Are you thinking of ending your life?
     If yes: Have you done something today to end your life? (In general, within past 48 hours)
     If not: In the last 2 months have you thought about suicide?


  ==============================
  Supportive Initial Statements
  ==============================
  Making a connection using a supportive initial state at the beginning of a call is vital to building safety and creating connection.
  Let callers know they reached the right place. Affirm them for wanting to talk about and process their problems.
  Be careful about asking names & ages immediately. Some callers are not comfortable sharing that info right away.

  Examples:
  • You made a good choice to call today, tell me more about what you are going through.
  • You called the right place, we're here to help. Could you share more about what's bothering you?
  • We're a safe place for anybody going through tough times, glad you decided to call today.

  ==============================
  Counselor Response to Confidentiality and Other Sensitive Issues
  ==============================
  **RECORDING OF CALLS**
  The message that callers hear when they reach the Hotline states that we “may use information provided to seek other assistance” & “your call may be monitored.”
  Our legal department wants to make sure we are honest with callers if they ask if calls are being recorded.
  If a caller asked “Is my call recorded?”
  Respond with “Yes, we record calls for quality assurance purposes.”
  If they are overly concerned: “Management listens to the calls to evaluate our counseling skills to ensure that we provide the best possible service.”

  **ANI/CALLER ID**
  If somebody asks if we have Caller ID – Answer: “Yes, it is available if necessary.”

  **CONFIDENTIALITY**
  DO NOT promise or state that we are a confidential line:
  “We keep information private, but if there is a safety concern we may need to involved a 3rd party for additional assistance.”
  When making follow up calls, unless the voicemail specifically identifies the person by name, DO NOT leave a message identifying that it’s the Hotline calling them. Also, only leave a general message that doesn’t include specific content from previous call. 
  (NOTE: Exceptions may be made when the situation involves imminent risk. Check with a supervisor if you have questions.)
  If anyone calls to inquire about a call made by someone to our hotline: “I am sorry; I do not have that information readily available.”
  If they are insistent in getting information, take their name and number for a supervisor to contact them.
  If somebody asks if we keep a record of our calls: “Yes, we keep a database of all Hotline calls.”

  **DISCLOSING PERSONAL INFORMATION**
  DO NOT disclose personal information about yourself. If you are asked, politely reply that you can’t give out personal information about yourself.
  If you are asked about your educational level, tell them that all counselors receive the same level of training to work at the hotline and that beyond that you can’t give our additional information.

  **RELIGION & PRAYER**
  As an employee of Boys Town, Counselors can help clients to explore religious or faith based supports to help a person cope with the issue going on in their life. However, they should not attempt to convert anyone to a particular religious faith.
  If a caller requests prater, counselors should not pray with a caller on the phone; instead, they can offer to connect them to a prayer line listed in the Resources Database. Prayer Requests are included on the incident report so they can be passed on.

  **PREGNANCY**
  Boys Town National Hotline Counselors will not participate directly or indirectly in the cost or actions related to terminating a pregnancy.
  Such prohibited activity includes but is not limited to providing a referral for an agency to perform an abortion, setting up an appointment, transportation to an appointment, encouraging the use of medications (morning after pill) or advising anyone that an abortion is in their best interest.
  Counselors should present alternatives (adoption, kinship, care, etc.) and provide appropriate counseling resources.

  **SEXUALITY CONCERNS**
  If is the position of the BTNHL that crisis counselors will not condone or encourage any sexual activity outside of marriage.
  Callers who present sexual issues should be handled calmly and professionally by keeping the call focused and moving toward a solution. Counselors should provide counseling referral or encourage caller to seek help form a medical professional rather than getting into any specific sexual issues.

  **SEXUAL ORIENTATION & GENDER IDENTITY**
  It is the position of the BTNHL that crisis counselors accept the sexual orientation and gender identity of all those who reach out for services and refrain from passing judgment on these callers.

  ==============================
  REFLECTION OF FEELINGS
  ==============================
  Tell me, how are you feeling about this?  
  It sounds like you are feeling _____ right now.  
  It’s OK to feel ______.  
  It makes sense to feel ______.
  You have a lot going on. (Depression, etc.) is difficult to deal with.

  This situation must be ______ for you.  
  - upsetting  
  - confusing  
  - stressful  
  - difficult  
  - frustrating  
  - overwhelming  
  - isolating  
  - challenging  
  - (avoid “scary” if re: parents)

  What you are feeling right now is:  
  - understandable  
  - normal  
  - complicated  
  - expected  
  - unfortunate

  Avoid “I” and “we” statements:  
  - ~~I am sorry~~, ~~We are sorry~~  
  - ~~I/we am/are proud of you~~  
  - ~~I/we feel bad that this is happening~~  
  - ~~I/we wish I/we could~~

  **Feeling Word Bank**

  ANGRY: irritated, upset, annoyed, insulted, bitter, resentful, frustrated, shocked, jealous, disgusted, furious  
  DEPRESSED: lousy, disappointed, discouraged, down, dissatisfied, miserable, guilty, disillusioned, exhausted, regretful  
  CONFUSED: hesitant, doubtful, uncertain, indecisive, distrustful, skeptical, lost, unsure  
  HELPLESS: alone, powerless, inadequate, victimized, vulnerable, empty, overwhelmed, numb, hopeless  

  ANXIOUS: worried, nervous, unsure, distressed, restless, panicked, uneasy, awkward, stressed, pressured, impatient  
  AFRAID: fearful, threatened, suspicious, frightened, alarmed, concerned  
  HURT: offended, wronged, insulted, rejected, alienated, heartbroken, embarrassed, left out, ignored, disappointed  
  SAD: tearful, unhappy, pained, grieved, lonely, dejected, misunderstood  

  ==============================
  CRISIS CALL MODEL - POP (PROBLEM, OPTIONS, PLAN)
  ==============================
  **PROBLEM**
  1. Build rapport & make a connection:  
    - identify and validate feelings / empathize / praise  
  2. Identify & understand person’s agenda:  
    - hear their story  
    - ask questions / clarify  
    - restate / summarize / focus  
  3. Assess lethality & current safety  

  **OPTIONS**
  1. Evaluate the situation/person’s ability, in order to determine:  
    - what level of control they have of their situation  
    - if focus should be on their immediate or near-future needs  
    - if collaboration is possible or a more directive approach is needed  
  2. Problem solve or discuss situational changes:  
    a) Assume client has their own solution(s):  
        - What would you like to see happen?  
        - What have you tried?  
        - What has worked in the past?  
    b) Offer suggestions:  
        - What would happen if…?  
        - How would you feel about…?  
        - Would you be comfortable…?  
  3. Discuss possible action plans:  
    - Develop a Safety Plan (and disable means) when needed  
    - Explore Coping Skills & Support Systems  
    - Offer referrals when appropriate  

  **PLAN**
  1. Restate and encourage person to follow through with plan/option(s)  
  2. Re-confirm safety plan (when present)  
  3. Encourage future call backs (when appropriate)  

  ==============================
  We should attempt to BUILD BRIDGES between kids & parents whenever possible
  ==============================
  Teens often reach out to us at a moment when they are very upset with their parents—they are angry about a consequence, an argument, chores, etc. As a result, it can be difficult to determine if the teen is contacting us because they simply aren’t getting along with their parents, or if actual abuse is occurring in the home.
  Asking clarifying questions is key to fully understanding the situation. Kids don’t always use the correct words to describe what happened, so the term “abuse” can take on many forms. Remember that you are also only hearing one side of the story at a moment where emotions are likely running high. Clarify; get the facts. If there is a potential need for intervention or a need for reporting, clear documentation on what happened is needed.
  As a Counselor, it is important to remain neutral and to not react on emotion. Be supportive, but avoid using statements like: “you don’t deserve that,” or “your parents shouldn’t treat you that way.” In addition, using feeling words like “scary” or “frightening” when referencing parents can increase conflict and place blame on the parents.
  How to respond:  
  1. Determine first if it is actually an abusive situation or a relationship issue.  
  2. Try asking questions about the parent/child relationship in general:  
    - How do they normally get along with their parents?  
    - What happened today to prompt them to reach out?  
  3. If not clear that it is an abusive situation, discuss what the teen can do:  
    - What can they do to make their relationship better, or avoid these problems in the future?  
    - What can they do to make amends right now?  
  4. Since we can’t guarantee that CPS will intervene with any abusive situation that we report to them, we should also help kids develop a plan for staying safe in the future.  

  ==============================
  WHO SHOULD BE BTNHL CALLERS BE OFFERED A FOLLOW UP CALL?
  ==============================
  **Any caller who would benefit, should be offered a Follow Up Call.**
  Callers who may benefit include those who are:
  • At risk to stay safe for any reason – abuse, self-harm, suicide, bullying.
  • Actively trying to make forward progress on any issue (school related, relationships, parenting, health concerns, life transitions, etc.).
  • Unable to continue current conversation due to bedtime, the start of work or class, being overheard by others, etc.
  • Needing a reminder to engage in self-care.
  • Taking small steps to accomplish a larger goal.
  When deciding whether to offer a Follow Up call, ask yourself:
  • “Will a call help the caller to feel supported and encouraged?”
  • “Is the caller more likely to stay safe with a review of safety plan steps?”
  • “Does the caller lack confidence/unlikely to reach back out again on their own?”
  • “Could a call install hope, especially those with no friends or family?”
  • “Will a call strengthen the confidence the caller needs to keeping reaching out?”
  If the answer to any of the above is yes, offer a Follow Up call.

  **When to Offer 988 Follow-up Calls**
  We are REQUIRED to offer 988 follow-up calls 95% of the time:
  • When the caller has had suicidal thoughts, a plan, gesture or attempt within the last 48 hours.
  • The call back should be scheduled with the caller for 24-72 hours after the original call.

  Exceptions to the above Required Follow-Up:
  • Welfare/safety check as part of a safety plan and completed within 24 hours with the guidance of SC (This is a small number to ensure they are alive)
  • In collaboration with the SC decide what is best for the caller.
  No follow-up required;
  • Callers that have NOT had suicidal thoughts, a plan, gesture or attempt within the last 48 hours.
  • We have sent intervention or MCR (the goal is to connect to local community supports)
  • Treatment plan/ongoing support (these callers know we are a support in addition to the local community supports they have)
  • Out of State (the goal is to connect to local community supports)
  ***Encourage callers to call 988 for support as needed (this is not a replacement for a required call-back, merely good customer service and care)

  Questions/Information to discuss when arranging a Follow-Up Call:
  “Would you be okay if we followed up to see how things are going?”
  • Is it best to call you in the morning, afternoon, or evening?
  • Is your voicemail private so we can leave a voicemail?
  • When we call, you probably won't recognize our number and will leave a voicemail if it is okay.
  • If we miss you, please feel free to call us anytime- We are here 24/7.

  ==============================
  EXPLORING THE PROBLEM
  ==============================
  **Counseling Questions**
  Because an individual may not be certain about what they need or want, it can be a challenge to determine how to best assist them.
  Below are questions that can be used to engage them in conversation, clarify their thoughts & feelings, and promote positive action.
  • For Focusing Callers: Out of all the problems that are overwhelming you, what is the biggest problem we can talk about today?
  • “Magic” Question: If everything were better tomorrow, what would look different?
  • What are your goals? What would you like to be doing in a month? year? five years?
  • If you could change one thing about your life, what would it be?
  • If there were one thing that you wouldn’t change about your life, what would it be?
  • If you could change one thing about yourself, what would it be?
  • If there were one thing that you wouldn’t change about yourself, what would it be?
  • What single experience in the last year has made you the happiest/saddest?
  • What is the best thing that you’ve done for someone else?
  • Who is someone that you admire?....look up to?.....trust? What are small things you could you do to be more like them?

  **Restating/Summarizing**
  Why restate & summarize?
  • Sets a tone for a professional discussion
  • Helps you take control of call
  • Demonstrates that you are a skilled counselor who is listening
  • Helps the individual organize their thinking
  • Clarifies and ensures that you are both on the same page and focused on the caller's main issue(s)
  • Provides you with a framework/transition to move into problem solving

  Examples:
  • So what I am hearing you say...
  • It sounds like the main thing bothering you is...
  • Would it be correct to say that...
  • So today, would you say that the one thing that is causing you the most pain...

  If you leave it out, it can result in
  • Casual conversations that jump around and are not necessarily helpful in the end
  • Multiple topics being discussed
  • Caller frustrated with your lack of understanding of their problem
  • Focusing on your agenda rather than the caller
  • Long call times

  ==============================
  CLOSING STATEMENTS
  ==============================
  **For those times when you are having difficulties Closing the Conversation...**
  We talked about a lot today. Take some time to consider some of the options we discussed before you decide what to do.
  You’ve agreed to keep yourself safe from acting on those thoughts of suicide, so how will you do that after this call?
  I’m glad you reached out, and I hope it helped to talk a bit. What’s on your agenda for the day?
  Using this discussion as a way to... (stay safe, deal with your depression etc..), take some time now and think about your next steps ....
  Tonight you decided to reach out and get some help. After talking a while you said you are... (safe, better, still anxious). What will help you stay on track when we are done talking?
  Your initial reason for calling was... do you feel you have the tools to work through that issue now?
  You did a great job calling and being honest about what you are dealing with; continue to be open and use the skills we discussed tonight.
  You now have some great ideas and tools to use when you feel this way. Check back with us some time to let us know how you are doing.
  You did a great job reaching out for help. Take care of yourself and remember we are just a phone call away.
  After we get off this call/text/chat, take a minute and look at YLYV.org like we discussed. I’m guessing that you will find some of those coping skills helpful tonight and in the future.
  Why don’t you see how the next couple of hours go and give us a call back if you feel like you can’t do this on your own.
  You sound like you're feeling a little better now. The next step is up to you, take some time to decide what will work best for you.
  We've gone over several options, and it seems like you're not sure right now if anything is going to work for you. Give yourself some time to think about what you might be comfortable doing.

  ==============================
  BUFFERS
  ==============================
  Do they have immediate supports available presently?
  Do they express reasons for living?
  Do they express ambivalence about dying?
  Do they have any social supports?
  Do they have plans for the future?
  Do they engage/connect with CC?
  Do they have a sense of purpose in their life?
  Do they believe life is valuable or are connected to a faith/spiritual practice?

  ==============================
  GREETING CRITERIA
  ==============================
  **Acceptable Greetings**
  • “Boys Town National Hotline, how may I help you?”
  • “Hello, you’ve reached 988. This is Joseph. How can I help today?”
  • “You’ve reached the Nebraska Family Helpline. How may I assist you?”
  **Greetings to Avoid:**
  • “Hello. Hotline.”
  • “988 Local. Can I get your name?”
  • “Hello?”
  • “What’s up?”
  • “988”
  • “Boys Town National Hotline.”

  ==============================
  Defining and Reporting Abuse Boys Town National Hotline
  ==============================
  Purpose:
  The purpose of this practice is to protect minors, physically/mentally handicapped adults, and the elderly who reach out to the hotline who may be experiencing abuse or neglect by complying with state and federal regulations regarding mandatory reporting requirements.
  Policy Statement:
  For this policy the Boys Town National Hotline® (BTNHL) complies with the State of Nebraska definition of what constitutes abuse of minors, physically/mentally handicapped adults, and the elderly to establish the ethical, moral, and legal foundation for BTNHL employees to report incidences of abuse to the proper authorities.
  Procedures:
  The State of Nebraska defines abuse or neglect as:
  ▪ Knowingly, intentionally, or negligently causing or permitting a minor, a mentally/physically challenged adult, or an elderly person to be placed in a situation that endangers his or her life, or physical or mental health.
  ▪ Cruelly confining, punishing, or depriving a person of necessary food, clothing, shelter, or care.
  ▪ Leaving a child under the age of 6 unattended in a motor vehicle.
  ▪ Sexually abusing or sexually exploiting a child by allowing, encouraging, or forcing him or her to solicit for or engage in prostitution, debauchery, public indecency, or obscene or pornographic photography, films, or depictions.

  All incidences of abuse as defined above are to be handled according to the following procedures. Crisis Counselor objectives in assisting with alleged abuse are to:
  **Ensure the immediate safety of the client; and assess lethality of client/victim.**
  When a Crisis Counselor receives a call/chat/email/text regarding the alleged abuse of a minor, physically/mentally challenged adults, or elderly person, the Crisis Counselor is to notify the Senior Counselor with a work unit of “01”.
  The Crisis Counselor should assess the immediate safety of the client.
  ▪ Current threat of abuse
  ▪ Caller’s lethality
  ▪ Current injuries
  If it is determined that there is current danger the police should be contacted immediately.

  Gather and document information in order to determine appropriate intervention.
  Identifying information
  ▪ On-going/current abuse must be reported if sufficient identifying information is obtained from the caller regarding the abuse.
  ▪ Information obtained from the Automatic Number Identification (ANI) digital readout is sufficient, in the State of Nebraska, to make a report to Child Protective Services (CPS) or Adult Protective Services (APS).
     In most cases, CPS/APS requires the name of the victim, type of abuse, and a means to locate him or her (phone number, address, or name of school) in order to investigate abuse allegations.

  Documentation
  ▪ The Abuse Report call screen is utilized to gather as much information as possible to facilitate the reporting process.

  Past Abuse
  ▪ In cases where the minor child discloses past physical or sexual abuse, the counselor should assess the following:
     Has the abuse ever been reported?
     Is there potential for further abuse?
  In either or both of these cases, information should be gathered to make a report to the appropriate agency.

  Report information to the proper authorities when necessary and/or develop a safety plan.
  Conference Call:
  ▪ A conference call to the appropriate Child Protective agency is offered to all callers discussing reportable abuse issues.
  ▪ A conference call can be made to the appropriate agency if agreed to by the client after notifying the Senior Counselor.
  ▪ The Senior Counselor can help determine if the Crisis Counselor should remain on the line once the caller has been connected with the appropriate agency. This determination is based on the caller’s comfort level with making the report.
  
  Notification of Mandatory Reporting:
  ▪ All adults contacting the BTNHL with issues of abuse are notified of our status as mandatory reporters, unless this notification puts a child in danger, or would cause the caller to withhold pertinent identifying information.
  ▪ The counselor and assisting Senior Counselor must use judgment when informing minors of the BTNHL’s mandatory reporting status. The information is withheld if it is felt that informing the client would put them at risk of life-threatening reactions (e.g., runaway, suicide attempt).
  ▪ The client’s desire to report or not report the abuse does not impact the BTNHL’s obligation to report the abuse.

  Agency Report and Documentation:
  ▪ The Abuse Report call screen is filled out by the Crisis Counselor taking the call.
  ▪ The Crisis Counselor contacts the appropriate agency, reports the incident of abuse, and completes the report.
     Abuse Reports are reported over the phone or online when available. A copy of the call notes & Abuse Report can be faxed upon request.
     The Crisis Counselor documents the call on the Incident and Abuse Report Log. The Senior Counselor reviews and initials the call notes and completes the documentation on the Incident and Abuse Report Checklist.
     If the Crisis Counselor is unable to make the Abuse Report because of limitations in CPS/APS reporting hours, it is marked on the Incident Report sheet for follow-up during business hours.
     If there are no immediate safety concerns and Senior Counselor and Crisis Counselor are unsure if the information provided constitutes an abuse reporting being made. Formatted notes should be completed and marked on the Incident Report for review.

  Safety Plan:
  ▪ In addition to reporting abuse to the appropriate authorities, the counselor should ensure that there is a plan of action for the client’s continued safety (e.g., support systems, coping skills, avoidance behaviors, follow-up call, etc.).
  ▪ If the client is willing, this plan should include a conference call to someone viewed as a support person by the client.
  
  Third Party Abuse Reports:
  ▪ If a third party calls to report alleged abuse, the Counselor can do the following:
     Offer to conference a call to the appropriate agency.
     If the Counselor feels that it is a legitimate report, and adequate identifying information is gathered, an attempt can be made to report the abuse, although most agencies will not accept/investigate a third party report.
     Encourage the caller to have the victim call the BTNHL directly in order to get the appropriate agencies involved.

  ==============================
  BOYS TOWN NATIONAL HOTLINE CODE OF ETHICS FOR SUICIDE PREVENTION AND CRISIS INTERVENTION
  ==============================
  PURPOSE
  To establish guidelines for a code of ethics for the Boys Town National Hotline (BTNHL) in accordance with the American Association of Suicidology (AAS). Hereafter, BTNHL personnel will be referred to as crisis workers.
   
  OBJECTIVES
  1. To protect the rights of callers requesting services provided by BTNHL.
  2. To promote compliance with professional and community standards of conduct.
  3. To provide guidelines for the resolution of ethical conflicts and in suicide prevention and crisis intervention procedures.
  
  PRINCIPLES
  Integrity
  Whether as a practitioner, trainer, or researcher, BTNHL personnel shall place the highest value on integrity. The best interests of the caller shall always be the overriding consideration at all times.
  Competence
  Responsibility should only be undertaken or assigned to personnel who have been trained and have demonstrated an adequate level of competence for the assigned activity. If the needs of the person being helped are beyond the crisis worker’s competence, referral to someone with the needed skills should be completed as expeditiously as possible. Sensitivity to the caller’s possible feelings of rejection or abandonment should be considered.
  If lack of competence is observed in other persons or agencies, the observation should be made known to one’s supervisor or to the individual responsible for taking corrective action.
  If physical or emotional problems interfere with the crisis worker’s optimal functioning, appropriate steps should be taken to see that such problems do not compromise the quality of services offered. The caller’s issues are first dealt with and then measures to correct the crisis worker’s problems are instituted. Further crisis work should be deferred until such problems no longer interfere with the worker’s competence.
  Moral Standards
  The crisis worker should respect the social and moral attitudes of Father Flanagan’s Boys’ Home, assuring that the reputation of Boys Town will not be jeopardized.
  Legal Standards
  In the course of crisis work, illegal actions by the caller should not be encouraged or facilitated. If the crisis worker recognizes a potential legal issue of which the caller is not aware, the crisis worker should inform the caller of that issue. In no case should the crisis worker participate in an illegal act.
  Representation
  The crisis worker shall accurately represent his/her qualifications, affiliations, and purposes when appropriate, and those of BTNHL. The crisis worker should not provide information which would imply the presence of qualifications or affiliation, professional or otherwise, which are not accurate or would lead others to assume qualities or characteristics that are not correct. If misrepresented by others, or if incorrect assumptions are made by others, the crisis worker should rectify such misconceptions.
  The crisis worker should not use his/her affiliation with Boys Town, or BTNHL, for purposes which are not consistent with the stated purpose of Boys Town.
  Public Statements
  All public statements, whether direct or indirect, should be accurate and free of sensationalism, bias, distortion, or misrepresentation of any kind. Special care in this regard is required in activities related to news articles aimed at stimulating public awareness, support, and solicitation of funds for BTNHL.
  When information is provided to the public about suicide prevention or crisis intervention techniques, it should be made clear that such techniques are to be used only by persons adequately trained in their use.
  Confidentiality
  Maintaining the confidentiality of information about callers is a primary responsibility of the crisis worker. Caller information should not be communicated to others unless specific provisions for such release are met according to Nebraska statutes.
  Confidential information may be revealed after careful consideration indicates the presence of clear and imminent danger to an individual or to society. This information should only be released to those who must be informed in order to reduce impending danger.
  Information about callers may be discussed only with others concerned with the case.
  Except for the reasons listed above, only when the caller gives permission may information be disclosed to another individual. The caller should specify what information may be given and to whom. In circumstances judged by crisis workers to constitute an emergency involving a threat to the life or safety of the caller, these restrictions may be suspended as necessary to provide the required assistance.
  Written and oral reports should contain only information germane to the purpose of the report. Every effort should be made to protect the caller’s privacy.
  In writing and teaching, care should be taken that any clinical material used should be presented in such a way that the identity of the individual is not revealed.
  The identity of research subjects should not be revealed or rendered recognizable without explicit permission.
  Personnel should assure that appropriate provisions are made for the maintenance of confidentiality in the storage, retrieval, use, and ultimate disposition of records.
  Welfare of Persons Receiving Crisis Services
  In accordance with III.B.1. above, if a caller would be best served by referral to another crisis worker, or another type of assistance, such referral should be accomplished without delay. Full consideration should be given to the possible adverse effects of referral. The procedure should be carried out in such a manner that these potential adverse effects are minimized.
  In the event of referral, the referring crisis worker should continue to render assistance as needed until such time as the responsibility for helping the person is assumed fully, if that is appropriate, by the worker taking over the case.
  Relationship with the Person Receiving Crisis Service
  Crisis services should be provided only in the context of a professional type of program. No illegal interaction should transpire in the course of providing crisis services. The crisis worker should not provide services to his/her associates, friends, or family members except in the most unusual circumstances, and then only with the assistance of an experienced consultant.
  BTNHL states precisely in the Practices Manual under which circumstances a call may be listened to by a third party without the caller’s knowledge or consent. An opinion on these issues has been obtained from legal counsel that relevant federal or Nebraska laws would not be violated by these policies and procedures.
  Offering of Services
  Any proffering of suicide prevention and crisis services should be carried out within strict limits of community standards, propriety, and good taste.
  Notices designed for public use, such as telephone books, posters, or brochures may contain a statement of the name, degree, certification and sponsoring agency of the provider, the services offered a description of those services, circumstances in which the services might be appropriately used, and how to obtain them.
  Professional Relations
  The integrity, traditions, and potential helping role of all professions and disciplines should be acknowledged and respected, both in relations between disciplines and in communications with persons in crisis. No suggestion of precedence among disciplines should be expressed or implied, though special needs may call for unique skills in individual cases. Crisis workers should not knowingly enter into a competitive role with other providers. 
  If the person being helped has a previously established relationship with another caregiver, the crisis worker should attempt to integrate the efforts being made. All concerned parties should strive for mutual agreement as to the best way to assist the person in crisis.
  Remuneration
  No commission, rebate, or other consideration or inducement should be involved in a referral to or from a worker for the provision of crisis services. The crisis worker should not use his/her relationship with the person being helped to promote his/her own benefit or that of BTNHL or any other enterprise.
  A BTNHL crisis worker should not accept a fee or other form of remuneration from a caller who is entitled to crisis services through BTNHL. A crisis worker should not accept a gift from a caller being helped.
  Ownership of Materials
  All materials prepared by a crisis worker in carrying out his/her regular duties as an employee of BTNHL, shall be the property of Boys Town. Release or publication of such materials will be governed by the policies established by Father Flanagan’s Boys’ Home. Materials prepared by a BTNHL employee, other than those materials resulting from his/her regular
  duties, shall, if published, and if Boys Town so desires, include a disclaimer of responsibility on the part of Boys Town for the content of the published materials.
  Promotional Activities
  A crisis worker associated with the promotion of BTNHL services, books, or other products, should ensure that these are presented in a professional, factual manner. Any claims made should be supported by scientifically acceptable evidence.
  If a financial interest is held in any commercial product, care must be taken to assure that the clinical care of persons in crisis is not adversely affected by that interest.
  Research
  All research activity must be carried out with meticulous attention to the well-being and dignity of allparticipants.The design and methodology of clinical studies shall follow federal guidelines for research involvinghuman subjects.
  Research carried out at BTNHL must be reviewed and approved by the governing board of Father Flanagan’s Boys’ Home, which will determine that compliance with human rights will be observed.

  Guidelines for a Code of Ethics for Suicide Prevention and Crisis Intervention. American Association of Suicidology Organization Certification Manual for Crisis InterventionPrograms. 1989.

  ==============================
  Perpetrator Calls Boys Town National Hotline
  ==============================
  The Boys Town National Hotline® (BTNHL) is required by law to report to the appropriate authorities in the caller’s area, any service recipient who states they have, is in the process of, or intends to commit an act of violence/crime against a specific individual/establishment with the plan and means available to carry out the expressed threat.
  The BTNHL is not obligated to inform the caller of this reporting policy.
  The Crisis Counselor taking the call notifies the Lead/Senior Counselor with a work unit of “01”. The Lead/Senior Counselor’s intervention on a call from a person, who states they have, is in the process of, or intends to commit a crime, depends on the circumstances of the call.
  • In life-threatening situations, the call procedures are those defined in the Initiating Intervention in Life Threatening Situations, Hotline Practice.
  • When BTNHL has identifying information on the caller:
  • The Lead/Senior Counselor obtains the caller’s phone number
  • The Lead/Senior Counselor contacts and gives the identifying information to the Police in the community from which the call originates.
  • Formatted call notes are written, and the call is documented on the Incident Report
  • The information from the call record can be communicated to the Boys Town Police Department by a BTNHL Supervisor for additional assistance and/or follow-up

  ==============================
  Maintaining Anonymity of Counselors Boys Town National Hotline
  ==============================
  The primary focus of the Boy Town National Hotline® (BTNHL) is to offer short-term crisis intervention to each caller. However, a caller becoming over dependent on BTNHL services would be counter-productive.
  To help eliminate caller over-dependence, maintain BTNHL employee safety, and ensure that the focus of a call appropriately remains on the problem presented by the caller, all BTNHL employees are to remain anonymous.
  To maintain BTNHL Crisis Counselors’ anonymity:
    ▪ No full names, addresses, phone numbers, or physical descriptions are to be given out to a caller.
    ▪ Crisis Counselors should not reveal other personal information or experiences to the caller.


  ==============================
  Initiating Intervention in Life Threatening Situations Boys Town National Hotline
  ==============================
  Purpose:  
  It is the goal of the BTNHL to ensure the safety of all clients at imminent risk of suicide or in immediate life-threatening situations, initiating emergency intervention with or without the client’s consent if needed. This includes those at high risk of engaging in self-harm, violence toward another, or reporting an emergency medical situation.

  Policy Statement:  
  To meet this goal, the BTNHL uses all available information to obtain the intervention and assistance of appropriate agencies in the caller’s area.

  Procedure:  
  The following practice is to be followed when a client indicates a life-threatening act is imminent, in progress, or there is an emergency medical situation:

  1. Crisis Counselor notifies Lead/Senior Counselor (enter work unit “99”) if:  
    - The client makes suicidal or homicidal statements.  
    - The client has any history or current thoughts of suicide or other life-threatening situation.  
    - The client answers “yes” to the question of self-harm, details a plan of action, and has the means to carry it out.  
    - A third party calls concerned someone may be suicidal.

  2. Crisis Counselor notifies Lead/Senior Counselor (enter work unit “90”) if caller is at imminent risk of suicide and emergency intervention may be needed:  
    - States a life-threatening action is imminent or has occurred.  
    - Reveals a medical situation requiring immediate attention.

  3. When dealing with suicidal clients, the Crisis Counselor will:  
    - Actively engage and establish rapport to promote the client’s collaboration in securing their own safety whenever possible.  
    - Include the client’s wishes, plans, needs, and capacities to reduce suicide risk.  
    - Explore the least invasive interventions appropriate to the situation.  
    - Reserve involuntary action as a last resort when the individual cannot participate in keeping safe.

  4. Lead/Senior Counselor monitors the call to:  
    - Assist and support the Crisis Counselor.  
    - Determine if intervention is necessary and appropriate.  
    - Consult with managers and supervisors (available 24×7).  
    - Contact the on-call administrator if the client is “high” risk but no intervention is taken.

  5. If additional assistance is needed or the situation is life-threatening, Lead/Senior Counselor will:  
    - Obtain Caller ID or texting info and any pertinent details.  
    - Obtain longitude, latitude, and ISP (for chats).  
    - Determine the level of assistance needed (Poison Control, mobile/crisis teams, emergency services, etc.).  
    - Contact the agency or third party and arrange intervention.  
    - Stay on the line until assistance arrives.

  6. If no ANI or ISP is available and the client won’t provide info:  
    - Offer to conference call a local agency, trusted adult, or therapist.  
    - Offer a follow-up call to check on their well-being.  
    - Before ending, de-escalate by exploring coping skills, support systems, or creating a safety plan.

  7. If the client needs emergency intervention and is on a cell phone:  
    - Contact local law enforcement.  
    - If police can’t locate, call the client back as follow-up.  
    - Use “Fone Find” to identify the carrier; clarify source of info when contacting dispatch.

  8. Because BTNHL is a national line, formal outside agreements aren’t possible. When needed, BT Village Police can assist 24/7 with carrier info or agency contacts. Carrier procedures are listed in the Red Book.

  9. When the call/chat/text concludes:  
    - Crisis Counselor completes formatted Call Notes.  
    - Crisis Counselor records on the Incident & Abuse Report Checklist.  
    - If an outside agency intervened and the resolution is unknown, Lead/Senior Counselor follows up.  
    - Lead/Senior Counselor reviews and initials call notes and completes the checklist.  
    - Any dispatch request triggers a Manager/Supervisor review with staff follow-up as warranted.

  10. Follow-up for unsuccessful interventions:  
      - Note unsuccessful intervention in call notes (e.g., police unable to locate).  
      - Attempt to re-establish contact to assess ongoing needs.  
      - If info allows, contact third parties or professionals who may help.  
      - Hotline may initiate follow-up if safety concerns persist.

  Third-Party Contacts:  
  If a third party calls 988 about someone at risk of suicide (including anonymous requests):  
    - Enter work unit “99.”  
    - Obtain caller’s contact info and relationship to the person at risk.  
    - Explore what the caller can do to keep the person safe (including means restriction).  
    - Depending on seriousness:  
      • Conference the third party with the person at risk or call them directly.  
      • Make an outbound call if the third party is an agency with contact info.  
      • Help a youth caller identify an adult to intervene.  
      • Request school personnel contact for at-risk youth (after hours only if no immediate risk).  
    - Provide referrals (Hotline, YLYV).  
    - Obtain agreement to collaborate with mobile crisis/outreach services.  
    - If immediate safety is a concern, instruct the third party to call 911 or contact police for them.

  If a third party is concerned about online comments or posts:  
    - Encourage them to share the Hotline or YLYV number with the person at risk.  
    - If an email address is available, offer to send assistance by email.  
    - If a phone number is available, offer to make an outbound call.  

  ==============================
  Homicidal Threats / Threats of Violence Boys Town National Hotline  
  ==============================
  **Purpose:**  
  It is the goal of the BTNHL to ensure the safety of all clients and assess for the safety of others when threats of homicide or threats of violence/crime against a specific individual, establishment, or school are communicated at any point during a call, chat, or text, and there is an identified plan and means available to carry out the threat.

  **Policy Statement:**  
  To meet this goal, the BTNHL uses all available information in an effort to obtain the intervention and assistance of appropriate agencies in the caller’s area.

  **Procedure:**  
  The following practice is to be followed when a client makes a homicidal threat or threat of violence:

  1. **Notification**  
    - The Crisis Counselor enters an ACD work unit of “99” to notify the Lead/Senior Counselor when the client makes a homicidal statement or threat of violence.

  2. **Crisis Counselor Actions**  
    When dealing with homicidal threats or threats of violence, the Crisis Counselor will:  
    - Assess whether there is a specific intended target.  
    - Ascertain if there is a plan and means available to carry out the threat.  
    - Ask clarifying questions to understand the person’s actual intent, capability, and likelihood of following through.  
    - Prior to ending the call/chat/text, attempt to de-escalate by dismantling the intended plan and/or securing an agreement not to carry out the threat.  
      - If the threat was specific as to time, place, person, and means, it still requires contacting law enforcement.

  3. **Lead/Senior Counselor Monitoring**  
    The Lead/Senior Counselor monitors the interaction to:  
    - Assist and support the Crisis Counselor.  
    - Determine if law enforcement notification is necessary and make the report if needed.  
    - Consult with the on-call supervisor if unclear about the need for law enforcement notification.

  4. **Documentation**  
    When the call/chat/text concludes:  
    - Document all incidents involving homicidal threats or threats of violence on the Incident Report, even if law enforcement was not contacted.  
    - Complete formatted Call Notes.  
    - Lead/Senior Counselor reviews and initials the Call Notes and completes the Incident Report Checklist.

  **Criteria for Reporting to Law Enforcement**  
  Use the following criteria to decide whether to report:

  1. **Foreseeability of Victim(s):**  
    - There must be an identifiable victim or victims (e.g., a named person or defined group).  
    - Generic threats against “someone” or “somebody” do not suffice.

  2. **Imminence/Urgency of Threat:**  
    - A precise timeline (“in one hour”) is sufficient but not required.  
    - Phrases like “very soon” indicate higher risk than “sometime” or “one day.”

  3. **Assessment of Risk:**  
    - Evaluate the plausibility of the threat (history of violence, substance use, familial relationships, weapon availability, ongoing mental health issues, etc.).  

  ==============================
  Domestic Violence and Sexual Assault Boys Town National Hotline  
  ==============================
  The Boys Town National Hotline® (BTNHL) does not report contacts regarding domestic violence or sexual assault to law enforcement agencies unless it has the consent of the client who makes the contact. However, if a client’s physical safety or medical condition is in jeopardy, Hotline employees will contact the authorities.  

  Contacts about consensual sexual relationships between adults and minors are not reported unless the minor is 15 years old or younger and the adult is 19 years old or older.  

  If an alleged victim of domestic violence or sexual assault is 18 or under, employees should refer to the Hotline’s internal practice Defining & Reporting Abuse.  

  **Support Staff Notification**  
  When a Crisis Counselor Lead/Senior Counselor uses work unit “01,” the Crisis Counselor makes an immediate assessment of safety issues and passes the results to the Lead/Senior Counselor. If the client is in immediate need of assistance, the Lead/Senior Counselor initiates intervention by contacting the appropriate law enforcement agency or emergency medical response team.  

  **Conference Call**  
  - A conference call to the appropriate agency (e.g., police, rape crisis center, hospital) is offered to all callers.  
  - A conference call is placed if the caller agrees and the Lead/Senior Counselor gives consent. The counselor contacts the agency first to ensure consistent, appropriate services.  
  - The Lead/Senior Counselor decides whether the Crisis Counselor remains on the line after connection, based on the caller’s comfort level.  

  The Hotline does not report contacts regarding domestic violence or sexual assault without the caller’s consent unless:  
  - There is reason to believe the caller (or another person) is currently in physical danger or in need of medical assistance.  
  - The contact appears to involve statutory rape (in Nebraska: a youth 15 or younger with an adult 19 or older).  
  - The contact reports the sexual assault/rape of a youth under 18, regardless of the perpetrator’s age.  

  **Incident Report Documentation**  
  - The Crisis Counselor completes the computerized, formatted Call Notes.  
  - The Lead/Senior Counselor reviews and edits the Call Notes, makes any necessary reports to law enforcement, and records the call on the Incident/Abuse Report.  
  - If there are no immediate safety concerns, the call record may be placed on the Incident Report for follow-up the next day.  
  - Any questions or concerns about domestic violence or sexual assault calls should be referred to a supervisor for consultation. 
  
  ======================================
  END OF IMPORTANT INSTRUCTIONS
  ======================================


  `;

  // Create the user message with the transcript
  const userMessage = `Here is the call transcript to evaluate. The transcript includes a summary followed by the conversation between the AGENT (counselor) and CUSTOMER (caller). 
  Now act as a master evaluator and based on all the infromation you have, analyze the transcript accordingly. Give accurate and detailed assessment which is free of any form of bias, 
  you don't always have to give a full score, you have to evaluate such that we can provide a constructive feedback and improve overall performance of the counselor.
  This evaluation will be used to provide feedback to the counselor and improve our crisis intervention services.

  SUMMARY:
  ${formattedTranscript.summary}

  TRANSCRIPT:
  ${transcriptText}

  Please analyze this transcript according to Boys Town's QA rubric and provide a detailed assessment. 

  **EVALUATION INSTRUCTIONS:**
  1. Evaluate strictly according to the Boys Town rubric criteria
  2. Pay particular attention to the counselor's use of the POP model and safety assessment
  3. Provide specific evidence with timestamps for each score
  4. Be objective and consistent in your scoring
  5. Return only the JSON evaluation results without additional commentary

  Your evaluation will directly impact counselor training and service quality, so accuracy and consistency are essential.
  
  After successfully analyzing the transcript and generating the output, take some time to reflect back on the analysis you did,
  see whether it meets all the requirements and if it is accurate, detailed and free of any form of bias. If you see any issues,
  please correct them and then return the final output. Make sure the results needs to be very accurte as it will help us to 
  improve overall performance of the counselor which ultimately will result in better service to our customers and help 
  those who are in need of help.  `;

  try {
    // Use the Conversational API with the correct structure
    // Move system prompt to top-level system field, not in messages array
    const command = new ConverseCommand({
      modelId: modelId,

      // Top-level system prompt as an array of SystemContentBlock
      system: [{ text: systemMessage }] as SystemContentBlock[],

      // Only user role in messages array
      messages: [
        {
          role: "user" as ConversationRole,
          content: [{ text: userMessage }] as ContentBlock[],
        },
      ],

      inferenceConfig: {
        //maxTokens: 4096,
        temperature: 0.1,
        topP: 0.9,
      },
    });

    const response = await bedrockClient.send(command);

    // Extract the content from the response
    // Bedrock returns the chat response under response.output?.message?.content
    let content = "";
    if (
      response.output?.message?.content &&
      response.output.message.content.length > 0
    ) {
      content = response.output.message.content[0].text || "";
    }

    // Try to parse the content as JSON if it's in JSON format
    try {
      return JSON.parse(content);
    } catch (e) {
      // If parsing fails, return the raw content
      return {
        raw_analysis: content,
        summary: formattedTranscript.summary,
      };
    }
  } catch (error) {
    console.error("Error calling Bedrock:", error);
    throw new Error(`Failed to analyze transcript: ${error}`);
  }
}
