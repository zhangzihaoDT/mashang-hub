import assert from 'node:assert/strict';
import { ensureMappedSession } from '../worker/opencode-session.mjs';
import { readNoteResponse, noteFailure, normalizeFlomoListSpacing } from '../worker/content/note-response.mjs';
const mappings = new Map([['publish::conversation', 'old-session']]);
let created = 0, saved = 0;
const config = { mappings, key: 'publish::conversation', directory: '/mock/content', save: async () => saved++,
  api: async () => ({ id: 'old-session', directory: '/mock/mashang-publish' }),
  create: async () => { created++; return { id: 'new-session', directory: '/mock/content' }; } };
assert.equal(await ensureMappedSession(config), 'new-session');
assert.equal(mappings.get(config.key), 'new-session'); assert.equal(created, 1); assert.equal(saved, 1);
assert.equal(await ensureMappedSession({ ...config, api: async () => ({ directory: '/mock/content' }) }), 'new-session');
assert.equal(created, 1);
await assert.rejects(ensureMappedSession({ ...config, create: async () => ({ id: 'wrong', directory: '/mock/old' }) }), /NOTE_SESSION_DIRECTORY/);
assert.equal(mappings.get(config.key), 'new-session');
const record = { openCodeSessionId: 'new-session', userMessageId: 'current', directory: '/mock/content' };
let polls = 0;
const final = { info: { id: 'answer', role: 'assistant', parentID: 'current', finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: '{"final_note":"**合成笔记**\\n\\n正文"}' }] };
const api = async path => path === '/session/status' ? { 'new-session': { type: 'busy' } } : [{ info: { id: 'current' } }, ...(++polls >= 2 ? [final] : [])];
assert.equal(await readNoteResponse(api, record, { info: { id: 'answer' }, parts: [] }, { intervalMs: 1 }), '**合成笔记**\n\n正文');
assert.equal(polls, 2, 'poll current execution rather than repeat a model request');
const idle = async path => path === '/session/status' ? {} : [{ info: { id: 'current' } }];
assert.equal(await readNoteResponse(idle, record, { parts: [{ type: 'text', text: '{"final_note":' }, { type: 'text', text: '"正文"}' }] }), '正文');
await assert.rejects(readNoteResponse(idle, record, { info: { error: { name: 'SyntheticFailure' } }, parts: [] }), { code: 'NOTE_MODEL_FAILED' });
await assert.rejects(readNoteResponse(idle, record, { parts: [] }), { code: 'NOTE_RESPONSE_EMPTY' });
await assert.rejects(readNoteResponse(idle, record, { parts: [{ type: 'text', text: 'invalid JSON' }] }), { code: 'NOTE_RESPONSE_FORMAT' });
assert.equal(noteFailure({ code: 'NOTE_RESPONSE_EMPTY' }).message.includes('尚未发送'), true);
assert.ok(!noteFailure(new Error('private path or credentials')).message.includes('private'));
console.log('Content session migration: stale directory replacement, same-directory reuse, invalid replacement refusal, empty/async response handling and safe failure reasons passed');

const spaced = '**合成标题**\n\n- 第一项\n\n- 第二项\n\n正文\n\n```text\n- code one\n\n- code two\n```\n\n#标签';
assert.equal(normalizeFlomoListSpacing(spaced), spaced.replace('- 第一项\n\n- 第二项', '- 第一项\n- 第二项'));
assert.equal(normalizeFlomoListSpacing('- 第一项\n\n\n- 第二项'), '- 第一项\n- 第二项');
assert.equal(noteFailure(new Error('Remove blank lines between list items')).code, 'NOTE_RESPONSE_FORMAT');
