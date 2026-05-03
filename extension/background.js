let socket = null;
let currentRoom = null;
let reconnectTimer = null;
let isConnecting = false;
let roomTabs = new Set(); // Set of tab IDs that have the content script active

const SERVER_URL = 'wss://syncstream-server.onrender.com';

// ─── STARTUP ──────────────────────────────────────────────────────────────────
chrome.storage.local.get(['roomData'], (result) => {
    if (result.roomData) {
        currentRoom = result.roomData;
        connectWebSocket();
    }
});

// ─── KEEP-ALIVE ───────────────────────────────────────────────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
        // Ping server health endpoint
        fetch('https://syncstream-server.onrender.com/health').catch(() => {});
        
        // Reconnect if socket died
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            console.log('[SyncStream] Alarm: Socket closed, reconnecting...');
            connectWebSocket();
        }
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
            socket.send(JSON.stringify({ 
                type: 'JOIN_ROOM', 
                roomId: currentRoom.roomId, 
                username: currentRoom.myUsername 
            }));
        }
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'ROOM_UPDATE') {
                const me = data.users.find(u => u.username === currentRoom?.myUsername);
                currentRoom = {
                    ...data,
                    myUsername: currentRoom?.myUsername,
                    myId: me?.id || currentRoom?.myId,
                    isHost: me?.isHost || false
                };
                chrome.storage.local.set({ roomData: currentRoom });
                const roomMsg = { type: 'ROOM_STATE', data: currentRoom };
                broadcastToPopup(roomMsg);
                broadcastToTabs(roomMsg);
            }
            else if (data.type === 'NOW_PLAYING') {
                if (currentRoom) { 
                    currentRoom.nowPlaying = data.title; 
                    currentRoom.nowPlayingUrl = data.url || ''; 
                    broadcastToPopup({ type: 'ROOM_STATE', data: currentRoom }); 
                }
                broadcastToTabs(data);
            }
            else if (data.type === 'ERROR') {
                broadcastToPopup({ type: 'JOIN_ERROR', message: data.message });
                broadcastToTabs({ type: 'JOIN_ERROR', message: data.message });
                if (data.message.toLowerCase().includes('not found')) {
                    chrome.storage.local.remove('roomData');
                    currentRoom = null;
                }
            }
            else { 
                broadcastToTabs(data); 
            }
        } catch (e) { console.error('[SyncStream] WS Message error:', e); }
    };

    socket.onclose = () => {
        isConnecting = false;
        console.log('[SyncStream] Disconnected');
        broadcastToPopup({ type: 'CONNECTION_STATUS', connected: false, connecting: false });
        if (currentRoom?.roomId) broadcastToTabs({ type: 'RECONNECTING', seconds: 3 });
        
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = (e) => { 
        isConnecting = false;
        console.error('[SyncStream] WS Error:', e);
    };
}

function broadcastToTabs(msg) {
    // Send to all tabs that we know have the content script
    roomTabs.forEach(tabId => {
        chrome.tabs.sendMessage(tabId, msg).catch(() => {
            // If message fails, tab might be closed or navigated away
            roomTabs.delete(tabId);
        });
    });
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {
        // Popup is likely closed, ignore
    });
}

// ─── TAB MANAGEMENT ───────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
    roomTabs.delete(tabId);
});

// Detect URL changes to trigger HOST_NAVIGATE
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!roomTabs.has(tabId) || !changeInfo.url || !currentRoom?.roomId) return;
    
    // Only the host (in their primary tab) can trigger room navigation
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
    // Register the tab if it's sending a message
    if (sender?.tab?.id) {
        roomTabs.add(sender.tab.id);
    }

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
            const sendOnOpen = () => { 
                if (socket.readyState === WebSocket.OPEN) socket.send(payload); 
                socket.removeEventListener('open', sendOnOpen); 
            };
            socket.addEventListener('open', sendOnOpen);
        }
    }
    else if (request.type === 'LEAVE_ROOM') {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
        currentRoom = null;
        chrome.storage.local.remove('roomData');
        broadcastToTabs({ type: 'ROOM_STATE', data: null });
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
