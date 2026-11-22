// Teacher login: one password, scrypt-hashed, with a signed session cookie.
//
// The password comes from either:
//   - the TEACHER_PASSWORD environment variable (best for hosting), or
//   - a one-time setup screen, which is only offered to someone on the same computer
//     as the server (so nobody on the internet can claim an empty install).

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'mt_session';
const SESSION_DAYS = 14;
const MIN_PASSWORD = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function createAuth({ file, envPassword }) {
  // Stored on disk: { secret, salt?, hash? }. The secret signs cookies; changing the
  // password rotates it, which logs out every other device.
  let store = {};
  const failures = new Map(); // ip -> { count, until }

  async function load() {
    try {
      store = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!store.secret) {
      store.secret = crypto.randomBytes(32).toString('hex');
      await save();
    }
  }

  async function save() {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  async function hashPassword(password, salt) {
    return (await scrypt(password, salt, 64)).toString('hex');
  }

  const hasPassword = () => Boolean(envPassword || store.hash);

  async function checkPassword(password) {
    const given = Buffer.from(String(password ?? ''));
    if (envPassword) {
      const want = Buffer.from(envPassword);
      // Compare hashes so the comparison takes the same time whatever the length.
      const a = crypto.createHash('sha256').update(given).digest();
      const b = crypto.createHash('sha256').update(want).digest();
      return crypto.timingSafeEqual(a, b);
    }
    if (!store.hash) return false;
    const actual = Buffer.from(await hashPassword(given, store.salt), 'hex');
    return crypto.timingSafeEqual(actual, Buffer.from(store.hash, 'hex'));
  }

  async function setPassword(password) {
    validateNewPassword(password);
    store.salt = crypto.randomBytes(16).toString('hex');
    store.hash = await hashPassword(String(password), store.salt);
    store.secret = crypto.randomBytes(32).toString('hex');
    await save();
  }

  function validateNewPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw Object.assign(new Error(`Use a password of at least ${MIN_PASSWORD} characters`), { status: 400 });
    }
  }

  function sign(value) {
    return crypto.createHmac('sha256', store.secret).update(value).digest('base64url');
  }

  function sessionCookie(req) {
    const expires = Date.now() + SESSION_DAYS * 864e5;
    const token = `${expires}.${sign(String(expires))}`;
    return cookieHeader(req, token, SESSION_DAYS * 86400);
  }

  function clearCookie(req) {
    return cookieHeader(req, '', 0);
  }

  function cookieHeader(req, value, maxAge) {
    const secure = isHttps(req) ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  function isTeacher(req) {
    const raw = (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE + '='));
    if (!raw) return false;
    const [expires, sig] = raw.slice(COOKIE.length + 1).split('.');
    if (!expires || !sig || Number(expires) < Date.now()) return false;
    const want = Buffer.from(sign(expires));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  // Setup without a password is only allowed from the server's own computer.
  function isLocalRequest(req) {
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) return false;
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  // Behind a hosting proxy the last X-Forwarded-For entry is the address the proxy saw;
  // earlier entries can be faked by the client.
  function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return forwarded.at(-1) || req.socket.remoteAddress || '';
  }

  function checkLockout(req) {
    // A ceiling across all addresses, so rotating addresses doesn't allow unlimited guessing.
    const global = failures.get('*');
    if (global && global.until > Date.now()) {
      throw Object.assign(new Error('Too many wrong passwords. Try again later.'), { status: 429 });
    }
    const entry = failures.get(clientIp(req));
    if (entry && entry.until > Date.now()) {
      const minutes = Math.ceil((entry.until - Date.now()) / 60000);
      throw Object.assign(new Error(`Too many wrong passwords. Try again in ${minutes} minute(s).`), { status: 429 });
    }
  }

  function recordFailure(req) {
    const ip = clientIp(req);
    const entry = failures.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.count = 0;
      entry.until = Date.now() + LOCKOUT_MS;
    }
    failures.set(ip, entry);
    const global = failures.get('*') || { count: 0, until: 0 };
    global.count += 1;
    if (global.count >= MAX_FAILURES * 10) {
      global.count = 0;
      global.until = Date.now() + LOCKOUT_MS;
    }
    failures.set('*', global);
  }

  return {
    load,
    isTeacher,
    status(req) {
      return {
        loggedIn: isTeacher(req),
        needsSetup: !hasPassword(),
        canSetup: !hasPassword() && isLocalRequest(req),
        managedByEnv: Boolean(envPassword),
      };
    },
    async setup(req, password) {
      if (hasPassword()) throw Object.assign(new Error('A password is already set'), { status: 409 });
      if (!isLocalRequest(req)) {
        throw Object.assign(new Error('Set the first password on the computer running the server, or set TEACHER_PASSWORD'), { status: 403 });
      }
      await setPassword(password);
      return sessionCookie(req);
    },
    async login(req, password) {
      checkLockout(req);
      if (!hasPassword()) throw Object.assign(new Error('No password has been set yet'), { status: 409 });
      if (!(await checkPassword(password))) {
        recordFailure(req);
        throw Object.assign(new Error('Wrong password'), { status: 401 });
      }
      failures.delete(clientIp(req));
      failures.delete('*');
      return sessionCookie(req);
    },
    logout: clearCookie,
    async changePassword(req, current, next) {
      if (envPassword) {
        throw Object.assign(new Error('The password is set by TEACHER_PASSWORD on the server; change it there'), { status: 409 });
      }
      checkLockout(req);
      if (!(await checkPassword(current))) {
        recordFailure(req);
        throw Object.assign(new Error('Current password is wrong'), { status: 401 });
      }
      await setPassword(next);
      return sessionCookie(req); // keep this device logged in, log out the others
    },
  };
}

function isHttps(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

module.exports = { createAuth };
