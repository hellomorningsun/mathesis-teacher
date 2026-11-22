// Mathesis Teacher: a small local server for uploading and organizing math lesson videos.
// No dependencies: uses only Node's built-in modules. Run with `npm start`.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const DB_FILE = path.join(DATA_DIR, 'library.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const auth = createAuth({ file: path.join(DATA_DIR, 'auth.json'), envPassword: process.env.TEACHER_PASSWORD || '' });
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// Classes the person asked to cover first (Indian school classes VI–XII, then BSc).
const LEVELS = ['', 'Class VI', 'Class VII', 'Class VIII', 'Class IX', 'Class X', 'Class XI', 'Class XII', 'BSc Mathematics'];

// ---------- storage ----------

let db = { videos: [], folders: [] };
let writeChain = Promise.resolve();

async function loadDb() {
  await fsp.mkdir(VIDEO_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    db = { videos: parsed.videos || [], folders: parsed.folders || [] };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await saveDb();
  }
  await auth.load();
}

function saveDb() {
  // Serialize writes and write atomically so a crash never leaves a half-written file.
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeChain;
}

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    // The student app will run on a different origin and read this API.
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out.slice(0, 20);
}

function cleanMeta(input, existing = {}) {
  const meta = {};
  if ('title' in input || !existing.title) {
    meta.title = cleanText(input.title, 200);
    if (!meta.title) throw httpError(400, 'Title is required');
  }
  if ('description' in input) meta.description = cleanText(input.description, 5000);
  if ('topics' in input) meta.topics = cleanTags(input.topics);
  if ('level' in input) {
    const level = cleanText(input.level, 40);
    if (!LEVELS.includes(level)) throw httpError(400, 'Unknown level');
    meta.level = level;
  }
  if ('folderId' in input) {
    const folderId = input.folderId || null;
    if (folderId && !db.folders.some((f) => f.id === folderId)) throw httpError(400, 'Unknown folder');
    meta.folderId = folderId;
  }
  if ('published' in input) meta.published = Boolean(input.published);
  return meta;
}

// Students (not logged in) only ever see videos marked visible.
function visibleVideos(req) {
  return auth.isTeacher(req) ? db.videos : db.videos.filter((v) => v.published);
}

function requireTeacher(req) {
  if (!auth.isTeacher(req)) throw httpError(401, 'Please log in as the teacher');
}

function publicVideo(v) {
  if (v.source === 'youtube') {
    const id = encodeURIComponent(v.youtubeId);
    return {
      ...v,
      url: null,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`,
      watchUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  return { ...v, source: 'file', url: `/media/${encodeURIComponent(v.file)}` };
}

// ---------- YouTube ----------

// Accepts the link shapes YouTube hands out: watch?v=, youtu.be/, shorts/, embed/, live/.
function parseYouTubeId(input) {
  const text = String(input ?? '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// Look up a video's title through YouTube's public oEmbed endpoint (no API key needed).
// Works for public and unlisted videos; private videos return an error.
async function youTubeInfo(id) {
  const endpoint = process.env.YOUTUBE_OEMBED_URL || 'https://www.youtube.com/oembed'; // overridable for tests
  const target = `${endpoint}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  let res;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(6000) });
  } catch {
    return { id, found: null }; // could not reach YouTube; not the teacher's fault
  }
  if (!res.ok) return { id, found: false };
  const data = await res.json().catch(() => ({}));
  return { id, found: true, title: cleanText(data.title, 200), channel: cleanText(data.author_name, 200) };
}

async function addYouTubeVideo(req, res) {
  const body = await readJson(req);
  const youtubeId = parseYouTubeId(body.youtubeUrl);
  if (!youtubeId) throw httpError(400, 'That does not look like a YouTube link');
  const existing = db.videos.find((v) => v.youtubeId === youtubeId);
  if (existing) throw httpError(409, `This video is already in your library as “${existing.title}”`);
  const meta = cleanMeta(body);
  const now = new Date().toISOString();
  const video = {
    id: newId(),
    source: 'youtube',
    youtubeId,
    title: meta.title,
    description: meta.description || '',
    topics: meta.topics || [],
    level: meta.level || '',
    folderId: meta.folderId || null,
    published: meta.published ?? true,
    file: null,
    durationSec: Number(body.durationSec) > 0 ? Math.round(Number(body.durationSec)) : null,
    createdAt: now,
    updatedAt: now,
  };
  db.videos.push(video);
  await saveDb();
  send(res, 201, publicVideo(video));
}

function newId() {
  return crypto.randomUUID();
}

// ---------- route handlers ----------

