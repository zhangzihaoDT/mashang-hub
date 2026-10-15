// Bounded provider-authored display data, with no paths or executable commands.
export function contentCard(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9-]{36}$/.test(value.ref) || !/^[a-f0-9]{64}$/.test(value.digest)) return null;
  if (typeof value.text !== 'string' || value.text.length > 60000 || typeof value.body !== 'string' || value.body.length > 60000) return null;
  const string = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  return { ref: value.ref, digest: value.digest, title: string(value.title, 200), body: value.body, text: value.text,
    tags: Array.isArray(value.tags) ? value.tags.filter(v => typeof v === 'string').slice(0, 30).map(v => v.slice(0, 100)) : [],
    notice: string(value.notice, 200), actions: Array.isArray(value.actions) ? value.actions.filter(a => /^[a-z][a-z-]{0,30}$/.test(a?.id) && typeof a.label === 'string').slice(0, 4).map(a => ({ id: a.id, label: a.label.slice(0, 40) })) : [] };
}
