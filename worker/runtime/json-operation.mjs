import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, relative, extname } from 'node:path';

const execute = promisify(execFile);
const allowed = { '.html': ['HTML', 'text/html'], '.md': ['Markdown', 'text/markdown'] };

/** Read trusted local provider JSON; only pinned, hashed report files are shared. */
export async function readJsonOperation(spec, { onArtifacts } = {}) {
  try {
    const { stdout } = await execute(spec.command, spec.args || [], {
      cwd: spec.cwd, timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(spec.env || {}) },
    });
    const view = JSON.parse(stdout);
    if (!view.lastRun || !view.details || !Array.isArray(view.artifacts)) throw Error('PROVIDER_FORMAT');
    const artifacts = [];
    for (const item of view.artifacts) {
      const kind = allowed[item.extension];
      const root = await realpath(spec.artifactRoot);
      const file = await realpath(item.file);
      const path = relative(root, file);
      if (!path || path.startsWith('..') || path.startsWith('/') || !kind || basename(file) !== item.name || extname(file) !== item.extension
          || !/^[a-f0-9]{64}$/.test(item.digest || '')) throw Error('ARTIFACT_SCOPE');
      const details = await stat(file);
      if (!details.isFile() || details.size !== item.size || details.size > 20 * 1024 * 1024) throw Error('ARTIFACT_SIZE');
      if (createHash('sha256').update(await readFile(file)).digest('hex') !== item.digest) throw Error('ARTIFACT_CHANGED');
      const identity = createHash('sha256').update(`${spec.cwd}:${item.runId}:${item.name}:${item.digest}`).digest('hex');
      artifacts.push({ ...item, file, path, type: kind[0], mimeType: kind[1], artifactId: `runtime_${identity}` });
    }
    await onArtifacts?.(artifacts);
    return { ...view, artifacts };
  } catch {
    // Never forward command lines, environment, stderr or local paths to Hub.
    return { lastRun: { status: 'BLOCKED', startedAt: null, finishedAt: null },
      details: { error: '本地状态或正式附件核验失败', reason: 'PROVIDER_UNAVAILABLE' }, artifacts: [] };
  }
}
