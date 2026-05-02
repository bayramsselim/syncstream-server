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

function randomId()    { return Math.random().toString(36).substring(2, 9); }
function randomColor() { const h = Math.floor(Math.random() * 360); return `hsl(${h},70%,75%)`; }
function randomRoomId(){ return Math.random().toString(36).substring(2, 6).toUpperCase(); }

wss.on('connection', (ws) => {
    ws.id       = randomId();
    ws.color    = randomColor();
    ws.roomId   = null;
    ws.username = null;
    ws.isInCall = false;

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        if (data.type === 'CREATE_ROOM') {
            const roomId = randomRoomId();
            ws.roomId   = roomId;
            ws.username = data.username || 'Host';
            rooms.set(roomId, {
                host:            ws.id,
                clients:         new Set([ws]),
                hostControlOnly: false,
                nowPlaying:      'Waiting for video...'
            });
            broadcastRoomUpdate(roomId);
        }

        else if (data.type === 'JOIN_ROOM') {
            const roomId = (data.roomId || '').trim().toUpperCase();
            if (rooms.has(roomId)) {
                ws.roomId   = roomId;
                ws.username = data.username || 'Guest';
                const room  = rooms.get(roomId);
                room.clients.add(ws);
                broadcastRoomUpdate(roomId);
                broadcastToRoom(roomId, { type: 'TOAST', message: `${ws.username} joined!`, color: ws.color }, null);
            } else {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
            }
        }

        else if (data.type === 'LEAVE_ROOM') {
            handleLeave(ws);
        }

        else if (data.type === 'PLAYER_EVENT') {
            const room = rooms.get(ws.roomId);
            if (!room) return;
            if (room.hostControlOnly && ws.id !== room.host) return;
            // Convert to SYNC_STATE for content.js
            broadcastToRoom(ws.roomId, {
                type:         'SYNC_STATE',
                event:        data.event,
                time:         data.time,
                playbackRate: data.playbackRate,
                byUsername:   ws.username
            }, ws);
        }

        else if (data.type === 'CHAT_MESSAGE') {
            if (!ws.roomId) return;
            broadcastToRoom(ws.roomId, {
                type:     'CHAT_MESSAGE',
                username: ws.username,
                color:    ws.color,
                text:     data.text
            }, null);
        }

        else if (data.type === 'REACTION') {
            if (!ws.roomId) return;
            broadcastToRoom(ws.roomId, { type: 'REACTION', username: ws.username, emoji: data.emoji }, null);
        }

        else if (data.type === 'SIGNALING') {
            const room = rooms.get(ws.roomId);
            if (!room) return;
            const target = Array.from(room.clients).find(c => c.id === data.targetId);
            if (target && target.readyState === 1) {
                target.send(JSON.stringify({
                    type:         'SIGNALING',
                    fromId:       ws.id,
                    fromUsername: ws.username,
                    payload:      data.payload
                }));
            }
        }

        else if (data.type === 'TOGGLE_HOST_CONTROL') {
            const room = rooms.get(ws.roomId);
            if (!room || ws.id !== room.host) return;
            room.hostControlOnly = !!data.value;
            broadcastRoomUpdate(ws.roomId);
        }

        else if (data.type === 'TOGGLE_CALL') {
            ws.isInCall = !!data.enabled;
            if (ws.roomId) broadcastRoomUpdate(ws.roomId);
        }

        else if (data.type === 'UPDATE_NOW_PLAYING') {
            const room = rooms.get(ws.roomId);
            if (!room) return;
            room.nowPlaying = data.title;
            broadcastToRoom(ws.roomId, { type: 'NOW_PLAYING', title: data.title }, null);
        }
    });

    ws.on('close', () => handleLeave(ws));
    ws.on('error', () => handleLeave(ws));
});

function handleLeave(ws) {
    if (!ws.roomId || !rooms.has(ws.roomId)) return;
    const room = rooms.get(ws.roomId);
    room.clients.delete(ws);
    if (room.clients.size === 0) {
        rooms.delete(ws.roomId);
    } else {
        if (room.host === ws.id) {
            room.host = Array.from(room.clients)[0].id;
        }
        broadcastRoomUpdate(ws.roomId);
    }
    ws.roomId = null;
}

function broadcastRoomUpdate(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const users = Array.from(room.clients).map(c => ({
        id:       c.id,
        username: c.username,
        color:    c.color,
        isHost:   c.id === room.host,
        isInCall: c.isInCall || false
    }));
    // Send ROOM_UPDATE — background.js converts this to ROOM_STATE for tabs/popup
    broadcastToRoom(roomId, {
        type:            'ROOM_UPDATE',
        roomId,
        users,
        hostControlOnly: room.hostControlOnly,
        nowPlaying:      room.nowPlaying
    }, null);
}

function broadcastToRoom(roomId, msgObj, excludeWs) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify(msgObj);
    room.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === 1) client.send(msg);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SyncStream Pro running on :${PORT}`));
