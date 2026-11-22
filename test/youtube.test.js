const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let server, mock, base, cookie;
const ID = 'AbCdEfGhIj0';

before(async () => {
  // Stand-in for YouTube's oEmbed endpoint: knows one video, 404s the rest.
  mock = http.createServer((req, res) => {
    const target = new URL(req.url, 'http://x').searchParams.get('url');
    if (target.endsWith(ID)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'Pythagoras theorem explained', author_name: 'Maths Class' }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.YOUTUBE_OEMBED_URL = `http://localhost:${mock.address().port}/oembed`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mathesis-yt-'));
  const { start } = require('../server');
  server = await start(0);
  base = `http://localhost:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pythagoras' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); mock.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const asTeacher = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...opts.headers } });

test('understands the usual YouTube link shapes', () => {
  const { parseYouTubeId } = require('../server');
  for (const link of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=xyz`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    ID,
  ]) assert.equal(parseYouTubeId(link), ID, link);
  for (const bad of ['', 'hello', 'https://vimeo.com/123456', 'https://evil.com/watch?v=AbCdEfGhIj0', 'https://youtube.com/watch?v=short', 'https://youtube.com.evil.com/watch?v=AbCdEfGhIj0']) {
    assert.equal(parseYouTubeId(bad), null, bad);
  }
});

test('looks up the title of a pasted link', async () => {
  const info = await (await asTeacher(`/api/youtube/info?url=${encodeURIComponent(`https://youtu.be/${ID}`)}`)).json();
  assert.deepEqual(info, { id: ID, found: true, title: 'Pythagoras theorem explained', channel: 'Maths Class' });
  const missing = await (await asTeacher(`/api/youtube/info?url=${encodeURIComponent('https://youtu.be/ZZZZZZZZZZZ')}`)).json();
  assert.equal(missing.found, false);
  assert.equal((await fetch(`${base}/api/youtube/info?url=${ID}`)).status, 401); // teacher only
});

test('adds, lists, hides and deletes a YouTube lesson', async () => {
  const res = await asTeacher('/api/videos/youtube', {
    method: 'POST',
    body: JSON.stringify({ youtubeUrl: `https://www.youtube.com/watch?v=${ID}`, title: 'Pythagoras', level: 'Class IX', topics: 'Geometry, Triangles' }),
  });
  assert.equal(res.status, 201);
  const v = await res.json();
  assert.equal(v.source, 'youtube');
  assert.equal(v.youtubeId, ID);
  assert.equal(v.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}?rel=0&modestbranding=1`);
  assert.equal(v.thumbnailUrl, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  assert.equal(v.url, null);

  const dup = await asTeacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({ youtubeUrl: `https://youtu.be/${ID}`, title: 'Again' }) });
  assert.equal(dup.status, 409);
  const bad = await asTeacher('/api/videos/youtube', { method: 'POST', body: JSON.stringify({ youtubeUrl: 'https://vimeo.com/1', title: 'x' }) });
  assert.equal(bad.status, 400);
  const anon = await fetch(`${base}/api/videos/youtube`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl: ID, title: 'x' }) });
  assert.equal(anon.status, 401);

  let students = await (await fetch(`${base}/api/videos?level=Class%20IX`)).json();
  assert.deepEqual(students.videos.map((x) => x.youtubeId), [ID]);

  await asTeacher(`/api/videos/${v.id}`, { method: 'PATCH', body: JSON.stringify({ published: false }) });
  students = await (await fetch(`${base}/api/videos`)).json();
  assert.equal(students.videos.length, 0);

  assert.equal((await asTeacher(`/api/videos/${v.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await asTeacher('/api/videos')).json()).videos.length, 0);
});
