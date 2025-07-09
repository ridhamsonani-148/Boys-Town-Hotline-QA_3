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

// Model ID for Amazon Nova Pro
const MODEL_ID = 'arn:aws:bedrock:us-east-1:216989103356:inference-profile/us.amazon.nova-premier-v1:0';

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
    const resultKey = formattedKey.replace('transcripts/formatted/', 'results/').replace('formatted_', 'analysis_');
    
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
    .map(item => `${item.beginTime} ${item.speaker}: ${item.text}`)
    .join('\n\n');
  
  // Create the system message
  const systemMessage = 
  `You are an *unbiased*, *strict* Boys Town QA evaluator.  
  Do **not** inflate or pad any scores.  
  Score each rubric item **only** if the transcript **fully** meets the rubric’s “Yes/Somewhat” definitions; otherwise assign the lower bracket.

  For **every** score you assign:
  - Pick exactly one checkbox value.
  - Cite the exact transcript line(s) that triggered that score.
  - If you can’t find evidence, assign the lowest score and set evidence to "N/A".

  **Do NOT** give full marks by default. If a criterion isn’t explicitly met, deduct points.  

  **Strict Scoring Rules**  
  1. Review the rubric definition for each item.  
  2. If the transcript doesn’t include the required behavior or phrase, score 0.  
  3. If it only partially meets it, score the middle option (e.g., “Somewhat”).  
  4. Only score “1”/“2”/“4” etc. when you find unambiguous, on-point evidence.  
  5. Always include a one-sentence rationale under “observation” explaining the deduction.

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


  Below is the Master Evaluation Form rubric you must follow:

  ==============================
  RAPPORT SKILLS / HOW WE TREAT PEOPLE
  ==============================
  1. Tone: Was the CC pleasant, helpful, calm, patient, and genuine?  
    ☐ 0  No  - Tone is aggressive, agitated, unkind, impatient, indifferent, or apathetic.  
    ☐ 1  Yes  - CC is kind. Tone is warm, natural, welcoming, interested, calm, and patient.  
    "Observations - Tone": 

  2. Professional: Was the CC professional during the contact?  
    ☐ 0  No  - CC encourages inappropriate or unsuitable conversation. CC uses slang, makes bodily noises or is sleepy. CC's conversation does not follow Boys Town policy.  
    ☐ 1  Yes  - Conversation is appropriate and suitable for a Boys Town Crisis Counselor.  
    "Observations - Professional": 

  3. Conversational Style: The CC engaged in a conversational dialogue with the contact.  
    ☐ 0  No  - The CC either spoke/texted far more than the contact or rarely spoke/texted; the rate of the conversation did not match contact.  
    ☐ 1  Yes  - Conversation is balanced - there is back and forth dialog between CC and the contact. CC is responsive to the contact's statements, matching conversational style.  
    "Observations - Conversational Style": 

  4. Supportive Initial Statement: Within the first few minutes, CC assures the contact.  
    ☐ 0  No  - The CC does not assure the contact that the hotline is here to help or that they did the right thing by reaching out.  
    ☐ 1  Yes  - CC assures the contact that the hotline is here to help, that they did the right thing by reaching out (i.e. “Thanks for reaching out today” or “We are here to help”).  
    "Observations - Supportive Initial Statement": 

  5. Affirmation and Praise: The CC provides quality affirmations throughout the contact.  
    ☐ 0  No  - CC misses opportunities to provide affirmations to contact.  
    ☐ 1  Yes  - CC provides affirmations throughout the contact when opportunities to do so arise (i.e. “I'm so glad you're willing to share your story, this is a lot to process on your own”).  
    "Observations - Affirmation and Praise": 

  6. Reflection of Feelings: The CC provides quality feeling reflections throughout the contact, naming specific emotions.  
    ☐ 0  No  - The CC does not reflect the feelings of the contact.  
    ☐ 1  Somewhat  - The CC provides only basic/shallow reflections to contact (i.e. “That sounds hard” or “That is understandable”).  
    ☐ 2  Yes  - The CC provides deep/meaningful feeling reflections throughout the contact; CC names the feeling and connects it with the person's story (i.e. “That sounds incredibly lonely; having your family so far away is difficult.” “I can see why it would be really frustrating to hear that from your teacher.”).  
    "Observations - Reflection of Feelings": 

  7. Explores Problem(s): Encourages the contact to explain their Problem(s), does not interrupt. CC asks open ended questions to prompt for additional information as needed.  
    ☐ 0  No  - CC interrupts or cuts the contact off while they are explaining their Problem(s) and/or seems disinterested in what the contact is sharing. CC asks yes/no questions, discouraging further sharing.  
    ☐ 1  Yes  - CC encourages contacts to fully express their feelings and explain their Problem(s). If the contact does not share details of their Problem(s), CC asks open-ended questions to prompt for additional information as needed.  
    "Observations - Explores Problem(s)":   
    "What is the contact's Problem(s)?": 

  8. Values the Person: The CC provides unconditional positive regard to the contact.  
    ☐ 0  No - The CC demonstrates contempt or resentment to a contact (i.e. blames the contact for their own problems, dismisses a contact's emotions as irrational, invalidates a contact's experience).  
    ☐ 1  Yes  - The CC demonstrates unconditional positive regard by accepting the contact's feelings and thoughts without judgement.  
    "Observations - Values the Person": 

  9. Non-Judgmental: The CC refrains from statements of judgement or from offering personal opinions regarding the contact's values, their situation, or any people connected to them.  
    ☐ 0  No  - The CC is judgmental or offers personal opinions about the contact's situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend).  
    ☐ 1  Yes  - The CC refrains from offering any judgement statements or personal opinions about the contact's situation, their values, or a person they are connected to who is brought up in the call (i.e. an ex-boyfriend/girlfriend).  
    "Observations - Non-judgmental": 

  ==============================
  COUNSELING SKILLS / THE PROCESS WE USE
  ==============================
  10. Clarifies Non-Suicidal Safety: CC asks clarifying questions to identify any non-suicidal safety concerns that must be addressed to effectively guide the direction of the contact.  
      ☐ 0  No  - CC fails to ask important clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.).  
      ☐ 1  Yes  - CC asks appropriate clarifying questions about potential safety concerns (abuse, self-injury, intimate partner violence, etc.). Default to 1 if non-suicidal safety concern were not present.  
      "Observations - Clarifies Non-Suicidal Safety": 

  11. Suicide Safety Assessment-SSA (Lethality Risk Assessment-LRA) Initiation and Completion: The CC assesses for suicidal ideation. (YLYV Text and 988 Chat/Text scoring reflects the protocols listed in One Note).  
      ☐ 0  No  - CC does not assess for suicide or assesses in an ineffective way (i.e. “You're not feeling suicidal today, are you?”).  
      ☐ 1  No  - The contact tells the CC they are not suicidal, but the CC does not clarify the statement and does not ask any other questions regarding suicidality. Third party contact, no assessment made. CC asks the contact if they are having “thoughts” or “a plan” but does not use the word “suicide” or the phrase “to end your life.”  
      ☐ 2  Yes  - CC initiates SSA but misses 2 or more of the required questions as listed in CMS based on the contact's answers.  
      ☐ 3  Yes  - CC initiates SSA but misses 1 of the required questions as listed in CMS based on the contact's answers.  
      ☐ 4  Yes  - CC conversationally asks the required SSA questions as listed in CMS or clarifies/restates understanding with contacts who volunteer that they are not suicidal.  
      "Observations - Suicidal Safety Assessment-SSA Initiation and Completion": 

  12. Exploration of Buffers (Protective Factors): CC works with the contact to understand their Buffers against suicidal thoughts and other non-suicidal safety concerns as listed in CMS.  
      ☐ 0  No  - CC does not explore Buffers and/or does not record the answers in CMS. Default to 1 if the contact does not have any suicidal safety or non-suicidal safety concerns.  
      ☐ 1  Yes  - CC asks questions to understand the Buffers and accurately records the answers in CMS. Default to 1 if the contact does not have any suicidal safety or non-suicidal safety concerns.  
      "Observations - Exploration of Buffers": 

  13. Restates then Collaborates Options: Restates the contact's primary concern and the type of support they are seeking; then collaborates with the individual to develop Options to address their situation. Empowers the individual to brainstorm coping skills and action steps.  
      ☐ 0  No  - The CC tells the contact what they should do/what's best for their situation without seeking input.  
      ☐ 1  Yes  - The CC works with the caller by asking questions about how they would like to handle the situation. If the CC provides suggestions, they ask the callers for input on the suggestions. Default to 1 if the contact’s situation requires immediate intervention without collaboration.  
      "Observations - Restates then Collaborates Options":   
      "What Options will the contact use to manage their situation?": 

  14. Identifies a Concrete Plan of Safety and Well-being: The CC helps the contact to create a solid Plan building on Buffers (Protective Factors) as identified previously (this applies for both suicidal and non-suicidal calls).  
      ☐ 0  No  - The CC does not establish a concrete plan.  
      ☐ 1  Yes  - In conjunction with the contact, the CC develops a concrete plan for right now (restricting means, utilizing immediately available support, etc.) or establishes what they will do if in crisis or feeling unsafe in the future.  
      ☐ 2  Yes  - In conjunction with the contact, the CC develops a concrete plan for right now and establishes what they will do if in crisis or feeling unsafe in the future. Default to 2 if the contact’s situation requires immediate intervention without safety planning.  
      "Observations - Identifies Concrete Plan":   
      "What is the contact's Plan for right now and for the future?": 

  15. Appropriate Termination (Follow Up Offered): The CC ends the contact appropriately and offers a Follow Up as needed.  
      ☐ 0  No  - The CC hung up on the caller/texter or ended the call prematurely; CC does not use an appropriate Closing Statement OR terminates call without offering a follow up call as needed for 988 and BTNHL contacts.  
      ☐ 1  Yes  - The CC ended the contact in a timely manner with an appropriate Closing Statement and offers the required follow up to 988 and BTNHL contacts.  
      "Observations - Appropriate Termination": 

  ==============================
  ORGANIZATIONAL SKILLS OF THE CALL/TEXT AS A WHOLE
  ==============================
  16. POP Model - does not rush:  
      ☐ 0  No  - CC rushes to Options and Plan before working to understand and explore the problem in a meaningful way.  
          Score as a 0 on both POP Model components if contact lacks organization and CC does not guide the conversation, just letting the contact talk.  
      ☐ 1  Yes - CC sufficiently explores and understands the problem prior to moving to Options and Plan. Gives time to each element of the POP Model.  
      "Observations - POP Model - does not rush": 

  17. POP Model - does not dwell:  
      ☐ 0  No  - CC allows caller to ruminate and fails to move to Options and Plan after the Problem has been sufficiently explored.  
          Score as a 0 on both POP Model components if contact lacks organization and CC does not guide the conversation, just letting the contact talk.  
      ☐ 1  Yes - The CC moves the call/text from Problem to Options and Plan smoothly, efficiently, and effectively. Gives time to each element of the POP Model.  
      "Observations - POP Model - does not dwell": 

  ==============================
  TECHNICAL SKILLS
  ==============================
  18. Greeting: The call is answered pleasantly and correctly.  
      ☐ 0  No  - Greeting is incorrect, incomplete or unpleasant. There is a significant delay in answering contact.  
      ☐ 1  Yes  - Greeting is correct and pleasant. CC uses the correct call gate and phrasing (i.e. “Boys Town National Hotline, how may I help you?” “988 Nebraska, how may I help you?”). Answers calls in a timely manner (answers 988 calls within the first 2 prompts).  
      "Observations - Greeting": 



  ==============================
  END OF RUBRIC
  ==============================

  ------------------------------------

  ==============================
  EXAMPLE CALL & SCORING SHEET
  ==============================

  Now you will see a **complete example** of how to apply the Master Evaluation Form to a real call and then output the results in the same format we will use in our pipeline.

  1. **Review the transcript below in detail.**  
  2. **Fill out the Master Evaluation Form** exactly as instructed above, choosing one checkbox per item and echoing observations under each label.  
  3. **Generate a CSV-formatted scoring sheet** matching the Excel example, with every column and row exactly as shown.

  --- Example Transcript: “Penas-Hull 100” ---
  00:00:02 Speaker 1: Press 1 to accept this lifeline call.  
  00:00:07 Speaker 2: On 8 Nebraska, how may I help you?  
  00:00:12 Speaker 1: Hi, yes, I was. I'm just having panic attack and I just. I'm not suicidal. I just wanted to.  
  00:00:21 Speaker 1: See if I could talk to somebody to help calm me down.  
  00:00:24 Speaker 2: Yeah. Well, it's great that you're reaching out. So just to confirm, any thoughts of suicide today or in the last couple of months?  
  00:00:33 Speaker 2: OK, appreciate you sharing that. So yeah, it's it's great that you're reaching out today. My name is Christopher. What's your name?  
  00:00:42 Speaker 1: Hi Christopher, I'm xxxx.  
  00:00:44 Speaker 2: xxxx, it's nice to meet you, xxxx.  
  00:00:50 Speaker 1: Yeah. It's nice to meet you too. Thanks for being here.  
  00:00:53 Speaker 2: Yeah, of course. Well, thanks for calling. So was there anything that?  
  00:00:58 Speaker 2: Happened before this call. It was kind of triggering for your anxiety.  
  00:01:02 Speaker 1: Yeah, I've.  
  00:01:04 Speaker 1: I suffer from anxiety.  
  00:01:08 Speaker 1: This triggering effect is just I'm worried about.  
  00:01:13 Speaker 1: Really worried about my my daughter, who just had a new baby and she has two other little girls and.  
  00:01:21 Speaker 1: Her oldest little girl who's.  
  00:01:23 Speaker 1: xxxx I don't know, I'm just starting to see.  
  00:01:27 Speaker 1: Signs of of what I think are autism or developmental delay and uh.  
  00:01:35 Speaker 1: It's just causing me to have this.  
  00:01:38 Speaker 1: Absolute fear and anxiety over it.  
  00:01:43 Speaker 1: And I don't know how to tell my daughter that because I don't want to upset her or her husband.  
  00:01:52 Speaker 1: And it's getting to the point I'm trying to help them with their kids because they just had a new baby. But every time I'm around my.  
  00:02:00 Speaker 1: Granddaughter that I think has delays, it's just causing me to have these panic attacks and they're coming over today and I'm going to babysit them again and I just.  
  00:02:10 Speaker 1: I'm getting to the point where I'm so fearful of being around her cause I.  
  00:02:16 Speaker 1: You know.  
  00:02:18 Speaker 1: I don't know. I'm just so fearful of the future for her and.  
  00:02:21 Speaker 1: I know it's irrational. I know she'll be fine. She's got wonderful parents, and it's not like it's.  
  00:02:26 Speaker 1: Severe autism or anything, but it's just.  
  00:02:30 Speaker 1: Causing this.  
  00:02:32 Speaker 1: Crippling anxiety.  
  00:02:36 Speaker 1: I don't know how to deal with it.  
  00:02:39 Speaker 2: Gotcha. Well, that sounds really difficult.  
  00:02:43 Speaker 2: How long have you been?  
  00:02:46 Speaker 2: How long have these panic attacks been triggered around your granddaughter?  
  00:02:53 Speaker 1: Just for about the past week.  
  00:02:56 Speaker 2: Gotcha.  
  00:03:01 Speaker 2: So it sounds like you're pretty close.  
  00:03:02 Speaker 2: With your daughter.  
  00:03:04 Speaker 2: You help out with the kids a lot. OK, that's good to hear.  
  00:03:05 Speaker 1: Yeah, very.  
  00:03:07 Speaker 1: Yeah.  
  00:03:09 Speaker 1: And I think that, you know the problem is I think I'm kind of having a PTSD cause my daughter, who's xx now.  
  00:03:18 Speaker 1: When she was the same age as my granddaughter.  
  00:03:22 Speaker 1: She was diagnosed with leukemia.  
  00:03:25 Speaker 1: At the age of x and so I went through a tremendous amount of anxiety and.  
  00:03:33 Speaker 1: Caring for her and she's got.  
  00:03:36 Speaker 1: God be blessed. She's fine.  
  00:03:41 Speaker 1: But I think it's just triggering this PTSD response in me.  
  00:03:48 Speaker 2: Gotcha.  
  00:03:50 Speaker 2: Gotcha. So.  
  00:03:52 Speaker 2: Did you have panic attacks when your daughter was diagnosed?  
  00:03:58 Speaker 1: UM, well, I mean, it's profound. Anxiety. Yes. And ever since then.  
  00:04:02 Speaker 1: If anything.  
  00:04:06 Speaker 1: Happens to a loved one or that I fear.  
  00:04:11 Speaker 1: Is danger to a loved one.  
  00:04:14 Speaker 1: I get these panic attacks because of what happened to xxxx.  
  00:04:19 Speaker 1: And I am on anxiety medication, but it's just not cutting it.  
  00:04:28 Speaker 2: OK, so you're on anxiety medication. Are you currently working?  
  00:04:33 Speaker 2: With a psychiatrist.  
  00:04:36 Speaker 1: No, I probably need to.  
  00:04:40 Speaker 1: I have. I've been well for a while. I mean, I've been quite well. I think I'm just exhausted. I my mom moved in with us. So I'm caring for my mom. And then.  
  00:04:50 Speaker 2: Ohh my gosh.  
  00:04:50 Speaker 1: Caring for my other grandkids. And so I'm I think I'm just completely, I don't know if I'm having a mental health breakdown. I just don't know.  
  00:05:02 Speaker 2: Well, it certainly sounds like you care a lot about the people in your life, and you've got some really close familial relationships. That's that's great to hear.  
  00:05:07 Speaker 1: I do.  
  00:05:12 Speaker 2: Yeah, yeah, it's understandable, though, to feel, you know, maybe a little overwhelmed taking care of your mom. And then your granddaughter and sounds like you're very close with your daughter. You guys spend a lot of time together.  
  00:05:25 Speaker 2: I mean.  
  00:05:25 Speaker 2: That's.  
  00:05:26 Speaker 2: You know, it's great that you guys are so well interconnected.  
  00:05:27 Speaker 1: Yeah.  
  00:05:32 Speaker 2: But that's also a lot.  
  00:05:35 Speaker 1: Yeah.  
  00:05:39 Speaker 1: Yeah.  
  00:05:42 Speaker 1: I think I've I've completely emptied, emptied myself.  
  00:05:42 Speaker 2: So go ahead.  
  00:05:46 Speaker 1: I feel like I've completely emptied myself.  
  00:05:54 Speaker 1: And I am married. My husband is very supportive. He he doesn't know how to help me.  
  00:05:59 Speaker 1: I understand that.  
  00:06:08 Speaker 2: Gotcha. So.  
  00:06:14 Speaker 2: And have you ever?  
  00:06:18 Speaker 2: Have you ever worked with a therapist before?  
  00:06:23 Speaker 1: I have that I probably need to see one again.  
  00:06:28 Speaker 2: Yeah. Gotcha. How long ago was that?  
  00:06:33 Speaker 1: A long time ago, probably.  
  00:06:37 Speaker 1: 15 years ago, OK.  
  00:06:40 Speaker 2: OK, well, here's what I'll tell you. You know, on that front, if that is something that you're interested in, you know, here at 9:00 and 8:00, we'd be happy to help get you connected with some referrals for a therapist.  
  00:06:55 Speaker 1: OK.  
  00:06:58 Speaker 1: UM.  
  00:07:03 Speaker 1: Yeah, I didn't. I just didn't know if you had any advice for. Just like talking to me.  
  00:07:09 Speaker 1: Down today, I mean I will, I I could try to reach out to my former therapist.  
  00:07:10 Speaker 2: Sure, sure.  
  00:07:17 Speaker 1: And you know, actually looking to getting some cognitive behavioral therapy.  
  00:07:22 Speaker 2: Hmm.  
  00:07:24 Speaker 2: OK, well, that sounds great. So what what I'm hearing Ann is that.  
  00:07:29 Speaker 2: You know, you've got a lot on your plate, you have some good supports.  
  00:07:34 Speaker 2: You know, reaching out, getting in contact with therapist is something that might be helpful, but really what you're most concerned about is how you're feeling right now. Is that right?  
  00:07:44 Speaker 2: Yeah. OK. And is there anything and that has been helpful for you in the past when you felt this way?  
  00:07:54 Speaker 1: You know, going for a walk.  
  00:07:58 Speaker 1: A brisk walk.  
  00:08:04 Speaker 1: You know, just listening to.  
  00:08:08 Speaker 1: Spiritual things you know.  
  00:08:13 Speaker 1: Self help things.  
  00:08:19 Speaker 1: Taking a nice shower and then.  
  00:08:22 Speaker 1: Her to get on cold for a little bit.  
  00:08:27 Speaker 1: Getting a massage or something.  
  00:08:32 Speaker 2: Yeah, those are those are all great things and certainly sound like they would be helpful. That's awesome. What about anything like any grounding techniques or something like that is that?  
  00:08:42 Speaker 2: Something that you've tried?  
  00:08:43 Speaker 1: I don't know what that is.  
  00:08:43 Speaker 2: In the past.  
  00:08:45 Speaker 2: Sure.  
  00:08:45 Speaker 1: No.  
  00:08:46 Speaker 2: So.  
  00:08:47 Speaker 2: Those are just.  
  00:08:49 Speaker 2: Strategies.  
  00:08:54 Speaker 2: Well, things that you can repeat in your head or activities that you can do.  
  00:09:00 Speaker 2: Just to kind of help get your mind off things and.  
  00:09:04 Speaker 2: Yeah, just to ground yourself. Like, have you ever heard of 54321? It's something that has been helpful for some of our callers when they're experiencing anxiety.  
  00:09:14 Speaker 1: No.  
  00:09:15 Speaker 2: OK, well 54321 is basically just.  
  00:09:19 Speaker 2: You know where you name 5 things you can see, 4 things you can touch, 3 things you can hear, 2 things you could smell, and 1 thing you can taste.  
  00:09:28 Speaker 2: And we just, you know, we would go through that and you name those things and.  
  00:09:33 Speaker 2: Is that something that you would like to try?  
  00:09:37 Speaker 2: Sure. OK. So it's it's pretty simple, uh, just as you're on the phone here with me.  
  00:09:45 Speaker 2: If you could just name 5 things that you can see.  
  00:09:47 Speaker 2:  
  00:09:55 Speaker 1: A picture on my wall. A door.  
  00:09:58 Speaker 1: Window.  
  00:10:01 Speaker 1: Ceiling fan.  
  00:10:04 Speaker 1: And a radio.  
  00:10:06 Speaker 2: Perfect. What about four things that you can touch?  
  00:10:13 Speaker 1: My blanket, my pillow.  
  00:10:18 Speaker 1: My chair.  
  00:10:22 Speaker 1: And myself.  
  00:10:30 Speaker 2: Sure. Yeah. What about three things that you can hear?  
  00:10:37 Speaker 1: I can hear you. I can hear myself.  
  00:10:47 Speaker 1: And the humming of our furnace.  
  00:10:53 Speaker 2: Perfect.  
  00:11:01 Speaker 2: That you could hear me first. That's that's usually the thing that it's usually one that gets overlooked if people are stuck. But awesome. Great work. So what about two things that you can smell?  
  00:11:16 Speaker 1: I don't know if I can smell anything.  
  00:11:24 Speaker 2: If there's nothing you could smell right now, what about just some smells around the house that you're familiar with?  
  00:11:33 Speaker 1: OK, like coffee brewing. And just the air freshener.  
  00:11:46 Speaker 2: What scent of air freshener do you have?  
  00:11:51 Speaker 1: It's ocean breeze.  
  00:11:57 Speaker 2: Alright. And one thing that you can taste.  
  00:12:04 Speaker 1: Like it tastes. I mean it seems like it's a metally taste in my mouth, but probably from my anxiety medication.  
  00:12:13 Speaker 2: Gotcha. Yeah.  
  00:12:15 Speaker 2: Yeah, well, you did a great job working through that 54321. How are you feeling after doing an activity like that?  
  00:12:26 Speaker 2:  
  00:12:33 Speaker 1: Yeah. I'm feeling OK.  
  00:12:39 Speaker 1: I just.  
  00:12:41 Speaker 1: I'm.  
  00:12:42 Speaker 1: I'm.

  --- Example Completed Scoring Sheet (CSV) ---
  Unnamed: 0,Name: Christopher Penas-Hull ,QUALITY ASSURANCE ASSESSMENT ,Unnamed: 3,Unnamed: 4,Unnamed: 5,Unnamed: 6,Unnamed: 7
  ,,Add score to the highlighted cells for auto calculations,,,,,
  ,,CONTACTS,,,,,
  ,,,,,988N2025007479,,
  ,,,,,Contact ID: 3286332,,
  ,,,,,,,
  ,Rapport Skills/How We Treat People:,,,,,,
  1.0,Tone,1,1.0,,,1.0,
  2.0,Professional,1,1.0,,,1.0,
  3.0,Conversational style ,1,1.0,,,1.0,
  4.0,Supportive Initial Statement,1,1.0,,0:24 It's great that you're reaching out.,1.0,
  5.0,Affirmation & Praise,1,1.0,,0:34 I appreciate you sharing th... or calling. 5:31 It's great that you are so interconnected.,1.0,
  6.0,Reflection of Feelings,2,2.0,,2:41 That sounds really difficult; to prop up the rest of your family and your granddaughter.,2.0,
  7.0,Explores Problem(s),1,1.0,,1:02 Is there anything that happened before this call that triggered these panic attacks when your daughter was diagnosed?,1.0,
  8.0,Values the Person,1,1.0,,,1.0,
  9.0,Non-Judgmental,1,1.0,,,1.0,
  ,Counseling Skills/The Process We Use:,,,,,,
  10.0,Clarifies Non-Suicidal Safety,1,1.0,,,1.0,
  11.0,Suicidal Safety Assessment-SSA (Lethality Risk Assessment-LRA) Initiation and Completion,4,4.0,,Questioned explicitly about thoughts of suicide today or in the last couple of months? Yes",4.0,
  12.0,Exploration of Buffers (Protective Factors),1,1.0,,4:34 Are you interested in therapist referrals? Yes.,1.0,
  13.0,Restates then Collaborates Options,1,1.0,,7:27 What I'm hearing is that...,1.0,
  14.0,Identifies Concrete Plan ,2,2.0,,17:45 Discussed safety plan and follow-up resources.,2.0,
  15.0,Appropriate termination (Follow Up Offered),1,1.0,,20:29 We’re here for you 24/7. Hope you have a good rest of your day.,1.0,
  ,Organizational Skills:,,,,,,
  16.0,POP Model - does not rush,1,1.0,,,1.0,
  17.0,POP Model - does not dwell,1,1.0,,,1.0,
  ,Technical Skills:,,,,,,
  18.0,Greeting,1,1.0,,"On 8 Nebraska, how may I help you?",1.0,
  19.0,SSA (LRA) Documentation,1,1.0,,Accurate documentation of risk factors.,1.0,
  20.0,Call Documentation/SC Communication,1,1.0,,Proper call notes uploaded.,1.0,
  ,Overall Total,,25.0,4.0,100,,80+ Meets Criteria
  ,   CONTACT Average,,,,,,70-79 Improvement Needed
  ,,,,,,,<69 Not At Criteria

  **End of example.** 
  
  
  --- Example Transcript 2: “Crystal Olson” ---
  
  00:00:00 Speaker 1: This lifeline call.
  00:00:03 Speaker 2: Thank you for calling on today. Lifeline, how can I help you?
  00:00:08 Speaker 1: I'm here. I was wondering if I could talk to a.
  00:00:11 Speaker 2: Counselor. Sure. My name is Crystal. What's your name?
  00:00:17 Speaker 1: Well, do I have to give you my name?
  00:00:21 Speaker 2: You don't have to if you don't want to.
  00:00:23 Speaker 1: OK. OK. Well, I had a.
  00:00:29 Speaker 1: Well, I'm going through a lot and I.
  00:00:34 Speaker 1: I don't know. I I guess I need to find help so.
  00:00:41 Speaker 1: How how does a person get help?
  00:00:44 Speaker 2: What are you struggling with? What's going on?
  00:00:48 Speaker 1: I'm not. I'm not a druggie. I don't have those problems.
  00:00:53 Speaker 1: What am I struggling with?
  00:00:58 Speaker 1: Homelessness. I am struggling with finances. I'm struggling with safety. I'm struggling with
  00:00:58 Speaker 1: loneliness.
  00:01:09 Speaker 1: Losing my job, losing my house, losing money, losing my family pretty.
  00:01:17 Speaker 1: Every any kind of fear in in anybody's life. Yeah, that's what I've hit. I've I've. That's what I'm
  00:01:17 Speaker 1: going through and and why?
  00:01:25 Speaker 2: Sounds like you've gone through a lot.
  00:01:29 Speaker 1: You know and.
  00:01:33 Speaker 1: And it's my family, right? My family is is going through it. Not necessarily me, but I am
  00:01:33 Speaker 1: because, you know, I support my family. And so it sucks me dry. Right. Like I completely
  00:01:33 Speaker 1: depleted of of.
  00:01:50 Speaker 1: Resources and and how to support everybody's needs, right?
  00:01:57 Speaker 1: I guess my biggest fear, you know, because I've lost, you know, my housing. I've lost my car.
  00:01:57 Speaker 1: I've lost. Honestly, I've lost everything. You know, I had two or three storage units of, you
  00:01:57 Speaker 1: know, family pictures. And, you know, just important things that would mean something to
  00:01:57 Speaker 1: me. Not necessarily.
  00:02:16 Speaker 1: Anybody else, but I couldn't pay for the storage unit. You know, after like 3 years of paying
  00:02:16 Speaker 1: them on time. It's just the last 3-4 months were.
  00:02:28 Speaker 1: So it couldn't get to them. And you know, they they took my stuff, you know, stuff that didn't
  00:02:28 Speaker 1: mean anything to anybody.
  00:02:37 Speaker 1: So I lost everything.
  00:02:39 Speaker 1: Completely lost everything. It's it's kind of like if your house starts on fire, right? Like
  00:02:39 Speaker 1: everything's gone. And so I was homeless for.
  00:02:48 Speaker 1: UM, well, I've been home with for quite a while and and and and here's the thing. I got an
  00:02:48 Speaker 1: apartment.
  00:02:55 Speaker 1: And we got kicked out within three weeks, got an eviction and then I got another apartment
  00:02:55 Speaker 1: right away. And what was it? Oh, yeah, probably.
  00:03:08 Speaker 1: Three weeks, we got kicked out, and that wasn't even evicted yet. You know, the guy just
  00:03:08 Speaker 1: kicked us out and and said, hey, listen or I said listen, that's against the law. I called the
  00:03:08 Speaker 1: police, you know? And the police, you know, because the guy put new locks on our door
  00:03:08 Speaker 1: and the police said, no, you can't do that.
  00:03:28 Speaker 1: You have to go through the proper legal, you know procedures and not evictions. So that
  00:03:28 Speaker 1: means you, you know, you guys take her to court and all that. So those are the things that
  00:03:28 Speaker 1: I'm going through and and it's not because.
  00:03:39 Speaker 1: Because I'm doing anything wrong, but my family's doing things wrong now. It's my job to
  00:03:39 Speaker 1: care for my family, so it's probably my job to find how to help them get through their
  00:03:39 Speaker 1: problems.
  00:03:53 Speaker 1: So there you go. Mean, I don't even know if.
  00:03:54 Speaker 2: That's a lot.
  00:03:56 Speaker 1: I made any sense?
  00:03:57 Speaker 2: No, you definitely did. You definitely did. UM.
  00:04:00 Speaker 1: You know and and and then and that affects my job performance. That affects my job
  00:04:00 Speaker 1: availability, right, going to my.
  00:04:07 Speaker 1: Work and you know not having a vehicle because of going through, losing everything right?
  00:04:07 Speaker 1: Like I, I had a great career and I don't want to go away from that career. But you know the
  00:04:07 Speaker 1: drama continues. I I can't be available for my career because I.
  00:04:27 Speaker 1: I you know, I always say I look, I I didn't have a vehicle to drive. I I barely, you know, honestly
  00:04:27 Speaker 1: I didn't even take a shower for like a month. It's just because you know.
  00:04:38 Speaker 1: I just I I found a a lower level job that like at a nursing home, you know and you know
  00:04:38 Speaker 1: everybody there smells anyway. So I was sorry to say that, but they do because I you know
  00:04:38 Speaker 1: you I'm just always cleaning up, you know, diapers the whole time. So yeah, I mean.
  00:04:59 Speaker 1: Nobody could tell if I took a shower or not, because but anyway, that's the only way I was
  00:04:59 Speaker 1: able to pull off that.
  00:05:07 Speaker 1: If I were to go in my real career, there's no way I could show up and not be, you know,
  00:05:07 Speaker 1: showered. You know, that's that's how low level I was, you know, and I still am kind of. I'm
  00:05:07 Speaker 1: getting a little bit better. I got a a vehicle yesterday. But you know, there you go. I mean, I can
  00:05:07 Speaker 1: ramble on and try to stick to the pointers.
  00:05:26 Speaker 1: There. But and the biggest thing is is is my family. Means the world to me and I put them
  00:05:26 Speaker 1: first and foremost in every way because I couldn't imagine not having my my family and I
  00:05:26 Speaker 1: don't know what to do right. I mean I I love my family so much.
  00:05:45 Speaker 1: And yet.
  00:05:47 Speaker 1: Look with my life. So, there you go. That's what's.
  00:05:50 Speaker 2: Yeah, it's that's that's a hard situation. When you say family, do you mean like husband,
  00:05:50 Speaker 2: children, who were you referring to, you say family?
  00:06:00 Speaker 2: Kids. Yeah. Kids. OK. OK. How old are your kids?
  00:06:04 Speaker 1: Yeah.
  00:06:07 Speaker 1: Young adults, but they're, UM, that special needs special needs. Then they can't
  00:06:07 Speaker 1: necessarily, umm, live on their own. So there are a little bit of umm resources out there to
  00:06:07 Speaker 1: support them and in a way. But you know.
  00:06:11 Speaker 2: OK, OK.
  00:06:27 Speaker 1: That's. That's the kind of words that I don't know that I want to go into. Does that make any
  00:06:27 Speaker 1: sense? Like I don't. I mean, nobody's gonna understand that. Except if, if, if, if they had a
  00:06:27 Speaker 1: family member who has special needs. I don't know if that they'll never make any sense to
  00:06:27 Speaker 1: anybody besides people who.
  00:06:45 Speaker 1: Or mothers specifically, maybe even fathers who have special needs kids something.
  00:06:52 Speaker 1: You know of of that relationship your your bond is is just different compared to typical.
  00:06:57 Speaker 2: In it, you're right, you're you're 100% right. There are resources out there to help, though.
  00:07:04 Speaker 2: I know you mentioned that you know that some of them, but there are resources that would
  00:07:04 Speaker 2: help in this situation that maybe you could utilize for your advantage to kind of get, you
  00:07:04 Speaker 2: know everybody back on there.
  00:07:14 Speaker 1: But you know.
  00:07:16 Speaker 1: The you know the the the the the problem is.
  00:07:22 Speaker 1: People get put out of their homes because of that, you know, I mean.
  00:07:28 Speaker 1: You know, like if I were to do that, if I reach out for help, you know, not always do the kids.
  00:07:37 Speaker 1: Embrace that you know, and and sometimes that can even cause more.
  00:07:42 Speaker 1: More drama, if that makes any sense. Meaning. I mean, maybe, maybe and and maybe
  00:07:42 Speaker 1: that's why you need to ask and tell it out loud, so maybe I can hear it in in a different view,
  00:07:42 Speaker 1: right? Like with my my kiddos. It's it's like you have to worry about their environment, right?
  00:07:42 Speaker 1: You you have to, you know, accommodate.
  00:08:03 Speaker 1: Their needs, meaning, you know.
  00:08:07 Speaker 1: UMII don't know how else to put it, but you have to accommodate that. You know you don't
  00:08:07 Speaker 1: have chaos in your in your environment, you don't have, you know, a lot of transitions, right?
  00:08:07 Speaker 1: A lot of changes and and you know.
  00:08:23 Speaker 1: And autism is what we're dealing with, right? So they're very highly sensitive to change in,
  00:08:23 Speaker 1: in, in our routines. And you know, so. So the best case scenario is having a stable.
  00:08:36 Speaker 1: Structured just a safe environment, really. UM.
  00:08:41 Speaker 1: So when I think about reaching out for help, you know that's that's lots of transition, right
  00:08:41 Speaker 1: like that. That's extra people coming in and out of of you know their day and.
  00:08:53 Speaker 1: And and and yeah, I would think that that's what what is needed, right to get those, those
  00:08:53 Speaker 1: kids, you know, on track. But you know, sometimes when you think it's the right thing,
  00:08:53 Speaker 1: sometimes it backfires and it it's it's it can be totally the wrong thing if that makes sense. It
  00:08:53 Speaker 1: it does make sense, but you need help.
  00:09:13 Speaker 2: You can't do it.
  00:09:14 Speaker 1: Yeah.
  00:09:14 Speaker 2: On your own.
  00:09:15 Speaker 2: And there are resources out there that can help.
  00:09:19 Speaker 1: But I'm supposed to be able to figure it out. I'm supposed to be able to do it, you know, if I
  00:09:19 Speaker 1: don't do it, I failed.
  00:09:24 Speaker 2: Well, part of part of part of figuring it out is utilizing resources available.
  00:09:34 Speaker 1: Yeah.
  00:09:35 Speaker 2: OK. Because there there are there the resources are there for a reason.
  00:09:40 Speaker 2: Because you don't have to be alone to help.
  00:09:44 Speaker 2: There are people out there that know how to deal with it, that can teach you how to deal
  00:09:44 Speaker 2: with it, that can teach you.
  00:09:49 Speaker 2: How to help your family?
  00:09:55 Speaker 2: Have you ever worked with the Autism Center for xxxxx?
  00:09:55 Speaker 2: 00:09:57
  00:09:55 Speaker 2: I would.
  00:10:01 Speaker 1: I reached out to hundreds of people and I never get anything, you know? You know what?
  00:10:01 Speaker 1: There was one time I had my my kid take medication. It was during the COVID time and it
  00:10:01 Speaker 1: was like right after the COVID hit. And I I put my son on medicine through the.
  00:10:20 Speaker 1: Psychiatrist, doctor and you know, here's here's just an example of why I fear all these
  00:10:20 Speaker 1: things is because that doctor gave my kid.
  00:10:30 Speaker 1: Like lorazepam and and then we make my kid, you know, again, the doctor didn't do
  00:10:30 Speaker 1: anything besides drag my kid up and, you know, didn't you know, encourage counseling and
  00:10:30 Speaker 1: will maybe encourage it. But we never, you know, got that lead. It didn't get no referral. But
  00:10:30 Speaker 1: anyway, my point is, is he gave my son the lorazepam. And then when it didn't work.
  00:10:52 Speaker 1: You know my son, you know, went wacko on it. You know, the doctor was like, no, give him
  00:10:52 Speaker 1: another one. And and and I was like. Ohh. And then I said well, it didn't work. He's still crazy
  00:10:52 Speaker 1: angry.
  00:11:04 Speaker 1: And you know, so the point is, is is the the instead the doctor's saying, oh, that didn't work.
  00:11:04 Speaker 1: Let's try a different thing. He increased the very crap that was making my kid crazy. And so,
  00:11:04 Speaker 1: you know, my kid was on xxxxxx. And like fluorine, you know, flight was coming out of his
  00:11:04 Speaker 1: mouth. I couldn't even stay up.
  00:11:25 Speaker 1: And and I I told that doctor I said that that's wrong. It's not the way.
  00:11:29 Speaker 1: Live and he wouldn't. He was like, well, we can't take him off of it. And I said heck, we are.
  00:11:29 Speaker 1: And he said no, we're not. And I said, you know, you have to do this. That's an unethical. You
  00:11:29 Speaker 1: can't. That's a drug that you can't just drop off. You have to taper it. And so I went
  00:11:29 Speaker 1: immediately and found another doctor right away.
  00:11:49 Speaker 1: And she started started the process of winging them off. She was like, that's a horrible
  00:11:54 Speaker 1: Drug and you know, and then then later on in my, you know, later on month later, I had
  00:11:54 Speaker 1: heard from families because I worked at the hospital and people would talk about that
  00:11:54 Speaker 1: doctor about how he ruined their daughters, kidneys and liver and and organs because, you
  00:11:54 Speaker 1: know, he had feed fed them so many drugs that were, you know, toxic to their.
  00:12:15 Speaker 1: So that's just one example of why I don't trust the system at all. You know, like, you know,
  00:12:15 Speaker 1: you you tried it to reach out for a resource and you think you're doing.
  00:12:27 Speaker 1: Good, good thing and and even when you advocate like when I said Ohh hell doctor that's
  00:12:27 Speaker 1: wrong. You know he really put a it was just a lot of.
  00:12:38 Speaker 1: A lot of tough times, you know what I'm saying? Like.
  00:12:42 Speaker 1: But then you know, I found a real good doctor and she was phenomenal and and hung him
  00:12:42 Speaker 1: off all medication. And it was like.
  00:12:49 Speaker 1: So you know what I'm saying? Like there could be really bad things that occur. And I guess I
  00:12:49 Speaker 1: don't know. You're right. I need to figure out.
  00:12:58 Speaker 1: Should be OK with UM asking for help and and know that I can get through this.
  00:13:01 Speaker 2: And that is the hardest thing to do. That really is the hardest thing to do. The Autism Center
  00:13:01 Speaker 2: for xxxxx is a fabulous, fabulous resource. They have a list of, like therapists. They have a list
  00:13:01 Speaker 2: of resources to help. They have a lot of things that maybe you didn't even know existed as
  00:13:01 Speaker 2: far as being able to help with kind of your situation.
  00:13:21 Speaker 2: And and with your with your family. So I would start there.
  00:13:25 Speaker 1: OK, so where let me Google. I don't have a pen and paper, so let me Google it and then I'll
  00:13:25 Speaker 1: take a picture of the contact information. What is it called autism?
  00:13:33 Speaker 2: It's called.
  00:13:34 Speaker 2: Center for xxxxx.
  00:13:37 Speaker 1: Center.
  00:13:44 Speaker 1: OK, this artist instead for xxxxx. OK. And it's a nonprofit organization, and let's see it says it
  00:13:44 Speaker 1: says, uh, the phone number and then 1000.
  00:13:58 Speaker 2: It sounds about right. Yeah. Without without looking at it. But that if you got the website,
  00:13:58 Speaker 2: then that'll be the good place to start. They have they, you know, they have case managers.
  00:13:58 Speaker 2: They can work with you. They can offer resources. They can kind of put you in the right
  00:13:58 Speaker 2: direction of how to get you and your family back on their feet.
  00:14:15 Speaker 1: OK, alright, I'll do that tomorrow because they're not probably open now, right? But they'll
  00:14:15 Speaker 1: have a.
  00:14:19 Speaker 2: Yeah, they're not gonna be able, but they'll be. They'll be open tomorrow. I really hope they
  00:14:19 Speaker 2: can help you. You know, you care about your family. And that is amazing. And you're they're
  00:14:19 Speaker 2: very lucky to have you as their mom.
  00:14:23 Speaker 1: You'll have a look right here.
  00:14:33 Speaker 1: Yeah, I know, I know. But it's it's killing me, you know, it's it's literally killing me. You know, I
  00:14:33 Speaker 1: can't imagine.
  00:14:39 Speaker 2: That's why it never hurts to accept.
  00:14:41 Speaker 1: The physical.
  00:14:41 Speaker 2: Help.
  00:14:41 Speaker 2: When you need it.
  00:14:44 Speaker 2: And you need it, and there's nothing wrong with needing help. There's nothing wrong for
  00:14:44 Speaker 2: asking for help because honestly, asking for help is a sign of strength, because it's a sign
  00:14:44 Speaker 2: that you recognize you can't do everything. You've tried it, and it hasn't worked.
  00:14:59 Speaker 2: Doesn't mean you're a bad person. Doesn't make you a bad parent. It just means you need.
  00:15:02 Speaker 2: A little assistance.
  00:15:04 Speaker 2: A little step in the right direction so that you can meet their needs.
  00:15:10 Speaker 1: Gosh, it's just too bad people like my, my friends and you know, why can't they be the the
  00:15:10 Speaker 1: helpers compared to like going to to the state and asking for help you.
  00:15:22 Speaker 2: Know you know and and saying, you know, they're they're people. Everybody knows
  00:15:22 Speaker 2: different things. And so sometimes you just gotta reach out to an expert.
  00:15:30 Speaker 2: To kind of help help your situation.
  00:15:34 Speaker 1: True. True. OK. I appreciate that I'm going to do that tomorrow. I think that's going to be
  00:15:34 Speaker 1: helpful. I I pray that it's I I have to use the right language. I have to tell them. Listen, I I just
  00:15:34 Speaker 1: need I if I tell them exactly what I told you then that will get me somewhere, right.
  00:15:51 Speaker 2: I think so. I think definitely. Well, it's a start in the right direction for sure.
  00:15:56 Speaker 1: OK, because I swear I've I've called many places. I just didn't. And then they're they're
  00:15:56 Speaker 1: always like. Well, what? What, what can we do? What can we help you with? And I'll be like,
  00:15:56 Speaker 1: well, I don't know. But just here's my problem. So let's figure it out.
  00:15:57 Speaker 2: It definitely is.
  00:16:06 Speaker 2: You don't know what's out there. Just ask what kind of resources are out there. Ask what
  00:16:06 Speaker 2: kind of resources are out there for help for you. Just give them what you need. Give them
  00:16:06 Speaker 2: the circumstances, let them know you know that you're you're trying to get everybody on
  00:16:06 Speaker 2: the same like on this. Get everybody on their feet.
  00:16:21 Speaker 2: Basically, and so if you explained it the way that you explained it to me, I think they'll be
  00:16:21 Speaker 2: able to offer you some help hopefully. And if they don't definitely reach back out to us, OK,
  00:16:21 Speaker 2: there may be some other options in the in the area.
  00:16:32 Speaker 1: Yeah, cause you know.
  00:16:34 Speaker 1: You, you you know what kinds of things I'm dealing with, like my. My kids are running away
  00:16:34 Speaker 1: from. I've I've to buy tracking devices on them. Like pretty much every other day because
  00:16:34 Speaker 1: they've gotten smart where they just throw them away now, you know? So and those are
  00:16:34 Speaker 1: not cheap, you know, literally that's $30.
  00:16:54 Speaker 1: Every other day, just for the the tracking device, you know, I mean.
  00:17:00 Speaker 1: And and then.
  00:17:02 Speaker 1: You know, broken things, things that are being broken. I have to pay for, you know, legal
  00:17:02 Speaker 1: things, right? Like the police, you know. And you know, attorneys, I've had to pay tons of
  00:17:02 Speaker 1: money for attorneys, you know? And I I just.
  00:17:20 Speaker 1: I don't know why my.
  00:17:20 Speaker 2: It's a lot.
  00:17:23 Speaker 1: I don't know why? Why? Why? They're having such a tough time. Like I I don't get it.
  00:17:31 Speaker 2: And maybe getting some resources in place will help with that. Maybe getting an
  00:17:31 Speaker 2: understanding of of diagnosis, getting an understanding of what they need as far as
  00:17:31 Speaker 2: anything that can help. I think it'll help you in the long run.
  00:17:45 Speaker 1: Yeah. OK God.
  00:17:47 Speaker 2: I I wish you the best of luck with everything and feel free to reach out again if you need
  00:17:47 Speaker 2: some more help, OK?
  00:17:47 Speaker 1: Alright, thank you so much.
  00:17:52 Speaker 1: OK. Thank you so much. Bye bye bye.
  00:17:53 Speaker 2: Alright, thanks.

  --- Example Completed Scoring Sheet (CSV) ---
  Unnamed: 0,Name: Crystal Olson ,Unnamed: 2,Unnamed: 3,Unnamed: 4,Unnamed: 5,Unnamed: 6
  ,,,,,,
  ,,,,,,
  ,,,,,988N2025003599,
  ,,,,,Contact ID: 3213827,
  ,,,,,,
  ,Rapport Skills/How We Treat People:,,,,,
  1.0,Tone,1.0,0.0,,"Talks quickly, somewhat over caller. 15:23 I know (kind of dismissive) also below - 17:52/termination.",
  2.0,Professional,1.0,1.0,,,
  3.0,Conversational style ,1.0,1.0,,,
  4.0,Supportive Initial Statement,1.0,0.0,,"0:16 Sure, my name is Crystal, what's your name?",
  5.0,Affirmation & Praise,1.0,1.0,,14:27 You care about your family and that is amazing. They are very lucky to have you.,
  6.0, Reflection of Feelings,2.0,1.0,,"1:28 Sounds like you've gone through a lot. 3:55 That's a lot. 5:54 That's a hard situation. 9:10 Makes sense, but you need help, you can't do it on your own. ",
  7.0,Explores Problem(s),1.0,0.0,,0:46 What are you struggling with? What's going on? What prompted her to call today?,
  8.0,Values the Person,1.0,0.0,,"9:31 Part of figuring it out is utilizing resources available. 15:32 Everyone knows different things, sometimes you just got to reach out to an expert. Kind of advice giving instead of supporting.",
  9.0,Non-Judgmental,1.0,1.0,,,
  ,Rapport Skills  ,,5.0,4.0,20,
  ,Counseling Skills/The Process We Use:,,,,,
  10.0,Clarifies Non-Suicidal Safety,1.0,1.0,,,
  11.0,Suicidal Safety Assessment-SSA (Lethality Risk Assessment-LRA): Initiation and Completion,4.0,1.0,,Did not assess for lethality. 3rd party.,
  12.0,Exploration of Buffers (Protective Factors),1.0,0.0,,Did not explore current Buffers (PF)/support.,
  13.0,Restates then Collaborates Options,1.0,0.0,,9:47 Talks to caller about using resources. Caller is frustrated as she has reached out to many organizations and has not seen any results. Gave referral for Autism Center. 13:27 I would start there. Tells caller what to do - does not pay attention to what the caller is saying.,
  14.0,Identifies Concrete Plan ,2.0,2.0,,15:52 Is going to reach out to the referral tomorrow. Agrees to call back if in crisis again.,
  15.0,Appropriate termination (Follow Up Offered),1.0,1.0,,17:52 I wish you the best with everything - kind of dismissive (tone point taken off at top).,
  ,Counseling Skills ,,5.0,4.0,20,
  ,Organizational Skills:,,,,,
  16.0,POP Model - does not rush,1.0,1.0,,,
  17.0,POP Model - does not dwell,1.0,1.0,,,
  ,Organizational Skills,,2.0,4.0,8,
  ,Technical Skills,,,,,
  18.0,Greeting,1.0,1.0,,"Thank you for calling 988 Lifeline, how can I help you?",
  19.0,SSA (LRA) Documentation,1.0,1.0,,Filled out risk factors.,
  20.0,Call Documentation/SC Communication,1.0,1.0,,ok,
  ,Technical Skills,,3.0,4.0,12,
  ,Overall Total,,15.0,4.0,60,80+ Meets Criteria
  ,   CONTACT  Average,,,,,70-79 Improvement Needed
  ,,,,,,<69 Not At Criteria

  `;

  // Create the user message with the transcript
  const userMessage = `Here is the call transcript to evaluate. The transcript includes a summary followed by the conversation between the AGENT (counselor) and CUSTOMER (caller). 
  Now act as a master evaluator and based on all the infromation you have, analyze the transcript according. Give accurate and detailed assessment which is free of any form of bias, 
  you don't always have to give a full score, you have to evaluate s that we can provide a constructive feedback and improve overall performance of the counselor is necessary.

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
        //maxTokens: 4096,
        temperature: 0.1,
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
