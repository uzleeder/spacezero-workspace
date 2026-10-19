# SpaceZero Workspace — Vercel deployment preparation

## Prepared topology

Browser → Vercel gateway → persistent Express/EJS backend → PostgreSQL.
The backend also owns private disk storage, the in-process AI worker and the
[training email/reminder worker](TRAINING-EMAILS.md). This is
not a Vercel-only deployment. Deploying the repository root directly as a Vercel
Function is rejected: its filesystem uploads and polling jobs need a persistent
runtime. The gateway has no database password, Gemini key or uploaded files.

## 1. Backend

Build from `spacezero-workspace` using `docker build -t spacezero-workspace .`.
Run one backend instance with HTTPS supplied by the hosting platform and a
persistent volume mounted at `/data`. The container runs as uid 1000; ensure the
volume is writable by this account. Do not publicly serve the volume.

Set the environment values from `.env.production.example` in the host's secret
manager. In Docker keep `STORAGE_ROOT=/data/storage`,
`UPLOAD_ROOT=/data/uploads`, `HOST=0.0.0.0`, and
`FFPROBE_PATH=/usr/bin/ffprobe` (these are container defaults).
`APP_ORIGIN` must be the exact final public Vercel/custom-domain HTTPS origin,
without a trailing slash. It is used for invitation links and request checks.

Use an existing PostgreSQL service. Apply migrations as a separate release step:
`npm run db:migrate:production` with the production DATABASE_URL loaded. The
image generates the PostgreSQL Prisma client; image builds do not migrate a
database. `GET /healthz` is a process liveness probe, not a database readiness test.

Do not seed a production database with demonstration users. Preserve the existing
`CREDENTIAL_ENCRYPTION_KEY` when moving encrypted data; creating a replacement
key would make the stored credentials unreadable. Configure real SMTP delivery
before inviting staff. Back up SQLite and both upload directories before import.

Data transfer: `scripts/import-postgresql.cjs` now discovers all business models
from the Prisma schema and orders them by foreign-key dependency. It refuses a
nonempty destination and verifies row counts in one transaction. Sessions,
invitation/reset tokens and rate-limit state are intentionally excluded. Test the
import against a new staging PostgreSQL database before production cutover. An
empty-database deploy does not migrate existing staff or their data automatically.
Copy `storage/` to `/data/storage` and `public/uploads/` to `/data/uploads`, keeping
relative paths. Resend invitations after domain and SMTP configuration.

## 2. Vercel project

Import the Git repository. Set Root Directory to
`spacezero-workspace/deploy/vercel` when the repository includes the parent folder,
or `deploy/vercel` when the repository root is already spacezero-workspace.

- Framework preset: Other.
- Build command: `npm run build` (included in vercel.json).
- Output Directory: leave unset; the build emits Vercel Build Output API v3.
- Environment variable: `BACKEND_ORIGIN=https://<actual-backend-host>`.
- Attach the intended domain in Vercel, then set the backend's APP_ORIGIN to it.

The build fails when BACKEND_ORIGIN is absent or contains a path, credentials,
or a local/placeholder hostname. Do not point it at the Vercel gateway itself.
Preview environments need a separate backend and database with the matching
APP_ORIGIN; a production backend deliberately rejects preview-origin writes.

## Acceptance before inviting employees

Verify login, invitation activation, password reset, role restrictions, and
protected file access through the real domain. Verify persistence after a
backend restart. Test a representative large video/audio upload and download
through Vercel. External proxy requests have a 120-second timeout; synchronous
AI requests can exceed it. Test those paths; long work must be moved to queued
jobs before relying on such operations in production. Never automatically retry
a timed-out submission that may already have saved an assessment.

Keep one backend replica while using the current in-process worker; scaling it
requires distributed job claims and shared storage. Client-IP forwarding remains
untrusted until the actual proxy topology is known; configure an exact trusted
proxy at that point, not unrestricted `trust proxy`.

## Verification status

Gateway build and configuration validation can be tested locally without account
credentials. Real Vercel routing, container runtime, PostgreSQL migrations/import,
large uploads, email delivery and provider calls require configured infrastructure.
No cloud deployment or DNS change is performed by these preparation files.

References:
- https://vercel.com/docs/routing/rewrites
- https://vercel.com/docs/build-output-api/configuration
- https://vercel.com/docs/limits#proxied-request-timeout
- https://vercel.com/docs/frameworks/backend/express
