// App-wide toasts, on sonner: showToast is fire-and-forget from anywhere, and
// the single <Toaster/> (mounted once at the app root) renders them. One raised
// before the Toaster mounts shows once it does (sonner replays live toasts).

import { createElement } from 'react';
import { toast } from 'sonner';
import { NotificationBanner, PlainToast } from '@/components/ToastViews';

export type ToastVariant = 'success' | 'error';

export interface ToastDetail {
  message: string;
  variant: ToastVariant;
  // Optional bold first line (e.g. a notification's "Alice in ~general").
  title?: string;
  // When set, the toast is tappable and runs this (e.g. deep-link into the
  // channel a notification came from) before dismissing.
  onActivate?: () => void;
  // 'notification' renders as a banner at the TOP of the screen with its own
  // high-contrast palette — the in-app popup surface for webviews without a
  // Notification API. Default toasts stay bottom-center near the action that
  // produced them.
  kind?: 'notification';
  // Notification banners with the same group (one conversation or thread)
  // share one banner: the newest message, and how many arrived.
  group?: string;
}

// How long a toast stays before going away. A grouped banner starts over with
// each new message, and a banner held under a finger waits for it to lift.
export const TOAST_TTL_MS = 4000;

// The Toaster the banners go to (the plain toasts use the default one).
export const BANNER_TOASTER_ID = 'notification-banners';

interface Banner {
  detail: ToastDetail;
  // Messages this banner stands for.
  count: number;
  held: boolean;
}

// Live banners by toast id, and which banner shows each notification group.
const banners = new Map<string | number, Banner>();
const groups = new Map<string, string | number>();

function forget(id: string | number) {
  banners.delete(id);
  for (const [group, groupId] of groups) {
    if (groupId === id) groups.delete(group);
  }
}

// Gone from the group map at once, so the next message of the conversation is
// a banner of its own even while this one is still animating out.
function closeBanner(id: string | number) {
  forget(id);
  toast.dismiss(id);
}

function holdBanner(id: string | number, held: boolean) {
  const banner = banners.get(id);
  if (!banner) return; // swiped away under the finger
  banner.held = held;
  publishBanner(banner, id);
}

// Creates the banner (no id) or redraws it in place (same id). Every redraw
// with a finite duration gives the banner its full time again; a held banner
// has none until the finger lifts.
function publishBanner(banner: Banner, existing?: string | number): string | number {
  const { message, variant, title, onActivate } = banner.detail;
  return toast.custom(
    (id) =>
      createElement(NotificationBanner, {
        message,
        variant,
        title,
        onActivate,
        count: banner.count,
        onDismiss: () => closeBanner(id),
        onHold: (held: boolean) => holdBanner(id, held),
      }),
    {
      id: existing,
      toasterId: BANNER_TOASTER_ID,
      duration: banner.held ? Infinity : TOAST_TTL_MS,
      // The banner swipes with the app's own gesture (ToastViews), not sonner's.
      dismissible: false,
      onAutoClose: (t) => forget(t.id),
    },
  );
}

function showBanner(detail: ToastDetail) {
  const existing = detail.group === undefined ? undefined : groups.get(detail.group);
  const previous = existing === undefined ? undefined : banners.get(existing);
  const banner: Banner = { detail, count: (previous?.count ?? 0) + 1, held: previous?.held ?? false };
  const id = publishBanner(banner, existing);
  banners.set(id, banner);
  if (detail.group !== undefined) groups.set(detail.group, id);
}

// showToast surfaces a transient message. Defaults to the error variant since the
// main callers are failure paths (e.g. a reminder that couldn't be scheduled).
export function showToast(
  message: string,
  variant: ToastVariant = 'error',
  opts?: Pick<ToastDetail, 'title' | 'onActivate' | 'kind' | 'group'>,
): void {
  const detail: ToastDetail = { message, variant, ...opts };
  if (detail.kind === 'notification') {
    showBanner(detail);
    return;
  }
  toast.custom(
    (id) =>
      createElement(PlainToast, {
        message,
        variant,
        title: detail.title,
        onActivate: detail.onActivate,
        onDismiss: () => toast.dismiss(id),
      }),
    { duration: TOAST_TTL_MS },
  );
}

// The toasts belong to the mounted Toaster: when it goes, so do they and the
// banners' grouping, and a later Toaster starts with none.
export function clearToasts(): void {
  banners.clear();
  groups.clear();
  toast.dismiss();
}
