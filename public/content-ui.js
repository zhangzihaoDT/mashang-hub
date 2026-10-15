const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const contentCopy = {
  notes: { welcome: '把想法，记下来。', description: '整理笔记、保存本地，也可以同步到 Flomo。', placeholder: '在这里写笔记，或粘贴要保存的内容…' },
  publish: { welcome: '把想法，分享出去。', description: '起草微博，预览正文后确认发布。', placeholder: '起草微博，或粘贴准备发布的正文…' },
};
export function contentCardHTML(card, readOnly = false) {
  return `<section class="content-card" aria-label="笔记"><h2>${escape(card.title)}</h2><div class="content-note-body">${escape(card.body)}</div>${card.tags?.length ? `<p class="content-tags">${card.tags.map(escape).join(' ')}</p>` : ''}${card.notice ? `<p class="content-feedback" role="status">${escape(card.notice)}</p>` : ''}${!readOnly && card.actions?.length ? `<div class="content-actions">${card.actions.map(a => `<button type="button" class="${a.id === 'edit' ? 'quiet' : 'content-primary'}" data-content-action="${escape(a.id)}">${escape(a.label)}</button>`).join('')}</div>` : ''}</section>`;
}
