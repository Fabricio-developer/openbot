// Messages the user sent with the queue shortcut (Cmd/Ctrl+Return). The send call reads the mark once, so the
// backend waits for the running turn to end instead of steering it.
const queuedClientMessageIds = new Set<string>();

export function markQueuedSend(clientMessageId: string): void {
  queuedClientMessageIds.add(clientMessageId);
}

export function takeQueuedSend(clientMessageId: string | undefined): boolean {
  if (!clientMessageId) return false;
  return queuedClientMessageIds.delete(clientMessageId);
}
