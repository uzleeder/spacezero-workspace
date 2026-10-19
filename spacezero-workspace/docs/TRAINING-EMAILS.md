# Training assignment emails

Every new training assignment queues a separate email for each employee in the same database transaction as the assignment. This includes individual, team, role, company-wide, bulk, onboarding and automatic assignments. The assignment form has **Assign & send email**; recent assignments also have a **Send email** action for sending again. Pending deliveries are reused, and successful sends have a one-minute resend cooldown.

Set a due date and time using the **Tashkent (UTC+05:00)** fields. If no time is entered, the deadline is 23:59. The first overdue reminder is scheduled three hours after the deadline, then every three hours after each successful send. For example, a 15:00 deadline produces reminders from 18:00, 21:00, and so on, including overnight. If the initial email is delayed, reminders start no earlier than three hours after it. No due date means an assignment email only.

Before each send, the worker checks the employee and training again. Completed training stops reminders. Required assessment attempts and passing scores are checked for multi-assessment courses. Archived/unpublished courses and inactive, archived or private test profiles receive no messages. Retake requests requeue the assignment email. Each email contains the training title, deadline, score/attempt requirements, notes and a sign-in-protected training link, never account passwords.

## Deployment

1. Generate the Prisma client and apply `20261012120000_training_emails` before starting the updated backend. Local SQLite: `npx prisma generate` and `npm run db:migrate`. PostgreSQL: `npm run db:generate:production` and `npm run db:migrate:production` with the production database environment. The Docker build already generates the PostgreSQL client; run migration deployment as the separate release step.
2. Configure the existing mail transport: `RESEND_API_KEY` (legacy `RESEND_API` also works), `RESEND_FROM`, and `APP_ORIGIN` (or `ACCOUNT_EMAIL_ORIGIN` for email links). The SMTP configuration remains supported. Keep credentials in the host's secret environment.
3. Run the persistent Express backend described in [VERCEL.md](VERCEL.md). It starts this independent email worker automatically, checks the queue every 15 seconds, and wakes it immediately after an assignment. Bulk sends are paced and processed in batches of 20. The worker does not wait for AI jobs.
4. If using an external scheduler instead, run `node scripts/process-training-emails.cjs` every minute with the same database and mail environment. It drains one bounded batch. Do not run the application directly as a Vercel Function: its background workers are disabled there. The supported Vercel gateway forwards to the persistent backend.

The database stores the next send time, delivery lease, retry state and last provider acceptance. Restarts preserve pending work; a missed interval produces one reminder when processing resumes, not a burst of missed reminders. No migration backfill emails existing assignments: use **Send email** to start their email schedule explicitly.

## Failures and verification

Provider failures retry automatically with increasing delays up to three hours. A stable message payload and [Resend idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys) are reused for retries; Resend retains these keys for 24 hours. Generic SMTP, or a crash exceeding that provider window, cannot guarantee exactly-once delivery. A database lease prevents two active workers from claiming the same message normally.

The recent-assignment list shows how many initial emails were accepted and flags send problems. Acceptance means the email provider accepted the request, not confirmed inbox delivery. Verify delivery/bounces in the provider dashboard.

`npm test -- --only=trainingEmails.test.js` uses an isolated temporary database and a fake mail sender. It checks the immediate send, deadline boundaries, recurring reminders, completion, multiple assessments, retry/idempotency, worker concurrency, role and organization permissions, and assignment transaction rollback. It does not email real employees.
