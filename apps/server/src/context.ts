/**
 * Shared application context and Fastify type augmentation.
 *
 * Routes receive their dependencies through this object instead of importing module
 * singletons. That is what allows the test suite to run each file against its own
 * in-memory database, and the desktop build to boot a second instance in-process without
 * the two fighting over global state.
 */

import type { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@rockscord/shared';
import type { Database } from './db/index.js';

/** Data attached to every authenticated socket. */
export interface SocketData {
  userId: string;
  sessionId: string;
  /** Server ids the user belongs to, cached at handshake for room joins. */
  serverIds: string[];
}

export type Gateway = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface AppContext {
  db: Database;
  /** Set once the realtime gateway is attached; routes emit through it. */
  gateway: Gateway | null;
}

/** The authenticated principal attached to a request by the auth preHandler. */
export interface RequestUser {
  id: string;
  sessionId: string;
  username: string;
  discriminator: string;
  displayName: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared context: database handle and realtime gateway. */
    ctx: AppContext;
    /** preHandler that rejects the request unless a valid access token is present. */
    authenticate: import('fastify').preHandlerHookHandler;
    /** preHandler that populates `request.user` when a token is present, but never rejects. */
    optionalAuth: import('fastify').preHandlerHookHandler;
  }

  interface FastifyRequest {
    /** Populated by `authenticate`. Guaranteed non-null inside guarded routes. */
    user?: RequestUser;
  }
}
