let socket = null;
let currentRoom = null;
let reconnectTimer = null;

const SERVER_URL = 'wss://sync-watch-pro.onrender.com';

// Restore room on service worker restart
chrome.storage.local.get(['roomData'], (result) => {
    if (result.roomData) {
        currentRoom = result.roomData;
        connectWebSocket();
    }
});

function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    socket = new WebSocket(SERVER_URL);

    socket.onopen = () => {
        console.log('[SyncStream] Connected');
        broadcastToPopup({ type: 'CONNECTION_STATUS', connected: true });
        if (currentRoom?.roomId) {
            socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: currentRoom.roomId, username: currentRoom.myUsername }));
        }
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'ROOM_UPDATE') {
                const me = data.users.find(u => u.username === currentRoom?.myUsername);
                currentRoom = {
                    roomId: data.roomId,
                    users: data.users,
                    hostControlOnly: data.hostControlOnly,
                    myUsername: currentRoom?.myUsername,
                    myId: me?.id || currentRoom?.myId,
                    isHost: me?.isHost || false,
                    nowPlaying: data.nowPlaying || currentRoom?.nowPlaying
                };
                chrome.storage.local.set({ roomData: currentRoom });
                // Send as ROOM_STATE so popup and content.js can handle it uniformly
                const roomMsg = { type: 'ROOM_STATE', data: currentRoom };
                broadcastToPopup(roomMsg);
                broadcastToTabs(roomMsg);
            }
            else if (data.type === 'NOW_PLAYING') {
                if (currentRoom) {
                    currentRoom.nowPlaying = data.title;
                    broadcastToPopup({ type: 'ROOM_STATE', data: currentRoom });
                }
                broadcastToTabs(data);
            }
            else if (data.type === 'ERROR') {
                broadcastToPopup({ type: 'JOIN_ERROR', message: data.message });
            }
            else {
                broadcastToTabs(data);
            }
        } catch (e) { console.error('[SyncStream] Message error:', e); }
    };

    socket.onclose = () => {
        console.log('[SyncStream] Disconnected');
        broadcastToPopup({ type: 'CONNECTION_STATUS', connected: false });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };
}

function broadcastToTabs(msg) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
    });
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_ROOM_STATE') {
        sendResponse(currentRoom);
    }
    else if (request.type === 'CREATE_ROOM' || request.type === 'JOIN_ROOM') {
        currentRoom = { myUsername: request.username, roomId: request.roomId || null };
        const payload = JSON.stringify(request);
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        } else {
            // Queue message; fire immediately when socket opens
            connectWebSocket();
            const sendOnOpen = () => { socket.send(payload); socket.removeEventListener('open', sendOnOpen); };
            socket.addEventListener('open', sendOnOpen);
        }
    }
    else if (request.type === 'LEAVE_ROOM') {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
        currentRoom = null;
        chrome.storage.local.remove('roomData');
    }
    else if (request.type === 'TOGGLE_HOST_CONTROL') {
        if (socket?.readyState === WebSocket.OPEN && currentRoom?.roomId) {
            socket.send(JSON.stringify({ type: 'TOGGLE_HOST_CONTROL', roomId: currentRoom.roomId, value: request.value }));
        }
    }
    else if (['PLAYER_EVENT', 'CHAT_MESSAGE', 'REACTION', 'UPDATE_NOW_PLAYING', 'SIGNALING', 'TOGGLE_CALL'].includes(request.type)) {
        if (socket?.readyState === WebSocket.OPEN && currentRoom?.roomId) {
            request.roomId = currentRoom.roomId;
            socket.send(JSON.stringify(request));
        }
    }
    return true;
});

connectWebSocket();

// Keep Render free tier awake
setInterval(() => {
    fetch('https://sync-watch-pro.onrender.com/health').catch(() => {});
}, 5 * 60 * 1000);
