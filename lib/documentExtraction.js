'use strict';

const OpenAI = require('openai');

let _client;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Extract structured metadata from a document using AI.
 * @returns {{ metadata: object, confidence: object }}
 */
async function extractDocumentMetadata(fileUrl, mimeType = 'application/pdf', fileName = '') {
  const prompt = `You are extracting structured metadata from a document.
File: ${fileName} (${mimeType})
URL: ${fileUrl}

Return JSON with these fields (use null for any field you cannot determine):
{
  "title": string,
  "issuer": string,
  "issue_date": "YYYY-MM-DD" or null,
  "expiry_date": "YYYY-MM-DD" or null,
  "policy_number": string or null,
  "amount": number or null,
  "category": string,
  "summary": string
}`;

  try {
    const resp = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });
    const metadata = JSON.parse(resp.choices[0].message.content);
    const confidence = Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, v !== null ? 0.8 : 0])
    );
    return { metadata, confidence };
  } catch (err) {
    return { metadata: {}, confidence: {} };
  }
}

module.exports = { extractDocumentMetadata };
