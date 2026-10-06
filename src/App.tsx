import { Route, Routes } from 'react-router';
import { ThemeProvider } from 'next-themes';
import { Analytics } from '@vercel/analytics/react';
import LoginView from '@/components/auth/LoginView';
import RequireAuth from '@/components/auth/RequireAuth';
import ResetPasswordView from '@/components/auth/ResetPasswordView';
import ChatView from '@/components/chat/ChatView';
import AppShell from '@/components/layout/AppShell';
import SettingsView from '@/components/settings/SettingsView';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/hooks/useAuth';
import { ConversationsProvider } from '@/hooks/useConversations';

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AuthProvider>
        <ConversationsProvider>
          <Routes>
            <Route path="/login" element={<LoginView />} />
            <Route path="/reset-password" element={<ResetPasswordView />} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<ChatView />} />
              <Route path="c/:conversationId" element={<ChatView />} />
              <Route path="settings" element={<SettingsView />} />
              <Route path="*" element={<ChatView />} />
            </Route>
          </Routes>
        </ConversationsProvider>
        <Toaster position="top-center" richColors />
        {import.meta.env.PROD && <Analytics />}
      </AuthProvider>
    </ThemeProvider>
  );
}
