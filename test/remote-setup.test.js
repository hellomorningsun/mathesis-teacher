// A fresh install reached through a proxy (as on a host) must not offer setup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('setup is refused from a remote address', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mathesis-remote-'));
  const { start } = require('../server');
  const server = await start(0);
  const base = `http://localhost:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.4' };
  const status = await (await fetch(`${base}/api/auth/status`, { headers })).json();
  assert.equal(status.needsSetup, true);
  assert.equal(status.canSetup, false);
  const res = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers, body: JSON.stringify({ password: 'takeover!!' }) });
  assert.equal(res.status, 403);
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
