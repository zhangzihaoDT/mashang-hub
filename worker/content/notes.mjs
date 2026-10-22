import { normalizeFlomoListSpacing } from './note-response.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicationService } from '../publishing/service.mjs';
import { snapshotDigest } from '../../server/operation-proof.mjs';

export const NOTES_OPERATION = 'notes-flomo';
export function noteIntent(prompt) {
  // Inspect only the instruction, never keywords inside the quoted note body.
  const command = String(prompt).split(/[：:\n]/, 1)[0].trim();
  if (/(?:微博|weibo)/i.test(command)) return null;
  if (!/(?:笔记|记录|记下来|记一下|保存到本地|保存本地|flomo|整理)/i.test(command)) return null;
  if (/^(?:怎么|如何|为什么|能否|是否|介绍|解释)/.test(command)) return null;
  const previewOnly = /(?:只整理|仅整理|不(?:要)?(?:发送|同步))/.test(command);
  return { sync: /flomo/i.test(command) && !previewOnly, save: /(?:记下来|记一下|保存|存到|存本地)/.test(command) && !/(?:只整理|仅整理|不(?:要)?保存|不(?:要)?存)/.test(command), raw: /原样/.test(command) };

}
export async function createNotesOperation({ root, dataDirectory = join(root, 'data'), notesDirectory = join(root, '../mashang-knbase/library/notes'), directory, publicKey, run }) {
  const [{ Storage }, { notes, validateNote }] = await Promise.all(['storage.mjs', 'notes.mjs'].map(name => import(pathToFileURL(join(root, 'src', name)).href)));
  const storage = new Storage(dataDirectory, undefined, { notesRoot: notesDirectory });
  const state = new Storage(directory);
  const readSnapshot = async (ref, digest) => {
    if (!/^[a-f0-9-]{36}$/.test(ref)) throw Error('INVALID_SNAPSHOT');
    const draft = await state.read(`snapshots/${ref}.json`);
    if (!draft || digest && snapshotDigest(draft) !== digest) throw Error('SNAPSHOT_CHANGED');
    return draft;
  };
  function card(draft, ref, digest) {
    const lines = draft.final_note.split('\n');
    const tags = lines.at(-1)?.match(/#[^\s#]+/g) || [];
    return { title: lines[0].replace(/^\*\*|\*\*$/g, ''), body: lines.slice(1, tags.length ? -1 : undefined).join('\n').trim(), tags, text: draft.final_note, ref, digest,
      localOnly: Boolean(draft.source_id), imageCount: draft.imageCount || 0,
      notice: draft.localSaved ? (draft.source_id ? `已保存到本地 · 原始资料已保留${draft.imageCount ? ` · ${draft.imageCount} 张原图` : ''}` : '已保存到本地') : '', actions: [...(!draft.localSaved ? [{ id: 'save', label: '保存本地' }] : []), ...(!draft.flomoTaskId && !draft.source_id ? [{ id: 'sync', label: '同步 Flomo' }] : [])] };
  }
  const evidence = async id => {
    const mapping = await state.read(`associations/${id}.json`);
    if (!mapping) return { status: 'UNKNOWN' };
    const task = await storage.read(`notes/tasks/${mapping.taskId}.json`);
    const receipt = mapping.contentHash ? await storage.read(`notes/receipts/${mapping.contentHash}.json`) : null;
    return { status: task?.status === 'SYNCED' || receipt?.status === 'SYNCED' ? 'COMPLETED' : 'UNKNOWN' };
  };
  const service = new PublicationService({ directory: join(directory, 'ledger'), targetId: NOTES_OPERATION, publicKey,
    reconcile: evidence,
    execute: async (draft, id) => {
      await state.locked(() => state.write(`associations/${id}.json`, { taskId: draft.flomoTaskId, contentHash: createHash('sha256').update(draft.final_note).digest('hex') }, { immutable: true }));
      const saved = await storage.read(`notes/tasks/${draft.flomoTaskId}.json`);
      if (!saved || saved.payload.final_note !== draft.final_note || saved.payload.original_content !== draft.original_content) throw Error('CONTENT_CHANGED');
      await notes(storage, null, { taskId: draft.flomoTaskId, confirm: true, ...(run ? { run } : {}) });
      return evidence(id);
    },
  });
  return {
    async rememberDiscussion(sessionId, prompt, text) {
      await state.locked(async () => {
        const path = `discussions/${snapshotDigest(sessionId)}.json`;
        const previous = await state.read(path, []);
        await state.write(path, [...previous, { prompt: prompt.slice(-20000), text: text.slice(-20000) }].slice(-6));
      });
    },
    async discussionContext(sessionId) { return (await state.read(`discussions/${snapshotDigest(sessionId)}.json`, [])).map(item => `用户：${item.prompt}\n回复：${item.text}`).join('\n\n').slice(-40000); },
    async rememberPublication(sessionId, text) { await state.locked(() => state.write(`publication-drafts/${snapshotDigest(sessionId)}.json`, { text })); },
    async publicationDraft(sessionId) { return (await state.read(`publication-drafts/${snapshotDigest(sessionId)}.json`))?.text; },
    async latestNote(sessionId) { const latest = await state.read(`sessions/${snapshotDigest(sessionId)}.json`); return latest ? (await readSnapshot(latest.ref)).final_note : null; },
    async handle(task, { generate, context = '', signal } = {}) {
      if (!['publish', 'content'].includes(task.workspaceId)) return null;
      const action = task.contentAction;
      const intent = action ? null : noteIntent(task.prompt || '');
      if (!action && !intent) return null;
      if (task.actor?.kind !== 'user' || !task.actor.authenticated) return { text: '请先登录后保存或同步笔记。' };
      let draft, previous;
      const hasMedia = Boolean(task.attachments?.length || task.sourceDocuments?.length);
      if (hasMedia && action?.action !== 'save-input') throw Error('Images and rich input are local Notes only');
      if (['save-input','sync-input'].includes(action?.action)) {
        if (!task.prompt?.trim() && !task.attachments?.length) return { text: '请先输入笔记内容。' };
        draft = { sessionId: task.sessionId, original_content: task.prompt, final_note: task.prompt, raw: false, localSaved: false, flomoTaskId: null };
      } else if (action) {
        previous = await readSnapshot(action.ref);
        if (previous.sessionId !== task.sessionId || !['edit', 'save', 'sync', 'edit-save', 'edit-sync'].includes(action.action)) throw Error('INVALID_NOTE_ACTION');
        draft = { ...previous, flomoTaskId: null };
        if (action.action.startsWith('edit')) { draft.original_content = previous.original_content; draft.final_note = task.prompt; draft.raw = false; draft.localSaved = Boolean(previous.localSaved && task.prompt === previous.final_note); if (!draft.localSaved) delete draft.localTaskId; }
        if (['sync','edit-sync'].includes(action.action)) draft.raw = false;
      } else {
        const latest = await state.read(`sessions/${snapshotDigest(task.sessionId)}.json`);
        previous = latest ? await readSnapshot(latest.ref) : null;
        const colon = /[：:\n]([\s\S]+)$/.exec(task.prompt);
        const source = colon?.[1] || (/(?:刚才|之前|以上).*讨论/.test(task.prompt) ? context || previous?.final_note : previous?.final_note || context);
        if (!source?.trim()) return { text: '请粘贴要整理的内容。' };
        const original = source;
        const reuse = !colon && previous && /^(?:请|直接|把这条笔记|把这段内容|将这段内容|保存|同步|发到|到|和|并|本地|flomo|\s|。|，)+$/i.test(task.prompt);
        const final = intent.raw ? original : reuse ? previous.final_note : await generate({ original, prompt: task.prompt, flomo: intent.sync, signal });
        draft = { sessionId: task.sessionId, original_content: original, final_note: final, raw: intent.raw, localSaved: Boolean(reuse && previous.localSaved), flomoTaskId: null };
      }
      if (hasMedia) {
        const { saveNoteSources } = await import(pathToFileURL(join(root, 'src/note-assets.mjs')).href);
        const source = await saveNoteSources(storage, { original_content: task.prompt || '', attachments: task.attachments || [], source_documents: task.sourceDocuments || [] });
        draft.source_id = source.source_id; draft.extracted_content = ''; draft.imageCount = source.attachments.length;
      }
      if (signal?.aborted) return { text: hasMedia ? '已取消整理，原始资料已保存。' : '已取消。' };
      const wantsSave = ['save','save-input','edit-save'].includes(action?.action) || intent?.save;
      const wantsSync = ['sync','sync-input','edit-sync'].includes(action?.action) || intent?.sync;
      if (wantsSave && ['save-input', 'edit-save'].includes(action?.action)) {
        try {
          const result = await generate({ original: draft.final_note, prompt: '保留原意，整理为本地 Markdown 笔记', flomo: false, signal, attachments: task.attachments || [] });
          if (task.attachments?.length) {
            if (typeof result?.final_note !== 'string' || typeof result?.extracted_content !== 'string' || !result.extracted_content.trim()) throw Error('Missing image extraction');
            draft.final_note = normalizeFlomoListSpacing(result.final_note); draft.extracted_content = result.extracted_content;
          } else draft.final_note = normalizeFlomoListSpacing(result);
        } catch (error) { if (draft.source_id) error.sourcesSaved = true; throw error; }
        draft.localSaved = false; delete draft.localTaskId;
      }
      if (wantsSync && draft.source_id) throw Error('Rich Notes cannot be synchronized to Flomo');
      if (wantsSync) {
        const beforeFormatting = draft.final_note;
        draft.final_note = normalizeFlomoListSpacing(draft.final_note);
        try { validateNote({ ...draft, target: 'flomo' }); }
        catch { draft.final_note = normalizeFlomoListSpacing(await generate({ original: draft.final_note, prompt: '保留原意，整理为 Flomo 笔记', flomo: true, signal })); validateNote({ ...draft, target: 'flomo' }); }
        if (draft.final_note !== beforeFormatting) { draft.localSaved = false; delete draft.localTaskId; }
        await notes(storage, { ...draft, target: 'flomo' }, { dryRun: true });
      }
      if (signal?.aborted) return { text: '已取消。' };
      if (wantsSave && !draft.localSaved) {
        if (!draft.raw) draft.final_note = normalizeFlomoListSpacing(draft.final_note);
        // Cancellation cannot erase a completed local save; no network is involved.
        let saved;
        try { saved = await notes(storage, { ...draft, target: 'local' }); }
        catch (error) { if (draft.source_id) error.sourcesSaved = true; throw error; }
        draft.localSaved = true; draft.localTaskId = saved.task_id;
      }
      if (wantsSync) {
        const preview = await notes(storage, { ...draft, target: 'flomo' });
        draft.flomoTaskId = preview.task_id;
      }
      const ref = randomUUID(), digest = snapshotDigest(draft);
      await state.locked(async () => {
        await state.write(`snapshots/${ref}.json`, draft, { immutable: true });
        await state.write(`sessions/${snapshotDigest(task.sessionId)}.json`, { ref });
      });
      return { text: draft.final_note, contentCard: card(draft, ref, digest), plainText: false,
        ...(wantsSync ? { operationPreview: { targetId: NOTES_OPERATION, snapshotRef: ref, digest, actionLabel: '同步 Flomo', sourceDigest: snapshotDigest(draft.original_content) } } : {}) };
    },
    async readPreview(message) {
      const draft = await readSnapshot(message.snapshotRef, message.digest);
      return { text: draft.final_note, digest: message.digest, contentCard: card(draft, message.snapshotRef, message.digest) };
    },
    async request(message, readOnly = false) {
      try {
        const draft = await readSnapshot(message.snapshotRef, message.digest);
        const result = await service.handle({ proof: message.proof, draft }, readOnly);
        return { status: result.status, reason: result.status === 'COMPLETED' ? 'OK' : 'RESULT_UNVERIFIED' };
      } catch { return { status: 'UNKNOWN', reason: 'RESULT_UNVERIFIED' }; }
    },
  };
}
