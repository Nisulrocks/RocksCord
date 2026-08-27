/**
 * HTTP client.
 *
 * Two things here are worth reading carefully:
 *
 * 1. **The access token lives in a module variable, never in localStorage.** Anything in
 *    localStorage is readable by any script that runs on the page, so a single XSS would
 *    hand over a long-lived credential. The refresh token is in an httpOnly cookie the
 *    page cannot read at all, and the access token dies with the tab.
 *
 * 2. **Refresh is single-flight.** When an access token expires, several in-flight
 *    requests will 401 at once. Without coordination each would trigger its own refresh,
 *    and since refresh tokens rotate, the second one would present an already-revoked
 *    token -- which the server correctly treats as theft and responds to by killing every
 *    session. So all callers await one shared refresh promise and then retry.
 */

import type { ApiErrorBody } from '@rockscord/shared';

/**
 * Same-origin by default: in development Vite proxies `/api` to the server, and in
 * production the server serves the client. `VITE_API_URL` overrides this for the desktop
 * app or a split deployment.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

/** Called when refresh fails, so the app can drop to the login screen. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.details = body?.error?.details;
  }

  /** First validation message for a field, for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0];
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic refresh-and-retry. Used by the auth calls themselves. */
  skipRefresh?: boolean;
  /** Send a FormData body untouched (file uploads). */
  formData?: FormData;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Exchange the refresh cookie for a new access token.
 * Concurrent callers share one request; see the note at the top of this file.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      // No Content-Type header here, deliberately: the refresh token travels in the
      // cookie, so there is no body. Declaring `application/json` with an empty body
      // makes Fastify reject the request as malformed before it reaches the route.
      const response = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { accessToken?: string };
      if (!data.accessToken) return false;
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so late callers still see the settled promise.
      queueMicrotask(() => {
        refreshPromise = null;
      });
    }
  })();

  return refreshPromise;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers = new Headers(options.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

    let body: BodyInit | undefined;
    if (options.formData) {
      // Do not set Content-Type: the browser must add the multipart boundary itself.
      body = options.formData;
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }

    return fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      headers,
      body,
      credentials: 'include',
    });
  };

  let response = await send();

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await send();
    } else {
      onUnauthorized();
      throw new ApiClientError(401, (await parseBody(response)) as ApiErrorBody, 'Signed out');
    }
  }

  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      (await parseBody(response)) as ApiErrorBody | null,
      `Request failed with ${response.status}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await parseBody(response)) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
  upload: <T>(path: string, formData: FormData) =>
    request<T>('POST', path, { formData }),
};

/** Turn a relative upload path into an absolute URL when the API is on another origin. */
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}
