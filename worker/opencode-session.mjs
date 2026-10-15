import { resolve } from 'node:path';

// A Hub conversation survives a repository move; its execution session may not.
export async function ensureMappedSession({ api, mappings, key, directory, create, save }) {
  let id = mappings.get(key);
  if (id) {
    const session = await api(`/session/${encodeURIComponent(id)}`, { directory });
    // Older providers may omit directory; only replace a proven stale binding.
    if (!session.directory || resolve(session.directory) === resolve(directory)) return id;
  }
  const session = await create();
  if (typeof session.id !== 'string' || !session.id || session.directory && resolve(session.directory) !== resolve(directory)) {
    throw Object.assign(new Error('NOTE_SESSION_DIRECTORY'), { code: 'NOTE_SESSION_DIRECTORY' });
  }
  id = session.id;
  mappings.set(key, id);
  await save();
  return id;
}
