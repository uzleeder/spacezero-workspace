# AI Practice — implementation audit (done BEFORE any code was changed)

Scope: AI Practice, AI Practice → Training, and Training receiving approved AI Practice packages.
Phase 3 (Skill Graph, analytics, intelligence) was out of scope and is only touched where it must be *read*.

## 1. AI Practice routes (before)
| Route | What it did |
|---|---|
| `GET /ai-practice` | Hub: work items derived from call batches + draft courses, tabs by "stage", plus a list of "Earlier raw uploads". |
| `GET /ai-practice/new` | Two cards: "Calls" and "Training material", plus a small "store a raw file" form. |
| `POST /ai-practice` | Stored a raw file as `PracticeMaterial` (never analyzed, never reachable from any workflow). |
| `GET/POST /ai-practice/calls…` | Separate call upload page; **upload immediately queued analysis**; retry, approve, delete, signed playback. |
| `GET /ai-practice/:id/file`, `POST /:id/archive` | Raw upload preview / archive. |

## 2. Training routes (before)
`/admin/training/new` (wizard that asked for audience, passing score, due date **before** any material existed; files were then uploaded one module at a time on the detail page), `/admin/training/:id` (one page mixing modules, AI buttons, workflow stepper, permissions, edit form), `/analyze`, `/analysis`, `/analysis/approve`, `/analysis/regenerate`, `/practice-plan` (GET/POST, **generated practice synchronously inside the request**), `/send-to-training`, `/publish`, `/draft`, `/archive`, `/delete`; `/admin/assessments/:id/*` (edit, per-question regenerate, natural-language revise, preview, approve, validate, delete).

## 3. Prisma models involved
`TrainingCourse` (used as source project, practice package **and** catalog entry), `TrainingModule` (source files), `TrainingAnalysis` (1:1), `Assessment` + `Question` (practice), `CallBatch` + `CallRecording`, `PracticeMaterial` (orphan raw uploads), `TrainingAssignment/Recipient/Attempt`, `SkillEvidence`.

## 4. AI / Gemini services
`lib/gemini.js` (structured output + Zod re-validation + retries — good), `lib/trainingAnalysis.js` (extract → map → validate), `lib/practiceEngine.js`, `lib/processSimulation.js`, `lib/practiceReview.js`, `lib/practiceValidation.js`, `lib/callIntelligence.js`, `lib/practiceGrading.js`, `lib/callEvidence.js`.

## 5. File storage
`lib/storage.js`: private root outside `public/`, MIME allow-list, **magic-byte signature check**, size limits, random names, path-traversal-safe resolver. Solid — kept as is.

## 6. Processing / status model
Analysis: `QUEUED→EXTRACTING→MAPPING→VALIDATING→READY_FOR_REVIEW→APPROVED|FAILED`. Calls: `UPLOADED→TRANSCRIBING→ANALYZING→AGGREGATING→GENERATING_PRACTICE→READY_FOR_REVIEW→APPROVED|FAILED`. The hub *derived* a six-stage label from these.

## 7. "Send to Training"
Flip `TrainingCourse.status` to `PUBLISHED` (no version, no record of what was sent, no protection against a second click, `POST /publish` skipped the practice check).

## 8. Skill Evidence
`recordAssessmentAttempt` → `SkillEvidence` → deterministic `lib/scoring.js`/`skillEngine.js`. Gemini only produces rubric/breakdown; it never writes `EmployeeSkill.currentScore`. **Correct — preserved.**

## 9. Authorization
AI Practice = `requireRole('ADMIN')`, organization scoped; `lib/objectAccess.js` gates `/admin/training/:id/*`. Sound.

## 10. UX / engineering problems found
1. **Upload triggered work / was tangled with configuration**: the wizard demanded audience, passing score and due date before a file existed; call upload started AI processing at once.
2. Three unrelated entry points (calls page, training wizard, raw store) and a raw store whose files could **never** be analyzed.
3. Technical status names leaked ("EXTRACTING", "TRANSCRIBING").
4. Analysis, approval and practice were separate pages; the mixed Training detail page held AI buttons that duplicated AI Practice.
5. **Practice generation ran inside the HTTP request** (browser had to stay open; a failure left a half-built plan).
6. **Analysis retry restarted from scratch**; a failed call retry was re-queued from the top.
7. **Double click on Analyze/Send could run twice**; nothing was idempotent.
8. **No versioning**: editing an approved practice silently re-opened it *under learners' feet*.
9. **Job types were only registered when a route happened to `require` them lazily** — after a server restart, queued analyses waited for that first request. This is why two analyses were found stuck for days.
10. Deleting a course cascaded through assignments and results.
11. Nothing showed *where* an AI conclusion came from beyond a flat list.

## Decision table
| Item | Decision |
|---|---|
| `lib/storage.js`, `gemini.js` structured output, scoring/evidence engine, per-question regenerate / revise / preview / validate, call redaction + signed playback, audit | **KEEP** |
| Analysis pipeline (idempotent, resumable, prompt versions, grounded insights, redaction of documents), call pipeline (started by the Admin), Gemini schema-retry, source hashing | **IMPROVE** |
| One `TrainingCourse` row as source + package + catalog entry | **KEEP** (this is what makes "no duplicated work / no disconnected copy" true); add version + origin fields |
| AI buttons and stepper on the Training detail page; `/practice-plan` and `/analysis` pages; call upload page; raw-store form | **MOVE** into the AI Practice workspace (old URLs redirect) |
| Synchronous practice generation; `PracticeMaterial` as a dead-end | **REMOVE / REPLACE** (background `AiTask`; raw uploads imported as sources) |
| `PracticeMaterial` rows, stuck analyses, published courses without version records | **MIGRATE / BACKFILL** (idempotent, facts only) |
