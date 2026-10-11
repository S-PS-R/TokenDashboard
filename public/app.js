const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = n => new Intl.NumberFormat(undefined, { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const exact = n => new Intl.NumberFormat().format(n);
const projectName = value => value.split(/[\\/]/).filter(Boolean).pop() || value;
const time = date => new Date(date).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
const keys = ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'];
let data, period = 'today', bucket = 'hour', view = 'sessions', paused = false, connection = 'Connecting…';
let visibleEvents = [];
function sum(events) { const total = Object.fromEntries(keys.map(k => [k, 0])); for (const e of events) for (const k of keys) total[k] += e[k] || 0; total.tokens = total.input_tokens + total.output_tokens; return total; }
function since() { const d = new Date(); d.setHours(0,0,0,0); if (period === 'all') return 0; if (period !== 'today') d.setDate(d.getDate() - Number(period) + 1); return d.getTime(); }
function matches(e) { return (!$('project').value || e.project === $('project').value) && (!$('model').value || e.model === $('model').value); }
function status(s) { if (!s.running) return { label:'Idle', className:'' }; return Date.now() - Date.parse(s.lastActivity) < 600000 ? { label:'Running', className:'running' } : { label:'Unconfirmed', className:'' }; }
function fillSelect(id, values, label) {
  const element = $(id), current = element.value, all = id === 'project' ? 'All projects' : 'All models';
  const unique = [...new Set(values)].sort();
  const signature = JSON.stringify(unique);
  if (element.dataset.signature === signature) return;
  element.dataset.signature = signature;
  element.innerHTML = `<option value="">${all}</option>` + unique.map(v => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  if (unique.includes(current)) element.value = current;
}
function limits() {
  if (!data.limits.length) { $('limits').innerHTML = '<div class="empty">No allowance reading yet. Sign in to Codex with ChatGPT to make plan data available.</div>'; $('limit-source').textContent = 'Unavailable'; }
  else {
    $('limits').innerHTML = data.limits.flatMap(l => ['primary','secondary'].map((kind, index) => {
      const w = l[kind]; if (!w) return '';
      const known = Number.isFinite(w.usedPercent), used = known ? Math.min(100, Math.max(0, w.usedPercent)) : null;
      const expired = Number.isFinite(w.resetsAt) && Date.now() / 1000 >= w.resetsAt;
      const stale = Date.now() - Date.parse(l.observedAt) > 120000;
      const title = w.windowDurationMins === 300 ? '5-hour allowance' : w.windowDurationMins === 10080 ? 'Weekly allowance' : w.windowDurationMins ? `${fmt(w.windowDurationMins / 60)}-hour allowance` : index ? 'Secondary allowance' : 'Primary allowance';
      const confidence = expired ? 'Reset passed · awaiting new reading' : stale ? 'Last recorded reading' : `${l.source === 'account' ? 'Account' : 'Log'} reading`;
      return `<article><div class="limit-top"><span class="limit-title">${esc(title)}${data.limits.length > 1 ? `<br><small>${esc(l.name || l.id)}</small>` : ''}</span><span class="limit-percent">${known ? `${fmt(100-used)}%` : '—'} <small>${expired ? 'last remaining' : 'remaining'}</small></span></div><div class="meter" role="meter" aria-label="${esc(title)} used"${known ? ` aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"` : ''}><svg viewBox="0 0 100 9" preserveAspectRatio="none" width="100%" height="9" aria-hidden="true"><rect width="${used ?? 0}" height="9" rx="1" fill="${used >= 90 ? '#f85149' : used >= 75 ? '#d29922' : '#3fb950'}"/></svg></div><div class="limit-detail"><span>${known ? `${used}% used` : 'Usage unavailable'}</span><span>${w.resetsAt ? `Reset: ${esc(time(w.resetsAt * 1000))}` : 'Reset unavailable'}</span></div><div class="footnote">${esc(confidence)} · ${esc(time(l.observedAt))}</div></article>`;
    })).join('');
    $('limit-source').textContent = data.limits.every(l => l.source === 'account') ? 'From your account' : data.limits.some(l => l.source === 'account') ? 'Account + logs' : 'From Codex logs';
  }
  $('account-status').textContent = `${data.accountStatus}. Account data refreshes every minute; local logs every 2.5 seconds. Missing or expired readings are never replaced with guessed usage.`;
}
function chart(events) {
  const groups = new Map();
  const slot = date => { const d = new Date(date); d.setMinutes(0,0,0); if (bucket === 'day') d.setHours(0,0,0,0); return d.getTime(); };
  let first = since(), end = slot(Date.now());
  if (!first) first = events.length ? slot(events[0].timestamp) : end;
  // Cap hourly plot at the most recent 7 days; daily plot can span the full selected period.
  if (bucket === 'hour') first = Math.max(first, end - 167 * 3600000);
  const cursor = new Date(slot(first));
  while (cursor.getTime() <= end) { groups.set(cursor.getTime(), []); if (bucket === 'day') cursor.setDate(cursor.getDate()+1); else cursor.setTime(cursor.getTime()+3600000); }
  for (const e of events) { const t = slot(e.timestamp); if (groups.has(t)) groups.get(t).push(e); }
  const entries = [...groups].map(([t, es]) => ({ t, ...sum(es) }));
  $('trend-caption').textContent = bucket === 'hour' ? 'Hourly totals · latest 7 days at most · local time' : 'Daily totals · selected period · local time';
  if (!events.length) { $('chart').innerHTML = '<div class="empty">No token activity in this selection.</div>'; return; }
  const w=760,h=220,left=50,bottom=28,top=8,plotH=h-bottom-top,plotW=w-left-8;
  const max = Math.max(1,...entries.map(e => e.tokens));
  const step = plotW / Math.max(1,entries.length), bar = Math.max(.5,step * .7);
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(bucket)} token activity chart">`;
  for(let i=0;i<=4;i++){ const y=top+plotH*i/4; svg+=`<line class="grid" x1="${left}" x2="${w}" y1="${y}" y2="${y}"/><text x="${left-9}" y="${y+4}" text-anchor="end">${fmt(max*(1-i/4))}</text>`; }
  entries.forEach((e,i) => {
    let y=top+plotH;
    const title = `${time(e.t)}: ${exact(e.tokens)} tokens (input ${exact(e.input_tokens)}, cached ${exact(e.cached_input_tokens)}, output ${exact(e.output_tokens)})`;
    svg+=`<g><title>${esc(title)}</title>`;
    for(const [value,color] of [[e.input_tokens-e.cached_input_tokens,'#5f8fbd'],[e.cached_input_tokens,'#56d58c'],[e.output_tokens,'#a799ed']]){const size=value/max*plotH;y-=size;svg+=`<rect x="${left+i*step+(step-bar)/2}" y="${y}" width="${bar}" height="${size}" fill="${color}"/>`;}
    svg+='</g>';
    if(i%Math.max(1,Math.ceil(entries.length/7))===0){ const date = new Date(e.t); const label = bucket==='hour' && period==='today' ? date.toLocaleTimeString(undefined,{hour:'numeric'}) : date.toLocaleDateString(undefined,{month:'short',day:'numeric'}); svg+=`<text x="${left+i*step+step/2}" y="${h-5}" text-anchor="middle">${esc(label)}</text>`; }
  });
  $('chart').innerHTML=svg+'</svg>';
}
function heatmap() {
  const today=new Date();today.setHours(0,0,0,0);
  const first=new Date(today);first.setDate(first.getDate()-364);
  const end=new Date(today);end.setDate(end.getDate()+1);
  const dayKey=value=>{const d=new Date(value);return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;};
  const days=new Map();
  for(const e of data.events.filter(matches)){
    const timestamp=Date.parse(e.timestamp);if(timestamp<first.getTime()||timestamp>=end.getTime())continue;
    const key=dayKey(timestamp);days.set(key,(days.get(key)||0)+e.input_tokens+e.output_tokens);
  }
  const max=Math.max(1,...days.values()),total=[...days.values()].reduce((a,b)=>a+b,0);
  const start=new Date(first);start.setDate(start.getDate()-start.getDay());
  const colors=['#161b22','#0e4429','#006d32','#26a641','#39d353'];
  const size=11,gap=3,step=size+gap,left=38,top=23;
  const cursor=new Date(start);let i=0,cells='',months='',lastMonth=null;
  while(cursor<=today){
    const column=Math.floor(i/7),x=left+column*step,y=top+cursor.getDay()*step;
    if(cursor>=first){
      const month=`${cursor.getFullYear()}-${cursor.getMonth()}`;
      if(month!==lastMonth){months+=`<text x="${x}" y="12">${esc(cursor.toLocaleDateString(undefined,{month:'short'}))}</text>`;lastMonth=month;}
      const value=days.get(dayKey(cursor))||0,level=value?Math.min(4,Math.ceil(value/max*4)):0;
      const label=`${cursor.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}: ${exact(value)} tokens`;
      cells+=`<rect class="day" data-date="${dayKey(cursor)}" data-detail="${esc(label)}" tabindex="0" role="img" aria-label="${esc(label)}" x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${colors[level]}"><title>${esc(label)}</title></rect>`;
    }
    cursor.setDate(cursor.getDate()+1);i++;
  }
  const width=left+Math.ceil(i/7)*step+9,height=top+7*step+2;
  const weekdays=[['Mon',1],['Wed',3],['Fri',5]].map(([label,row])=>`<text x="0" y="${top+row*step+9}">${label}</text>`).join('');
  const svg=`<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Daily token usage over the past 365 days">${months}${weekdays}${cells}</svg>`;
  // Preserve the focused square and hover detail across frequent live updates.
  if($('heatmap').dataset.chart!==svg){
    const focused=document.activeElement?.closest('#heatmap rect.day');const focusDate=focused?.getAttribute('data-date');
    $('heatmap').innerHTML=svg;$('heatmap').dataset.chart=svg;
    if(focusDate){const replacement=[...$('heatmap').querySelectorAll('rect.day')].find(r=>r.getAttribute('data-date')===focusDate);replacement?.focus({preventScroll:true});}
  }
  $('heatmap-title').textContent=`${fmt(total)} tokens in the last year`;
  $('heatmap-summary').textContent=`${days.size} active ${days.size===1?'day':'days'} · one square per day`;
}
function table() {
  const search=$('search').value.toLowerCase();
  const groups=new Map();
  for(const e of visibleEvents){const key=view==='projects'?e.project:e.sessionId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
  // Include sessions without token counts yet so a new running task is visible.
  if(view==='sessions')for(const s of data.sessions)if((!$('project').value||s.project===$('project').value)&&(!$('model').value||s.model===$('model').value)&&Date.parse(s.lastActivity)>=since()&&!groups.has(s.id))groups.set(s.id,[]);
  const sessions=new Map(data.sessions.map(s=>[s.id,s]));
  const rows=[...groups].map(([id,events])=>({id,events,...sum(events),session:sessions.get(id)})).filter(r=>`${r.session?.name??r.id} ${r.session?.project??r.id}`.toLowerCase().includes(search)).sort((a,b)=>b.tokens-a.tokens);
  $('table-head').innerHTML=`<tr><th>${view==='projects'?'Project':'Session / project'}</th><th>Total</th><th>Input</th><th>Cached</th><th>Output</th><th>${view==='projects'?'Sessions':'Activity'}</th></tr>`;
  $('table-body').innerHTML=rows.length?rows.map(r=>{const s=r.session,st=s?status(s):null;return `<tr><td><b title="${esc(view==='projects'?r.id:s?.name)}">${esc(view==='projects'?projectName(r.id):s?.name??r.id)}</b><small title="${esc(view==='projects'?r.id:s?.project)}">${esc(view==='projects'?r.id:`${projectName(s?.project??'Unknown')} · ${s?.model??'Unknown'}`)}</small></td><td>${fmt(r.tokens)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.cached_input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${view==='projects'?new Set(r.events.map(e=>e.sessionId)).size:`<span class="badge ${st?.className??''}">${esc(st?.label??'Unknown')}</span>`}</td></tr>`;}).join(''):'<tr><td colspan="6" class="empty">No sessions match this selection.</td></tr>';
}
function render() {
  if(!data)return;
  fillSelect('project',data.sessions.map(s=>s.project),projectName);fillSelect('model',data.events.map(e=>e.model),v=>v);
  limits();visibleEvents=data.events.filter(e=>Date.parse(e.timestamp)>=since()&&matches(e));const totals=sum(visibleEvents);
  for(const [id,k] of [['total','tokens'],['input','input_tokens'],['cached','cached_input_tokens'],['output','output_tokens']]){$(id).textContent=fmt(totals[k]);$(id).title=exact(totals[k]);}
  $('uncached').textContent=`${fmt(totals.input_tokens-totals.cached_input_tokens)} uncached`;
  $('cache-rate').textContent=`${totals.input_tokens?Math.round(totals.cached_input_tokens/totals.input_tokens*100):0}% of input reused`;
  $('reasoning').textContent=`${fmt(totals.reasoning_output_tokens)} reasoning tokens included`;
  const active=data.sessions.filter(s=>status(s).className==='running');$('active-count').textContent=active.length;
  $('active-sessions').innerHTML=active.length?active.slice(0,5).map(s=>`<div class="active-item"><div><b title="${esc(s.name)}">${esc(s.name)}</b><small>${esc(projectName(s.project))}</small></div><span class="badge running">Running</span></div>`).join(''):'<div class="empty">No recently active running turns.</div>';
  chart(visibleEvents);heatmap();table();
  $('updated').textContent=`Updated ${new Date(data.collectedAt).toLocaleTimeString()}`;
  $('coverage').textContent=`${data.logFiles} log files · ${data.sessions.length} local sessions`;
  $('directory').textContent=data.directory;
  $('error').hidden=!data.readErrors;if(data.readErrors)$('error').textContent=`${data.readErrors} log files or directories could not be read. Totals may be incomplete.`;
  const summary=data.accountUsage?.summary;
  const metrics=summary?[['lifetimeTokens','Lifetime tokens'],['peakDailyTokens','Peak daily tokens'],['currentStreakDays','Current streak (days)'],['longestStreakDays','Longest streak (days)']].filter(([key])=>Number.isFinite(summary[key])):[];
  $('account-summary').hidden=!metrics.length;
  $('account-summary').innerHTML=metrics.length?`<h2>Account activity summary</h2><p class="muted">Reported by Codex services · may cover more activity than local logs</p><div class="summary-grid">${metrics.map(([key,label])=>`<div><strong>${fmt(summary[key])}</strong><span>${label}</span></div>`).join('')}</div><div class="footnote">Reading from ${esc(time(data.accountUsage.observedAt))}${summary.lifetimeTokens === 0 && data.events.length ? ' · The service currently reports zero account tokens despite local activity. Its summary may not yet include these sessions.' : ''}</div>`:'';
  $('connection').textContent=paused?'Updates paused':connection;
}
const stream=new EventSource('/api/events');
stream.onopen=()=>{connection='Live · local';$('connection').textContent=paused?'Updates paused':connection;};
stream.onmessage=e=>{if(paused)return;try{data=JSON.parse(e.data);render();}catch{connection='Unable to render data';$('connection').textContent=connection;}};
stream.onerror=()=>{connection='Reconnecting…';$('connection').textContent=connection;};
function buttons(id,attribute,callback){$(id).addEventListener('click',e=>{const button=e.target.closest('button');if(!button)return;for(const b of $(id).querySelectorAll('button'))b.classList.toggle('selected',b===button);callback(button.dataset[attribute]);render();});}
buttons('periods','period',v=>period=v);buttons('buckets','bucket',v=>bucket=v);buttons('views','view',v=>view=v);
for(const id of ['project','model','search'])$(id).addEventListener(id==='search'?'input':'change',render);
for(const event of ['mouseover','focusin'])$('heatmap').addEventListener(event,e=>{const square=e.target.closest('rect.day');if(square)$('heatmap-detail').textContent=square.getAttribute('data-detail');});
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume updates':'Pause updates';$('connection').textContent=paused?'Updates paused':connection;if(!paused)fetch('/api/data').then(r=>r.json()).then(d=>{data=d;render();}).catch(()=>{$('connection').textContent='Connection unavailable';});};
$('export').onclick=()=>{const cell=value=>`"${String(value??'').replace(/"/g,'""')}"`;const rows=[['timestamp','session','project','model','input','cached_input','output','reasoning_output'],...visibleEvents.map(e=>[e.timestamp,data.sessions.find(s=>s.id===e.sessionId)?.name??e.sessionId,e.project,e.model,e.input_tokens,e.cached_input_tokens,e.output_tokens,e.reasoning_output_tokens])];const csv=rows.map(r=>r.map(v=>cell(typeof v==='string'&&/^[=+@\-\t\r]/.test(v)?`'${v}`:v)).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='codex-local-usage.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
