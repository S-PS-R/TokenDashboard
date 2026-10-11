import { readdir, stat, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
export function normalizeLimits(raw) {
  if (!raw) return null;
  const window = w => w ? { usedPercent: w.usedPercent ?? w.used_percent ?? null,
    windowDurationMins: w.windowDurationMins ?? w.window_minutes ?? null,
    resetsAt: w.resetsAt ?? w.resets_at ?? null } : null;
  return { id: raw.limitId ?? raw.limit_id ?? 'codex', name: raw.limitName ?? raw.limit_name,
    primary: window(raw.primary), secondary: window(raw.secondary), planType: raw.planType ?? raw.plan_type,
    credits: raw.credits ?? null };
}

export class LogCollector {
  constructor(directory) { this.directory = directory; this.files = new Map(); this.names = new Map(); this.errors = 0; }
  async scan() {
    const found = new Set();
    const walk = async dir => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (e) { if (e.code !== 'ENOENT') this.errors++; return; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          found.add(file);
          try { await this.read(file); } catch { this.errors++; }
        }
      }
    };
    this.errors = 0;
    await walk(path.join(this.directory, 'sessions'));
    await walk(path.join(this.directory, 'archived_sessions'));
    for (const file of this.files.keys()) if (!found.has(file)) this.files.delete(file);
    try {
      this.names.clear();
      for (const line of (await readFile(path.join(this.directory, 'session_index.jsonl'), 'utf8')).split('\n')) {
        try { const r = JSON.parse(line); if (r.id && r.thread_name) this.names.set(r.id, r.thread_name); } catch {}
      }
    } catch {}
    return this.snapshot();
  }
  async read(file) {
    const info = await stat(file);
    let state = this.files.get(file);
    if (!state || info.size < state.offset || info.ino !== state.ino || (info.size === state.offset && info.mtimeMs !== state.mtime)) {
      state = { offset: 0, ino: info.ino, mtime: 0, tail: '', meta: {}, model: 'Unknown', events: [], limits: [], previous: null, lastActivity: null, running: false };
      this.files.set(file, state);
    }
    if (info.size === state.offset) return;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      // Keep incomplete records as bytes so UTF-8 characters can span reads safely.
      let pending = state.tail ? Buffer.from(state.tail, 'base64') : Buffer.alloc(0);
      while (state.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - state.offset), state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let start = 0, end;
        while ((end = pending.indexOf(10, start)) !== -1) {
          const line = pending.subarray(start, end).toString('utf8');
          start = end + 1;
          try { this.record(state, JSON.parse(line)); } catch {}
        }
        pending = pending.subarray(start);
      }
      state.tail = pending.toString('base64');
      state.mtime = info.mtimeMs;
    } finally { await handle.close(); }
  }
  record(state, r) {
    const p = r.payload;
    if (!p || !Number.isFinite(Date.parse(r.timestamp))) return;
    if (r.type === 'session_meta') state.meta = { id: p.id, cwd: p.cwd, forkedFrom: p.forked_from_id, provider: p.model_provider };
    if (r.type === 'turn_context' && p.model) state.model = p.model;
    if (r.type !== 'event_msg') return;
    state.lastActivity = r.timestamp;
    if (p.type === 'task_started') state.running = true;
    if (['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) state.running = false;
    if (p.type !== 'token_count') return;
    if (p.rate_limits) state.limits.push({ ...normalizeLimits(p.rate_limits), observedAt: r.timestamp });
    const total = p.info?.total_token_usage, last = p.info?.last_token_usage;
    if (!total && !last) return;
    let usage;
    if (total) {
      const next = Object.fromEntries(fields.map(k => [k, number(total[k])]));
      const reset = state.previous && fields.some(k => next[k] < state.previous[k]);
      usage = state.previous && !reset ? Object.fromEntries(fields.map(k => [k, Math.max(0, next[k] - state.previous[k])]))
        : Object.fromEntries(fields.map(k => [k, number(last?.[k])]));
      state.previous = next;
    } else usage = Object.fromEntries(fields.map(k => [k, number(last[k])]));
    if (!usage.input_tokens && !usage.output_tokens) return;
    usage.cached_input_tokens = Math.min(usage.input_tokens, usage.cached_input_tokens);
    // Forks can repeat their parent's history. The original event time and counters identify that history.
    const key = `${r.timestamp}|${JSON.stringify(total ?? last)}`;
    state.events.push({ key, timestamp: r.timestamp, model: state.model, ...usage });
  }
  snapshot() {
    const sessions = new Map(), events = new Map(), limits = new Map();
    const states = [...this.files.values()].sort((a, b) => Number(Boolean(a.meta.forkedFrom)) - Number(Boolean(b.meta.forkedFrom)));
    for (const s of states) {
      const id = s.meta.id;
      if (!id || (s.meta.provider && s.meta.provider !== 'openai')) continue;
      const project = s.meta.cwd ?? 'Unknown workspace';
      const old = sessions.get(id);
      if (!old || (s.lastActivity ?? '') > (old.lastActivity ?? '')) sessions.set(id,
        { id, name: this.names.get(id) ?? id.slice(0, 8), project, model: s.model, lastActivity: s.lastActivity,
          running: s.running, forkedFrom: s.meta.forkedFrom ?? null });
      for (const event of s.events) if (!events.has(event.key)) events.set(event.key, { ...event, sessionId: id, project });
      for (const limit of s.limits) if (!limits.has(limit.id) || limit.observedAt > limits.get(limit.id).observedAt) limits.set(limit.id, limit);
    }
    return { sessions: [...sessions.values()], events: [...events.values()].sort((a,b) => a.timestamp.localeCompare(b.timestamp)),
      logLimits: [...limits.values()], readErrors: this.errors, logFiles: this.files.size };
  }
}
