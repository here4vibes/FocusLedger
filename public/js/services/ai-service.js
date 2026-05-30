/**
 * ai-service.js — shared AI frontend client for FocusLedger.
 *
 * All functions return Promises. Loading callbacks (onLoading, onComplete, onError)
 * are optional. All errors are surfaced via rejected promises and onError callbacks.
 */

(function (root) {
  'use strict';

  var token = localStorage.getItem('fl_token');

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getHeaders() {
    return {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    };
  }

  function post(url, body, callbacks) {
    var onLoading = callbacks && callbacks.onLoading;
    var onComplete = callbacks && callbacks.onComplete;
    var onError = callbacks && callbacks.onError;

    if (onLoading) onLoading();

    return fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          if (onComplete) onComplete(data);
          return data;
        } else {
          var err = new Error(data.message || 'Request failed');
          if (onError) onError(err);
          return Promise.reject(err);
        }
      })
      .catch(function (err) {
        if (onError) onError(err);
        return Promise.reject(err);
      });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * extractDocumentFields(fileContent, fileType, callbacks?)
   *
   * Sends a document file (via file URL + metadata) to the AI extraction endpoint.
   * fileContent: { url: string, name: string, mimeType?: string }
   * callbacks: { onLoading?, onComplete?, onError? }
   *
   * Returns Promise<{ metadata, confidence }>
   */
  function extractDocumentFields(fileContent, fileType, callbacks) {
    var body = {
      fileUrl: fileContent.url || fileContent.s3Url || '',
      fileName: fileContent.name || 'document',
      mimeType: fileContent.mimeType || fileContent.mime_type || fileType || 'application/pdf'
    };
    return post('/api/ai/extract-fields', body, callbacks || {});
  }

  /**
   * parseAIResponse(raw, callbacks?)
   *
   * Normalizes an AI raw response (string or object) into a consistent field map.
   * raw: string (raw JSON string, markdown code block, or plain text) or object
   * callbacks: { onLoading?, onComplete?, onError? }
   *
   * Returns Promise<{ fields: object }>
   */
  function parseAIResponse(raw, callbacks) {
    return post('/api/ai/parse-ai-response', { raw: raw }, callbacks || {});
  }

  /**
   * summarizeText(text, maxLength?, callbacks?)
   *
   * Generic text summarization. Returns a plain-text summary.
   * text: string to summarize
   * maxLength: optional max character count (default 200)
   * callbacks: { onLoading?, onComplete?, onError? }
   *
   * Returns Promise<{ summary: string }>
   */
  function summarizeText(text, maxLength, callbacks) {
    var body = { text: text };
    if (maxLength !== undefined) body.maxLength = maxLength;
    // Handle callbacks where maxLength is omitted
    if (typeof maxLength === 'object') {
      callbacks = maxLength;
    }
    return post('/api/ai/summarize', body, callbacks || {});
  }

  /**
   * suggestTaskFromText(text, values?, callbacks?)
   *
   * Parse freeform text into task suggestions (Buddy brain-dump style).
   * text: string to parse
   * values: optional array of { id, value_name } for value tagging
   * callbacks: { onLoading?, onComplete?, onError? }
   *
   * Returns Promise<{ tasks: [{ title, value_name, value_id, priority }] }>
   */
  function suggestTaskFromText(text, values, callbacks) {
    // values is optional — can be passed as callbacks if omitted
    var body = { text: text };
    if (Array.isArray(values)) {
      body.values = values;
    } else if (typeof values === 'object') {
      callbacks = values;
    }
    return post('/api/ai/suggest-tasks', body, callbacks || {});
  }

  // ─── Exports ──────────────────────────────────────────────────────────────

  root.AIService = {
    extractDocumentFields: extractDocumentFields,
    parseAIResponse: parseAIResponse,
    summarizeText: summarizeText,
    suggestTaskFromText: suggestTaskFromText
  };

})(window);