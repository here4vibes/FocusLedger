'use strict';
/**
 * lib/s3-storage.js — zero-dependency S3-compatible object storage.
 *
 * Works with Cloudflare R2, AWS S3, Backblaze B2, MinIO — anything that
 * speaks the S3 API. Uses AWS Signature V4 with only Node built-ins (crypto,
 * https) so no SDK install is required.
 *
 * Env vars (all required to enable the Document Vault):
 *   S3_ENDPOINT          e.g. https://<accountid>.r2.cloudflarestorage.com
 *   S3_BUCKET            bucket name
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_REGION            default 'auto' (R2) — use e.g. 'us-east-1' for AWS
 *   S3_PUBLIC_BASE_URL   public URL prefix objects are served from,
 *                        e.g. https://files.focusledger.net (R2 custom domain)
 *                        — if unset, falls back to <endpoint>/<bucket>
 */

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

function cfg() {
  return {
    endpoint: process.env.S3_ENDPOINT || '',
    bucket: process.env.S3_BUCKET || '',
    accessKey: process.env.S3_ACCESS_KEY_ID || '',
    secretKey: process.env.S3_SECRET_ACCESS_KEY || '',
    region: process.env.S3_REGION || 'auto',
    publicBase: (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.endpoint && c.bucket && c.accessKey && c.secretKey);
}

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, str) => crypto.createHmac('sha256', key).update(str).digest();

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// Encode a key for the request path (each segment, preserving slashes).
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Signed S3 request. method: PUT/DELETE/GET. Returns { status, body }.
 */
function s3Request(method, key, body, contentType) {
  return new Promise((resolve, reject) => {
    const c = cfg();
    const endpoint = new URL(c.endpoint);
    const host = endpoint.host;
    const service = 's3';
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260713T024800Z
    const dateStamp = amzDate.slice(0, 8);

    const payload = body || Buffer.alloc(0);
    const payloadHash = sha256hex(payload);
    // Path-style: /<bucket>/<key>
    const canonicalUri = `/${encodeURIComponent(c.bucket)}/${encodeKey(key)}`;

    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;
    if (method === 'PUT') headers['content-length'] = String(payload.length);

    const signedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderKeys.map(h => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderKeys.join(';');

    const canonicalRequest = [
      method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${c.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest)),
    ].join('\n');

    const signature = crypto.createHmac('sha256', signingKey(c.secretKey, dateStamp, c.region, service))
      .update(stringToSign).digest('hex');

    headers['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = https.request({
      method, host, path: canonicalUri, headers, port: endpoint.port || 443,
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

/**
 * Upload a file. Returns the public URL to store in documents.s3_url.
 * @returns {Promise<{ url: string, key: string }>}
 */
async function putObject(key, buffer, contentType) {
  const res = await s3Request('PUT', key, buffer, contentType);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`S3 put failed ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const c = cfg();
  const url = c.publicBase
    ? `${c.publicBase}/${encodeKey(key)}`
    : `${c.endpoint.replace(/\/$/, '')}/${encodeURIComponent(c.bucket)}/${encodeKey(key)}`;
  return { url, key };
}

async function deleteObject(key) {
  const res = await s3Request('DELETE', key, null, null);
  if (res.status < 200 || res.status >= 300 && res.status !== 404) {
    throw new Error(`S3 delete failed ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return true;
}

/**
 * Presigned GET URL — lets a private-bucket object be fetched/viewed for a
 * short window without exposing credentials. Standard SigV4 query signing.
 * @param {string} key
 * @param {number} expiresSec default 300 (5 min)
 * @returns {string} a temporary https URL
 */
function signedGetUrl(key, expiresSec = 300) {
  const c = cfg();
  const endpoint = new URL(c.endpoint);
  const host = endpoint.host;
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${c.region}/${service}/aws4_request`;
  const canonicalUri = `/${encodeURIComponent(c.bucket)}/${encodeKey(key)}`;

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(expiresSec, 604800)),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest))].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c.secretKey, dateStamp, c.region, service))
    .update(stringToSign).digest('hex');

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Extract the storage key from a stored URL (public base or path-style).
function keyFromUrl(url) {
  if (!url) return null;
  const c = cfg();
  try {
    const u = new URL(url);
    if (c.publicBase && url.startsWith(c.publicBase)) {
      return decodeURIComponent(u.pathname.replace(/^\//, ''));
    }
    // path-style: /<bucket>/<key...>
    const parts = u.pathname.replace(/^\//, '').split('/');
    if (parts[0] === c.bucket) parts.shift();
    return parts.map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

module.exports = { isConfigured, putObject, deleteObject, keyFromUrl, signedGetUrl };
