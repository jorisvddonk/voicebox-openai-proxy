#!/usr/bin/env node
/**
 * OpenAI-compatible speech proxy for Voicebox.
 *
 * Exposes a subset of the OpenAI Audio API using Voicebox as the backend.
 *
 * Endpoints:
 *   GET  /v1/models             → Voicebox GET /profiles
 *   POST /v1/audio/speech       → Voicebox POST /generate/stream
 *   POST /v1/audio/transcriptions → Voicebox POST /transcribe
 *   GET  /health                → synthetic ok
 */

const http = require('http');
const { spawn } = require('child_process');

const VB = process.env.VOICEBOX_BASE_URL || 'http://127.0.0.1:17493';
const PORT = parseInt(process.env.PORT || '17494', 10);
const API_KEYS = process.env.API_KEYS ? process.env.API_KEYS.split(',').map(s => s.trim()).filter(Boolean) : null;

// ── logging ──────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function log(m) { console.error(`[${ts()}] ${m}`); }

function trunc(s, n = 500) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function bodySummary(method, path, buf, headers) {
  const ct = (headers['content-type'] || '').toLowerCase();
  if (ct.includes('json') && buf.length > 0) {
    try {
      const p = JSON.parse(buf.toString());
      if (p.input) return `input="${trunc(p.input, 80)}"`;
      if (p.messages) return `messages=${p.messages.length}`;
      return trunc(JSON.stringify(p), 120);
    } catch { return trunc(buf.toString(), 120); }
  }
  if (ct.includes('multipart')) return 'multipart/form-data';
  if (buf.length > 0) return trunc(buf.toString(), 120);
  return '';
}

function resSummary(body) {
  if (Buffer.isBuffer(body) && body.length > 0) return `audio ${body.length} bytes`;
  if (typeof body === 'string' && body.length > 0) {
    try {
      const p = JSON.parse(body);
      if (p.error) return trunc(p.error.message, 100);
      if (p.object === 'list') return `models=${p.data.length}`;
      return trunc(body, 120);
    } catch { return trunc(body, 120); }
  }
  return '';
}

// ── helpers ──────────────────────────────────────────────────────────

function oaiError(status, message, type = 'invalid_request_error', param = null, code = null) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { message, type, param, code } }),
  };
}

function oaiJson(data, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function oaiAudio(buf, format) {
  const mime =
    format === 'mp3' ? 'audio/mpeg' :
    format === 'opus' ? 'audio/opus' :
    format === 'flac' ? 'audio/flac' :
    format === 'pcm' ? 'audio/L16' :
    'audio/wav';
  return { status: 200, headers: { 'Content-Type': mime }, body: buf };
}

async function vbFetch(path, opts = {}) {
  const url = `${VB}${path}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...opts.headers },
    ...opts,
  });
  return res;
}

async function vbJson(path, opts = {}) {
  const res = await vbFetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Voicebox ${path}: ${res.status}`);
    err.status = res.status;
    err.detail = text;
    throw err;
  }
  return res.json();
}

// ── audio conversion ────────────────────────────────────────────────

function hasFfmpeg() {
  try { return require('child_process').spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

const FFMPEG = hasFfmpeg();

function convertAudio(wavBuf, targetFormat) {
  if (targetFormat === 'wav' || !FFMPEG) return wavBuf;

  const codecMap = {
    mp3: ['-codec:a', 'libmp3lame', '-f', 'mp3'],
    opus: ['-codec:a', 'libopus', '-f', 'opus'],
    flac: ['-codec:a', 'flac', '-f', 'flac'],
    pcm: ['-f', 's16le', '-acodec', 'pcm_s16le'],
  };
  const args = codecMap[targetFormat];
  if (!args) return wavBuf;

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-y',
      ...args,
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) {
        log(`ffmpeg exit code ${code} for ${targetFormat}, returning wav`);
        resolve(wavBuf);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    proc.on('error', () => resolve(wavBuf));
    proc.stdin.end(wavBuf);
  });
}

// ── authentication ───────────────────────────────────────────────────

function authenticate(headers) {
  if (!API_KEYS) return null;
  const ah = headers['authorization'];
  if (!ah || !ah.startsWith('Bearer ')) return oaiError(401, 'Missing or invalid authorization', 'authentication_error');
  const token = ah.slice(7).trim();
  if (!API_KEYS.includes(token)) return oaiError(401, 'Invalid API key', 'authentication_error');
  return null;
}

// ── routes ───────────────────────────────────────────────────────────

let profileCache = null;
let profileCacheAt = 0;

async function getProfiles() {
  if (profileCache && Date.now() - profileCacheAt < 5000) return profileCache;
  const raw = await vbJson('/profiles');
  const list = Array.isArray(raw) ? raw : [];
  // Build a stable model list: prefer unique profile names, fallback to id
  const names = new Map();
  const models = [];
  for (const p of list) {
    const id = p.name && !names.has(p.name) ? p.name : p.id;
    names.set(p.name, true);
    models.push({ id, object: 'model', created: 0, owned_by: 'voicebox', _profileId: p.id });
  }
  profileCache = models;
  profileCacheAt = Date.now();
  return models;
}

async function resolveProfileId(voice) {
  const models = await getProfiles();
  // Try exact name match first
  const exact = models.find(m => m.id === voice || m._profileId === voice);
  if (exact) return exact._profileId;
  // Try case-insensitive name match
  const ci = models.find(m => m.id.toLowerCase() === voice.toLowerCase());
  if (ci) return ci._profileId;
  return null;
}

