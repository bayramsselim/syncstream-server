let socket = null;
let currentRoom = null;
let reconnectTimer = null;

const SERVER_URL = 'wss://syncstream-server.onrender.com';
let uiMasters = new Map();

// Load saved room data on startup
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
        console.log('[SyncStream] WebSocket Connected');
        broadcastConnectionStatus(true);
        // If we were already in a room, rejoin it automatically
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
                // Find my current info in the user list
                const me = data.users.find(u => u.username === currentRoom?.myUsername);
                
                // Construct complete state
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
                sendToPopup({ type: 'ROOM_STATE', data: currentRoom });
                sendToTabs({ type: 'ROOM_STATE', data: currentRoom });
            } 
            else if (data.type === 'NOW_PLAYING') {
                if (currentRoom) {
                    currentRoom.nowPlaying = data.title;
                    sendToPopup({ type: 'ROOM_STATE', data: currentRoom });
                }
                sendToTabs(data);
            }
            else {
                // Forward other messages (SYNC_STATE, CHAT, etc.) to tabs
                sendToTabs(data);
            }
        } catch (e) {
            console.error('[SyncStream] Message error:', e);
        }
    };

    socket.onclose = () => {
        console.log('[SyncStream] WebSocket Closed');
        broadcastConnectionStatus(false);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };
}

function sendToTabs(msg) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
    });
}

function sendToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastConnectionStatus(isConnected) {
    sendToPopup({ type: 'CONNECTION_STATUS', connected: isConnected });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_ROOM_STATE') {
        sendResponse(currentRoom);
    } 
    else if (request.type === 'CREATE_ROOM' || request.type === 'JOIN_ROOM') {
        currentRoom = { myUsername: request.username, roomId: request.roomId || null };
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connectWebSocket();
            // Wait for connection then send
            setTimeout(() => {
                if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
            }, 1500);
        } else {
            socket.send(JSON.stringify(request));
        }
    } 
    else if (request.type === 'LEAVE_ROOM') {
        currentRoom = null;
        chrome.storage.local.remove('roomData');
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
    } 
    else if (['PLAYER_EVENT', 'CHAT_MESSAGE', 'REACTION', 'UPDATE_NOW_PLAYING', 'SIGNALING', 'TOGGLE_CALL'].includes(request.type)) {
        if (socket?.readyState === WebSocket.OPEN && currentRoom?.roomId) {
            request.roomId = currentRoom.roomId;
            socket.send(JSON.stringify(request));
        }
    }
    else if (request.type === 'GET_UI_PERMISSION') {
        const tabId = sender.tab.id;
        const frameId = sender.frameId;
        if (!uiMasters.has(tabId)) {
            uiMasters.set(tabId, frameId);
            sendResponse({ canShow: true });
        } else {
            sendResponse({ canShow: uiMasters.get(tabId) === frameId });
        }
    }
    return true;
});

// Tab management
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') uiMasters.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => uiMasters.delete(tabId));

connectWebSocket();

// Keep-alive
setInterval(() => {
    fetch('https://syncstream-server.onrender.com/health').catch(() => {});
}, 5 * 60 * 1000);
