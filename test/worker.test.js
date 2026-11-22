// Runs the real Worker on a local copy of Cloudflare (wrangler dev + a local D1 database).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const PASSWORD = 'pythagoras-123';
const ID = 'AbCdEfGhIj0';
const PORT = 8790 + Math.floor(Math.random() * 100);
const base = `http://localhost:${PORT}`;
const wrangler = path.join(__dirname, '..', 'node_modules', '.bin', 'wrangler');
let dev, mock, persist, cookie;

before(async () => {
  // Stand-in for YouTube's oEmbed endpoint: knows one video.
  mock = http.createServer((req, res) => {
    const target = new URL(req.url, 'http://x').searchParams.get('url') || '';
    if (target.endsWith(ID)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'Pythagoras theorem explained', author_name: 'Maths Class' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => mock.listen(0, r));

  persist = fs.mkdtempSync(path.join(os.tmpdir(), 'mathesis-cf-'));
  const cwd = path.join(__dirname, '..');
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'mathesis', '--local', '--persist-to', persist], { cwd, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  dev = spawn(wrangler, ['dev', '--port', String(PORT), '--persist-to', persist,
    '--var', `TEACHER_PASSWORD:${PASSWORD}`, '--var', `YOUTUBE_OEMBED_URL:http://localhost:${mock.address().port}/oembed`], { cwd, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/auth/status`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const res = await post('/api/auth/login', { password: PASSWORD });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => {
  dev?.kill();
  mock?.close();
  fs.rmSync(persist, { recursive: true, force: true });
});

const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const teacher = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...opts.headers } });

test('serves the teacher pages with security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Mathesis/);
  assert.match(res.headers.get('content-security-policy'), /frame-src https:\/\/www.youtube-nocookie.com/);
});

test('login: wrong password, lockout, secure cookie', async () => {
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  assert.deepEqual(status, { loggedIn: false, needsSetup: false, canSetup: false, managedByEnv: true });
  assert.match((await post('/api/auth/login', { password: PASSWORD })).headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login', { password: 'nope' }, ip)).status, 401);
  assert.equal((await post('/api/auth/login', { password: PASSWORD }, ip)).status, 429);
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { Cookie: 'mt_session=9999999999999.abc' } }).then((r) => r.json())).loggedIn, false);
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } }).then((r) => r.json())).loggedIn, true);
});

test('YouTube lessons: look up, add, filter, hide, delete', async () => {
  const info = await (await teacher(`/api/youtube/info?url=${encodeURIComponent(`https://youtu.be/${ID}`)}`)).json();
  assert.equal(info.title, 'Pythagoras theorem explained');
  assert.equal((await fetch(`${base}/api/youtube/info?url=${ID}`)).status, 401);

  const folder = await (await teacher('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Geometry' }) })).json();
  const res = await teacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({
    youtubeUrl: `https://www.youtube.com/watch?v=${ID}`, title: 'Pythagoras', level: 'Class IX', topics: 'Triangles, geometry', folderId: folder.id,
  }) });
  assert.equal(res.status, 201);
  const v = await res.json();
  assert.deepEqual(v.topics, ['Triangles', 'geometry']);
  assert.equal(v.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}?rel=0&modestbranding=1`);

  assert.equal((await teacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({ youtubeUrl: `youtu.be/${ID}`, title: 'x' }) })).status, 409);
  assert.equal((await teacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({ youtubeUrl: 'https://vimeo.com/1', title: 'x' }) })).status, 400);
  assert.equal((await teacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({ youtubeUrl: 'QwErTyUiOp1', title: 'x', level: 'Grade 99' }) })).status, 400);

  // Students (no cookie) see it, filtered by class and topic.
  let list = await (await fetch(`${base}/api/videos?level=Class%20IX&topic=triangles`)).json();
  assert.deepEqual(list.videos.map((x) => x.id), [v.id]);
  const folders = await (await fetch(`${base}/api/folders`)).json();
  assert.equal(folders.folders[0].count, 1);

  // Students cannot change anything.
  for (const r of await Promise.all([
    post('/api/videos/youtube', { youtubeUrl: 'QwErTyUiOp1', title: 'x' }),
    fetch(`${base}/api/videos/${v.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"hacked"}' }),
    fetch(`${base}/api/videos/${v.id}`, { method: 'DELETE' }),
    post('/api/folders', { name: 'x' }),
  ])) assert.equal(r.status, 401);

  // Hidden videos disappear for students, including their topics and counts.
  const edited = await (await teacher(`/api/videos/${v.id}`, { method: 'PATCH', body: JSON.stringify({ published: false, title: 'Pythagoras (draft)' }) })).json();
  assert.equal(edited.title, 'Pythagoras (draft)');
  assert.equal(edited.published, false);
  assert.equal((await (await fetch(`${base}/api/videos`)).json()).videos.length, 0);
  assert.equal((await fetch(`${base}/api/videos/${v.id}`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/topics`)).json()).topics.length, 0);
  assert.equal((await (await teacher('/api/videos')).json()).videos.length, 1);

  // Deleting a folder keeps its videos.
  assert.equal((await teacher(`/api/folders/${folder.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await teacher(`/api/videos/${v.id}`)).json()).folderId, null);

  assert.equal((await teacher(`/api/videos/${v.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await teacher('/api/videos')).json()).videos.length, 0);
});

test('understands the usual YouTube link shapes', async () => {
  const { parseYouTubeId } = await import('../src/worker.js');
  for (const link of [`https://www.youtube.com/watch?v=${ID}&t=42s`, `https://youtu.be/${ID}?si=x`, `youtu.be/${ID}`, `https://m.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`, ID]) {
    assert.equal(parseYouTubeId(link), ID, link);
  }
  for (const bad of ['', 'hello', 'https://vimeo.com/123', 'https://evil.com/watch?v=AbCdEfGhIj0', 'https://youtube.com.evil.com/watch?v=AbCdEfGhIj0']) {
    assert.equal(parseYouTubeId(bad), null, bad);
  }
});
