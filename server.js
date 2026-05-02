const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getRandomPastelColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue}, 70%, 75%)`;
}

wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substring(2, 10);
    ws.roomId = null;
    ws.username = null;
    ws.color = getRandomPastelColor();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'CREATE_ROOM') {
                const roomId = generateRoomId();
                ws.roomId = roomId;
                ws.username = data.username || 'Anonymous';
                rooms.set(roomId, {
                    host: ws.id,
                    clients: new Set([ws]),
                    nowPlaying: 'Waiting for video...',
                    hostControlOnly: false
                });
                broadcastRoomUpdate(roomId);
            } 
            else if (data.type === 'JOIN_ROOM') {
                const roomId = data.roomId.toUpperCase();
                if (rooms.has(roomId)) {
                    ws.roomId = roomId;
                    ws.username = data.username || 'Anonymous';
                    const room = rooms.get(roomId);
                    room.clients.add(ws);
                    broadcastRoomUpdate(roomId);
                    broadcastToRoom(roomId, { type: 'TOAST', message: `${ws.username} joined!`, color: ws.color }, null);
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
                }
            } 
            else if (data.type === 'PLAYER_EVENT') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    if (room.hostControlOnly && ws.id !== room.host) return;
                    broadcastToRoom(data.roomId, { type: 'SYNC_STATE', event: data.event, time: data.time, playbackRate: data.playbackRate, byUsername: ws.username }, ws);
                }
            }
            else if (data.type === 'CHAT_MESSAGE') {
                broadcastToRoom(data.roomId, { type: 'CHAT_MESSAGE', username: ws.username, color: ws.color, text: data.text }, null);
            }
            else if (data.type === 'REACTION') {
                broadcastToRoom(data.roomId, { type: 'REACTION', username: ws.username, emoji: data.emoji }, null);
            }
            else if (data.type === 'SIGNALING') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    const target = Array.from(room.clients).find(c => c.id === data.targetId);
                    if (target) {
                        target.send(JSON.stringify({ type: 'SIGNALING', fromId: ws.id, fromUsername: ws.username, payload: data.payload }));
                    }
                }
            }
            else if (data.type === 'TOGGLE_CALL') {
                ws.isInCall = data.enabled;
                broadcastRoomUpdate(ws.roomId);
            }
            else if (data.type === 'UPDATE_NOW_PLAYING') {
                if (rooms.has(data.roomId)) {
                    rooms.get(data.roomId).nowPlaying = data.title;
                    broadcastToRoom(data.roomId, { type: 'NOW_PLAYING', title: data.title }, null);
                }
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            room.clients.delete(ws);
            if (room.clients.size === 0) rooms.delete(ws.roomId);
            else {
                if (room.host === ws.id) room.host = room.clients.values().next().value.id;
                broadcastRoomUpdate(ws.roomId);
            }
        }
    });
});

function broadcastRoomUpdate(roomId) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const users = Array.from(room.clients).map(c => ({ id: c.id, username: c.username, color: c.color, isHost: c.id === room.host, isInCall: c.isInCall || false }));
    broadcastToRoom(roomId, { type: 'ROOM_UPDATE', roomId: roomId, hostControlOnly: room.hostControlOnly, users: users }, null);
}

function broadcastToRoom(roomId, messageObj, excludeWs = null) {
    if (!rooms.has(roomId)) return;
    const msg = JSON.stringify(messageObj);
    for (const client of rooms.get(roomId).clients) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(msg);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
