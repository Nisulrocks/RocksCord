/**
 * Voice support routes.
 *
 *   GET  /api/voice/ice-servers          ICE configuration for the WebRTC peer connections
 *   GET  /api/voice/channels/:channelId  who is currently in a voice channel
 *
 * The actual call is peer-to-peer: audio and video never touch this server, only the
 * signalling does (see `realtime/voice.ts`). That is what makes voice free to operate --
 * an SFU would need an always-on server with real bandwidth.
 *
 * STUN is enough for most home networks. A TURN relay is only needed behind symmetric
 * NAT or restrictive corporate firewalls, so it is optional and read from configuration.
 */

import type { FastifyInstance } from 'fastify';
import { DEFAULT_ICE_SERVERS, LIMITS, Permission } from '@rockscord/shared';
import { env } from '../env.js';
import { assertChannelPermission, getChannelPermissionContext } from '../lib/permissions.js';
import { getVoiceParticipants } from '../realtime/voice.js';

export default async function voiceRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.addHook('preHandler', app.authenticate);

  app.get('/ice-servers', async () => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> =
      DEFAULT_ICE_SERVERS.map((server) => ({ urls: server.urls }));

    if (env.TURN_URL) {
      iceServers.push({
        urls: env.TURN_URL,
        username: env.TURN_USERNAME,
        credential: env.TURN_CREDENTIAL,
      });
    }

    return {
      iceServers,
      /** Clients show a warning past this many peers, where a full mesh gets expensive. */
      softCap: LIMITS.VOICE_CHANNEL_SOFT_CAP,
      hasTurn: Boolean(env.TURN_URL),
    };
  });

  app.get('/channels/:channelId', async (request) => {
    const { channelId } = request.params as { channelId: string };

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');

    return { participants: await getVoiceParticipants(db, channelId) };
  });
}
