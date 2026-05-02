document.addEventListener('DOMContentLoaded', () => {
    // 🌌 Yıldız Efekti
    const starContainer = document.getElementById('star-container');
    if (starContainer && !starContainer.hasChildNodes()) {
        for(let i=0; i<40; i++) {
            const star = document.createElement('div');
            star.className = 'star';
            star.style.width = Math.random() * 2 + 'px';
            star.style.height = star.style.width;
            star.style.left = Math.random() * 100 + '%';
            star.style.top = Math.random() * 100 + '%';
            star.style.animationDuration = (Math.random() * 3 + 2) + 's';
            starContainer.appendChild(star);
        }
    }

    const elements = {
        joinView:    document.getElementById('join-view'),
        roomView:    document.getElementById('room-view'),
        username:    document.getElementById('username-input'),
        roomCodeIn:  document.getElementById('room-input'),
        mainBtn:     document.getElementById('main-action-btn'),
        roomDisplay: document.getElementById('current-room-code'),
        userList:    document.getElementById('user-list'),
        leaveBtn:    document.getElementById('leave-btn'),
        copyCodeBtn: document.getElementById('copy-code-btn'),
        copyLinkBtn: document.getElementById('copy-link-btn'),
        npTitle:     document.getElementById('now-playing-title'),
        hostControls:document.getElementById('host-controls'),
        hostToggle:  document.getElementById('host-control-only'),
        status:      document.getElementById('connection-status')
    };

    // 🔄 Başlangıç Durumu
    chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (room) => {
        if (room && room.roomId) updateUI(room);
        else showView('join');
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'ROOM_STATE') {
            if (msg.data && msg.data.roomId) updateUI(msg.data);
            else showView('join');
        } else if (msg.type === 'CONNECTION_STATUS') {
            elements.status.style.background = msg.connected ? '#10b981' : '#ef4444';
            elements.status.style.boxShadow = `0 0 10px ${msg.connected ? '#10b981' : '#ef4444'}`;
        }
    });

    // 🚀 Akıllı Buton Mantığı
    elements.mainBtn.onclick = () => {
        const u = elements.username.value.trim();
        const c = elements.roomCodeIn.value.trim().toUpperCase();
        
        if (!u) {
            alert('Please enter a display name.');
            return;
        }

        elements.mainBtn.disabled = true;
        elements.mainBtn.textContent = 'CONNECTING...';

        if (c) {
            // Kod varsa katıl
            chrome.runtime.sendMessage({ type: 'JOIN_ROOM', username: u, roomId: c });
        } else {
            // Kod yoksa kur
            chrome.runtime.sendMessage({ type: 'CREATE_ROOM', username: u });
        }
    };

    elements.leaveBtn.onclick = () => {
        chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
        showView('join');
    };

    elements.copyCodeBtn.onclick = () => {
        const code = elements.roomDisplay.textContent;
        navigator.clipboard.writeText(code).then(() => {
            elements.copyCodeBtn.textContent = 'COPIED!';
            setTimeout(() => elements.copyCodeBtn.textContent = 'Copy Code', 2000);
        });
    };

    elements.copyLinkBtn.onclick = () => {
        const code = elements.roomDisplay.textContent;
        const url = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&ss_room=${code}`;
        navigator.clipboard.writeText(url).then(() => {
            elements.copyLinkBtn.textContent = 'LINK COPIED!';
            setTimeout(() => elements.copyLinkBtn.textContent = 'Copy Link', 2000);
        });
    };

    elements.hostToggle.onchange = () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_HOST_CONTROL', value: elements.hostToggle.checked });
    };

    function updateUI(room) {
        showView('room');
        elements.roomDisplay.textContent = room.roomId;
        elements.npTitle.textContent = room.nowPlaying || 'Watching together...';
        
        elements.userList.innerHTML = '';
        room.users.forEach(u => {
            const item = document.createElement('div');
            item.className = 'user-item';
            item.innerHTML = `
                <div class="user-avatar" style="background:${u.color || '#6366f1'}">${u.username.charAt(0).toUpperCase()}</div>
                <div style="flex:1">${u.username} ${u.isHost ? '<b style="color:#6366f1; font-size:9px;">HOST</b>' : ''}</div>
                ${u.isInCall ? '🎤' : ''}
            `;
            elements.userList.appendChild(item);
        });

        if (room.isHost) {
            elements.hostControls.style.display = 'flex';
            elements.hostToggle.checked = room.hostControlOnly;
        } else {
            elements.hostControls.style.display = 'none';
        }

        elements.mainBtn.disabled = false;
        elements.mainBtn.textContent = 'START WATCHING';
    }

    function showView(v) {
        elements.joinView.style.display = v === 'join' ? 'flex' : 'none';
        elements.roomView.style.display = v === 'room' ? 'flex' : 'none';
    }
});
