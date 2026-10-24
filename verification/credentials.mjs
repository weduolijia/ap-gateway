import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function cloudBaseUrl(variable = 'AP_CLOUD_URL') {
  const input = process.env[variable];
  assert.ok(input, `Set ${variable} to your deployment origin`);
  const url = new URL(input);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, `${variable} must be an HTTPS origin without embedded credentials`);
  return url.origin;
}

export function credentialsPath(mode) {
  return process.env.AP_ADMIN_CREDENTIALS_FILE || (mode === 'cloud'
    ? join(homedir(), '.config', 'ap-gateway', 'admin-credentials.json')
    : new URL('../.wrangler/auth-verification/login.json', import.meta.url));
}

export async function readAdminCredentials(mode) {
  const credentials = JSON.parse(await readFile(credentialsPath(mode), 'utf8'));
  assert.ok(typeof credentials.password === 'string' && credentials.password.length >= 12 &&
    credentials.password.length <= 128, 'Administrator credentials must contain a valid password');
  return credentials;
}
