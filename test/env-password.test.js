const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('TEACHER_PASSWORD from the environment works', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mathesis-env-'));
  process.env.TEACHER_PASSWORD = 'from-the-host';
  const { start } = require('../server');
  const server = await start(0);
  const base = `http://localhost:${server.address().port}`;
  const post = (password) => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal((await post('nope')).status, 401);
  assert.equal((await post('from-the-host')).status, 200);
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  assert.equal(status.needsSetup, false);
  assert.equal(status.managedByEnv, true);
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
