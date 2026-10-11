import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeLimits } from './collector.mjs';

async function resolveCodex(binary) {
  if (binary !== 'codex' || process.platform !== 'win32') return binary;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'codex.exe');
    try { await access(candidate); return candidate; } catch {}
  }
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) if (entry.isDirectory()) {
      const candidate = path.join(root, entry.name, 'codex.exe');
      try { candidates.push({ candidate, modified: (await stat(candidate)).mtimeMs }); } catch {}
    }
    candidates.sort((a,b) => b.modified - a.modified);
    if (candidates.length) return candidates[0].candidate;
  } catch {}
  return binary;
}

export class AccountReader {
  constructor(binary = 'codex') { this.binary = binary; this.pending = new Map(); this.nextId = 1; this.child = null;
    this.limits = []; this.history = []; this.usage = null; this.status = 'Connecting to Codex'; this.busy = false; }
  async connect() {
    if (this.child) return;
    const child = spawn(await resolveCodex(this.binary), ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id != null && this.pending.has(message.id)) {
            const request = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error.message ?? 'Account request failed'));
            else request.resolve(message.result);
          } else if (message.method === 'account/rateLimits/updated') this.updateLimits(message.params);
        } catch {}
      }
    });
    // Never expose app-server stderr, credentials, or account identity to the browser.
    child.stderr.resume();
    const closed = () => {
      if (this.child === child) this.child = null;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex connection unavailable')); }
      this.pending.clear();
    };
    child.on('error', closed); child.on('exit', closed); child.stdin.on('error', () => {});
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_plus_dashboard', title: 'Codex Plus Dashboard', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    } catch (error) { child.kill(); this.child = null; throw error; }
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('Codex is not available'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    });
  }
  updateLimits(result) {
    const observedAt = new Date().toISOString();
    const raw = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : result?.rateLimits ? [result.rateLimits] : [];
    if (!raw.length) return;
    this.limits = raw.map(r => ({ ...normalizeLimits(r), observedAt, source: 'account' }));
    this.history.push(...this.limits);
    this.history = this.history.slice(-10000);
    this.status = 'Account connected';
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.connect();
      this.updateLimits(await this.request('account/rateLimits/read'));
      try {
        const usage = await this.request('account/usage/read');
        this.usage = { summary: usage.summary ?? null, dailyUsageBuckets: usage.dailyUsageBuckets ?? null, observedAt: new Date().toISOString() };
      } catch { /* Older Codex versions may expose limits without account usage summaries. */ }
      if (!this.limits.length) this.status = 'Account limits unavailable; using log snapshots';
    } catch {
      this.status = 'Account connection unavailable; using log snapshots';
      this.close();
    } finally { this.busy = false; }
  }
  close() { this.child?.kill(); this.child = null; }
}
