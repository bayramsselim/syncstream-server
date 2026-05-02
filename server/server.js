const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, uptime: process.uptime() }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SyncStream Pro Server');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

const MAX_ROOM_SIZE  = 10;
const MAX_MSG_PER_S  = 20;   // rate limit: messages per second per connection
const MAX_JOIN_TRIES = 8;    // brute-force: max failed join attempts per connection

function randomId()    { return Math.random().toString(36).substring(2, 9); }
function randomColor() { return `hsl(${Math.floor(Math.random() * 360)},70%,75%)`; }
function randomRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

wss.on('connection', (ws) => {
    ws.id          = randomId();
    ws.color       = randomColor();
    ws.roomId      = null;
    ws.username    = null;
    ws.isInCall    = false;
    ws.isAway      = false;
    ws.msgCount    = 0;
    ws.joinTries   = 0;

    // Reset rate-limit counter every second
    const rateLimitTimer = setInterval(() => { ws.msgCount = 0; }, 1000);

    ws.on('message', (raw) => {
        // ── Rate limit ────────────────────────────────────────────────────────
        ws.msgCount++;
        if (ws.msgCount > MAX_MSG_PER_S) return;

        let data;
        try { data = JSON.parse(raw); } catch { return; }

        // ── CREATE_ROOM ───────────────────────────────────────────────────────
        if (data.type === 'CREATE_ROOM') {
            if (ws.roomId) return; // already in a room
            const roomId    = randomRoomId();
            ws.roomId       = roomId;
            ws.username     = (data.username || 'Host').substring(0, 24);
            rooms.set(roomId, {
                host:            ws.id,
                clients:         new Set([ws]),
                hostControlOnly: false,
                nowPlaying:      'Waiting for video...'
            });
            broadcastRoomUpdate(roomId);
        }

        // ── JOIN_ROOM ─────────────────────────────────────────────────────────
        else if (data.type === 'JOIN_ROOM') {
            if (ws.joinTries >= MAX_JOIN_TRIES) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Too many attempts. Please reconnect.' }));
                return;
            }
            const roomId = (data.roomId || '').trim().toUpperCase();
            if (!rooms.has(roomId)) {
                ws.joinTries++;
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found.' }));
                return;
            }
            const room = rooms.get(roomId);
            if (room.clients.size >= MAX_ROOM_SIZE) {
                ws.send(JSON.stringify({ type: 'ERROR', message: `Room is full (max ${MAX_ROOM_SIZE} users).` }));
                return;
            }
            ws.roomId   = roomId;
            ws.username = (data.username || 'Guest').substring(0, 24);
            room.clients.add(ws);
            broadcastRoomUpdate(roomId);
            broadcastToRoom(roomId, { type: 'TOAST', message: `${ws.username} joined!`, color: ws.color }, null);
        }

        // ── LEAVE_ROOM ────────────────────────────────────────────────────────
        else if (data.type === 'LEAVE_ROOM') {
            handleLeave(ws);
        }

        // ── Room-scoped messages ──────────────────────────────────────────────
        else if (ws.roomId && rooms.has(ws.roomId)) {

            if (data.type === 'PLAYER_EVENT') {
                const room = rooms.get(ws.roomId);
                if (room.hostControlOnly && ws.id !== room.host) return;
                broadcastToRoom(ws.roomId, {
                    type: 'SYNC_STATE', event: data.event,
                    time: data.time, playbackRate: data.playbackRate,
                    byUsername: ws.username
                }, ws);
            }

            else if (data.type === 'CHAT_MESSAGE') {
                const text = (data.text || '').substring(0, 500); // max message length
                broadcastToRoom(ws.roomId, { type: 'CHAT_MESSAGE', username: ws.username, color: ws.color, text }, null);
            }

            else if (data.type === 'REACTION') {
                broadcastToRoom(ws.roomId, { type: 'REACTION', username: ws.username, emoji: data.emoji }, null);
            }

            else if (data.type === 'SIGNALING') {
                const room   = rooms.get(ws.roomId);
                const target = Array.from(room.clients).find(c => c.id === data.targetId);
                if (target?.readyState === 1) {
                    target.send(JSON.stringify({ type: 'SIGNALING', fromId: ws.id, fromUsername: ws.username, payload: data.payload }));
                }
            }

            else if (data.type === 'TOGGLE_HOST_CONTROL') {
                const room = rooms.get(ws.roomId);
                if (ws.id !== room.host) return;
                room.hostControlOnly = !!data.value;
                broadcastRoomUpdate(ws.roomId);
            }

            else if (data.type === 'TOGGLE_CALL') {
                ws.isInCall = !!data.enabled;
                broadcastRoomUpdate(ws.roomId);
            }

            else if (data.type === 'USER_STATUS') {
                ws.isAway = !!data.away;
                broadcastRoomUpdate(ws.roomId);
            }

            else if (data.type === 'HOST_NAVIGATE') {
                const room = rooms.get(ws.roomId);
                if (room.hostControlOnly && ws.id !== room.host) return;
                const url   = (data.url   || '').substring(0, 2000);
                const title = (data.title || '').substring(0, 200);
                broadcastToRoom(ws.roomId, { type: 'HOST_NAVIGATE', url, title, username: ws.username }, ws);
            }

            else if (data.type === 'UPDATE_NOW_PLAYING') {
                const room = rooms.get(ws.roomId);
                room.nowPlaying    = (data.title || '').substring(0, 200);
                room.nowPlayingUrl = (data.url   || '').substring(0, 500);
                broadcastToRoom(ws.roomId, { type: 'NOW_PLAYING', title: room.nowPlaying, url: room.nowPlayingUrl }, null);
            }
        }
    });

    ws.on('close', () => { clearInterval(rateLimitTimer); handleLeave(ws); });
    ws.on('error', () => { clearInterval(rateLimitTimer); handleLeave(ws); });
});

function handleLeave(ws) {
    if (!ws.roomId || !rooms.has(ws.roomId)) return;
    const room = rooms.get(ws.roomId);
    room.clients.delete(ws);
    if (room.clients.size === 0) {
        rooms.delete(ws.roomId);
    } else {
        if (room.host === ws.id) room.host = Array.from(room.clients)[0].id;
        broadcastRoomUpdate(ws.roomId);
    }
    ws.roomId = null;
}

function broadcastRoomUpdate(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const users = Array.from(room.clients).map(c => ({
        id: c.id, username: c.username, color: c.color,
        isHost: c.id === room.host, isInCall: c.isInCall || false, isAway: c.isAway || false
    }));
    broadcastToRoom(roomId, {
        type: 'ROOM_UPDATE', roomId,
        users, hostControlOnly: room.hostControlOnly,
        nowPlaying: room.nowPlaying, nowPlayingUrl: room.nowPlayingUrl || ''
    }, null);
}

function broadcastToRoom(roomId, msgObj, excludeWs) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify(msgObj);
    room.clients.forEach(c => { if (c !== excludeWs && c.readyState === 1) c.send(msg); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SyncStream Pro :${PORT}`));
