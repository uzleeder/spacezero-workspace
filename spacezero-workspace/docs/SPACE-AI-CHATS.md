# Space AI conversations

The corner Space AI panel answers on the current page. **Open Space AI** opens the same conversation on `/assistant`, with a history sidebar, **New chat**, and chat deletion. Enter sends; Shift+Enter starts a new line. Both views support light and dark themes, and the history sidebar collapses on small screens.

Each conversation belongs to its signed-in profile and organization. Routes recheck both on reads, replies, and deletion. Admins and supervisors cannot open someone else's chat; read-only **View as** does not reveal or change the employee's conversations. Existing question-preview audit records still apply. Chat deletion removes that conversation and its messages; it does not erase existing audit events.

Follow-up questions include at most 12 recent messages as context. Every reply rebuilds the currently authorized workspace facts. Historical conversation text is not treated as authority or permission to access more data. Existing AI rate limits still apply.

## Knowledge, images and chat controls

Space AI now includes reviewed platform guidance plus role-visible Library items, current published Standards and Workflow content, the user's assigned training material (at its assigned module version), and authorized leave status. It also receives setup checklist statuses and the existing role-scoped workspace summaries. Private leave notes, login secrets and assessment answer keys are excluded. Answers show related source links where available.

Retrieval authorizes documents before ranking or opening files. It selects up to ten matching documents and extracts up to four files of 5 MB or less using the existing document reader. PDFs without extracted text, images and recordings are not full-text indexed; the AI receives that coverage limitation and must acknowledge missing information.

Both chat views accept one PNG, JPEG or WebP image up to 5 MB. The image preview can be removed before sending. Images are processed by the existing Gemini service only on submission and stored outside public assets. Every image URL checks the conversation owner or an explicit snapshot grant. Follow-ups may include the most recent image in that conversation.

Right-click a chat, press Shift+F10 on it, or use its options button for **Rename**, **Pin / Unpin**, **Archive / Restore**, **Share**, and **Delete**. Archived conversations have a separate folder and must be restored before another reply. Rename and deletion use page dialogs; deletion removes messages, image files and shared links, with Cancel focused initially.

Sharing creates a fixed, read-only snapshot for 1–20 selected active coworkers in the same organization. The private conversation itself remains owner-only. A recipient must sign in; forwarding the link does not grant access to another account. Later messages are not included. The owner can copy or revoke each link in the Share dialog. Sharing does not send an email or notification automatically.

When available facts cannot answer a question, Space AI offers the supplied Admin Telegram contacts. Technical failures or unanswered technical questions prioritize Engineer Max. These are links the user can choose to open; Space AI does not send Telegram messages. Provider error details are not shown to users.

## English voice controls

Both the full chat page and corner panel offer **Microphone** (dictate into a draft, then review and Send) and **Voice chat** (pause after speaking to send the question, hear the reply, then speak again). **End voice chat** stops the session; **Stop speaking** stops playback and automatic listening. Saved AI messages have **Read aloud**. Recognition uses English, playback selects an English voice, and the AI is instructed to answer in English while preserving proper names and item titles.

Voice starts only after a user presses a control. Capture stops before playback and when the panel closes, the tab becomes hidden, or the page is left. Empty speech, recognition errors, rate limits, and failed answers do not create an automatic retry loop. A draft is preserved when voice is stopped. Text chat remains available in unsupported browsers.

This uses the browser's Web Speech APIs and requires browser support and microphone permission. Recognition may use the browser vendor's online speech service; a notice appears beside the controls. SpaceZero receives the transcript through the existing authenticated chat endpoint and does not store raw voice recordings for this feature. See [MDN's speech recognition documentation](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

`tests/spaceAiVoice.test.js` verifies the voice state transitions with substituted speech services, without recording the operator or contacting a speech provider. Actual microphone capture and provider recognition require an interactive check in the user's supported browser.

## Deployment

The additive `20261104180000_space_ai_chats` migration creates conversations and messages. `20261104190000_ai_chat_tools` adds pin/archive state, image/source fields and restricted snapshots. Apply both before starting the updated server. Back up the database first and use the command matching the existing database provider:

```sh
# Existing SQLite installation, with its DATABASE_URL loaded
npm run db:migrate
npx prisma generate

# Existing PostgreSQL installation, with its DATABASE_URL loaded
npm run db:generate:production
npm run db:migrate:production
```

Restart the backend after the migration and client generation. Keep the existing server-side Gemini configuration. No credentials, account passwords, email settings, or training reminder intervals are changed by this feature.

SQLite migrations and route tests run against isolated temporary databases. Both Prisma schemas validate; a live PostgreSQL deployment remains an environment-specific check.

## Verification

- `tests/aiChats.test.js`: persistence, follow-ups, owner/organization isolation, View-as privacy, image validation and access, deletion/file cleanup, rename/pin/archive, restricted immutable snapshots, revocation, role-filtered Library/Standards, assigned module versions, and leave privacy.
- `tests/spacezeroAI.test.js`: existing role-scoped facts and model failure handling.
- Browser review uses a synthetic learner and stubbed AI, with no employee data sent to a model: inline replies, opening the same chat, New chat, saved history, fallback contacts, and responsive theme layouts.

The regression run initially passed 739 of 740 tests. The remaining audio fallback fixture assumed Unix executables and an unavailable bundled ffprobe. It now uses portable Node fixtures in an isolated child process; all five audio format tests pass. The eight chat tests also pass after the final behavior changes. Lint, JavaScript/EJS validation, and release-package checks pass.
