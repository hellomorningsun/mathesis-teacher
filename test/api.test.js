const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mathesis-'));
const { start } = require('../server');

let server, base, cookie = '';
before(async () => {
  server = await start(0);
  base = `http://localhost:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pythagoras' }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});
// Every request in the main tests is made as the logged-in teacher.
const realFetch = globalThis.fetch;
const fetch = (url, opts = {}) => realFetch(url, { ...opts, headers: { Cookie: cookie, ...opts.headers } });
const anon = (url, opts) => realFetch(url, opts);
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const upload = (name, meta, bytes = Buffer.alloc(5000, 7)) =>
  fetch(`${base}/api/videos`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Filename': encodeURIComponent(name), 'X-Meta': encodeURIComponent(JSON.stringify(meta)) },
    body: bytes,
  });

test('upload, list, filter, edit, stream and delete a video', async () => {
  const folder = await (await fetch(`${base}/api/folders`, json('POST', { name: 'Algebra basics' }))).json();
  const res = await upload('linear equations.mp4', { title: 'Linear equations', topics: 'Algebra, equations, algebra', level: 'Class VIII', folderId: folder.id, durationSec: 61.4 });
  assert.equal(res.status, 201);
  const v = await res.json();
  assert.deepEqual(v.topics, ['Algebra', 'equations']);
  assert.equal(v.durationSec, 61);
  assert.equal(v.size, 5000);

  await upload('geo.webm', { title: 'Triangles', topics: ['Geometry'], level: 'Class IX' });

  let list = await (await fetch(`${base}/api/videos?topic=algebra`)).json();
  assert.deepEqual(list.videos.map((x) => x.title), ['Linear equations']);
  list = await (await fetch(`${base}/api/videos?level=Class%20IX`)).json();
  assert.deepEqual(list.videos.map((x) => x.title), ['Triangles']);
  list = await (await fetch(`${base}/api/videos?q=triang`)).json();
  assert.equal(list.videos.length, 1);
  list = await (await fetch(`${base}/api/videos?folder=none`)).json();
  assert.deepEqual(list.videos.map((x) => x.title), ['Triangles']);

  const ranged = await fetch(`${base}${v.url}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/5000');

  const edited = await (await fetch(`${base}/api/videos/${v.id}`, json('PATCH', { title: 'Solving linear equations', published: false }))).json();
  assert.equal(edited.title, 'Solving linear equations');
  assert.equal(edited.published, false);
  list = await (await fetch(`${base}/api/videos?published=true`)).json();
  assert.equal(list.videos.length, 1);

  const topics = await (await fetch(`${base}/api/topics`)).json();
  assert.deepEqual(topics.topics.map((t) => t.name).sort(), ['Algebra', 'Geometry', 'equations']);

  assert.equal((await fetch(`${base}/api/folders/${folder.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await fetch(`${base}/api/videos/${v.id}`)).json()).folderId, null);

  assert.equal((await fetch(`${base}/api/videos/${v.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}${v.url}`)).status, 404);
});

test('data survives a restart', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'library.json'), 'utf8'));
  assert.equal(saved.videos.length, 1);
});

test('rejects bad uploads', async () => {
  assert.equal((await upload('notes.pdf', { title: 'x' })).status, 415);
  assert.equal((await upload('a.mp4', { title: '' })).status, 400);
  assert.equal((await upload('a.mp4', { title: 'x', level: 'Grade 99' })).status, 400);
  assert.equal((await upload('a.mp4', { title: 'x' }, Buffer.alloc(0))).status, 400);
  assert.equal((await fetch(`${base}/media/..%2Flibrary.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fserver.js`)).status, 404);
});

test('students see only visible videos and cannot change anything', async () => {
  const hidden = await (await upload('secret.mp4', { title: 'Draft lesson', published: false, topics: ['Draft topic'] })).json();
  const shown = await (await upload('open.mp4', { title: 'Open lesson', level: 'Class X' })).json();

  const list = await (await anon(`${base}/api/videos`)).json();
  assert.ok(list.videos.some((v) => v.id === shown.id));
  assert.ok(!list.videos.some((v) => v.id === hidden.id));
  assert.equal((await anon(`${base}/api/videos/${hidden.id}`)).status, 404);
  assert.equal((await anon(`${base}${hidden.url}`)).status, 404);
  assert.equal((await anon(`${base}${shown.url}`)).status, 200);
  const topics = await (await anon(`${base}/api/topics`)).json();
  assert.ok(!topics.topics.some((t) => t.name === 'Draft topic'));

  const writes = [
    anon(`${base}/api/videos`, { method: 'POST', headers: { 'X-Filename': 'a.mp4', 'X-Meta': encodeURIComponent('{"title":"x"}') }, body: Buffer.alloc(10) }),
    anon(`${base}/api/videos/${shown.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"hacked"}' }),
    anon(`${base}/api/videos/${shown.id}`, { method: 'DELETE' }),
    anon(`${base}/api/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' }),
  ];
  for (const res of await Promise.all(writes)) assert.equal(res.status, 401);
  assert.equal((await (await fetch(`${base}/api/videos/${shown.id}`)).json()).title, 'Open lesson');

  // A forged or expired cookie is not accepted.
  const forged = await realFetch(`${base}/api/videos/${shown.id}`, { method: 'DELETE', headers: { Cookie: 'mt_session=9999999999999.abc' } });
  assert.equal(forged.status, 401);
});

test('login, wrong passwords, lockout and password change', async () => {
  const post = (p, body, headers = {}) => realFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // Setup can only happen once, and never through a proxy.
  assert.equal((await post('/api/auth/setup', { password: 'another-one' })).status, 409);

  const status = await (await anon(`${base}/api/auth/status`)).json();
  assert.deepEqual(status, { loggedIn: false, needsSetup: false, canSetup: false, managedByEnv: false });

  const ok = await post('/api/auth/login', { password: 'pythagoras' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const viaHttps = await post('/api/auth/login', { password: 'pythagoras' }, { 'X-Forwarded-Proto': 'https' });
  assert.match(viaHttps.headers.get('set-cookie'), /Secure/);

  const ip = { 'X-Forwarded-For': '203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login', { password: 'wrong' }, ip)).status, 401);
  assert.equal((await post('/api/auth/login', { password: 'pythagoras' }, ip)).status, 429);

  // Changing the password logs out other sessions.
  const oldCookie = cookie;
  const changed = await post('/api/auth/password', { current: 'pythagoras', next: 'euclid-1234' }, { Cookie: cookie });
  assert.equal(changed.status, 200);
  cookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await realFetch(`${base}/api/auth/status`, { headers: { Cookie: oldCookie } }).then((r) => r.json())).loggedIn, false);
  assert.equal((await realFetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } }).then((r) => r.json())).loggedIn, true);
  assert.equal((await post('/api/auth/login', { password: 'euclid-1234' })).status, 200);
  assert.equal((await post('/api/auth/password', { current: 'euclid-1234', next: 'short' }, { Cookie: cookie })).status, 400);
});
