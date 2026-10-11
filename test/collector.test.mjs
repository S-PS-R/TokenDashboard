import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LogCollector, normalizeLimits } from '../src/collector.mjs';

test('incremental reads count new cumulative usage once, even after repeated snapshots and forked history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-dashboard-'));
  try {
    await mkdir(path.join(dir,'sessions'));
    const record = (type, payload, timestamp='2026-10-11T15:00:00Z') => JSON.stringify({type,payload,timestamp})+'\n';
    const usage = (input, cached, output) => ({input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:1});
    const first = record('event_msg',{type:'token_count',info:{total_token_usage:usage(100,40,10),last_token_usage:usage(100,40,10)}});
    const second = record('event_msg',{type:'token_count',info:{total_token_usage:usage(160,60,20),last_token_usage:usage(60,20,10)},rate_limits:{limit_id:'codex',plan_type:'plus',primary:{used_percent:4,window_minutes:300,resets_at:1791748853}}},'2026-10-11T15:01:00Z');
    const file=path.join(dir,'sessions','root.jsonl');
    await writeFile(file,record('session_meta',{id:'root',cwd:'C:/Project',model_provider:'openai'})+record('turn_context',{model:'gpt-6.1-sol'})+first+second+second);
    const collector=new LogCollector(dir);let data=await collector.scan();
    assert.equal(data.events.reduce((sum,e)=>sum+e.input_tokens,0),160);
    assert.equal(data.events.reduce((sum,e)=>sum+e.output_tokens,0),20);
    assert.equal(data.events.reduce((sum,e)=>sum+e.reasoning_output_tokens,0),1);
    assert.equal(data.logLimits[0].primary.usedPercent,4);
    assert.equal((await collector.scan()).events.length,2);
    await writeFile(path.join(dir,'sessions','fork.jsonl'),record('session_meta',{id:'fork',cwd:'C:/Project',forked_from_id:'root'})+first+second);
    assert.equal((await collector.scan()).events.length,2);
    const third=record('event_msg',{type:'token_count',info:{total_token_usage:usage(180,70,30),last_token_usage:usage(20,10,10)}},'2026-10-11T15:02:00Z');
    await appendFile(file,third.slice(0,-1));
    assert.equal((await collector.scan()).events.length,2);
    await appendFile(file,'\n');
    data=await collector.scan();assert.equal(data.events.length,3);
    assert.equal(data.events.reduce((sum,e)=>sum+e.input_tokens,0),180);
    await writeFile(file,record('session_meta',{id:'root',cwd:'C:/Project'})+first);
    data=await collector.scan();assert.equal(data.events.reduce((sum,e)=>sum+e.input_tokens,0),160);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('normalizes live account and logged limit snapshots without inventing absent values',()=>{
  assert.deepEqual(normalizeLimits({limitId:'codex',primary:{usedPercent:0,windowDurationMins:300,resetsAt:123}}).primary,
    {usedPercent:0,windowDurationMins:300,resetsAt:123});
  assert.equal(normalizeLimits({limit_id:'codex',primary:{}}).primary.usedPercent,null);
  assert.equal(normalizeLimits({limit_id:'codex'}).secondary,null);
});