async function handleHealth() {
  return oaiJson({ status: 'ok' });
}

async function handleModels() {
  const models = await getProfiles();
  return oaiJson({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'voicebox' })) });
}

async function handleTTS(body) {
  const { input, voice, response_format = 'wav', instructions } = body;
  if (!input) return oaiError(400, 'Missing required field: input');
  if (!voice) return oaiError(400, 'Missing required field: voice');

  const profileId = await resolveProfileId(voice);
  if (!profileId) return oaiError(404, 'Voice not found');

  const genReq = { profile_id: profileId, text: input, language: 'en' };
  if (instructions) genReq.instruct = instructions;

  const vbRes = await vbFetch('/generate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(genReq),
  });

  if (!vbRes.ok) {
    const txt = await vbRes.text();
    if (vbRes.status === 404) return oaiError(404, 'Voice not found');
    return oaiError(502, `Backend error: ${vbRes.status} ${trunc(txt, 200)}`);
  }

  const ct = vbRes.headers.get('content-type') || '';
  if (!ct.includes('audio')) {
    const txt = await vbRes.text();
    return oaiError(502, `Backend did not return audio: ${trunc(txt, 200)}`);
  }

  const ab = await vbRes.arrayBuffer();
  let wavBuf = Buffer.from(ab);

  const format = (response_format || 'wav').toLowerCase();
  wavBuf = await convertAudio(wavBuf, format);
  return oaiAudio(wavBuf, format);
}

async function handleTranscription(headers, bodyBuf) {
  const parts = await parseMultipart(headers, bodyBuf);
  const file = parts.file;
  if (!file) return oaiError(400, 'Missing required field: file');

  const fd = new FormData();
  const blob = new Blob([Buffer.from(file.buffer)], { type: file.mime || 'audio/wav' });
  fd.append('file', blob, file.name || 'audio.wav');
  if (parts.language) fd.append('language', parts.language);

  const res = await fetch(`${VB}/transcribe`, { method: 'POST', body: fd });
  const txt = await res.text();
  if (!res.ok) return oaiError(res.status, trunc(txt, 200));

  const data = JSON.parse(txt);
  return oaiJson({ text: data.text || '' });
}

// ── router ───────────────────────────────────────────────────────────

async function route(method, path, headers, bodyBuf) {
  // Auth check
  const authErr = authenticate(headers);
  if (authErr) return authErr;

  if (method === 'GET' && path === '/health') return handleHealth();
  if (method === 'GET' && path === '/v1/models') return handleModels();

  if (method === 'POST' && (path === '/' || path === '/v1/audio/speech')) {
    return handleTTS(JSON.parse(bodyBuf.toString('utf-8')));
  }

  if (method === 'POST' && path === '/v1/audio/transcriptions') {
    const ct = (headers['content-type'] || '').toLowerCase();
    if (!ct.includes('multipart/form-data')) {
      return oaiError(400, 'Transcriptions must use multipart/form-data');
    }
    return handleTranscription(headers, bodyBuf);
  }

  return oaiError(404, 'Not found', 'invalid_request_error');
}

// ── minimal multipart parser (no deps) ──────────────────────────────

function parseMultipart(headers, buf) {
  const m = (headers['content-type'] || '').match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!m) return Promise.reject(new Error('No boundary in multipart'));

  const b = m[1] || m[2];
  const delim = Buffer.from(`--${b}`);
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(delim, pos);
    if (start === -1) break;
    const end = buf.indexOf(delim, start + delim.length);
    if (end === -1) break;
    const block = buf.slice(start + delim.length, end);
    const hdrEnd = block.indexOf(Buffer.from('\r\n\r\n'));
    if (hdrEnd === -1) { pos = end; continue; }
    const rawH = block.slice(0, hdrEnd).toString();
    const bStart = hdrEnd + 4;
    const bEnd = block.length - 2;
    parts.push({
      name: (rawH.match(/name="([^"]+)"/i) || [])[1],
      filename: (rawH.match(/filename="([^"]+)"/i) || [])[1],
      mime: (rawH.match(/content-type:\s*(\S+)/i) || [])[1],
      buffer: block.slice(bStart, bEnd),
    });
    pos = end;
  }
  const result = {};
  for (const p of parts) {
    if (!p.name) continue;
    if (p.filename) {
      result[p.name] = { buffer: p.buffer, name: p.filename, mime: p.mime };
    } else {
      result[p.name] = p.buffer.toString().trim();
    }
  }
  return Promise.resolve(result);
}

// ── server ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const t0 = Date.now();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks);
    const summary = bodySummary(req.method, url.pathname, buf, req.headers);
    log(`>>> ${req.method} ${url.pathname}${summary ? ' ' + summary : ''}`);

    try {
      const result = await route(req.method, url.pathname, req.headers, buf);
      const dur = Date.now() - t0;
      log(`<<< ${req.method} ${url.pathname} ${result.status} ${resSummary(result.body)} (${dur}ms)`);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      const dur = Date.now() - t0;
      log(`XXX ${req.method} ${url.pathname} ${err.stack || err.message} (${dur}ms)`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'Internal server error', type: 'server_error', param: null, code: null },
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}  (backend: ${VB})`);
  if (!FFMPEG) log('ffmpeg not found — audio conversion disabled, returning WAV for all formats');
  if (!API_KEYS) log('API_KEYS not set — authentication disabled');
});
