import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LogCollector } from './src/collector.mjs';
import { AccountReader } from './src/account.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.env.CODEX_DIR ?? path.join(os.homedir(), '.codex'));
const collector = new LogCollector(directory);
const account = new AccountReader(process.env.CODEX_BIN ?? 'codex');
let local = await collector.scan();
let scanning = false;
const scan = async () => { if (scanning) return; scanning = true; try { local = await collector.scan(); } catch {} finally { scanning = false; } };
const data = () => {
  const byId = new Map(local.logLimits.map(r => [r.id, { ...r, source: 'log' }]));
  for (const limit of account.limits) if (!byId.has(limit.id) || Date.now() - Date.parse(limit.observedAt) < 120000 || limit.observedAt >= byId.get(limit.id).observedAt) byId.set(limit.id, limit);
  return { ...local, limits: [...byId.values()], accountUsage: account.usage, limitHistory: account.history,
    accountStatus: account.status, collectedAt: new Date().toISOString(), directory };
};
const clients = new Set();
const server = http.createServer(async (req, res) => {
  // Restrict browser access to the local origin, including protection against DNS rebinding.
  const host = req.headers.host ?? '';
  if (!/^127\.0\.0\.1:\d+$/.test(host)) { res.writeHead(403); res.end('Local access only'); return; }
  if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end('Origin not allowed'); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  const url = new URL(req.url, `http://${host}`);
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (url.pathname === '/api/data') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data())); return; }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(data())}\n\n`); clients.add(res);
    req.on('close', () => clients.delete(res)); return;
  }
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  const file = files[url.pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try { const content = await readFile(path.join(root, 'public', file[0])); res.setHeader('Content-Type', `${file[1]}; charset=utf-8`); res.end(content); }
  catch { res.writeHead(500); res.end('Unable to load dashboard'); }
});
let port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
server.on('error', error => { if (error.code === 'EADDRINUSE' && port < 65535) server.listen(++port, '127.0.0.1'); else throw error; });
server.listen(port, '127.0.0.1', () => console.log(`Codex Plus Dashboard: http://127.0.0.1:${server.address().port}`));
void account.refresh();
const scanTimer = setInterval(async () => { await scan(); for (const res of clients) { if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); } else res.write(`data: ${JSON.stringify(data())}\n\n`); } }, 2500);
const accountTimer = setInterval(() => void account.refresh(), 60000);
function stop() { clearInterval(scanTimer); clearInterval(accountTimer); account.close(); for (const res of clients) res.end(); server.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
