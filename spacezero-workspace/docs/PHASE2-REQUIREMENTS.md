phase 2ga o'tamiz: hammasini steplarga bo'lib boshidan oxirgacha tugat: LET'S GOOO!!!!

* SPACEZERO ACADEMY — PHASE 2 
AI Training Intelligence, Call Intelligence, Assessment 
Generation & Intensive Practice Engine 
Phase 1 must already be functioning. 
Do NOT rebuild or replace the Phase 1 architecture. 
Build on top of the existing authentication, roles, teams, employee profiles, training 
assignments, Knowledge Library, Skill Graph foundation, Supabase database and security 
architecture. 
This phase creates the core intelligence engine of SpaceZero Academy. 
The fundamental workflow is: 
UPLOAD → ANALYZE → CLASSIFY → RECOMMEND PRACTICE → HUMAN APPROVAL 
→ PRACTICE → SCORE → RETAKE IF REQUIRED → UPDATE SKILLS 
Use the Google Gemini API as the primary AI engine. 
All Gemini/API processing must happen securely server-side. 
Never expose API keys in browser/client code. 
1. TRAINING CREATION WORKFLOW 
Admin or authorized Supervisor clicks: 
Create Training 
The creation workflow should be simple and guided. 
Step 1 — Basic Information 
Allow: 
● Training title 
● Description 
● Intended audience 
● Travel Agent 
● Flight Expert 
● Supervisor 
● Multiple roles 
● Specific team 
● Specific employees 
● Optional due date 
● Mandatory or optional 
● Passing threshold 
Default minimum passing score: 
70% 
Admin may configure a HIGHER threshold for a particular training. 
Do not allow mandatory assessments below the organization's configured minimum without 
Admin authorization. 
2. TRAINING MATERIAL UPLOAD 
One training may contain MULTIPLE sources. 
Support: 
● Video 
● PDF 
● PowerPoint / PPTX 
● Word / DOCX 
● Audio 
● Images/screenshots 
● Written notes 
● Call recordings 
Example: 
A Supervisor could upload: 
1 training video 
1 PDF 
additional written notes 
The AI must understand these materials TOGETHER as one training package. 
Preserve source relationships. 
Where technically possible, preserve: 
● PDF page 
● slide number 
● video timestamp 
● audio timestamp 
● document section 
This will later allow generated training and feedback to explain where information came from. 
3. TRAINING INTELLIGENCE ENGINE 
Gemini must first UNDERSTAND the material. 
Do NOT immediately ask Gemini: 
"Create a quiz." 
Use a multi-stage pipeline. 
Stage A — Extract 
Extract: 
● facts 
● rules 
● procedures 
● concepts 
● terminology 
● examples 
● warnings 
● common mistakes 
● workflows 
● decision points 
● communication techniques 
● practical behaviors 
● skills being taught 
● expected employee actions 
Stage B — Build Training Map 
Produce validated structured output containing: 
● training type 
● learning objectives 
● extracted skills 
● critical knowledge 
● practical behaviors 
● common mistakes 
● difficulty 
● recommended assessment methods 
● recommended practice intensity 
● relevant Skill Graph skills 
Stage C — Validate 
Run a validation step before assessment generation. 
Verify that: 
● questions are supported by source material 
● correct answers are supported by source material 
● company rules are not invented 
● important material is covered 
● assessments test application rather than only memory 
● practical exercises match the actual training 
Where technically possible, maintain internal source references. 
4. AUTOMATIC TRAINING 
CLASSIFICATION 
AI should classify training automatically. 
Possible classifications include: 
● Sales / Communication 
● Technical 
● Process / SOP 
● Product Knowledge 
● Customer Service 
● Leadership / Supervisor 
● Compliance / Policy 
● Mixed 
A training may have multiple classifications. 
Example: 
"Keeping Premium Clients on the Line" 
could be: 
Sales + Communication + Customer Service 
Example: 
"Sabre Mixed Cabin" 
could be: 
Technical + Process 
5. AI PRACTICE RECOMMENDATION 
After analysis, show the creator: 
AI Recommended Practice Plan 
Example: 
Training: 
Keeping Premium Clients on the Line 
AI recommends: 
✓ Knowledge Quiz 
✓ AI Client Role-play 
✓ Voice Practice 
✓ Objection Handling Simulation 
Not recommended: 
Technical Command Exercise 
Creator can choose: 
Accept AI Recommendation 
OR 
Customize Practice 
This is essential. 
AI recommends. 
Admin/Supervisor retains final control. 
6. PRACTICE TYPES 
Build a modular Practice Engine. 
Different training should produce different forms of practice. 
A. KNOWLEDGE QUIZ 
Support: 
● Multiple choice 
● Multi-select 
● Ordering 
● Matching 
● Scenario questions 
● Short answers 
● True/False only when appropriate 
Avoid trivia. 
Prefer practical questions. 
Bad: 
"What is Sabre?" 
Better: 
"A customer wants Business Class from LAX to Tokyo with one connection. What should you 
verify before presenting the itinerary?" 
B. SALES ROLE-PLAY 
Gemini acts as a realistic customer. 
Possible customer personalities: 
● Busy executive 
● Price-sensitive traveler 
● Skeptical traveler 
● Returning premium customer 
● Luxury traveler 
● Difficult customer 
● Comparison shopper 
● "I'll think about it" customer 
● Customer who wants to get off the phone quickly 
The AI must NOT make the role-play artificially easy. 
The simulated customer should react naturally to what the Agent says. 
Evaluate relevant skills such as: 
● Opening 
● Discovery 
● Listening 
● Confidence 
● Call control 
● Client engagement 
● Product knowledge 
● Price presentation 
● Objection handling 
● Professionalism 
● Closing 
● Next-step creation 
C. VOICE PRACTICE 
Agent responds verbally. 
Where authorized: 
● record response 
● store securely 
● transcribe 
● analyze response 
Evaluate supported characteristics such as: 
● clarity 
● pacing 
● filler words 
● structure 
● professionalism 
● communication quality 
● training-content accuracy 
Do NOT claim to scientifically determine personality or emotion from someone's voice. 
D. TECHNICAL PRACTICE 
Especially important for Flight Experts and Sabre/GDS training. 
Generate: 
● command completion 
● workflow ordering 
● error diagnosis 
● scenario solving 
● next-best-action 
● technical simulations 
Example: 
"A client needs JFK–LHR Business Class on October 15. Show the appropriate workflow for 
searching availability." 
Test actual application rather than definitions only. 
E. PROCESS SIMULATION 
For SOP/process training: 
Present a realistic situation. 
Learner chooses an action. 
Scenario changes according to learner decisions. 
Evaluate whether correct workflow was followed. 
F. PRODUCT KNOWLEDGE PRACTICE 
Especially useful for: 
● Aircraft 
● Business Class cabins 
● First Class cabins 
● Seats 
● Airlines 
● Lounges 
● Product differences 
Ask learner to: 
● identify products 
● compare aircraft 
● compare cabins 
● choose the appropriate option 
● identify meaningful differences 
● explain a product to a customer 
● recommend the best option for a particular traveler 
7. INTENSIVE PRACTICE 
Practice should NOT consist of one easy quiz. 
The objective is demonstrated competence. 
Where appropriate use progressive difficulty: 
Level 1 — Recall 
Does the learner remember the information? 
Level 2 — Understanding 
Does the learner understand why? 
Level 3 — Application 
Can the learner use the information? 
Level 4 — Realistic Scenario 
Can the learner perform in a realistic work situation? 
Level 5 — Difficult Scenario 
Can the learner handle complications, objections, errors or edge cases? 
Not every training requires all five levels. 
AI should recommend appropriate intensity. 
Admin/Supervisor may adjust it. 
8. SCORING SYSTEM 
Every assessment should produce: 
● Overall score 
● Skill-level scores 
● Evidence 
● Feedback 
● Mistakes 
● Recommended improvement 
● Retake recommendation if required 
PASSING RULE 
Default minimum passing score: 
70% 
If the final required score is below 70%: 
FAILED — RETAKE REQUIRED 
Suggested competency labels: 
Below 70% — Retake Required 
70–79% — Passed / Needs Improvement 
80–89% — Proficient 
90–100% — Strong Mastery 
Allow Admin to configure these labels/thresholds later. 
Passing does NOT mean the skill disappears from coaching. 
Example: 
Agent passes at 73%. 
Their Skill Graph might still show: 
Objection Handling — 64% — Priority Improvement 
Training completion and skill competency are separate concepts. 
9. SMART RETAKE ENGINE 
If an employee scores below 70%, do NOT simply show exactly the same test again. 
Identify WHY they failed. 
Example: 
Overall: 62% 
Aircraft Knowledge: 91% 
Discovery: 78% 
Objection Handling: 39% 
Closing: 46% 
Do NOT force unnecessary Aircraft Knowledge practice. 
Instead generate targeted remediation for: 
● Objection Handling 
● Closing 
Then reassess those skills. 
Retake questions/scenarios should vary while testing the same competency. 
Store every attempt permanently. 
Never overwrite previous scores. 
10. REAL CUSTOMER CALL UPLOAD — 
CORE FEATURE 
Real customer communications will be one of the most important inputs into SpaceZero 
Academy. 
Admin and authorized Supervisor must be able to upload customer call recordings. 
Support: 
● Single call 
● Multiple calls 
● Batch upload 
When uploading call(s), immediately ask: 
"How should these calls be used?" 
Provide two primary options. 
OPTION 1 — INDIVIDUAL AGENT 
IMPROVEMENT 
Analyze these calls to coach a specific employee. 
Creator selects the employee. 
Example: 
Travel Agent: John Smith 
Calls uploaded: 10 
The system securely transcribes and analyzes the calls. 
Analyze relevant patterns such as: 
● Opening 
● Discovery 
● Listening 
● Call control 
● Keeping customer engaged 
● Product explanation 
● Price presentation 
● Objection handling 
● Confidence of language 
● Professionalism 
● Closing 
● Next steps 
● Missed opportunities 
Do NOT judge an employee based on one isolated moment where multiple calls exist. 
For multiple calls, identify REPEATED patterns. 
Example output: 
Strengths 
Product Knowledge — Strong 
Discovery — Strong 
Professionalism — Strong 
Improvement Areas 
Objection Handling — Weak 
Client Engagement — Weak 
Closing — Needs Improvement 
Then recommend: 
Personalized Practice Plan 
Example: 
✓ Objection Handling Role-play 
✓ "I'll Think About It" Simulation 
✓ Closing Practice 
✓ Client Engagement Voice Exercise 
Admin/Supervisor reviews recommendations. 
They can: 
● Accept 
● Edit 
● Remove 
● Add practice 
Then: 
Assign to Agent 
The assigned practice appears on the employee's dashboard. 
Results update the employee's Skill Graph. 
OPTION 2 — BEST-PRACTICE / TRAINING 
CALL 
Use this successful call to teach other employees. 
This is for strong calls from top-performing agents or other examples management considers 
valuable. 
Example: 
A high-performing Agent closes a difficult $12,000 Business Class sale. 
Admin uploads the call and selects: 
Best-Practice Training Call 
Gemini analyzes: 
Why did this call work? 
Identify: 
● Strong opening 
● Effective discovery 
● Key questions 
● Trust-building moments 
● Good product explanation 
● Price positioning 
● Objection handling 
● Conversation control 
● Closing technique 
● Important turning points 
Where possible, connect observations to transcript timestamps. 
Example: 
03:42 — Discovery 
Agent discovers that schedule flexibility matters more than price. 
08:17 — Value Positioning 
Agent explains why the selected routing is better before presenting price. 
14:32 — Objection Handling 
Agent addresses price resistance without immediately discounting. 
18:05 — Closing 
Agent creates a clear next step and secures commitment. 
Then AI can create a training package from the call: 
● Training title 
● Learning objectives 
● Call summary 
● Key moments 
● Why the techniques worked 
● Extracted skills 
● Best-practice examples 
● Quiz 
● Role-play 
● Scenario practice 
● Reflection questions 
Admin/Supervisor MUST review and approve this material before it becomes training. 
Once approved, it can be assigned to: 
● Specific employee 
● Team 
● All Travel Agents 
● Other appropriate audiences 
This turns strong real-world performance into reusable company training. 
11. CALL PROCESSING ARCHITECTURE 
Calls may be long and there may eventually be many. 
Do NOT build call processing as one huge synchronous API request. 
Use a processing pipeline. 
Suggested states: 
UPLOADED 
→ TRANSCRIBING 
→ ANALYZING 
→ AGGREGATING 
→ GENERATING PRACTICE 
→ READY FOR REVIEW 
→ APPROVED 
Handle: 
● processing failures 
● retry 
● partial failure 
● corrupted audio 
● unsupported formats 
● duplicate upload 
● long recordings 
● batch processing 
The UI should clearly show processing status. 
12. CALL SECURITY 
Customer calls may contain sensitive information. 
Treat them as highly sensitive. 
Implement: 
● private storage 
● strict RLS 
● short-lived signed URLs 
● role validation 
● access logging 
● configurable retention 
● deletion workflow 
● secure transcription processing 
● server-side AI processing 
Never use public storage buckets for calls. 
Document what information is transmitted to external AI services. 
Architecture should support redacting sensitive information before AI analysis. 
Where practical, redact: 
● payment/card information 
● passport/document numbers 
● phone numbers 
● email addresses 
● other unnecessary personally identifiable information 
Do not send unnecessary sensitive data to Gemini. 
13. HUMAN ASSIGNMENT ENGINE 
Admin can assign: 
● Complete training 
● Specific practice 
● Skill remediation 
● Retake 
● Call-generated personalized training 
Supervisor can perform the same actions only for employees they are authorized to manage. 
Example: 
Supervisor sees: 
Client Engagement — 54% 
Clicks: 
Assign Practice 
Selects: 
Client Engagement Role-play 
Sets: 
● due date 
● required attempts 
● minimum score 
● optional Supervisor note 
Employee receives notification. 
14. SKILL GRAPH UPDATE 
Every meaningful assessment creates Skill Evidence. 
Gemini must NOT directly overwrite someone's Skill Graph score. 
Store evidence. 
Each evidence item should contain: 
● Employee 
● Skill 
● Assessment 
● Assessment type 
● Score 
● Difficulty 
● Date 
● Attempt number 
● Source 
● Evidence weight/confidence 
Examples of evidence sources: 
● Quiz 
● Role-play 
● Voice Practice 
● Technical Simulation 
● Call Analysis 
● Supervisor Assessment 
The Skill Graph calculation then determines current competency. 
Practical evidence should generally carry more weight than simple recall questions. 
Recent evidence should generally matter more than very old evidence. 
Do not use arbitrary "+2 / -2" scoring. 
Keep the scoring model transparent and configurable. 
15. CREATOR REVIEW 
AI-generated material must NOT automatically become mandatory employee training. 
Before publishing, Admin/Supervisor sees: 
● AI classification 
● Extracted objectives 
● Detected skills 
● Recommended practices 
● Generated questions 
● Role-play configuration 
● Technical exercises 
● Scoring rubric 
● Source references where available 
For call-generated training also show: 
● call analysis 
● selected call moments 
● AI explanation of why they matter 
Creator can: 
● Edit 
● Delete 
● Regenerate 
● Approve 
Only after approval can the material be assigned. 
16. AI RELIABILITY 
Use structured outputs/schema validation wherever possible. 
Do not trust raw AI output blindly. 
Validate: 
● required fields 
● scores 
● ranges 
● question structure 
● correct-answer existence 
● source references 
● training type 
● skill mappings 
Implement: 
● retry logic 
● timeout handling 
● malformed-output handling 
● API failure handling 
● rate-limit handling 
● processing status 
● useful error messages 
Store appropriate metadata for AI-generated assessments, including model/version where 
useful. 
17. PHASE 2 ACCEPTANCE TESTS 
Do not consider Phase 2 complete until all of these are tested. 
TEST A — SALES VIDEO 
Upload a sales training video. 
Expected: 
AI identifies Sales/Communication. 
Recommends: 
● Quiz 
● Role-play 
● Voice/scenario practice 
Generated assessment must reflect actual video content. 
TEST B — SABRE TRAINING 
Upload Sabre/GDS technical training. 
Expected: 
AI identifies Technical/Process. 
Recommends: 
● Technical exercises 
● Workflow scenarios 
● Practical assessment 
It must NOT treat Sabre training like generic sales training. 
TEST C — AIRCRAFT / CABIN MATERIAL 
Upload aircraft/cabin slides or PDF. 
Expected: 
AI identifies Product Knowledge. 
Generates: 
● product comparison 
● aircraft/cabin questions 
● realistic customer recommendation scenarios 
TEST D — MIXED VIDEO + NOTES 
Upload training video plus additional written notes. 
Expected: 
AI uses BOTH sources. 
Assessment should incorporate relevant information from both. 
TEST E — INDIVIDUAL AGENT CALL ANALYSIS 
Upload multiple real customer calls for one Agent. 
Select: 
Individual Agent Improvement 
Expected: 
● Calls transcribed 
● Calls analyzed 
● Repeated strengths identified 
● Repeated weaknesses identified 
● Relevant Skill Graph skills mapped 
● Personalized practice recommended 
● Supervisor/Admin can review 
● Practice can be assigned to that Agent 
TEST F — BEST-PRACTICE CALL 
Upload a strong successful sales call. 
Select: 
Best-Practice / Training Call 
Expected: 
AI explains: 
● why the call worked 
● important moments 
● techniques used 
● skills demonstrated 
Then generates a reusable training package. 
Admin/Supervisor reviews before publishing. 
Training can then be assigned to other employees. 
TEST G — FAILURE / RETAKE 
Agent scores: 
69% 
Expected: 
FAILED 
RETAKE REQUIRED 
System identifies weak skills. 
Targeted remediation is created. 
Agent completes new practice. 
Agent scores: 
82% 
Expected: 
PASSED 
Both attempts remain in history. 
Skill Evidence and Skill Graph update correctly. 
18. FINAL PHASE 2 QA 
Before reporting completion: 
Run: 
● TypeScript checks 
● lint 
● production build 
● relevant automated tests 
● RLS/permission tests 
● upload tests 
● large-file tests 
● Gemini API failure tests 
● malformed AI response tests 
● scoring tests 
● retake tests 
● call processing tests 
● batch call tests 
● Agent/Supervisor/Admin authorization tests 
Verify: 
● No exposed API keys 
● No public customer-call storage 
● No cross-team data leakage 
● No dead buttons 
● No fake functionality 
● No critical console errors 
● No unfinished critical flow 
● No placeholder functionality represented as complete 
After Phase 2 is complete, provide: 
1. What was implemented 
2. Files created/changed 
3. Database migrations 
4. AI architecture 
5. Gemini integration 
6. Call-processing architecture 
7. Security implementation 
8. Tests performed 
9. Manual configuration required 
10. Known limitations/risks 
11. Exact instructions for testing Phase 2 myself 
STOP AFTER PHASE 2. 
Do NOT start Phase 3 until instructed. 
ADDITION — MANDATORY VIDEO / AUDIO 
CONSUMPTION & ANTI-SKIP CONTROLS 
For mandatory training containing VIDEO or AUDIO/CALL content, the learner must actually 
consume the required material before proceeding to the assessment. 
The system must NOT mark training as completed simply because the media player reached 
the end. 
Learners may watch videos or listen to audio at up to 1.2× playback speed. Playback speed 
must not exceed 1.2× for mandatory training content. 
VIDEO TRAINING 
For mandatory video: 
● Disable seeking into unwatched future portions of the video. 
● Employee may rewind previously watched sections. 
● Employee may pause and resume. 
● Employee may select playback speeds from the available options up to 1.2×. 
● Track actual watched ranges. 
● Track total required watch coverage. 
● Save progress securely. 
● Allow employee to continue later from their previous position. 
Example: 
Employee has genuinely watched minutes 0–12. 
They may: 
✓ rewind to minute 5 
✓ continue from minute 12 
✓ watch at up to 1.2× speed 
They may NOT: 
✗ jump directly from minute 12 to minute 35 
✗ use a playback speed faster than 1.2× to bypass the required training time 
Once minute 35 has genuinely been reached through playback, that section becomes available 
for normal seeking/review. 
AUDIO / TRAINING CALLS 
Apply equivalent rules to mandatory audio and training calls. 
Employee must listen to the complete required recording. 
They may: 
● pause 
● resume 
● rewind already-consumed sections 
● listen at up to 1.2× playback speed 
They may NOT: 
● skip forward over unconsumed mandatory content 
● use a playback speed faster than 1.2× to bypass required content 
COMPLETION TRACKING 
Store server-side learning progress including: 
● Employee 
● Training 
● Media item 
● Duration 
● Playback speed 
● Watched/listened ranges 
● Percentage consumed 
● Last playback position 
● Started timestamp 
● Last activity 
● Completed timestamp 
Do NOT rely solely on browser-side video ended or audio ended events. 
Client-side events can be manipulated. 
Completion state must be validated and persisted through the backend. 
MULTIPLE MEDIA ITEMS 
If a training contains: 
Video 1 
Video 2 
PDF 
Training Call 
Notes 
The creator should be able to mark individual materials as: 
Required 
or 
Optional / Reference 
All REQUIRED media must satisfy its completion requirements before the mandatory final 
assessment can be unlocked. 
The 1.2× playback-speed limit applies to required video and audio/call content. 
Optional/reference media may follow the normal media-player rules. 
ASSESSMENT LOCK 
If mandatory training content has not been completed: 
Keep: 
Start Assessment 
locked. 
Display clearly: 
"Complete all required training material before starting the assessment." 
Once all required material has been completed: 
Unlock the assessment. 
IMPORTANT — DO NOT CREATE A FRUSTRATING EXPERIENCE 
The anti-skip system is intended to prevent employees from falsely completing training. 
It should NOT punish legitimate learning behavior. 
Employees should always be able to: 
● Pause 
● Continue later 
● Rewind 
● Replay 
● Review previously completed sections 
● Watch or listen at up to 1.2× speed 
Progress must survive: 
● Page refresh 
● Logout/login 
● Browser restart 
● Device change where technically supported 
ADMIN / SUPERVISOR VISIBILITY 
Authorized Admin/Supervisor should be able to see: 
Training assigned 
Training started 
Media progress 
Training content completed 
Assessment unlocked 
Assessment attempted 
Passed / Failed / Retake Required 
Do NOT expose unnecessary low-level tracking information in the normal Supervisor UI. 
Present useful learning status rather than surveillance-style analytics.
