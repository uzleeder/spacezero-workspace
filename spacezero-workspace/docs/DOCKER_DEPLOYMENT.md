# Docker deployment

This legacy application runs as Express/EJS with Prisma and PostgreSQL. Its
background jobs run inside the application process, so this deployment does
not need Redis or a separate worker container.

1. Copy `.env.production.example` to `.env` and set production values.
2. Set `DATABASE_URL` to use the Compose database host:

   `postgresql://academy_legacy:CHANGE_ME@db:5432/academy_legacy?schema=public`

3. Copy `.env.db.example` to `.env.db` and use matching database credentials.
4. Set the Docker-backed private storage paths in `.env`:

   ```text
   STORAGE_ROOT=/data/storage
   UPLOAD_ROOT=/data/uploads
   PORT=3000
   ```

5. Set `APP_ORIGIN` to the public HTTPS URL and configure SMTP, Gemini, and
   the encryption key as required by `.env.production.example`.
6. Start the stack:

   `docker compose -f docker-compose.prod.yml up -d --build`

Migrations and the existing seed run before the application starts. The app is
published on host port `3003`; ports `3000`, `3001`, and `3002` remain free for
the existing LMS/Django deployments. All Compose resources use `academy_legacy`
names and are isolated from those stacks.
