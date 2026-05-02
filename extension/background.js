let socket = null;
let currentRoom = null;
let reconnectTimer = null;
let isConnecting = false;
let contentTabId = null; // tab where content script is active

const SERVER_URL = 'wss://syncstream-server.onrender.com';

// ─── STARTUP ──────────────────────────────────────────────────────────────────
chrome.storage.local.get(['roomData'], (result) => {
    if (result.roomData) {
        currentRoom = result.roomData;
        connectWebSocket();
    }
});

// ─── KEEP-ALIVE via chrome.alarms (reliable across MV3 service worker sleeps) ─
chrome.alarms.create('keepAlive', { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
        fetch('https://syncstream-server.onrender.com/health').catch(() => {});
        // Reconnect if socket died while worker was sleeping
        if (!socket || socket.readyState === WebSocket.CLOSED) connectWebSocket();
    }
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function connectWebSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (isConnecting) return;
    isConnecting = true;

    broadcastToPopup({ type: 'CONNECTION_STATUS', connected: false, connecting: true });

    socket = new WebSocket(SERVER_URL);

    socket.onopen = () => {
        isConnecting = false;
        console.log('[SyncStream] Connected');
        broadcastToPopup({ type: 'CONNECTION_STATUS', connected: true, connecting: false });
        broadcastToTabs({ type: 'CONNECTION_STATUS', connected: true, connecting: false });
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
                    roomId:          data.roomId,
                    users:           data.users,
                    hostControlOnly: data.hostControlOnly,
                    myUsername:      currentRoom?.myUsername,
                    myId:            me?.id || currentRoom?.myId,
                    isHost:          me?.isHost || false,
                    nowPlaying:      data.nowPlaying    || currentRoom?.nowPlaying,
                    nowPlayingUrl:   data.nowPlayingUrl || currentRoom?.nowPlayingUrl || ''
                };
                chrome.storage.local.set({ roomData: currentRoom });
                const roomMsg = { type: 'ROOM_STATE', data: currentRoom };
                broadcastToPopup(roomMsg);
                broadcastToTabs(roomMsg);
            }
            else if (data.type === 'NOW_PLAYING') {
                if (currentRoom) { currentRoom.nowPlaying = data.title; currentRoom.nowPlayingUrl = data.url || ''; broadcastToPopup({ type: 'ROOM_STATE', data: currentRoom }); }
                broadcastToTabs(data);
            }
            else if (data.type === 'ERROR') { broadcastToPopup({ type: 'JOIN_ERROR', message: data.message }); }
            else { broadcastToTabs(data); }
        } catch (e) { console.error('[SyncStream] Message error:', e); }
    };

    socket.onclose = () => {
        isConnecting = false;
        console.log('[SyncStream] Disconnected');
        broadcastToPopup({ type: 'CONNECTION_STATUS', connected: false, connecting: false });
        if (currentRoom?.roomId) broadcastToTabs({ type: 'RECONNECTING', seconds: 4 });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 4000);
    };

    socket.onerror = () => { isConnecting = false; };
}

function broadcastToTabs(msg) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
    });
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── TAB NAVIGATION DETECTION ─────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== contentTabId || !changeInfo.url || !currentRoom?.roomId) return;
    const canNavigate = currentRoom.isHost || !currentRoom.hostControlOnly;
    if (!canNavigate) return;
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'HOST_NAVIGATE',
            roomId: currentRoom.roomId,
            url: changeInfo.url,
            title: tab.title || ''
        }));
    }
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender?.tab?.id) contentTabId = sender.tab.id;
    if (request.type === 'GET_ROOM_STATE') {
        sendResponse(currentRoom);
    }
    else if (request.type === 'GET_CONNECTION_STATE') {
        sendResponse({ connected: socket?.readyState === WebSocket.OPEN, connecting: isConnecting });
    }
    else if (request.type === 'CREATE_ROOM' || request.type === 'JOIN_ROOM') {
        currentRoom = { myUsername: request.username, roomId: request.roomId || null };
        const payload = JSON.stringify(request);
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        } else {
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
    else if (['PLAYER_EVENT', 'CHAT_MESSAGE', 'REACTION', 'UPDATE_NOW_PLAYING', 'SIGNALING', 'TOGGLE_CALL', 'USER_STATUS'].includes(request.type)) {
        if (socket?.readyState === WebSocket.OPEN && currentRoom?.roomId) {
            request.roomId = currentRoom.roomId;
            socket.send(JSON.stringify(request));
        }
    }
    return true;
});

connectWebSocket();
