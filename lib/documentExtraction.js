'use strict';

const { complete } = require('./claude-client');

/**
 * Extract structured metadata from a document using AI.
 * @returns {{ metadata: object, confidence: object }}
 */
async function extractDocumentMetadata(fileUrl, mimeType = 'application/pdf', fileName = '') {
  const prompt = `You are extracting structured metadata from a document.
File: ${fileName} (${mimeType})
URL: ${fileUrl}

Return ONLY valid JSON with these fields (use null for any field you cannot determine):
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
    const raw = await complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 400 });
    const metadata = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim());
    const confidence = Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, v !== null ? 0.8 : 0])
    );
    return { metadata, confidence };
  } catch {
    return { metadata: {}, confidence: {} };
  }
}

module.exports = { extractDocumentMetadata };
