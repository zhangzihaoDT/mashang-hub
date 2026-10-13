import { stat } from 'node:fs/promises';
import { resolveLocalArtifact } from './artifact-resolver.mjs';
export function artifactCandidates(text) {
  return [...String(text || '').matchAll(/(?:^|[\s"'`(：:])([^\s"'`<>(),;]+\.(?:md|html|csv|png))(?=$|[\s"'`<>(),;])/giu)].map(m => m[1]);
}
// Only successful current-turn tools and files modified during this execution
// provide evidence for partial artifacts. Existing output-root policy still applies.
export async function toolArtifacts(messages, entry, workspace) {
  const found = new Map();
  const finishedAt = entry.finishedAt || messages.filter(m => m.info?.parentID === entry.userMessageId && (m.info?.error || m.info?.finish === 'stop')).at(-1)?.info?.time?.completed || Infinity;
  for (const message of messages) {
    if (message.info?.parentID !== entry.userMessageId || message.info?.role !== 'assistant') continue;
    for (const part of message.parts || []) {
      if (part.type !== 'tool' || part.state?.status !== 'completed' || !['write', 'bash', 'apply_patch', 'edit'].includes(part.tool) || (part.state.metadata?.exit != null && part.state.metadata.exit !== 0)) continue;
      // Decode strings rather than scan escaped JSON paths/line breaks.
      const values = [part.state.output, ...Object.values(part.state.input || {}).filter(v => typeof v === 'string')];
      for (const path of new Set(values.flatMap(artifactCandidates))) {
        const artifact = await resolveLocalArtifact(path, workspace.root, workspace.outputRoots);
        if (artifact) {
          const modifiedAt = (await stat(artifact.file)).mtimeMs;
          if (modifiedAt >= entry.startedAt && modifiedAt <= finishedAt && modifiedAt <= (part.state.time?.end || Infinity) + 1000) found.set(artifact.file, artifact);
        }
      }
    }
  }
  return [...found.values()];
}
