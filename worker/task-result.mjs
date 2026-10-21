// Read the existing local outbox; never execute or reconcile a task here.
export function readTaskResult(journal, request) {
  const entry = journal.entries[request.taskId];
  if (!entry || entry.executor !== 'agent' || entry.sessionId !== request.sessionId ||
      entry.attemptId !== request.attemptId || entry.dispatchId !== request.dispatchId) return null;
  const event = entry.events.findLast(item => item.type === 'agent.message.completed');
  if (!event || typeof event.text !== 'string') return null;
  return { text: event.text, plainText: event.plainText === true, contentCard: event.contentCard || null };
}
