// Centralized React Query key factory. Keys are returned `as const`
// so partial-match invalidations work even when the underlying query
// was created with a fuller key (e.g. a deep-link anchor segment).

export const queryKeys = {
  // Auth / users
  user: (userId: string) => ['user', userId] as const,
  usersBatch: (sortedIDs?: readonly string[]) =>
    sortedIDs === undefined ? (['users-batch'] as const) : (['users-batch', sortedIDs] as const),
  searchUsers: (query: string) => ['searchUsers', query] as const,
  allUsers: () => ['allUsers'] as const,

  // Workspace
  workspaceSettings: () => ['workspace-settings'] as const,
  emojis: () => ['emojis'] as const,
  sidebarCategories: () => ['sidebarCategories'] as const,

  // Channels
  userChannels: () => ['userChannels'] as const,
  browseChannels: (query?: string) =>
    query === undefined ? (['browseChannels'] as const) : (['browseChannels', query] as const),
  channel: (channelId: string) => ['channel', channelId] as const,
  channelBySlug: (slug?: string) =>
    slug === undefined ? (['channelBySlug'] as const) : (['channelBySlug', slug] as const),
  channelMembers: (channelId?: string) =>
    channelId === undefined ? (['channelMembers'] as const) : (['channelMembers', channelId] as const),

  // Conversations
  userConversations: () => ['userConversations'] as const,
  conversation: (conversationId: string) => ['conversation', conversationId] as const,

  // Messages — anchor=null means tail mode. The *All variants drop
  // the anchor segment for partial-match invalidations across all
  // anchor variants.
  channelMessages: (channelId: string, anchor: string | null = null) =>
    ['channelMessages', channelId, anchor] as const,
  channelMessagesAll: (channelId: string) => ['channelMessages', channelId] as const,
  conversationMessages: (conversationId: string, anchor: string | null = null) =>
    ['conversationMessages', conversationId, anchor] as const,
  conversationMessagesAll: (conversationId: string) => ['conversationMessages', conversationId] as const,

  // Threads
  userThreads: () => ['userThreads'] as const,
  thread: (parentPath: string, threadRootID: string) => ['thread', parentPath, threadRootID] as const,

  // Pinned / files (parentPath is "channels/<id>" or "conversations/<id>")
  pinned: (parentPath: string) => ['pinned', parentPath] as const,
  files: (parentPath: string) => ['files', parentPath] as const,

  // Attachments
  attachment: (id: string) => ['attachment', id] as const,
  attachmentsBatch: (key: string) => ['attachments-batch', key] as const,

  // Search
  search: (
    index: string,
    query: string,
    limit: number,
    opts: object,
    nonce: number,
  ) => ['search', index, query, limit, opts, nonce] as const,

  // Admin / unfurl
  unfurl: (url: string) => ['unfurl', url] as const,
  adminSearchStatus: () => ['admin-search-status'] as const,
};

// parentPath builds the slash-separated key segment that thread,
// pinned, and files queries share — kept here so every caller derives
// it the same way.
export function parentPath(opts: { channelId?: string; conversationId?: string }): string {
  if (opts.channelId) return `channels/${opts.channelId}`;
  return `conversations/${opts.conversationId}`;
}
