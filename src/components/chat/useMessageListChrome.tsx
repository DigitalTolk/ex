import { useMemo, type ReactNode } from 'react';

// The list's Virtuoso Header (the chat intro, or the older-page loader) and
// Footer (the newer-page loader of a link-opened window). Memoized so the
// COMPONENT identities only change when their inputs do — defining them
// inline gave a fresh function every render, which react-virtuoso treats as a
// new component type and unmounts + remounts the header/footer subtree on
// every unrelated parent re-render (e.g. a WS message landing elsewhere),
// flickering the loading indicators.
export function useMessageListChrome({
  intro,
  hasNextPage,
  isFetchingNextPage,
  hasPreviousPage,
  isFetchingPreviousPage,
}: {
  intro?: ReactNode;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  hasPreviousPage?: boolean;
  isFetchingPreviousPage?: boolean;
}) {
  const Header = useMemo(() => {
    const Cmp = () => (
      <>
        {intro && !hasNextPage ? <div className="mx-auto w-full max-w-4xl px-4 pt-2 mobile:px-3">{intro}</div> : null}
        {hasNextPage ? (
          <div
            data-testid="message-list-load-more"
            className="flex h-8 items-center justify-center text-xs text-muted-foreground"
          >
            {isFetchingNextPage ? 'Loading earlier messages…' : ''}
          </div>
        ) : null}
      </>
    );
    return Cmp;
  }, [intro, hasNextPage, isFetchingNextPage]);

  const Footer = useMemo(() => {
    const Cmp = () =>
      hasPreviousPage ? (
        <div
          data-testid="message-list-load-newer"
          className="flex h-8 items-center justify-center text-xs text-muted-foreground"
        >
          {isFetchingPreviousPage ? 'Loading newer messages…' : ''}
        </div>
      ) : null;
    return Cmp;
  }, [hasPreviousPage, isFetchingPreviousPage]);

  return { Header, Footer };
}
