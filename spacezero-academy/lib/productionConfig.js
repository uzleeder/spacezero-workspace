'use strict';
function validateProductionConfig(env = process.env) {
  const errors = [];
  if (env.VERCEL) errors.push('Deploy deploy/vercel as the Vercel project. This backend requires persistent private storage and a running job worker; direct Vercel Function deployment is not supported.');
  if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || '')) errors.push('DATABASE_URL must use PostgreSQL');
  if (!/^https:\/\//.test(env.APP_ORIGIN || '')) errors.push('APP_ORIGIN must use HTTPS');
  for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD', 'STORAGE_ROOT', 'GEMINI_API_KEY', 'CREDENTIAL_ENCRYPTION_KEY']) if (!env[key]) errors.push(`${key} is required`);
  if (env.CREDENTIAL_ENCRYPTION_KEY && Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'base64').length !== 32) errors.push('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  if (errors.length) throw new Error(errors.join('; '));
}
module.exports = { validateProductionConfig };
