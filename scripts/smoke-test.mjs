/**
 * End-to-end smoke test against a *running* server.
 *
 *   npm run smoke            (server must already be running on :4000)
 *   npm run smoke -- http://192.168.1.20:4000   (test another machine)
 *
 * Unlike the Vitest suite, this drives the real HTTP + WebSocket stack the way a browser
 * does: two users log in, both open sockets, one sends a message, and the other must
 * receive it live. It is the fastest way to confirm a deployment actually works.
 *
 * Requires the seed accounts (`npm run db:seed`).
 */
import { io } from 'socket.io-client';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const API = `${BASE}/api`;

async function login(identifier) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: 'password123' }),
  });
  if (!res.ok) throw new Error(`login ${identifier}: ${res.status} ${await res.text()}`);
  return res.json();
}

function connect(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error(`${label}: no ready within 10s`)), 10000);
    socket.on('ready', (payload) => {
      clearTimeout(timer);
      resolve({ socket, ready: payload });
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${err.message}`));
    });
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const alex = await login('alex@rockscord.test');
const nova = await login('nova@rockscord.test');
check('both users log in', true, `${alex.user.username} + ${nova.user.username}`);

const a = await connect(alex.accessToken, 'alex');
const n = await connect(nova.accessToken, 'nova');
check('both sockets receive ready', true,
  `alex sees ${a.ready.servers.length} server(s), ${a.ready.channels.length} channel(s)`);

const general = a.ready.channels.find((c) => c.name === 'general');
check('general channel present in ready payload', Boolean(general), general?.id);

// Presence: nova connected after alex, so alex should have been told nova came online.
const presenceSeen = new Promise((resolve) => {
  a.socket.on('presence:update', (p) => { if (p.userId === nova.user.id) resolve(p); });
});

a.socket.emit('channel:subscribe', { channelId: general.id });
n.socket.emit('channel:subscribe', { channelId: general.id });
await new Promise((r) => setTimeout(r, 400));

// Typing indicator: alex types, nova should see it.
const typingSeen = new Promise((resolve) => n.socket.on('typing:start', resolve));
a.socket.emit('typing:start', { channelId: general.id });

// Message: alex sends over REST, nova should receive over socket.
const messageSeen = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('nova did not receive the message in 8s')), 8000);
  n.socket.on('message:create', (m) => { clearTimeout(timer); resolve(m); });
});

const body = `realtime probe ${Date.now()}`;
const sendRes = await fetch(`${API}/channels/${general.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alex.accessToken}` },
  body: JSON.stringify({ content: body }),
});
const sent = await sendRes.json();
check('message accepted by API', sendRes.status === 201, `status ${sendRes.status}`);

const received = await messageSeen;
check('nova receives the message in real time', received.content === body, received.content);
check('message id matches what the sender got', received.id === sent.message.id, received.id);

const typing = await Promise.race([typingSeen, new Promise((r) => setTimeout(() => r(null), 3000))]);
check('typing indicator delivered', typing?.userId === alex.user.id, typing ? typing.username : 'timeout');

const presence = await Promise.race([presenceSeen, new Promise((r) => setTimeout(() => r(null), 3000))]);
check('presence update delivered', presence?.status === 'online', presence ? presence.status : 'timeout');

// Edit + delete propagate.
const editSeen = new Promise((r) => n.socket.on('message:update', r));
await fetch(`${API}/channels/${general.id}/messages/${sent.message.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alex.accessToken}` },
  body: JSON.stringify({ content: 'edited by probe' }),
});
const edited = await Promise.race([editSeen, new Promise((r) => setTimeout(() => r(null), 3000))]);
check('edit propagates', edited?.message?.content === 'edited by probe', edited?.message?.content);

// Nova must not be able to delete alex's message (she is a Moderator, so she actually can --
// verify a plain member cannot instead).
const kit = await login('kit@rockscord.test');
const kitDelete = await fetch(`${API}/channels/${general.id}/messages/${sent.message.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${kit.accessToken}` },
});
check('plain member cannot delete another user\'s message', kitDelete.status === 403,
  `status ${kitDelete.status}`);

// Moderator (nova) can.
const novaDelete = await fetch(`${API}/channels/${general.id}/messages/${sent.message.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${nova.accessToken}` },
});
check('moderator can delete it', novaDelete.status === 200, `status ${novaDelete.status}`);

a.socket.close();
n.socket.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
