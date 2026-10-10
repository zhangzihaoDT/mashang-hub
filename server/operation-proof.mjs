import { createHash, sign, verify } from 'node:crypto';

export const snapshotDigest = draft => createHash('sha256').update(JSON.stringify(draft)).digest('hex');
export function approvalProof(record, privateKey, now = Date.now()) {
  const payload = JSON.stringify({ taskId: record.controlId, operationId: record.operationId, targetId: record.targetId, snapshotRef: record.snapshotRef, digest: record.digest, version: 1, expiresAt: now + 120000 });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}
export function verifyProof(proof, publicKey, { now = Date.now(), readOnly = false } = {}) {
  if (typeof proof?.payload !== 'string' || typeof proof?.signature !== 'string' || !verify(null, Buffer.from(proof.payload), publicKey, Buffer.from(proof.signature, 'base64'))) throw Error('INVALID_APPROVAL');
  const record = JSON.parse(proof.payload);
  if (record.version !== 1 || !/^operation_[a-f0-9-]{36}$/.test(record.operationId) || !/^[a-f0-9]{64}$/.test(record.digest) || !/^[a-f0-9-]{36}$/.test(record.snapshotRef) || !Number.isFinite(record.expiresAt) || (!readOnly && now >= record.expiresAt)) throw Error('INVALID_APPROVAL');
  return record;
}
