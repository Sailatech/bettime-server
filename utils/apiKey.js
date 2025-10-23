const crypto = require('crypto');
const util = require('util');
const pbkdf2 = util.promisify(crypto.pbkdf2);

const ITERATIONS = 310000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function generateKey() {
  const id = crypto.randomBytes(6).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return `${id}.${secret}`;
}

async function hashKey(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await pbkdf2(plain, salt, ITERATIONS, KEYLEN, DIGEST);
  return `${salt}$${ITERATIONS}$${derived.toString('hex')}`;
}

async function verifyKey(plain, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [salt, iterationsStr, derivedHex] = parts;
  const iterations = Number(iterationsStr);
  const derived = await pbkdf2(plain, salt, iterations, KEYLEN, DIGEST);
  try {
    return crypto.timingSafeEqual(Buffer.from(derivedHex, 'hex'), derived);
  } catch {
    return false;
  }
}

module.exports = { generateKey, hashKey, verifyKey };
