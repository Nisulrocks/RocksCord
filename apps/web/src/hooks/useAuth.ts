/**
 * Session lifecycle.
 *
 * On load the app has no access token (it is deliberately never persisted), so it tries
 * to redeem the httpOnly refresh cookie. Success means a silent sign-in; failure means
 * show the login screen. That is what makes a page refresh keep you logged in without
 * putting a long-lived credential anywhere a script can read it.
 *
 * A timer refreshes the token before it expires, so a long-idle tab never has to
 * discover expiry the hard way -- through a failed request in the middle of a send.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelfUser } from '@rockscord/shared';
import {
  api,
  refreshAccessToken,
  setAccessToken,
  setUnauthorizedHandler,
} from '../lib/api';
import { connectSocket, disconnectSocket } from '../lib/socket';
import { useAppStore } from '../store/useAppStore';

interface AuthResponse {
  user: SelfUser;
  accessToken: string;
  expiresIn: number;
}

export type AuthPhase = 'checking' | 'signed-out' | 'signed-in';

/** Refresh this long before expiry, so a slow network still beats the deadline. */
const REFRESH_MARGIN_SECONDS = 90;

export function useAuth() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const reset = useAppStore((s) => s.reset);
  const [phase, setPhase] = useState<AuthPhase>('checking');
  const refreshTimer = useRef<number | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const signOutLocally = useCallback(() => {
    clearRefreshTimer();
    setAccessToken(null);
    disconnectSocket();
    reset();
    setPhase('signed-out');
  }, [clearRefreshTimer, reset]);

  /** Schedule the next silent refresh. */
  const scheduleRefresh = useCallback(
    (expiresInSeconds: number) => {
      clearRefreshTimer();
      const delay = Math.max(30, expiresInSeconds - REFRESH_MARGIN_SECONDS) * 1000;
      refreshTimer.current = window.setTimeout(async () => {
        const ok = await refreshAccessToken();
        if (ok) scheduleRefresh(expiresInSeconds);
        else signOutLocally();
      }, delay);
    },
    [clearRefreshTimer, signOutLocally],
  );

  const establish = useCallback(
    (response: AuthResponse) => {
      setAccessToken(response.accessToken);
      setUser(response.user);
      setPhase('signed-in');
      scheduleRefresh(response.expiresIn);
      connectSocket();
    },
    [setUser, scheduleRefresh],
  );

  /* -------------------------------------------------------------------- */
  /* Bootstrap                                                             */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    // A failed refresh anywhere in the app drops straight to the login screen.
    setUnauthorizedHandler(() => signOutLocally());

    (async () => {
      const refreshed = await refreshAccessToken();
      if (cancelled) return;

      if (!refreshed) {
        setPhase('signed-out');
        return;
      }

      try {
        const { user: me } = await api.get<{ user: SelfUser }>('/api/auth/me');
        if (cancelled) return;
        setUser(me);
        setPhase('signed-in');
        // The server's TTL is authoritative; 15 minutes is its default.
        scheduleRefresh(15 * 60);
        connectSocket();
      } catch {
        if (!cancelled) setPhase('signed-out');
      }
    })();

    return () => {
      cancelled = true;
      clearRefreshTimer();
    };
    // Intentionally runs once: this is the app's boot sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------------------------- */
  /* Actions                                                               */
  /* -------------------------------------------------------------------- */

  const login = useCallback(
    async (identifier: string, password: string) => {
      const response = await api.post<AuthResponse>(
        '/api/auth/login',
        { identifier, password },
        { skipRefresh: true },
      );
      establish(response);
      return response.user;
    },
    [establish],
  );

  const register = useCallback(
    async (input: {
      email: string;
      username: string;
      password: string;
      displayName?: string;
    }) => {
      const response = await api.post<AuthResponse>('/api/auth/register', input, {
        skipRefresh: true,
      });
      establish(response);
      return response.user;
    },
    [establish],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout', undefined, { skipRefresh: true });
    } catch {
      // Even if the request fails, the local session must still end.
    }
    signOutLocally();
  }, [signOutLocally]);

  return { phase, user, login, register, logout };
}
