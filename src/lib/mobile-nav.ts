// Asks AppLayout for the channel list: a conversation header's back button
// on a phone slides the drawer back in; /activity on a compact window opens
// the sidebar overlay.
export const OPEN_CHANNELS_EVENT = 'ex:open-channels';

export function requestOpenChannels(): void {
  window.dispatchEvent(new Event(OPEN_CHANNELS_EVENT));
}
