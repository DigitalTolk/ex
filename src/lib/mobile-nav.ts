import { create } from 'zustand';

// A request for the channel list: a conversation header's back button on a
// phone slides the drawer back in; /activity on a compact window opens the
// sidebar overlay. It is state rather than an event, so a request made before
// AppLayout is listening — /activity on a cold load mounts in the same commit
// as the layout, and its effect runs first — is still served.
export const useOpenChannelsRequest = create<{ pending: boolean }>(() => ({ pending: false }));

export function requestOpenChannels(): void {
  useOpenChannelsRequest.setState({ pending: true });
}

// takeOpenChannelsRequest reports whether a request is waiting, and clears it.
export function takeOpenChannelsRequest(): boolean {
  const { pending } = useOpenChannelsRequest.getState();
  if (pending) useOpenChannelsRequest.setState({ pending: false });
  return pending;
}
