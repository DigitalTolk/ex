import { Fragment, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  PragmaticCategoryDropHitbox,
  PragmaticCategoryHeader,
  PragmaticChannelRow,
  PragmaticConversationRow,
  PragmaticSection,
  SidebarDropGap,
} from './sidebar-dnd';
import { CATEGORY_DROP_END } from './sidebar-dnd-core';
import { dropCount } from './sidebar-drop-resolution';
import { useSidebarDrag } from './useSidebarDrag';
import { foldedSectionItems, isSectionHidden, spacedSectionKeys, useSidebarSections } from './useSidebarSections';
import { dmPartnerID, useDMPartners } from './useDMPartners';
import {
  Plus,
  ChevronDown,
  MoreVertical,
  Trash2,
  ArrowDownAZ,
  Clock3,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isGuest } from '@/lib/roles';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { deviceKind } from '@/lib/device';
import { usePointerDevice } from '@/hooks/usePointerDevice';
import { useSidebarViewPreferences } from '@/hooks/useSidebarViewPreferences';
import { SidebarSectionKeys } from '@/lib/sidebar-groups';
import { SidebarUnreadControls } from '@/components/layout/SidebarUnreadControls';
import { ChannelRow } from './ChannelRow';
import { ConversationRow } from './ConversationRow';
import { SidebarPageLinks } from './SidebarPageLinks';
import { DeleteCategoryDialog, SidebarAddCategory } from './SidebarCategoryControls';
import { SidebarArchivedSection } from './SidebarArchivedSection';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';

interface SidebarProps {
  onClose: () => void;
}

