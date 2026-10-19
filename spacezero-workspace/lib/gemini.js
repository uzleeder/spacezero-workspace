'use strict';

// Central, server-only Gemini wrapper. Every stage of the AI pipeline (extraction,
// classification, quiz generation, role-play, call analysis, ...) calls
// generateStructured() so that:
//   - the API key never leaves the server (this app has no client bundler, so nothing under
//     public/js ever touches process.env — the boundary is structural, not just convention),
//   - every response is JSON-schema-constrained on the Gemini side AND re-validated against a
//     Zod schema on our side before any caller ever sees it (never trust raw AI output),
//   - transient failures (timeout/429/5xx) retry with backoff; non-retryable failures
//     (malformed output, schema mismatch) surface immediately with a clear error.
const { GoogleGenAI } = require('@google/genai');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_RETRIES = 3;
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;
const BASE_BACKOFF_MS = 500;

class GeminiError extends Error {
  constructor(message, { retryable = false, cause, schema = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.retryable = retryable;
    if (schema) this.schema = true;
    if (cause) this.cause = cause;
  }
}

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new GeminiError('GEMINI_API_KEY is not configured', { retryable: false });
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GeminiError('Gemini request timed out', { retryable: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function classifyError(err) {
  if (err instanceof GeminiError) return err;
  const status = err?.status ?? err?.code;
  const retryable = status === 429 || status === 500 || status === 503 || /timeout|ECONNRESET|ETIMEDOUT/i.test(err?.message || '');
  return new GeminiError(err?.message || 'Gemini request failed', { retryable, cause: err });
}

/**
 * Calls Gemini with structured JSON output and validates the result against a Zod schema.
 * @param {object} params
 * @param {string} [params.model]
 * @param {string} [params.systemInstruction]
 * @param {string|Array} params.contents - prompt text, or Gemini `contents` (for multimodal input)
 * @param {object} params.responseSchema - Gemini JSON schema (Type.OBJECT/... from @google/genai)
 * @param {import('zod').ZodType} params.zodSchema - re-validated locally before returning
 * @returns {Promise<{data: any, modelVersion: string, raw: string}>}
 */
async function generateStructured({ model = DEFAULT_MODEL, systemInstruction, contents, responseSchema, zodSchema, task = null, promptVersion = null }) {
  const ai = getClient();
  let lastError;
  let schemaRetries = 0; // an answer that does not match the schema is asked for once more before the task is failed
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: {
            ...(systemInstruction ? { systemInstruction } : {}),
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
        TIMEOUT_MS
      );

      let parsed;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new GeminiError('Gemini returned malformed JSON', { retryable: true });
      }

      const validated = zodSchema.safeParse(parsed);
      if (!validated.success) {
        if (schemaRetries < 1) { schemaRetries += 1; attempt -= 1; throw new GeminiError('Gemini output failed schema validation (retrying once)', { retryable: true, schema: true }); }
        throw new GeminiError(`Gemini output failed schema validation: ${validated.error.message}`, { retryable: false });
      }

      return { data: validated.data, modelVersion: response.modelVersion || model, raw: response.text, task, promptVersion };
    } catch (err) {
      lastError = classifyError(err);
      if (!lastError.retryable || attempt === MAX_RETRIES) throw lastError;
      if (!lastError.schema) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * Plain (non-structured) generation — used for free-form role-play turns, where the reply is
 * conversational text rather than a schema-validated object.
 */
async function generateText({ model = DEFAULT_MODEL, systemInstruction, contents }) {
  const ai = getClient();
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({ model, contents, config: systemInstruction ? { systemInstruction } : undefined }),
        TIMEOUT_MS
      );
      return { text: response.text, modelVersion: response.modelVersion || model };
    } catch (err) {
      lastError = classifyError(err);
      if (!lastError.retryable || attempt === MAX_RETRIES) throw lastError;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

module.exports = { generateStructured, generateText, GeminiError, DEFAULT_MODEL };
