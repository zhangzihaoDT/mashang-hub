/** Generic source-backed line comparison. No provider paths or financial rules. */
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#FF7A2F','#2878A9','#437C68','#174A7C','#8A6BA8','#7F743E','#279EAD','#9D5965'];
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? `${value.slice(5,7)}/${value.slice(8,10)}` : value || '—';
const updateStatus = operation => ({AWAITING_PERMISSION:'等待确认更新',RUNNING:'正在更新',COMPLETED:'最近一次更新完成',FAILED:'上次更新失败 · 保留现有结果',CANCELLED:'上次更新已取消 · 保留现有结果'})[operation?.lastRun?.status] || '按需更新';
export function trendComparison(c, artifacts=[], operation=null, canRun=true, control=null) {
  const confirmation=control?.status==='AWAITING_PERMISSION'
    ? `<div class="comparison-confirmation" role="group" aria-label="确认 Compare 更新"><span>Compare 更新等待确认</span><button class="rt-btn allow" data-control="${esc(control.controlId)}" data-decision="approve">允许</button><button class="rt-btn reject" data-control="${esc(control.controlId)}" data-decision="reject">拒绝</button></div>`
    : '';
  if (!c || !Array.isArray(c.dates) || c.dates.length<2 || !Array.isArray(c.series)) {
    if (!operation) return '';
    const busy=['RUNNING','AWAITING_PERMISSION'].includes(operation.lastRun?.status);
    const enabled=canRun && operation.enabled && !busy;
    const actionLabel=operation.lastRun?.status==='AWAITING_PERMISSION'?'等待确认…':operation.lastRun?.status==='RUNNING'?'更新中…':'生成 Compare';
    return `<section class="trend-comparison"><div class="business-section-head"><div><h2>观察篮子 · 长期走势</h2><p class="rt-sub">独立研究快照，不属于每日正式日报。</p></div><button class="rt-btn" data-op="run" data-target="${esc(operation.id)}" ${enabled?'':'disabled'}>${actionLabel}</button></div><p class="rt-sub" role="status">${esc(updateStatus(operation))}</p>${confirmation}<p>尚无可核验的 Compare 快照。</p></section>`;
  }
  const series=c.series.filter(s=>Array.isArray(s.values) && s.values.length===c.dates.length);
  const numbers=series.flatMap(s=>s.values.filter(Number.isFinite));
  if (!numbers.length) return '';
  let lo=Math.min(...numbers),hi=Math.max(...numbers);const span=hi-lo||1;lo-=span*.05;hi+=span*.05;
  const x=i=>62+i/(c.dates.length-1)*880, y=v=>278-(v-lo)/(hi-lo)*250;
  const ticks=Array.from({length:5},(_,i)=>lo+(hi-lo)*i/4);
  const grid=ticks.map(v=>`<line x1="62" x2="942" y1="${y(v)}" y2="${y(v)}" stroke="#e4ebef"/><text x="52" y="${y(v)+4}" text-anchor="end" fill="#556270" font-size="12">${v.toFixed(0)}</text>`).join('');
  const lines=series.map((s,j)=>{let open=false;let d='';s.values.forEach((v,i)=>{if(!Number.isFinite(v)){open=false;return;}d+=`${open?'L':'M'}${x(i).toFixed(2)},${y(v).toFixed(2)} `;open=true;});return `<path d="${d}" fill="none" stroke="${s.benchmark?'#374957':colors[j%colors.length]}" stroke-width="${s.benchmark?2.8:2}" ${s.benchmark?'stroke-dasharray="7 5"':''}><title>${esc(s.label)} · ${esc(c.dates.at(-1))} · ${Number.isFinite(s.values.at(-1))?s.values.at(-1).toFixed(2):'未知'}</title></path>`;}).join('');
  const legend=series.map((s,j)=>`<span style="display:inline-flex;gap:6px;align-items:center"><i style="display:inline-block;width:16px;border-top:3px ${s.benchmark?'dashed':'solid'} ${s.benchmark?'#374957':colors[j%colors.length]}"></i>${esc(s.label)}</span>`).join('');
  const artifact=artifacts.find(a=>a.digest===c.artifactDigest);
  const links=artifact?`<div class="rt-actions"><a class="rt-btn" href="/api/artifacts/content?artifactId=${encodeURIComponent(artifact.artifactId)}" target="_blank" rel="noopener">查看完整对比报告</a><a href="/api/artifacts/download?artifactId=${encodeURIComponent(artifact.artifactId)}" download>下载交互 HTML</a></div>`:'';
  const busy=['RUNNING','AWAITING_PERMISSION'].includes(operation?.lastRun?.status);
  const enabled=Boolean(operation && canRun && operation.enabled && !busy);
  const actionLabel=operation?.lastRun?.status==='AWAITING_PERMISSION'?'等待确认…':operation?.lastRun?.status==='RUNNING'?'更新中…':operation?.lastRun?.status==='FAILED'?'重试更新':'手动更新';
  const updateControl=operation?`<div class="comparison-refresh"><span class="rt-sub" role="status">${esc(updateStatus(operation))}${operation.lastRun?.status==='FAILED'?` · 当前保留截至 ${esc(dateLabel(c.endDate))} 的结果`:''}</span><button class="rt-btn" data-op="run" data-target="${esc(operation.id)}" ${enabled?'':'disabled'}>${actionLabel}</button></div>`:'';
  return `<section class="trend-comparison"><div class="business-section-head"><div><h2>${esc(c.title)}</h2><p class="rt-sub">独立研究快照 · 截至 ${esc(dateLabel(c.endDate))}</p></div>${updateControl}</div>${confirmation}<p class="rt-sub">${esc(c.startDate)} — ${esc(c.endDate)} · ${esc(c.unit)}</p><svg viewBox="0 0 960 320" role="img" aria-label="${esc(c.title)}，${esc(c.startDate)}至${esc(c.endDate)}" style="display:block;width:100%;height:auto;min-height:180px;background:#fff">${grid}${lines}<text x="62" y="310" font-size="12" fill="#556270">${esc(c.startDate)}</text><text x="942" y="310" text-anchor="end" fill="#556270" font-size="12">${esc(c.endDate)}</text></svg><div style="display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px;margin:12px 0">${legend}</div><p class="rt-sub">${esc(c.note)}</p>${links}</section>`;
}
