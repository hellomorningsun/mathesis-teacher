// Mathesis Teacher on Cloudflare Workers.
// The pages in /public are served as static assets; this Worker answers /api/*.
// The library (titles, classes, topics, folders) lives in a D1 database. Videos live on YouTube.

const LEVELS = ['Class VI', 'Class VII', 'Class VIII', 'Class IX', 'Class X', 'Class XI', 'Class XII', 'BSc Mathematics'];
const COOKIE = 'mt_session';
const SESSION_DAYS = 14;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 ? 'Something went wrong on the server' : err.message }, status);
    }
  },
};

// ---------- helpers ----------

function json(body, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The student app will run on another address and read this API.
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 1024 * 1024) throw httpError(413, 'Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);

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

async function cleanMeta(env, input, existing = {}) {
  const meta = {};
  if ('title' in input || !existing.title) {
    meta.title = cleanText(input.title, 200);
    if (!meta.title) throw httpError(400, 'Title is required');
  }
  if ('description' in input) meta.description = cleanText(input.description, 5000);
  if ('topics' in input) meta.topics = cleanTags(input.topics);
  if ('level' in input) {
    const level = cleanText(input.level, 40);
    if (level && !LEVELS.includes(level)) throw httpError(400, 'Unknown class');
    meta.level = level;
  }
  if ('folderId' in input) {
    const folderId = input.folderId || null;
    if (folderId && !(await env.DB.prepare('SELECT 1 FROM folders WHERE id = ?').bind(folderId).first())) {
      throw httpError(400, 'Unknown folder');
    }
    meta.folderId = folderId;
  }
  if ('published' in input) meta.published = Boolean(input.published);
  return meta;
}

function rowToVideo(r) {
  const id = encodeURIComponent(r.youtube_id);
  return {
    id: r.id,
    source: 'youtube',
    youtubeId: r.youtube_id,
    title: r.title,
    description: r.description,
    topics: JSON.parse(r.topics || '[]'),
    level: r.level,
    folderId: r.folder_id,
    published: Boolean(r.published),
    durationSec: r.duration_sec,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: null,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

// Students (not logged in) only ever see videos marked visible.
async function visibleVideos(env, teacher) {
  const sql = teacher ? 'SELECT * FROM videos' : 'SELECT * FROM videos WHERE published = 1';
  const { results } = await env.DB.prepare(sql).all();
  return results.map(rowToVideo);
}

// ---------- YouTube ----------

// Accepts the link shapes YouTube hands out: watch?v=, youtu.be/, shorts/, embed/, live/.
export function parseYouTubeId(input) {
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

// Title lookup through YouTube's public oEmbed endpoint (no API key needed).
// Works for public and unlisted videos; private videos return an error.
async function youTubeInfo(env, id) {
  const endpoint = env.YOUTUBE_OEMBED_URL || 'https://www.youtube.com/oembed';
  const target = `${endpoint}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  let res;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(6000) });
  } catch {
    return { id, found: null };
  }
  if (!res.ok) return { id, found: false };
  const data = await res.json().catch(() => ({}));
  return { id, found: true, title: cleanText(data.title, 200), channel: cleanText(data.author_name, 200) };
}

// ---------- login ----------
// The password is the TEACHER_PASSWORD secret. Session cookies are signed with a key derived
// from it, so changing the secret logs every device out.

const enc = new TextEncoder();

async function hmacKey(env) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(`mathesis-session:${env.TEACHER_PASSWORD}:${env.SESSION_SECRET || ''}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function isTeacher(request, env) {
  if (!env.TEACHER_PASSWORD) return false;
  const raw = (request.headers.get('Cookie') || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [expires, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), enc.encode(expires));
  } catch {
    return false;
  }
}

async function sessionCookie(env) {
  const expires = String(Date.now() + SESSION_DAYS * 864e5);
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(expires)));
  return `${COOKIE}=${expires}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function passwordMatches(env, given) {
  // Compare digests so timing does not reveal anything about the password.
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(given ?? ''))),
    crypto.subtle.digest('SHA-256', enc.encode(env.TEACHER_PASSWORD)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Wrong-password limits are kept in D1 so they hold across Cloudflare's many servers.
async function checkLockout(env, keys) {
  const now = Date.now();
  for (const key of keys) {
    const row = await env.DB.prepare('SELECT until FROM login_failures WHERE key = ?').bind(key).first();
    if (row && row.until > now) {
      throw httpError(429, `Too many wrong passwords. Try again in ${Math.ceil((row.until - now) / 60000)} minute(s).`);
    }
  }
}

async function recordFailure(env, key, limit) {
  const row = await env.DB.prepare('SELECT count FROM login_failures WHERE key = ?').bind(key).first();
  const count = (row?.count || 0) + 1;
  const locked = count >= limit;
  await env.DB.prepare('INSERT INTO login_failures (key, count, until) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET count = ?2, until = ?3')
    .bind(key, locked ? 0 : count, locked ? Date.now() + LOCKOUT_MS : 0)
    .run();
}

async function login(request, env) {
  if (!env.TEACHER_PASSWORD) throw httpError(409, 'No teacher password is set on the server yet');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  await checkLockout(env, [`ip:${ip}`, '*']);
  const { password } = await readJson(request);
  if (!(await passwordMatches(env, password))) {
    await recordFailure(env, `ip:${ip}`, MAX_FAILURES);
    await recordFailure(env, '*', MAX_FAILURES * 10); // ceiling across all addresses
    throw httpError(401, 'Wrong password');
  }
  await env.DB.prepare("DELETE FROM login_failures WHERE key IN (?, '*')").bind(`ip:${ip}`).run();
  return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env) });
}

// ---------- router ----------

async function route(request, env, url) {
  const { pathname } = url;
  const m = request.method;
  let match;

  if (m === 'OPTIONS') {
    return json(null, 204, {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  const teacher = await isTeacher(request, env);

  // --- login ---
  if (pathname === '/api/auth/status' && m === 'GET') {
    // No setup screen in the cloud: the password is set as a Cloudflare secret.
    return json({ loggedIn: teacher, needsSetup: !env.TEACHER_PASSWORD, canSetup: false, managedByEnv: true });
  }
  if (pathname === '/api/auth/login' && m === 'POST') return login(request, env);
  if (pathname === '/api/auth/logout' && m === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  // --- read: open to students, but only for visible videos ---
  if (pathname === '/api/videos' && m === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const topic = (url.searchParams.get('topic') || '').toLowerCase();
    const folder = url.searchParams.get('folder');
    const level = url.searchParams.get('level');
    const publishedOnly = url.searchParams.get('published') === 'true';
    let videos = (await visibleVideos(env, teacher)).filter((v) => {
      if (publishedOnly && !v.published) return false;
      if (folder === 'none' && v.folderId) return false;
      if (folder && folder !== 'none' && v.folderId !== folder) return false;
      if (level && v.level !== level) return false;
      if (topic && !v.topics.some((t) => t.toLowerCase() === topic)) return false;
      if (q && ![v.title, v.description, ...v.topics].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
    const sorters = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    videos.sort(sorters[url.searchParams.get('sort')] || sorters.newest);
    return json({ videos });
  }
  if ((match = /^\/api\/videos\/([\w-]+)$/.exec(pathname)) && m === 'GET') {
    const video = (await visibleVideos(env, teacher)).find((v) => v.id === match[1]);
    if (!video) throw httpError(404, 'Video not found');
    return json(video);
  }
  if (pathname === '/api/topics' && m === 'GET') {
    const counts = new Map();
    for (const v of await visibleVideos(env, teacher)) {
      for (const t of v.topics) {
        const entry = counts.get(t.toLowerCase()) || { name: t, count: 0 };
        entry.count += 1;
        counts.set(t.toLowerCase(), entry);
      }
    }
    const topics = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return json({ topics });
  }
  if (pathname === '/api/levels' && m === 'GET') {
    const videos = await visibleVideos(env, teacher);
    return json({ levels: LEVELS.map((name) => ({ name, count: videos.filter((v) => v.level === name).length })) });
  }
  if (pathname === '/api/folders' && m === 'GET') {
    const videos = await visibleVideos(env, teacher);
    const { results } = await env.DB.prepare('SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE').all();
    const folders = results.map((f) => ({ id: f.id, name: f.name, createdAt: f.created_at, count: videos.filter((v) => v.folderId === f.id).length }));
    return json({ folders, unfiled: videos.filter((v) => !v.folderId).length });
  }

  // --- everything below changes the library: teacher only ---
  if (!teacher) throw httpError(401, 'Please log in as the teacher');

  if (pathname === '/api/youtube/info' && m === 'GET') {
    const id = parseYouTubeId(url.searchParams.get('url'));
    if (!id) throw httpError(400, 'That does not look like a YouTube link');
    return json(await youTubeInfo(env, id));
  }
  if (pathname === '/api/videos/youtube' && m === 'POST') {
    const body = await readJson(request);
    const youtubeId = parseYouTubeId(body.youtubeUrl);
    if (!youtubeId) throw httpError(400, 'That does not look like a YouTube link');
    const existing = await env.DB.prepare('SELECT title FROM videos WHERE youtube_id = ?').bind(youtubeId).first();
    if (existing) throw httpError(409, `This video is already in your library as “${existing.title}”`);
    const meta = await cleanMeta(env, body);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const duration = Number(body.durationSec) > 0 ? Math.round(Number(body.durationSec)) : null;
    await env.DB.prepare(
      `INSERT INTO videos (id, youtube_id, title, description, topics, level, folder_id, published, duration_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, youtubeId, meta.title, meta.description || '', JSON.stringify(meta.topics || []), meta.level || '', meta.folderId || null,
        meta.published === false ? 0 : 1, duration, now, now)
      .run();
    const row = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
    return json(rowToVideo(row), 201);
  }
  if (pathname === '/api/videos' && m === 'POST') {
    throw httpError(400, 'File uploads are not available online. Upload the video to YouTube as Unlisted and paste its link.');
  }
  if ((match = /^\/api\/videos\/([\w-]+)$/.exec(pathname))) {
    const row = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(match[1]).first();
    if (!row) throw httpError(404, 'Video not found');
    if (m === 'PATCH') {
      const body = await readJson(request);
      const v = { ...rowToVideo(row), ...(await cleanMeta(env, body, rowToVideo(row))) };
      if ('durationSec' in body) {
        const d = Number(body.durationSec);
        v.durationSec = Number.isFinite(d) && d > 0 ? Math.round(d) : null;
      }
      await env.DB.prepare(
        `UPDATE videos SET title = ?, description = ?, topics = ?, level = ?, folder_id = ?, published = ?, duration_sec = ?, updated_at = ?
         WHERE id = ?`,
      )
        .bind(v.title, v.description, JSON.stringify(v.topics), v.level, v.folderId, v.published ? 1 : 0, v.durationSec, new Date().toISOString(), row.id)
        .run();
      return json(rowToVideo(await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(row.id).first()));
    }
    if (m === 'DELETE') {
      await env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(row.id).run();
      return json(null, 204);
    }
  }
  if (pathname === '/api/folders' && m === 'POST') {
    const name = cleanText((await readJson(request)).name, 100);
    if (!name) throw httpError(400, 'Folder name is required');
    if (await env.DB.prepare('SELECT 1 FROM folders WHERE name = ? COLLATE NOCASE').bind(name).first()) {
      throw httpError(409, 'A folder with that name already exists');
    }
    const folder = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    await env.DB.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').bind(folder.id, folder.name, folder.createdAt).run();
    return json(folder, 201);
  }
  if ((match = /^\/api\/folders\/([\w-]+)$/.exec(pathname))) {
    const folder = await env.DB.prepare('SELECT * FROM folders WHERE id = ?').bind(match[1]).first();
    if (!folder) throw httpError(404, 'Folder not found');
    if (m === 'PATCH') {
      const name = cleanText((await readJson(request)).name, 100);
      if (!name) throw httpError(400, 'Folder name is required');
      if (await env.DB.prepare('SELECT 1 FROM folders WHERE name = ? COLLATE NOCASE AND id != ?').bind(name, folder.id).first()) {
        throw httpError(409, 'A folder with that name already exists');
      }
      await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ?').bind(name, folder.id).run();
      return json({ id: folder.id, name, createdAt: folder.created_at });
    }
    if (m === 'DELETE') {
      // Videos are kept; they move to "Unfiled".
      await env.DB.batch([
        env.DB.prepare('UPDATE videos SET folder_id = NULL WHERE folder_id = ?').bind(folder.id),
        env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(folder.id),
      ]);
      return json(null, 204);
    }
  }
  throw httpError(404, 'Not found');
}
