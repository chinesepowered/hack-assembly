// Minimal .env loader + proxy-aware WebSocket agent (no dotenv dependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

export const API_KEY = process.env.ASSEMBLYAI_API_KEY || '';
export const PORT = Number(process.env.PORT || 3000);

// Corporate/sandbox proxies: honour HTTPS_PROXY for outbound WebSockets.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
export const wsAgent = proxy ? new HttpsProxyAgent(proxy) : undefined;

export function requireKey() {
  if (!API_KEY) {
    console.error('Missing ASSEMBLYAI_API_KEY. Copy .env.example to .env and add your key.');
    process.exit(1);
  }
}
