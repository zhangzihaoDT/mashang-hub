const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = v => /^\d{8}$/.test(v || '') ? `${v.slice(4,6)}/${v.slice(6)}` : '—';
const number = v => typeof v === 'number' && Number.isFinite(v);
function color(v,mode) {
 if(!number(v)) return '#edf0f2';
 const fraction=Math.min(1,Math.max(0,mode==='change'?Math.abs(v)/30:mode==='activeRatio'?v:v/100));
 const target=mode==='change' && v<0 ? [221,112,56] : [50,123,173];
 return `rgb(${target.map(c=>Math.round(245+(c-245)*fraction)).join(',')})`;
}
export function heatmap(visuals,mode='strength',previousDate) {
 const cells=visuals.industries || [];
 const label={strength:'行业 RPS15',activeRatio:'所属一级行业活跃比例',change:`RPS15 较 ${date(previousDate)} 变化`}[mode];
 return `<div class="snapshot-heatmap"><div class="snapshot-chart-head"><span>行业趋势 · ${cells.length}</span><select data-heat-mode aria-label="行业热力图口径"><option value="strength" ${mode==='strength'?'selected':''}>趋势强度</option><option value="activeRatio" ${mode==='activeRatio'?'selected':''}>活跃比例</option><option value="change" ${mode==='change'?'selected':''}>较昨日变化</option></select></div><div class="heat-grid">${cells.map(c=>{
 const v=c[mode],text=!number(v)?'不可比 / 未知':mode==='activeRatio'?`${(v*100).toFixed(0)}%`:mode==='change'?`${v>0?'+':''}${v.toFixed(1)}`:v.toFixed(1);
 const title=`${c.group} · ${c.name} · ${label}：${text}`;
 return `<button type="button" class="heat-cell ${number(v)?'':'no-data'}" data-heat-info="${esc(title)}" aria-label="${esc(title)}" title="${esc(title)}" style="background:${color(v,mode)};color:${number(v) && (mode==='change'?Math.abs(v)>20:mode==='activeRatio'?v>.65:v>65)?'#fff':'#40586a'}">${esc(c.name.slice(0,2))}</button>`;
 }).join('')}</div><div class="chart-legend">${mode==='change'?'橙色下降 · 蓝色上升 · 灰色不可比':mode==='activeRatio'?'浅 → 深：所属一级行业活跃比例 0–100%':'浅 → 深：RPS15 0–100'}<span class="heat-info" role="status">点选行业查看数值</span></div></div>`;
}
export function breadth(b) {
 const points=b.history || [],valid=points.filter(p=>number(p.active) && p.total>0),max=Math.max(1,...valid.map(p=>p.active));
 const x=i=>10+i*280/Math.max(1,points.length-1),y=v=>75-v/max*60;
 const lines=[],dots=[];
 points.forEach((p,i)=>{
  if(!number(p.active)) return;
  const prev=points[i-1];
  if(i && number(prev.active) && p.basis===prev.basis) lines.push(`<path d="M${x(i-1)},${y(prev.active)} L${x(i)},${y(p.active)}"/>`);
  dots.push(`<circle cx="${x(i)}" cy="${y(p.active)}" r="3"><title>${esc(date(p.date))} · ${p.active}/${p.total} · ${(p.active/p.total*100).toFixed(1)}%${p.dataComplete===false?' · 数据不完整':''}</title></circle>`);
 });
 const delta=number(b.delta)?`${b.delta<0?'↓':b.delta>0?'↑':'→'} ${Math.abs(b.delta)}`:'变化不可比';
 return `<div class="breadth-chart"><div class="snapshot-chart-head"><span>ETF 趋势活跃</span><span class="breadth-delta ${b.delta<0?'cooling':''}">${delta}</span></div><div class="breadth-value">${number(b.active)?b.active:'—'} <small>/ ${b.total || '—'} · ${b.total?(b.active/b.total*100).toFixed(1)+'%':'未知'}</small></div><svg viewBox="0 0 300 90" role="img" aria-label="最近 ${points.length} 个交易日 ETF 活跃数量，${valid.length} 日有正式发布；缺失或来源不同不连线"><path class="chart-baseline" d="M10 75H290"/><g class="breadth-line">${lines.join('')}</g><g class="breadth-points">${dots.join('')}</g><text x="10" y="88">${date(points[0]?.date)}</text><text x="290" y="88" text-anchor="end">${date(points.at(-1)?.date)}</text><text x="10" y="10">${max}</text></svg><span class="chart-legend">近 ${points.length} 交易日 · ${valid.length} 日已发布${valid.length<points.length?' · 缺失留空':''} · 来源改变不连线</span></div>`;
}
export function distribution(items) {
 const total=items.reduce((n,x)=>n+x.count,0),colors=['#327bad','#85bad9','#de894f','#dce3e8'];
 return `<div class="state-distribution"><div class="snapshot-chart-head"><span>行业状态分布</span><span>${total}</span></div><div class="state-bar" role="img" aria-label="${esc(items.map(x=>`${x.label} ${x.count}`).join('，'))}">${items.map((x,i)=>`<span style="width:${total?x.count/total*100:0}%;background:${colors[i]}" title="${esc(x.label)} ${x.count}"></span>`).join('')}</div><div class="state-legend">${items.map((x,i)=>`<span><i style="background:${colors[i]}"></i>${esc(x.label)} <strong>${x.count}</strong></span>`).join('')}</div></div>`;
}
export function snapshotColumns(summary,mode) {
 const s=summary.sections || [],v=summary.visuals;
 if(!v) return s.map(x=>`<article><h3>${esc(x.title)}</h3>${x.rows.map(r=>`<p>${esc(r)}</p>`).join('')}</article>`).join('');
 return `<article><h3>市场状态</h3><p>${esc(s[0]?.rows?.[0])}</p>${breadth(v.breadth)}<details class="snapshot-evidence"><summary>广度口径</summary><p>趋势活跃条件沿用已发布事实；每日样本总数可能不同。变化数只比较同源共同样本，不代表固定全池净变化。</p></details></article><article><h3>关注方向</h3>${heatmap(v,mode,summary.previousDate)}<p class="snapshot-caption">${esc(s[1]?.rows?.slice(0,2).map(r=>r.split('：')[0]).join(' · '))} · 多行业共同支撑</p><details class="snapshot-evidence"><summary>方向与位置证据</summary>${(s[1]?.rows||[]).map(r=>`<p>${esc(r)}</p>`).join('')}</details></article><article><h3>重要变化</h3>${distribution(v.distribution)}${(s[2]?.rows||[]).slice(0,1).map(r=>`<p>${esc(r)}</p>`).join('')}<details class="snapshot-evidence"><summary>跨期可比范围</summary>${(s[2]?.rows||[]).slice(1).map(r=>`<p>${esc(r)}</p>`).join('')}<p>分布为本期状态，不是跨日迁移图。</p></details></article>`;
}