async function uploadVideo(req, res) {
  // The browser sends the raw file as the body and the details as headers,
  // which lets us stream large files straight to disk.
  const originalName = decodeURIComponent(req.headers['x-filename'] || '');
  const ext = path.extname(originalName).toLowerCase();
  if (!VIDEO_TYPES[ext]) {
    throw httpError(415, `Unsupported file type. Use one of: ${Object.keys(VIDEO_TYPES).join(', ')}`);
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) throw httpError(413, 'File is larger than the upload limit');

  let meta;
  let rawMeta;
  try {
    rawMeta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '{}'));
    meta = cleanMeta(rawMeta);
  } catch (err) {
    throw err.status ? err : httpError(400, 'Invalid video details');
  }

  const id = newId();
  const file = `${id}${ext}`;
  const dest = path.join(VIDEO_DIR, file);
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) req.destroy(httpError(413, 'File is larger than the upload limit'));
  });
  try {
    await pipeline(req, fs.createWriteStream(dest));
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err.status ? err : httpError(400, 'Upload was interrupted');
  }
  if (size === 0) {
    await fsp.rm(dest, { force: true });
    throw httpError(400, 'The file is empty');
  }

  const now = new Date().toISOString();
  const video = {
    id,
    source: 'file',
    title: meta.title,
    description: meta.description || '',
    topics: meta.topics || [],
    level: meta.level || '',
    folderId: meta.folderId || null,
    published: meta.published ?? true,
    file,
    originalName: path.basename(originalName).slice(0, 255),
    mimeType: VIDEO_TYPES[ext],
    size,
    durationSec: Number(rawMeta.durationSec) > 0 ? Math.round(Number(rawMeta.durationSec)) : null,
    createdAt: now,
    updatedAt: now,
  };
  db.videos.push(video);
  await saveDb();
  send(res, 201, publicVideo(video));
}

