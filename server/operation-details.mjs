/** Generic business operation metadata. No provider paths or execution rules. */
const str = (v, n = 2000) => typeof v === 'string' ? v.slice(0, n) : null;
const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 128).map(x => str(x)) : [];
export function operationDetails(value) {
  if (!value || typeof value !== 'object') return undefined;
  const d = {};
  for (const key of ['targetDate', 'scheduledTargetDate', 'runId', 'phase', 'error', 'reason', 'retryAt', 'triggerSource']) if (str(value[key])) d[key] = str(value[key]);
  for (const key of ['elapsedSeconds', 'completedSteps', 'totalSteps']) if (Number.isFinite(value[key]) && value[key] >= 0) d[key] = value[key];
  if (typeof value.timezone === 'string') { try { new Intl.DateTimeFormat('en', {timeZone:value.timezone}).format(); d.timezone=value.timezone; } catch {} }
  if (Array.isArray(value.metrics)) d.metrics = value.metrics.slice(0, 32).map(m=>({label:str(m.label,200),value:str(m.value,200)}));
  if (value.schedule && typeof value.schedule === 'object') {
    const s = value.schedule;
    d.schedule = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : null,
      agentStatus: str(s.agentStatus, 40), lastCheckedAt: str(s.lastCheckedAt, 40),
      heartbeatAgeSeconds: Number.isFinite(s.heartbeatAgeSeconds) ? Math.max(0, s.heartbeatAgeSeconds) : null,
      nextScheduledAt: str(s.nextScheduledAt, 40), lastOccurrenceAt: str(s.lastOccurrenceAt, 40),
      lastOccurrenceStatus: str(s.lastOccurrenceStatus, 40),
      lastOccurrenceTradeDate: str(s.lastOccurrenceTradeDate, 40),
      manualPendingCount: Number.isInteger(s.manualPendingCount) ? Math.max(0, s.manualPendingCount) : 0,
      missedPolicy: s.missedPolicy === 'manual_only' ? 'manual_only' : null,
    };
  }
  if(value.marketSnapshot && typeof value.marketSnapshot === 'object') {
    const m=value.marketSnapshot;
    d.marketSnapshot={version:str(m.version,100),tradeDate:str(m.tradeDate,40),runId:str(m.runId,100),previousDate:str(m.previousDate,40),method:str(m.method),sections:Array.isArray(m.sections)?m.sections.slice(0,3).map(s=>({title:str(s.title,100),rows:list(s.rows).slice(0,4)})):[]};
    if(m.visuals && typeof m.visuals === 'object') {
      const v=m.visuals, num=(x,min,max)=>Number.isFinite(x) && x>=min && x<=max ? x:null;
      d.marketSnapshot.visuals={
        industries:Array.isArray(v.industries)?v.industries.slice(0,200).map(c=>({code:str(c.code,100),name:str(c.name,100),group:str(c.group,100),strength:num(c.strength,0,100),activeRatio:num(c.activeRatio,0,1),change:num(c.change,-100,100)})):[],
        breadth:{active:num(v.breadth?.active,0,100000),total:num(v.breadth?.total,0,100000),delta:num(v.breadth?.delta,-100000,100000),history:Array.isArray(v.breadth?.history)?v.breadth.history.slice(-20).map(p=>({date:str(p.date,40),active:num(p.active,0,100000),total:num(p.total,0,100000),basis:str(p.basis,400),dataComplete:typeof p.dataComplete==='boolean'?p.dataComplete:null})):[]},
        distribution:Array.isArray(v.distribution)?v.distribution.slice(0,4).map(p=>({label:str(p.label,100),count:num(p.count,0,100000)??0})):[]};
    }
  }
  if (value.publication) d.publication = {
    run_id: str(value.publication.run_id, 100), trade_date: str(value.publication.trade_date, 40),
    published_at: str(value.publication.published_at, 40),
  };
  if (value.quality) d.quality = { status: str(value.quality.status, 40),
    data_complete: typeof value.quality.data_complete === 'boolean' ? value.quality.data_complete : null,
    warnings: list(value.quality.warnings), errors: list(value.quality.errors),
    ...(value.quality.truncated || ['warnings','errors'].some(k=>Array.isArray(value.quality[k]) && (value.quality[k].length>128 || value.quality[k].some(x=>typeof x==='string' && x.length>2000))) ? {truncated:true} : {}) };
  return d;
}
export function operationArtifacts(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 8).filter(a => /^runtime_[a-f0-9]{64}$/.test(a?.artifactId || '')
    && ['.html', '.md'].includes(a.extension) && /^[a-f0-9]{64}$/.test(a.digest || '')
    && Number.isInteger(a.size) && a.size >= 0 && a.size <= 20 * 1024 * 1024).map(a => ({
      artifactId: a.artifactId, name: str(a.name, 200), extension: a.extension,
      size: a.size, digest: a.digest, runId: str(a.runId, 100), targetDate: str(a.targetDate, 40),
    }));
}
