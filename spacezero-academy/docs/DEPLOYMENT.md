# Phase 1 deployment

Architecture remains Express, EJS/vanilla JavaScript and Prisma. SQLite stays available for local development; PostgreSQL uses a separately generated client and migration history. No Supabase, React, Gemini or assessment engine is added.

## PostgreSQL

1. Back up SQLite and the storage directory. Stop writes during the final snapshot/import.
2. Provision a NEW PostgreSQL database. Use a migration owner separately from the application's restricted database account. Never expose the database to browsers.
3. Run `npm run db:generate:production`.
4. Set DATABASE_URL to PostgreSQL and run `npm run db:migrate:production`. This applies `prisma/postgresql/migrations/20260917000000_initial/migration.sql`.
5. Set SQLITE_DATABASE_URL and POSTGRES_DATABASE_URL privately and run `npm run db:import:production`. The import refuses nonempty destinations and verifies counts transactionally. Existing Profile, Skill, EmployeeSkill, SkillEvidence and all business data retain their IDs. Sessions/reset/invitation tokens are not imported; pending employees need fresh invitations.
6. Copy private storage and existing image uploads preserving paths. Do not configure a reverse proxy/static host to serve either uploads or storage directly.
7. Verify the import in staging before switching production traffic. Keep the original SQLite database intact for rollback; after new production writes, rollback requires reconciling those writes.

PostgreSQL migration generation/schema validation is separate from actually applying/testing it on a PostgreSQL server. The latter is pending a configured server. SQLite does not implement RLS. This architecture enforces permissions in Express and keeps DB credentials server-side; no claim of PostgreSQL RLS testing is made.

## Email and startup

Use `.env.production.example` as a template. Supply environment variables through the service manager (or Node `--env-file`); never commit secrets. The SMTP provider must authorize ali@above9.travel as sender. STARTTLS/SMTPS is required outside isolated tests. No reset or invitation URL is returned in an HTTP response. Email failures are visible to administrators and recorded without token values; failed invitation tokens are revoked.

Run `npm run validate:production` and `npm start` with the production environment loaded. Startup refuses missing HTTPS origin, SMTP settings, PostgreSQL URL or private-storage configuration. A TLS reverse proxy should forward to the loopback Express listener. Trust proxy is disabled; configure a specific trusted proxy only after infrastructure is known. Never enable unrestricted trust proxy. Rate limits are persisted in the database.

## Private files

Local disk provider: files are served only through session-authenticated and object-authorized routes, never public URLs. Each read rechecks current permissions. There is no presigned public URL for this provider. Uploads have limits and file-signature checks, random server-generated names and path traversal checks. Grant only the service account access to private storage and encrypt host disks/backups. DOC/PPT legacy document preview/conversion and antivirus/CDR scanning require deployment integration; signature validation is not malware scanning.

Admin-only download actions are enforced. An authorized viewer can still capture bytes/screenshots; a browser cannot guarantee that visible content is impossible to copy. Do not treat inline Content-Disposition as DRM.

## Checks

`npm run lint`, `npm run validate`, `npm test`, `npm run test:security`, `npm run db:validate:production`.
Tests migrate a NEW temporary SQLite database and use an isolated localhost SMTP receiver. They never email real employees. Real mailbox delivery and live PostgreSQL migration/isolation checks remain deployment acceptance gates.
