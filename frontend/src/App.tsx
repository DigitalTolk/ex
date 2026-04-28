import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { UpdateBanner } from '@/components/UpdateBanner';
import { Toaster } from '@/components/ui/sonner';
import LoginPage from '@/pages/LoginPage';
import OIDCCallbackPage from '@/pages/OIDCCallbackPage';
import ChatPage from '@/pages/ChatPage';
import { ChannelView } from '@/components/chat/ChannelView';
import { ConversationView } from '@/components/chat/ConversationView';
import DirectoriesPage from '@/pages/DirectoriesPage';
import AdminPage from '@/pages/AdminPage';
import NewConversationPage from '@/pages/NewConversationPage';
import ThreadsPage from '@/pages/ThreadsPage';
import type { ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
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
          element={
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              Select a channel or conversation to start chatting
            </div>
          }
        />
        <Route path="directory" element={<DirectoriesPage />} />
        <Route path="threads" element={<ThreadsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="channel/:id" element={<ChannelView />} />
        <Route path="conversations/new" element={<NewConversationPage />} />
        <Route path="conversation/:id" element={<ConversationView />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <UnreadProvider>
              <PresenceProvider>
                <NotificationProvider>
                  <TypingProvider>
                    <TooltipProvider>
                      {/* h-dvh + flex-col viewport constraint so the
                          UpdateBanner sits as a normal block above the
                          app and never has to overlay scrolling content. */}
                      <div className="flex h-dvh flex-col">
                        <UpdateBanner />
                        <div className="min-h-0 flex-1">
                          <AppRoutes />
                        </div>
                      </div>
                      <Toaster position="top-right" richColors />
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
