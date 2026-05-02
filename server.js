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
            console.log('Received:', data.type, 'from', ws.username || ws.id);
            
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
                    
                    // Notify everyone that someone joined
                    broadcastToRoom(roomId, {
                        type: 'TOAST',
                        message: `${ws.username} joined the room!`,
                        color: ws.color
                    }, ws);

                    ws.send(JSON.stringify({
                        type: 'NOW_PLAYING',
                        title: room.nowPlaying
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' }));
                }
            } 
            else if (data.type === 'LEAVE_ROOM') {
                leaveRoom(ws);
            }
            else if (data.type === 'PLAYER_EVENT') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    // If hostControlOnly is true, ONLY accept events from the host!
                    if (room.hostControlOnly && ws.id !== room.host) {
                        return; // Ignore event
                    }

                    broadcastToRoom(data.roomId, {
                        type: 'SYNC_STATE',
                        event: data.event,
                        time: data.time,
                        playbackRate: data.playbackRate,
                        byUsername: ws.username
                    }, ws);
                }
            }
            else if (data.type === 'CHAT_MESSAGE') {
                if (rooms.has(data.roomId)) {
                    broadcastToRoom(data.roomId, {
                        type: 'CHAT_MESSAGE',
                        username: ws.username,
                        color: ws.color,
                        text: data.text
                    }, null);
                }
            }
            else if (data.type === 'REACTION') {
                if (rooms.has(data.roomId)) {
                    broadcastToRoom(data.roomId, {
                        type: 'REACTION',
                        username: ws.username,
                        emoji: data.emoji
                    }, null);
                }
            }
            else if (data.type === 'TYPING') {
                if (rooms.has(data.roomId)) {
                    broadcastToRoom(data.roomId, {
                        type: 'TYPING',
                        username: ws.username,
                        isTyping: data.isTyping
                    }, ws);
                }
            }
            else if (data.type === 'TOGGLE_HOST_CONTROL') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    if (room.host === ws.id) {
                        room.hostControlOnly = data.enabled;
                        broadcastRoomUpdate(data.roomId);
                        broadcastToRoom(data.roomId, {
                            type: 'TOAST',
                            message: `Host Control Mode is now ${data.enabled ? 'ON' : 'OFF'}`,
                            color: '#ffb86c'
                        }, null);
                    }
                }
            }
            else if (data.type === 'SIGNALING') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    const targetClient = Array.from(room.clients).find(c => c.id === data.targetId);
                    if (targetClient) {
                        targetClient.send(JSON.stringify({
                            type: 'SIGNALING',
                            fromId: ws.id,
                            fromUsername: ws.username,
                            payload: data.payload
                        }));
                    }
                }
            }
            else if (data.type === 'TOGGLE_CALL') {
                ws.isInCall = data.enabled;
                broadcastRoomUpdate(ws.roomId);
            }
            else if (data.type === 'UPDATE_NOW_PLAYING') {
                if (rooms.has(data.roomId)) {
                    const room = rooms.get(data.roomId);
                    room.nowPlaying = data.title;
                    broadcastToRoom(data.roomId, {
                        type: 'NOW_PLAYING',
                        title: data.title
                    }, null);
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        leaveRoom(ws);
    });
});

function leaveRoom(ws) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        room.clients.delete(ws);
        
        broadcastToRoom(ws.roomId, {
            type: 'TOAST',
            message: `${ws.username} left the room.`,
            color: '#ff5555'
        }, ws);

        if (room.clients.size === 0) {
            rooms.delete(ws.roomId);
        } else {
            if (room.host === ws.id) {
                const nextClient = room.clients.values().next().value;
                if (nextClient) {
                    room.host = nextClient.id;
                    broadcastToRoom(ws.roomId, {
                        type: 'TOAST',
                        message: `${nextClient.username} is now the host!`,
                        color: '#50fa7b'
                    }, null);
                }
            }
            broadcastRoomUpdate(ws.roomId);
        }
        
        ws.roomId = null;
    }
}

function broadcastRoomUpdate(roomId) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const usersInfo = Array.from(room.clients).map(c => ({
        id: c.id,
        username: c.username,
        color: c.color,
        isHost: c.id === room.host,
        isInCall: c.isInCall || false
    }));
    
    broadcastToRoom(roomId, {
        type: 'ROOM_UPDATE',
        roomId: roomId,
        hostControlOnly: room.hostControlOnly,
        users: usersInfo
    }, null);
}

function broadcastToRoom(roomId, messageObj, excludeWs = null) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const messageStr = JSON.stringify(messageObj);
    for (const client of room.clients) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`SyncStream Signaling Server running on port ${PORT}`);
});
