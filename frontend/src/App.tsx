import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
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
import DirectoriesPage from '@/pages/DirectoriesPage';
import AdminPage from '@/pages/AdminPage';
import IncomingWebhooksPage from '@/pages/IncomingWebhooksPage';
import CustomEmojiPage from '@/pages/CustomEmojiPage';
import NewConversationPage from '@/pages/NewConversationPage';
import ThreadsPage from '@/pages/ThreadsPage';
import DraftsPage from '@/pages/DraftsPage';
import ActivityPage from '@/pages/ActivityPage';
import SearchResultsPage from '@/pages/SearchResultsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { GENERAL_CHANNEL_SLUG } from '@/lib/roles';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useServerVersion } from '@/hooks/useServerVersion';
import type { ReactNode } from 'react';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div
        className="min-h-dvh bg-sidebar dark:bg-sidebar"
        aria-label="Loading chat"
        data-testid="app-auth-loading"
      />
    );
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
                            <AppRoutes />
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
