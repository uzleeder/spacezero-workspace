'use strict';
const { GoogleGenAI } = require('@google/genai');
const { resolveStoragePath } = require('./storage');
// Uploaded files are removed from the provider after processing, including failures.
async function withAiMedia(storagePath, mimeType, run) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let file;
  try {
    file = await ai.files.upload({ file: resolveStoragePath(storagePath), config: { mimeType } });
    const deadline = Date.now() + 300000;
    while (file.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      file = await ai.files.get({ name: file.name });
    }
    if (file.state !== 'ACTIVE') throw new Error('Media processing failed or timed out.');
    return await run({ fileData: { fileUri: file.uri, mimeType: file.mimeType } });
  } finally { if (file?.name) await ai.files.delete({ name: file.name }).catch(() => undefined); }
}
module.exports = { withAiMedia };