function listVideos(req, res, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const topic = (url.searchParams.get('topic') || '').toLowerCase();
  const folder = url.searchParams.get('folder');
  const level = url.searchParams.get('level');
  const publishedOnly = url.searchParams.get('published') === 'true';
  let videos = visibleVideos(req).filter((v) => {
    if (publishedOnly && !v.published) return false;
    if (folder === 'none' && v.folderId) return false;
    if (folder && folder !== 'none' && v.folderId !== folder) return false;
    if (level && v.level !== level) return false;
    if (topic && !v.topics.some((t) => t.toLowerCase() === topic)) return false;
    if (q) {
      const hay = [v.title, v.description, ...v.topics].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sort = url.searchParams.get('sort') || 'newest';
  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  videos = [...videos].sort(sorters[sort] || sorters.newest);
  send(res, 200, { videos: videos.map(publicVideo) });
}

function findVideo(id) {
  const video = db.videos.find((v) => v.id === id);
  if (!video) throw httpError(404, 'Video not found');
  return video;
}

async function updateVideo(req, res, id) {
  const video = findVideo(id);
  const body = await readJson(req);
  const meta = cleanMeta(body, video);
  if ('durationSec' in body) {
    const d = Number(body.durationSec);
    meta.durationSec = Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  }
  Object.assign(video, meta, { updatedAt: new Date().toISOString() });
  await saveDb();
  send(res, 200, publicVideo(video));
}

async function deleteVideo(res, id) {
  const video = findVideo(id);
  db.videos = db.videos.filter((v) => v.id !== id);
  await saveDb();
  if (video.file) await fsp.rm(path.join(VIDEO_DIR, video.file), { force: true });
  send(res, 204, '');
}

function listTopics(req, res) {
  const counts = new Map();
  for (const v of visibleVideos(req)) {
    for (const t of v.topics) {
      const key = t.toLowerCase();
      const entry = counts.get(key) || { name: t, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const topics = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  send(res, 200, { topics });
}

function listFolders(req, res) {
  const videos = visibleVideos(req);
  const folders = db.folders
    .map((f) => ({ ...f, count: videos.filter((v) => v.folderId === f.id).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  send(res, 200, { folders, unfiled: videos.filter((v) => !v.folderId).length });
}

async function createFolder(req, res) {
  const body = await readJson(req);
  const name = cleanText(body.name, 100);
  if (!name) throw httpError(400, 'Folder name is required');
  if (db.folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, 'A folder with that name already exists');
  }
  const folder = { id: newId(), name, createdAt: new Date().toISOString() };
  db.folders.push(folder);
  await saveDb();
  send(res, 201, folder);
}

async function renameFolder(req, res, id) {
  const folder = db.folders.find((f) => f.id === id);
  if (!folder) throw httpError(404, 'Folder not found');
  const name = cleanText((await readJson(req)).name, 100);
  if (!name) throw httpError(400, 'Folder name is required');
  if (db.folders.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, 'A folder with that name already exists');
  }
  folder.name = name;
  await saveDb();
  send(res, 200, folder);
}

async function deleteFolder(res, id) {
  if (!db.folders.some((f) => f.id === id)) throw httpError(404, 'Folder not found');
  db.folders = db.folders.filter((f) => f.id !== id);
  // Videos are kept; they just move to "Unfiled".
  for (const v of db.videos) if (v.folderId === id) v.folderId = null;
  await saveDb();
  send(res, 204, '');
}

async function serveMedia(req, res, name) {
  const file = path.basename(name);
  const full = path.join(VIDEO_DIR, file);
  const type = VIDEO_TYPES[path.extname(file).toLowerCase()];
  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    throw httpError(404, 'Not found');
  }
  if (!type || !stat.isFile()) throw httpError(404, 'Not found');
  if (!visibleVideos(req).some((v) => v.file && v.file === file)) throw httpError(404, 'Not found');

  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    // Hidden videos must not be kept by shared caches.
    'Cache-Control': 'private, max-age=3600',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(full), res).catch(() => {});
  }
  let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
  let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : stat.size - 1;
  start = Math.max(0, start);
  end = Math.min(end, stat.size - 1);
  if (start > end || start >= stat.size) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(full, { start, end }), res).catch(() => {});
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found');
  let body;
  try {
    body = await fsp.readFile(full);
  } catch {
    throw httpError(404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; media-src 'self' blob:; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'",
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ---------- router ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const m = req.method;
  let match;

  if (m === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Meta',
    });
  }
  // --- login ---
  if (pathname === '/api/auth/status' && m === 'GET') return send(res, 200, auth.status(req));
  if (pathname === '/api/auth/setup' && m === 'POST') {
    const cookie = await auth.setup(req, (await readJson(req)).password);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/auth/login' && m === 'POST') {
    const cookie = await auth.login(req, (await readJson(req)).password);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/auth/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) });
  }
  if (pathname === '/api/auth/password' && m === 'POST') {
    requireTeacher(req);
    const body = await readJson(req);
    const cookie = await auth.changePassword(req, body.current, body.next);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  // --- read: open to students, but only for visible videos ---
  if (pathname === '/api/videos' && m === 'GET') return listVideos(req, res, url);
  if ((match = /^\/api\/videos\/([\w-]+)$/.exec(pathname)) && m === 'GET') {
    const video = visibleVideos(req).find((v) => v.id === match[1]);
    if (!video) throw httpError(404, 'Video not found');
    return send(res, 200, publicVideo(video));
  }
  if (pathname === '/api/topics' && m === 'GET') return listTopics(req, res);
  if (pathname === '/api/levels' && m === 'GET') {
    const videos = visibleVideos(req);
    const levels = LEVELS.filter(Boolean).map((name) => ({ name, count: videos.filter((v) => v.level === name).length }));
    return send(res, 200, { levels });
  }
  if (pathname === '/api/folders' && m === 'GET') return listFolders(req, res);
  if (pathname === '/api/youtube/info' && m === 'GET') {
    requireTeacher(req);
    const id = parseYouTubeId(url.searchParams.get('url'));
    if (!id) throw httpError(400, 'That does not look like a YouTube link');
    return send(res, 200, await youTubeInfo(id));
  }

  // --- write: teacher only ---
  if (pathname.startsWith('/api/') && m !== 'GET') requireTeacher(req);
  if (pathname === '/api/videos' && m === 'POST') return uploadVideo(req, res);
  if (pathname === '/api/videos/youtube' && m === 'POST') return addYouTubeVideo(req, res);
  if ((match = /^\/api\/videos\/([\w-]+)$/.exec(pathname))) {
    if (m === 'PATCH') return updateVideo(req, res, match[1]);
    if (m === 'DELETE') return deleteVideo(res, match[1]);
  }
  if (pathname === '/api/folders' && m === 'POST') return createFolder(req, res);
  if ((match = /^\/api\/folders\/([\w-]+)$/.exec(pathname))) {
    if (m === 'PATCH') return renameFolder(req, res, match[1]);
    if (m === 'DELETE') return deleteFolder(res, match[1]);
  }
  if ((match = /^\/media\/([^/]+)$/.exec(pathname)) && (m === 'GET' || m === 'HEAD')) {
    return serveMedia(req, res, decodeURIComponent(match[1]));
  }
  if (m === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  throw httpError(404, 'Not found');
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      // Drain whatever is left of a rejected upload so the browser gets the error message.
      req.resume();
      send(res, status, { error: status === 500 ? 'Something went wrong on the server' : err.message }, { Connection: 'close' });
    });
  });
}

async function start(port = PORT) {
  await loadDb();
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

if (require.main === module) {
  start().then((server) => {
    console.log(`Mathesis Teacher is running at http://localhost:${server.address().port}`);
    console.log(`Videos and library data are stored in ${DATA_DIR}`);
    if (!process.env.TEACHER_PASSWORD && auth.status({ headers: {}, socket: {} }).needsSetup) {
      console.log('No teacher password yet: open the address above on this computer to create one.');
    }
  });
}

module.exports = { start, parseYouTubeId };
