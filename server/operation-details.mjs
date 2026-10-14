/** Generic business operation metadata. No provider paths or execution rules. */
const str = (v, n = 2000) => typeof v === 'string' ? v.slice(0, n) : null;
const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 128).map(x => str(x)) : [];
export function operationDetails(value) {
  if (!value || typeof value !== 'object') return undefined;
  const d = {};
  for (const key of ['targetDate', 'runId', 'phase', 'error', 'reason', 'retryAt']) if (str(value[key])) d[key] = str(value[key]);
  for (const key of ['elapsedSeconds', 'completedSteps', 'totalSteps']) if (Number.isFinite(value[key]) && value[key] >= 0) d[key] = value[key];
  if (typeof value.timezone === 'string') { try { new Intl.DateTimeFormat('en', {timeZone:value.timezone}).format(); d.timezone=value.timezone; } catch {} }
  if (Array.isArray(value.metrics)) d.metrics = value.metrics.slice(0, 32).map(m=>({label:str(m.label,200),value:str(m.value,200)}));
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
