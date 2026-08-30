/**
 * Root component: decides between the auth screen and the app shell, and mounts the
 * global overlays plus the handful of app-wide side effects.
 */

import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useAppStore } from './store/useAppStore';
import { onDesktopNavigate } from './lib/desktop';
import { AuthPage } from './pages/AuthPage';
import { AppShell } from './pages/AppShell';
import { InvitePage } from './pages/InvitePage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ContextMenu, Toasts } from './components/ui/Overlays';
import { ModalHost } from './components/modals/ModalHost';
import { WelcomeModal, markWelcomed, shouldWelcome } from './components/modals/WelcomeModal';
import { ProfileCard } from './components/ProfileCard';
import { Spinner } from './components/ui/primitives';

export function App() {
  const { phase, login, register, logout } = useAuth();
  const pruneTyping = useAppStore((s) => s.pruneTyping);
  const user = useAppStore((s) => s.user);
  const navigate = useNavigate();

  /**
   * Typing indicators expire on a timer rather than on an event, because the "stopped
   * typing" case has no event -- someone can simply walk away. One shared interval for
   * the whole app is far cheaper than a timeout per indicator.
   */
  useEffect(() => {
    const interval = window.setInterval(pruneTyping, 1500);
    return () => window.clearInterval(interval);
  }, [pruneTyping]);

  /**
   * Deep links from the desktop shell, currently `rockscord://invite/CODE`.
   *
   * Routed rather than loaded: navigating with the router keeps the socket, the session,
   * and everything already open, where a full page load would tear all of it down to
   * arrive at the same place.
   *
   * A no-op in a browser and in older shells, so this is safe to run unconditionally.
   */
  useEffect(() => onDesktopNavigate((path) => navigate(path)), [navigate]);

  /*
   * Show the developer's note once per account.
   *
   * Keyed on the user rather than the device, so a second person signing in on the same
   * machine is greeted rather than skipped. Deciding on `user.id` also means it waits for
   * the session to resolve, which is what keeps it from flashing over the login form.
   */
  const [welcoming, setWelcoming] = useState(false);
  useEffect(() => {
    if (phase !== 'signed-in' || !user) return;
    if (shouldWelcome(user.id)) setWelcoming(true);
  }, [phase, user]);

  const dismissWelcome = () => {
    if (user) markWelcomed(user.id);
    setWelcoming(false);
  };

  if (phase === 'checking') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-2">
        <div className="flex flex-col items-center gap-3 text-ink-faint">
          <Spinner size={26} />
          <span className="text-sm">Restoring your session…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <Routes>
        {/* An invite link works signed out: it shows the preview and then the login form. */}
        <Route path="/invite/:code" element={<InvitePage signedIn={phase === 'signed-in'} />} />

        {/*
         * Outside the signed-in branch, like invites, because a reset link is often
         * opened on the device that is still signed in -- which is exactly the case where
         * someone is trying to lock an intruder out. Sent to `/friends` instead, it would
         * appear to do nothing.
         */}
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {phase === 'signed-in' ? (
          <>
            <Route path="/channels/:serverId/:channelId?" element={<AppShell onLogout={logout} />} />
            <Route path="/dm/:channelId?" element={<AppShell onLogout={logout} />} />
            <Route path="/friends" element={<AppShell onLogout={logout} />} />
            <Route path="*" element={<Navigate to="/friends" replace />} />
          </>
        ) : (
          <>
            <Route path="/login" element={<AuthPage mode="login" onLogin={login} onRegister={register} />} />
            <Route path="/register" element={<AuthPage mode="register" onLogin={login} onRegister={register} />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        )}
      </Routes>

      {welcoming && <WelcomeModal onClose={dismissWelcome} />}
      <ModalHost />
      <ContextMenu />
      <ProfileCard />
      <Toasts />
    </>
  );
}
