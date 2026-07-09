// Build URLs that open a channel/conversation with a specific message
// scrolled into view. The hash is consumed by useMessageDeepLinkHighlight;
// the optional `?thread=…` query is consumed by Channel/ConversationView
// to auto-open the thread sidebar so the reply is visible inside it.
export function buildChannelHref(slug: string, msgId?: string, threadRoot?: string): string {
  let path = `/channel/${slug}`;
  if (threadRoot) path += `?thread=${encodeURIComponent(threadRoot)}`;
  if (msgId) path += `#msg-${msgId}`;
  return path;
}

export function buildConversationHref(id: string, msgId?: string, threadRoot?: string): string {
  let path = `/conversation/${id}`;
  if (threadRoot) path += `?thread=${encodeURIComponent(threadRoot)}`;
  if (msgId) path += `#msg-${msgId}`;
  return path;
}
