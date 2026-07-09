export function shouldAutoStickMessageList(opts: {
  anchorMsgId?: string;
  hasPreviousPage?: boolean;
  atBottom: boolean;
  autoStickSuppressed?: boolean;
}): boolean {
  if (opts.anchorMsgId || opts.hasPreviousPage) return false;
  if (opts.autoStickSuppressed) return false;
  return opts.atBottom;
}
