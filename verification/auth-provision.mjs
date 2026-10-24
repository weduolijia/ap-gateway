import assert from 'node:assert/strict';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudBaseUrl, credentialsPath } from './credentials.mjs';

const mode = process.argv[2];
assert.ok(['local', 'cloud'].includes(mode), 'Choose local or cloud explicitly');
const root = fileURLToPath(new URL('../', import.meta.url));
const siteUrl = mode === 'cloud' ? cloudBaseUrl() : 'http://127.0.0.1:8788';
const selectedPath = credentialsPath(mode);
const path = selectedPath instanceof URL ? fileURLToPath(selectedPath) : resolve(selectedPath);
const relativePath = relative(root, path);
if (mode === 'cloud') {
  assert.ok(relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath),
    'Cloud credentials must be stored outside this repository');
}
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
let credentials;
try {
  credentials = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(credentials.siteUrl === siteUrl, 'Existing credentials belong to another deployment; choose another external file');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!credentials) {
  credentials = {
    siteUrl,
    password: process.env.AP_ADMIN_PASSWORD || randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
    note: 'Private administrator credentials. Never commit or share this file. Dashboard password changes do not update it.',
  };
  assert.ok(credentials.password.length >= 12 && credentials.password.length <= 128, 'Password must contain 12 to 128 characters');
  await writeFile(path, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
assert.ok(typeof credentials.password === 'string' && credentials.password.length >= 12 &&
  credentials.password.length <= 128, 'Credentials file contains an invalid password');
const salt = randomBytes(16);
const digest = pbkdf2Sync(credentials.password, salt, 100000, 32, 'sha256');
const passwordHash = `pbkdf2-sha256$100000$${salt.toString('hex')}$${digest.toString('hex')}`;
const seedDirectory = mode === 'local' ? join(root, '.wrangler', 'auth-verification')
  : join(root, '.wrangler', 'auth-provision', 'cloud');
await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
const sqlPath = join(seedDirectory, 'seed.sql');
await writeFile(sqlPath,
  `INSERT INTO auth_admin(id,password_hash,session_version,updated_at) SELECT 1,'${passwordHash}',1,${Date.now()} WHERE NOT EXISTS(SELECT 1 FROM auth_admin WHERE id=1);\n`,
  { mode: 0o600 });
console.log(JSON.stringify({ mode, credentialsPath: path, sqlPath, existingAdministratorsPreserved: true }));
