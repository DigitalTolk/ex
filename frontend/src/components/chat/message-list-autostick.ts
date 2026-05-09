export function shouldAutoStickMessageList(opts: {
  anchorMsgId?: string;
  hasPreviousPage?: boolean;
  atBottom: boolean;
}): boolean {
  if (opts.anchorMsgId || opts.hasPreviousPage) return false;
  return opts.atBottom;
}
