let socket = null;
let currentRoom = null;
let reconnectTimer = null;

const SERVER_URL = 'wss://syncstream-server.onrender.com';
let uiMasters = new Map(); // tabId -> frameId (who is allowed to show UI)

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
        broadcastConnectionStatus(true);
        if (currentRoom?.roomId) {
            socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: currentRoom.roomId, username: currentRoom.myUsername }));
        }
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'ROOM_UPDATE') {
                const me = data.users.find(u => u.username === currentRoom?.myUsername);
                const myId = me?.id || currentRoom?.myId;
                currentRoom = { ...currentRoom, ...data, isHost: me?.isHost || false, myId: myId };
                chrome.storage.local.set({ roomData: currentRoom });
                // Send ROOM_STATE to all tabs with complete state including myId
                sendToTabs({ type: 'ROOM_STATE', data: currentRoom });
            } else {
                sendToTabs(data);
            }
        } catch (e) {}
    };

    socket.onclose = () => {
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

function broadcastConnectionStatus(isConnected) {
    chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS', connected: isConnected }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
        sendResponse({ connected: socket && socket.readyState === WebSocket.OPEN });
    } else if (request.type === 'CREATE_ROOM' || request.type === 'JOIN_ROOM') {
        if (!socket || socket.readyState !== WebSocket.OPEN) connectWebSocket();
        setTimeout(() => {
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
        }, 1000);
        currentRoom = { myUsername: request.username, roomId: request.roomId };
    } else if (request.type === 'LEAVE_ROOM') {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
        currentRoom = null;
        chrome.storage.local.remove('roomData');
    } else if (['PLAYER_EVENT', 'CHAT_MESSAGE', 'REACTION', 'UPDATE_NOW_PLAYING', 'SIGNALING', 'TOGGLE_CALL'].includes(request.type)) {
        if (socket?.readyState === WebSocket.OPEN && currentRoom?.roomId) {
            request.roomId = currentRoom.roomId;
            socket.send(JSON.stringify(request));
        }
    } else if (request.type === 'GET_ROOM_STATE') {
        sendResponse(currentRoom);
    } else if (request.type === 'GET_UI_PERMISSION') {
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

// Clear master when tab is closed or refreshed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') uiMasters.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => uiMasters.delete(tabId));

connectWebSocket();

// Keep Render server alive (pings every 10 minutes)
const SERVER_HTTP = 'https://syncstream-server.onrender.com/health';
setInterval(() => {
    fetch(SERVER_HTTP).catch(() => {});
}, 10 * 60 * 1000);
// Also ping immediately on load
fetch(SERVER_HTTP).catch(() => {});
