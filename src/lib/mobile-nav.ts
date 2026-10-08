// Fired by a conversation header's back button on a phone; AppLayout slides
// the channel list back in.
export const OPEN_CHANNELS_EVENT = 'ex:open-channels';

export function requestOpenChannels(): void {
  window.dispatchEvent(new Event(OPEN_CHANNELS_EVENT));
}
