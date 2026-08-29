/** Limits enforced on both ends so the client can show counters before the server rejects. */
export const LIMITS = {
  USERNAME_MIN: 2,
  USERNAME_MAX: 32,
  DISPLAY_NAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 128,
  BIO_MAX: 190,
  CUSTOM_STATUS_MAX: 128,
  SERVER_NAME_MIN: 2,
  SERVER_NAME_MAX: 64,
  SERVER_DESCRIPTION_MAX: 256,
  CHANNEL_NAME_MIN: 1,
  CHANNEL_NAME_MAX: 48,
  CHANNEL_TOPIC_MAX: 512,
  ROLE_NAME_MAX: 48,
  NICKNAME_MAX: 32,
  MESSAGE_MAX: 4000,
  MESSAGE_PAGE_SIZE: 50,
  MESSAGE_PAGE_SIZE_MAX: 100,
  SEARCH_QUERY_MIN: 1,
  SEARCH_QUERY_MAX: 100,
  MAX_ATTACHMENTS_PER_MESSAGE: 5,
  /** 8 MB. Chosen to stay comfortably inside free-tier storage and request limits. */
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  /** Beyond this, a WebRTC full mesh starts to strain a typical uplink. */
  VOICE_CHANNEL_SOFT_CAP: 8,

  /**
   * Custom emoji per server.
   *
   * Every member downloads every emoji the first time they open the server, so this is a
   * bandwidth ceiling as much as a product one.
   */
  MAX_EMOJIS_PER_SERVER: 50,
  /** Emoji render at roughly 22px; anything larger is bytes nobody sees. */
  MAX_EMOJI_BYTES: 256 * 1024,
  MAX_SERVERS_PER_USER: 100,
  MAX_CHANNELS_PER_SERVER: 200,
  MAX_ROLES_PER_SERVER: 50,
} as const;

/** File types accepted by the upload endpoint. Anything else is rejected outright. */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
] as const;

export const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

/** Reserved names that would collide with client-side routes or look official. */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'system',
  'everyone',
  'here',
  'me',
  'rockscord',
  'support',
  'moderator',
  'root',
  'null',
  'undefined',
]);

/** STUN servers used for WebRTC. Google's are free, public, and unauthenticated. */
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
] as const;
