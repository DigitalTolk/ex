import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { queryClient } from '@/lib/query-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { NotificationCountTitleBridge } from '@/components/NotificationCountTitleBridge';
import { Toaster } from '@/components/Toaster';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { InAppLinkRouter } from '@/components/InAppLinkRouter';
import LoginPage from '@/pages/LoginPage';
import OIDCCallbackPage from '@/pages/OIDCCallbackPage';
import ChatPage from '@/pages/ChatPage';
import { ChannelView } from '@/components/chat/ChannelView';
import { ConversationView } from '@/components/chat/ConversationView';
import { GENERAL_CHANNEL_SLUG } from '@/lib/roles';
import { removeBootSplash } from '@/lib/boot-splash';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useServerVersion } from '@/hooks/useServerVersion';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

// Cold routes are code-split with React.lazy so their code (and any deps
// only they use) stays out of the initial bundle. The boot/hot path stays
// eager on purpose: LoginPage + OIDCCallbackPage carry the sign-in flow and
// ChatPage/ChannelView/ConversationView are where every session lands —
// lazy-loading those would just add a fallback flash after auth.
const DirectoriesPage = lazy(() => import('@/pages/DirectoriesPage'));
const AdminPage = lazy(() => import('@/pages/AdminPage'));
const IncomingWebhooksPage = lazy(() => import('@/pages/IncomingWebhooksPage'));
const CustomEmojiPage = lazy(() => import('@/pages/CustomEmojiPage'));
const NewConversationPage = lazy(() => import('@/pages/NewConversationPage'));
const ThreadsPage = lazy(() => import('@/pages/ThreadsPage'));
const DraftsPage = lazy(() => import('@/pages/DraftsPage'));
const ActivityPage = lazy(() => import('@/pages/ActivityPage'));
const SearchResultsPage = lazy(() => import('@/pages/SearchResultsPage'));
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

// How long the boot spinner runs before admitting the connection is slow and
// offering the sign-in escape hatch. Auth restore retries with backoff behind
// this screen, so the hint is honest: we ARE still trying.
const SLOW_CONNECT_HINT_MS = 5_000;

// Shown while the session restore is in flight. This used to be an empty div,
// which read as a dead blank app whenever the restore request stalled on a
// flaky connection — always give the user signal and an exit.
function AuthLoadingScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_CONNECT_HINT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-sidebar dark:bg-sidebar"
      role="status"
      aria-label="Loading chat"
      data-testid="app-auth-loading"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">Connecting…</p>
      {slow && (
        <div className="flex flex-col items-center gap-3 pt-2" data-testid="app-auth-loading-slow">
          <p className="text-xs text-muted-foreground">
            Still trying to reach the server. We&apos;ll keep retrying.
          </p>
          <Link
            to="/login"
            className="text-xs font-medium text-foreground underline underline-offset-2"
          >
            Go to sign-in
          </Link>
        </div>
      )}
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function ChatHomeRoute() {
  const isMobile = useIsMobile();
  if (!isMobile) return <Navigate to={`/channel/${GENERAL_CHANNEL_SLUG}`} replace />;
  return <div className="hidden" data-testid="mobile-channel-home" aria-hidden="true" />;
}

function ServerVersionBootstrap() {
  useServerVersion();
  return null;
}

// RoutedErrorBoundary keys the boundary on the current path so navigating to a
// different route clears a latched render error (in-app recovery, no hard reload).
function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<LoginPage />} />
      <Route path="/oidc/callback" element={<OIDCCallbackPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={<ChatHomeRoute />}
        />
        <Route path="directory" element={<Navigate to="/directory/channels" replace />} />
        <Route path="directory/:section" element={<DirectoriesPage />} />
        <Route path="search" element={<SearchResultsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="threads" element={<ThreadsPage />} />
        <Route path="drafts" element={<DraftsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="webhooks" element={<IncomingWebhooksPage />} />
        <Route path="emojis" element={<CustomEmojiPage />} />
        <Route path="channel/:id" element={<ChannelView />} />
        <Route path="conversations/new" element={<NewConversationPage />} />
        <Route path="conversation/:id" element={<ConversationView />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App() {
  // First React commit: dismiss the pre-bundle boot splash from index.html.
  // From here on the in-app loading states (AuthLoadingScreen) own the screen.
  useEffect(() => {
    removeBootSplash();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <InAppLinkRouter />
        <ThemeProvider>
          <AuthProvider>
            <UnreadProvider>
              <PresenceProvider>
                <NotificationProvider>
                  <TypingProvider>
                    <TooltipProvider>
                      <ServerVersionBootstrap />
                      <NotificationCountTitleBridge />
                      <Toaster />
                      <div className="flex h-dvh flex-col bg-sidebar pt-safe-top">
                        <div className="min-h-0 flex-1 bg-background">
                          <RoutedErrorBoundary>
                            {/* Fallback for lazy route chunks. Inside the
                                error boundary so a failed chunk fetch (stale
                                deploy) latches a recoverable error screen
                                instead of a blank page. */}
                            <Suspense
                              fallback={
                                <div
                                  className="flex h-full items-center justify-center"
                                  role="status"
                                  aria-label="Loading page"
                                  data-testid="route-loading"
                                >
                                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                                </div>
                              }
                            >
                              <AppRoutes />
                            </Suspense>
                          </RoutedErrorBoundary>
                        </div>
                      </div>
                    </TooltipProvider>
                  </TypingProvider>
                </NotificationProvider>
              </PresenceProvider>
            </UnreadProvider>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
