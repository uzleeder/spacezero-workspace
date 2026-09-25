# What SpaceZero Academy sends to the AI service (Google Gemini)

All AI calls are made **server-side** (`lib/gemini.js`, `lib/aiMedia.js`). The API key lives only in the
`GEMINI_API_KEY` environment variable; no browser code can read it. Every reply is validated against a
schema (Zod) before it is used, and nothing generated becomes training without an Admin approving it.

| Feature | Sent to Gemini | Not sent |
|---|---|---|
| Training analysis | Text of uploaded documents/notes (extracted server-side); uploaded video, audio, images and PDFs via the Files API (deleted from Google's side after the run) | Anything about employees |
| Practice generation / review edits | The analysis (knowledge, behaviours, mistakes, source map) and, for edits, the current questions and the Admin's instruction | Learner data |
| Quiz grading | Free-text answers together with the question and expected answer | Learner name or identity |
| Role-play / voice practice | The conversation transcript (or the learner's voice recording for voice practice) and the scenario rubric | Learner name or identity |
| Customer calls | The call audio for transcription (the prompt tells the model to replace card numbers, passport numbers, phone numbers and e-mail addresses with `[REDACTED]`), then only the **redacted** transcript for analysis (`lib/redact.js` also strips them again) | Customer names are not removed unless spoken as such; see limitations |
| Never | Passwords, credentials, addresses, setup, leave or vault records | |

**Limitations.** Redaction is pattern based and best effort, not a compliance guarantee. Audio sent for
transcription is processed by Google under your Gemini API terms; do not upload calls you are not allowed
to process this way. Every call upload requires an explicit "authorized for AI processing" confirmation.

**Storage.** Recordings are stored privately under `STORAGE_ROOT` (never a public bucket), played only
through short-lived signed links bound to one person and one recording, and every view and playback is
audit-logged. Retention is configurable in Settings & Security → Policies (`calls.retentionDays`).