function SidebarSectionsSkeleton() {
  return (
    <div className="mt-2 space-y-4 px-2" data-testid="sidebar-primary-loading" aria-hidden="true">
      {['w-20', 'w-24', 'w-32'].map((widthClass) => (
        <div key={widthClass} className="space-y-2">
          <div className={`h-4 rounded bg-white/10 ${widthClass}`} />
          <div className="h-8 rounded-md bg-white/5 mobile:h-12" />
          <div className="h-8 rounded-md bg-white/5 mobile:h-12" />
        </div>
      ))}
    </div>
  );
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user } = useAuth();
  const { hideConversation } = useUnread();
  const view = useSidebarViewPreferences();
  const { unreadSection, unreadOnly } = view;
  const { ready, sections: sidebarSections, archivedChannels, visibleConversations, categories } = useSidebarSections(view);
  const dmUserMap = useDMPartners(visibleConversations, user?.id);
  const { isDraggingCategory, dropIndicator, suppressedNavigationID, clearSuppressedNavigation } = useSidebarDrag(
    sidebarSections,
    categories,
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // The Archived section starts folded: archived channels are history, not
  // where work happens.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Drag-to-reorder needs a mouse or trackpad. Without one — a phone, or an
  // iPad on its own — a hold on a row opens its menu (useRowLongPressMenu) and
  // iPadOS would start a native drag lift from that same hold.
  const pointerDevice = usePointerDevice();
  const dragDisabled = deviceKind() === 'touch' && !pointerDevice;
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // null = closed; otherwise the section being deleted.
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; title: string } | null>(null);

  function toggleGroupCollapsed(sectionKey: string) {
    setCollapsedGroups((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  }

  const spacedSections = spacedSectionKeys(sidebarSections, collapsedGroups, unreadOnly);

  return (
    <div className="flex h-full w-full min-w-0 flex-col text-gray-300 touch:select-none touch:touch-pan-y touch:[-webkit-touch-callout:none] touch:[-webkit-user-select:none]">
      <ScrollArea
        className="min-h-0 w-full flex-1 mobile:touch-pan-y"
        scrollbarClassName="opacity-0 transition-opacity data-[scrolling]:opacity-100"
        data-testid="sidebar-scroll-area"
      >
        {/* Bottom padding clears the home indicator on notched phones (the
            drawer is a full-height mobile surface with no bottom chrome). */}
        {/* The extra top padding is the gap under the Home / Activity switch,
            kept inside the scroller so rows scroll right up to the switch. */}
        <div className="w-full min-w-0 space-y-1 p-2 pt-5 mobile:pt-2 mobile:pb-[calc(var(--bottom-safe-inset,env(safe-area-inset-bottom))+0.5rem)]">
          {/* Threads first (Activity has its own sidebar mode — see the
              Home / Activity switch above). */}
          <SidebarPageLinks onClose={onClose} />

          {/* Visual break between top-level pages and the channel/DM list. */}
          <div
            data-testid="sidebar-top-divider"
            role="separator"
            className="my-2 h-px bg-white/10"
          />

          {/* "Add category" sits above the sections so the affordance is
              obvious before users scroll into the list; the unread view
              options icon shares its row. */}
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <SidebarAddCategory />
            </div>
            <SidebarUnreadControls
              unreadOnly={unreadOnly}
              onUnreadOnlyChange={view.setUnreadOnly}
              unreadSection={unreadSection}
              onUnreadSectionChange={view.setUnreadSection}
            />
          </div>

          {/* Unified sidebar list: Favorites (mixed) → user categories
              (mixed) → Channels (uncategorised) → Direct Messages
              (always rendered as the bottom section; its "+" routes to
              /conversations/new). User-defined categories contain channels;
              DMs/groups can only appear here when favorited. */}
          {ready ? (
          <nav aria-label="Channels and direct messages" data-testid="sidebar-primary-sections">
            {unreadOnly && (
              <div
                data-testid="sidebar-unread-only-strip"
                className="mt-1 flex items-center justify-between rounded-md bg-white/5 px-2 py-1 text-xs text-gray-400 mobile:px-3 mobile:py-2 mobile:text-sm"
              >
                <span>Showing unread only</span>
                <button
                  type="button"
                  onClick={() => view.setUnreadOnly(false)}
                  data-testid="sidebar-unread-show-all"
                  className="font-medium text-gray-300 hover:text-white"
                >
                  Show all
                </button>
              </div>
            )}
            {unreadOnly && sidebarSections.every((section) => section.items.length === 0) && (
              <p data-testid="sidebar-unread-empty" className="px-2 py-3 text-sm text-gray-500">
                You're all caught up.
              </p>
            )}
            {sidebarSections.map((section) => {
              const isUnreadSection = section.key === SidebarSectionKeys.Unread;
              const isFavorites = section.key === SidebarSectionKeys.Favorites;
              const isChannelsDefault = section.key === SidebarSectionKeys.Channels;
              const isDMsDefault = section.key === SidebarSectionKeys.DirectMessages;
              const isUserCategory = !isUnreadSection && !isFavorites && !isChannelsDefault && !isDMsDefault;
              if (isSectionHidden(section, unreadOnly)) return null;
              // Rows in the Unread section belong to other sections, so they
              // aren't reordered from here.
              const rowDragDisabled = dragDisabled || isUnreadSection;
              const canDropChannel = isFavorites || isUserCategory || isChannelsDefault;
              const collapsed = !!collapsedGroups[section.key];
              // An open section stands apart: a wide gap above its heading
              // and above the next heading. Collapsed headings in a row pack
              // tight, like a menu.
              const spaced = spacedSections.has(section.key);
              const visibleItems = collapsed ? foldedSectionItems(section.items, pathname) : section.items;

              // The live channel/DM drop target that falls in THIS section (null
              // otherwise) — drives the push-aside gap below.
              const channelGap =
                dropIndicator?.kind === 'channel' && dropIndicator.sectionKey === section.key
                  ? dropIndicator
                  : null;
              // A category drag that would land BEFORE this section opens a gap
              // above it, pushing this section (and everything below) down — the
              // same WYSIWYG push-aside the channel/DM drag gets.
              const categoryGap =
                dropIndicator?.kind === 'category' &&
                dropIndicator.beforeCategoryID === (isChannelsDefault ? CATEGORY_DROP_END : section.key);

              return (
                <div
                  key={section.key}
                  className={`relative ${spaced ? 'mt-5 mobile:mt-3' : 'mt-2'}`}
                  data-testid={`sidebar-group-${section.key}`}
                >
                  {categoryGap && <SidebarDropGap sectionKey={section.key} testId={`sidebar-drop-gap-cat-${section.key}`} />}
                  {(isFavorites || isUserCategory || isChannelsDefault) && (
                    <PragmaticCategoryDropHitbox
                      active={!dragDisabled && isDraggingCategory}
                      data={{
                        type: 'section-header-target',
                        sectionKey: section.key,
                        categoryID: isChannelsDefault ? CATEGORY_DROP_END : section.key,
                      }}
                      testID={`sidebar-category-boundary-drop-${section.key}`}
                    />
                  )}
                  <PragmaticCategoryHeader
                    id={section.key}
                    draggable={isUserCategory && !dragDisabled}
                    dropData={
                      !dragDisabled && (isFavorites || isUserCategory || isChannelsDefault)
                        ? {
                            type: 'section-header-target',
                            sectionKey: section.key,
                            categoryID: isChannelsDefault ? CATEGORY_DROP_END : section.key,
                          }
                        : undefined
                    }
                    className="group/sec relative flex items-center"
                    testID={`sidebar-group-header-${section.key}`}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleGroupCollapsed(section.key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleGroupCollapsed(section.key);
                        }
                      }}
                      aria-expanded={!collapsed}
                      data-testid={`sidebar-group-toggle-${section.key}`}
                      className="flex flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-gray-400 hover:bg-white/5 mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                      />
                      <span className="truncate">{section.title}</span>
                    </div>
                    {/* Hover-revealed actions per section type; always shown
                        (and finger-sized) on touch devices, which have no hover. */}
                    {isChannelsDefault && !isGuest(user?.systemRole) && (
                      <button
                        onClick={() => setCreateChannelOpen(true)}
                        aria-label="Create channel"
                        title="Create channel"
                        data-testid="sidebar-create-channel"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white touch:h-7 touch:w-7 touch:opacity-100 mobile:h-10 mobile:w-10"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {isDMsDefault && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                        {/* New DM "+": always a real tap target on mobile;
                            desktop keeps the hover-reveal. Close the mobile
                            drawer like every other sidebar navigation — leaving
                            it latched open kept the new page translated
                            off-screen (and its autofocused input then dragged
                            the overflow-hidden shell into a garbled state). */}
                        <button
                          onClick={() => {
                            navigate('/conversations/new');
                            onClose();
                          }}
                          aria-label="New direct message"
                          title="New direct message"
                          data-testid="sidebar-new-dm"
                          className="h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white touch:h-7 touch:w-7 touch:opacity-100 mobile:h-10 mobile:w-10"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        {/* Sort menu stays desktop hover-only (hidden on mobile);
                            the header shows only the "+" on touch. mobile:hidden
                            (not just opacity/pointer-events) so it also leaves
                            the flex layout — an invisible 20px slot here pushed
                            the "+" left, out of line with the Channels "+". */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label="Sort direct messages"
                            data-testid="sidebar-dm-sort-menu"
                            className="h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white touch:h-7 touch:w-7 touch:opacity-100 mobile:hidden"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onClick={() => view.setConversationSort('recent')}>
                              <Clock3 className="mr-2 h-4 w-4" />
                              Recent activity
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => view.setConversationSort('az')}>
                              <ArrowDownAZ className="mr-2 h-4 w-4" />
                              A-Z
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                    {isUserCategory && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Manage ${section.title} category`}
                          data-testid={`sidebar-category-menu-${section.key}`}
                          className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white touch:h-7 touch:w-7 touch:opacity-100 mobile:h-10 mobile:w-10"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onClick={() => setCategoryToDelete({ id: section.key, title: section.title })}
                            data-testid={`sidebar-category-delete-${section.key}`}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete category
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </PragmaticCategoryHeader>
                  <div className="mt-1 space-y-1">
                    {visibleItems.map((item, index) => {
                      if (item.kind === 'channel') {
                        const channelDropIndex = section.key === SidebarSectionKeys.Favorites
                          ? index
                          : visibleItems
                              .slice(0, index)
                              .filter((candidate) => candidate.kind === 'channel').length;
                        // Open the push-aside gap just above this row when the
                        // live drop target resolves to its slot (not the tail).
                        const showGap =
                          channelGap != null && channelGap.area !== 'end' && channelGap.index === channelDropIndex;
                        return (
                          // No wrapper div: the ChannelRow's own element is the
                          // direct `space-y-1` child (and already `relative`), so
                          // SIDEBAR_DRAGGING_COLLAPSE can fully remove its slot on
                          // pick-up (margin included).
                          <Fragment key={`ch-${item.channel.channelID}`}>
                            {showGap && <SidebarDropGap sectionKey={section.key} />}
                            <PragmaticChannelRow
                              sectionKey={section.key}
                              index={channelDropIndex}
                              channel={item.channel}
                              disabled={rowDragDisabled}
                            >
                              {(dragProps) => (
                                <ChannelRow
                                  channel={item.channel}
                                  hasUnread={!!item.channel.unread}
                                  notifyCount={Number(item.channel.unreadNotifyCount ?? 0)}
                                  onClose={onClose}
                                  draggable={!rowDragDisabled}
                                  suppressNavigation={suppressedNavigationID === item.channel.channelID}
                                  onSuppressNavigationConsumed={clearSuppressedNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticChannelRow>
                          </Fragment>
                        );
                      }
                      const conv = item.conversation;
                      const conversationDropIndex = section.key === SidebarSectionKeys.Favorites ? index : -1;
                      const otherID = conv.type !== 'group' ? dmPartnerID(conv, user?.id) : undefined;
                      const dmAvatarURL = otherID ? dmUserMap.get(otherID)?.avatarURL : undefined;
                      const dmUserStatus = otherID ? dmUserMap.get(otherID)?.userStatus : undefined;
                      const resolvedDMAvatarURL = conv.avatarURL ?? dmAvatarURL;
                      const resolvedDMUserStatus = conv.userStatus ?? dmUserStatus;
                      // Favorited DMs are channel-drop targets too; open the gap
                      // above one when the live target resolves to its slot.
                      const showConvGap =
                        channelGap != null && channelGap.area !== 'end' && channelGap.index === conversationDropIndex;
                      return (
                        // No wrapper div (see the channel branch): the row's own
                        // element is the direct `space-y-1` child so a favorited
                        // DM's slot collapses fully on pick-up.
                        <Fragment key={`conv-${conv.conversationID}`}>
                          {showConvGap && <SidebarDropGap sectionKey={section.key} />}
                          {section.key === SidebarSectionKeys.Favorites ? (
                            <PragmaticConversationRow
                              sectionKey={section.key}
                              index={conversationDropIndex}
                              conversation={conv}
                              disabled={dragDisabled}
                            >
                              {(dragProps) => (
                                <ConversationRow
                                  conversation={conv}
                                  hasUnread={!!conv.unread}
                                  notifyCount={Number(conv.unreadNotifyCount ?? 0)}
                                  dmAvatarURL={resolvedDMAvatarURL}
                                  dmUserStatus={resolvedDMUserStatus}
                                  dmUserID={otherID}
                                  onClose={onClose}
                                  onHide={hideConversation}
                                  draggable={!dragDisabled}
                                  suppressNavigation={suppressedNavigationID === conv.conversationID}
                                  onSuppressNavigationConsumed={clearSuppressedNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticConversationRow>
                          ) : (
                            <ConversationRow
                              conversation={conv}
                              hasUnread={!!conv.unread}
                              notifyCount={Number(conv.unreadNotifyCount ?? 0)}
                              dmAvatarURL={resolvedDMAvatarURL}
                              dmUserStatus={resolvedDMUserStatus}
                              dmUserID={otherID}
                              onClose={onClose}
                              onHide={hideConversation}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                    {/* Tail gap: drop resolves past the last row (area 'end'). */}
                    {channelGap != null && channelGap.area === 'end' && <SidebarDropGap sectionKey={section.key} />}
                  </div>
                  <PragmaticSection
                    data={{ type: 'channel-target', sectionKey: section.key, index: dropCount(section.key, visibleItems), area: 'end' }}
                    disabled={!canDropChannel}
                    className="min-h-2 pb-2"
                    testID={canDropChannel ? `sidebar-section-tail-drop-${section.key}` : undefined}
                  >
                    {/* Land-in-place: no drop line. The row itself re-sorts to
                        its released slot via the optimistic reorder cache. */}
                  </PragmaticSection>
                </div>
              );
            })}
            {archivedChannels.length > 0 && !unreadOnly && (
              <SidebarArchivedSection
                channels={archivedChannels}
                open={archivedOpen}
                onToggle={() => setArchivedOpen((open) => !open)}
                onClose={onClose}
              />
            )}
          </nav>
          ) : (
            <SidebarSectionsSkeleton />
          )}
        </div>
      </ScrollArea>

      {/* Dialogs */}
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
      />
      <DeleteCategoryDialog category={categoryToDelete} onClose={() => setCategoryToDelete(null)} />
    </div>
  );
}
