// HTTP cancellation is transport evidence, never execution-stop evidence.
export async function inspectExecution(api, record) {
  const options = { directory: record.directory, signal: AbortSignal.timeout(5000) };
  const statuses = await api('/session/status', options);
  const messages = await api(`/session/${encodeURIComponent(record.openCodeSessionId)}/message?limit=100`, options);
  if (!Array.isArray(messages) || !messages.some(message => message.info?.id === record.userMessageId)) return { state: 'UNKNOWN' };
  const replies = messages.filter(message => message.info?.role === 'assistant' && message.info.parentID === record.userMessageId);
  const completed = replies.findLast(message => message.info.finish === 'stop' && !message.info.error && message.info.time?.completed);
  if (completed) return { state: 'COMPLETED', response: completed };
  const idle = !statuses[record.openCodeSessionId] || statuses[record.openCodeSessionId].type === 'idle';
  if (!idle) return { state: 'RUNNING' };
  const error = replies.findLast(message => message.info.error)?.info.error;
  if (error?.name === 'MessageAbortedError') return { state: 'CANCELLED' };
  if (error) return { state: 'FAILED', error: error.name || 'OPENCODE_ERROR' };
  if (record.abortAcknowledged) return { state: 'CANCELLED' };
  return { state: 'UNKNOWN' };
}

export async function requestExecutionCancel(api, record) {
  if (record.abortPending || record.abortAcknowledged || !record.requestStarted) return;
  record.abortPending = true;
  try {
    const acknowledged = await api(`/session/${encodeURIComponent(record.openCodeSessionId)}/abort`, {
      method: 'POST', directory: record.directory, signal: AbortSignal.timeout(5000),
    });
    record.abortAcknowledged = acknowledged === true;
  } finally { record.abortPending = false; }
}

export async function waitForExecution(api, record, { onUnverified = () => {}, onEvidence = () => {}, intervalMs = 1000 } = {}) {
  let notified = false;
  while (!record.settled) {
    try {
      if (record.source && !record.abortAcknowledged) {
        await requestExecutionCancel(api, record).catch(() => {});
        onEvidence(record);
      }
      const evidence = await inspectExecution(api, record);
      if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(evidence.state)) return evidence;
    } catch { /* Keep the mapping until execution evidence can be read. */ }
    if (!notified) { notified = true; onUnverified(); }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
