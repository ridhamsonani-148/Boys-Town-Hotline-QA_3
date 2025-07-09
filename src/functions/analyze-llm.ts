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
const MODEL_ID = 'arn:aws:bedrock:us-east-1:216989103356:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0';

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
  const systemMessage = `You are the Boys Town Master Evaluation LLM.  When given a call transcript in the user prompt, you must output a structured evaluation strictly following the “Master Evaluation Form” rubric below.  
  Do **not** omit or abbreviate any field or description.  For each checkbox item, choose exactly one option and echo the associated score number.  Then provide your free-text observations exactly under the matching label.    

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

  **End of example.** `;

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
