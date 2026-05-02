document.addEventListener('DOMContentLoaded', () => {
    const setupView = document.getElementById('setup-view');
    const roomView  = document.getElementById('room-view');

    const usernameInput  = document.getElementById('username');
    const roomCodeInput  = document.getElementById('room-code-input');
    const createRoomBtn  = document.getElementById('create-room-btn');
    const joinRoomBtn    = document.getElementById('join-room-btn');
    const leaveRoomBtn   = document.getElementById('leave-room-btn');
    const copyCodeBtn    = document.getElementById('copy-code-btn');
    const copyLinkBtn    = document.getElementById('copy-link-btn');
    const hostControls   = document.getElementById('host-controls');
    const hostControlCb  = document.getElementById('host-control-checkbox');
    const currentCode    = document.getElementById('current-room-code');
    const usersList      = document.getElementById('users-list');
    const userCount      = document.getElementById('user-count');
    const connStatus     = document.getElementById('connection-status');

    let myUsername = 'Anonymous';

    // Load saved state
    chrome.storage.local.get(['username', 'roomData'], (res) => {
        if (res.username) { usernameInput.value = res.username; myUsername = res.username; }
        if (res.roomData?.roomId) showRoomView(res.roomData);
        else showSetupView();
    });

    // Connection status
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
        if (res) setConnected(res.connected);
    });

    // Background messages
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'ROOM_UPDATE')       showRoomView(msg.data);
        else if (msg.type === 'CONNECTION_STATUS') setConnected(msg.connected);
        else if (msg.type === 'LEFT_ROOM')    showSetupView();
        else if (msg.type === 'NOW_PLAYING') {
            const el = document.getElementById('now-playing-title');
            if (el) el.textContent = msg.title;
        }
    });

    // Create room
    createRoomBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Anonymous';
        myUsername = username;
        chrome.storage.local.set({ username });
        chrome.runtime.sendMessage({ type: 'CREATE_ROOM', username });
    });

    // Join room
    joinRoomBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Anonymous';
        const roomId = roomCodeInput.value.trim().toUpperCase();
        if (!roomId) { alert('Please enter a room code.'); return; }
        myUsername = username;
        chrome.storage.local.set({ username });
        chrome.runtime.sendMessage({ type: 'JOIN_ROOM', roomId, username });
    });

    // Leave room
    leaveRoomBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
        showSetupView();
    });

    // Copy room code
    copyCodeBtn.addEventListener('click', () => {
        const code = currentCode.textContent;
        navigator.clipboard.writeText(code).then(() => {
            copyCodeBtn.innerHTML = '✓';
            setTimeout(() => { copyCodeBtn.innerHTML = '⎘'; }, 2000);
        });
    });

    // Copy share link
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', () => {
            const code = currentCode.textContent;
            const link = `https://syncstream-server.onrender.com/join/${code}`;
            // We'll copy a user-friendly message with the room code
            const shareText = `Join my SyncStream Pro watch party! Room code: ${code} — Install the extension and enter this code.`;
            navigator.clipboard.writeText(shareText).then(() => {
                copyLinkBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyLinkBtn.textContent = '🔗 Share Link'; }, 2000);
            });
        });
    }

    // Host control toggle
    if (hostControlCb) {
        hostControlCb.addEventListener('change', (e) => {
            chrome.runtime.sendMessage({ type: 'TOGGLE_HOST_CONTROL', enabled: e.target.checked });
        });
    }

    function showSetupView() {
        setupView.classList.add('active');
        roomView.classList.remove('active');
    }

    function showRoomView(data) {
        setupView.classList.remove('active');
        roomView.classList.add('active');
        updateRoomUI(data);
    }

    function updateRoomUI(data) {
        if (!data) return;
        currentCode.textContent = data.roomId;
        userCount.textContent = data.users?.length || 0;

        const amHost = data.users?.some(u => u.username === myUsername && u.isHost);
        if (hostControls) {
            hostControls.style.display = amHost ? 'block' : 'none';
            if (hostControlCb) hostControlCb.checked = data.hostControlOnly || false;
        }

        usersList.innerHTML = '';
        (data.users || []).forEach(user => {
            const li = document.createElement('li');
            li.className = `user-item ${user.isHost ? 'host' : ''}`;
            const initials = user.username.substring(0, 2).toUpperCase();
            const color = user.color || '#a855f7';
            const micIcon  = user.isInCall ? '🎤' : '';
            const hostIcon = user.isHost ? '<span class="host-badge">HOST</span>' : '';
            li.innerHTML = `
                <div class="user-avatar" style="background:${color};color:#111;">${initials}</div>
                <div class="user-name">${user.username}</div>
                <div style="margin-left:auto;font-size:12px;">${micIcon} ${hostIcon}</div>
            `;
            usersList.appendChild(li);
        });
    }

    function setConnected(ok) {
        if (!connStatus) return;
        connStatus.classList.toggle('online', ok);
        connStatus.classList.toggle('offline', !ok);
        connStatus.title = ok ? 'Connected to server' : 'Disconnected from server';
    }
});
