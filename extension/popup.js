document.addEventListener('DOMContentLoaded', () => {
    const views = {
        init:   document.getElementById('view-init'),
        action: document.getElementById('view-action'),
        room:   document.getElementById('view-room')
    };

    const el = {
        nameIn:       document.getElementById('name-in'),
        userNameLbl:  document.getElementById('user-name-label'),
        joinCodeIn:   document.getElementById('join-code-in'),
        roomCodeDsp:  document.getElementById('room-code-display'),
        userList:     document.getElementById('user-list'),
        npTitle:      document.getElementById('now-playing-title'),
        hostControls: document.getElementById('host-controls'),
        hostToggle:   document.getElementById('host-control-only'),
        btnNext:      document.getElementById('btn-next'),
        btnCreate:    document.getElementById('btn-create'),
        btnJoin:      document.getElementById('btn-join'),
        btnBack:      document.getElementById('btn-back'),
        btnLeave:     document.getElementById('btn-leave'),
        btnCopy:      document.getElementById('btn-copy'),
        btnShare:     document.getElementById('btn-share'),
        connectingMsg:document.getElementById('connecting-msg'),
        dot1:         document.getElementById('status-dot'),
        dot2:         document.getElementById('status-dot-2')
    };

    let myName = '';

    // ── Helpers ───────────────────────────────────────────────────────────────
    function showView(name) {
        Object.keys(views).forEach(k => views[k].classList.toggle('active', k === name));
    }

    function setDotState(connected, connecting) {
        [el.dot1, el.dot2].forEach(d => {
            if (!d) return;
            d.className = 'status-dot' + (connected ? ' connected' : connecting ? ' connecting' : '');
        });
    }

    // ── Restore saved username ────────────────────────────────────────────────
    chrome.storage.local.get(['savedUsername'], (res) => {
        if (res.savedUsername) {
            el.nameIn.value = res.savedUsername;
            el.nameIn.select();
        }
    });

    // ── Check for ss_room in active tab URL (auto-fill room code) ─────────────
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.url) return;
        try {
            const hash = new URL(tabs[0].url).hash;
            const code = hash.match(/ss_room=([A-Z0-9]+)/i)?.[1];
            if (code) el.joinCodeIn.value = code.toUpperCase();
        } catch (_) {}
    });

    // ── Connection status ─────────────────────────────────────────────────────
    chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, (res) => {
        if (res) setDotState(res.connected, res.connecting);
    });

    // ── Restore room state on popup open ─────────────────────────────────────
    chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
        if (res?.roomId) updateRoomUI(res);
        else showView('init');
    });

    // ── Live updates from background ──────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'ROOM_STATE') {
            if (msg.data?.roomId) updateRoomUI(msg.data);
            else showView('init');
        }
        else if (msg.type === 'CONNECTION_STATUS') {
            setDotState(msg.connected, msg.connecting);
            if (!msg.connected && !msg.connecting) el.connectingMsg.style.display = 'none';
            if (msg.connecting)  el.connectingMsg.style.display = 'block';
            if (msg.connected)   el.connectingMsg.style.display = 'none';
        }
        else if (msg.type === 'JOIN_ERROR') {
            el.connectingMsg.style.display = 'none';
            el.btnCreate.disabled = false;
            el.btnJoin.disabled   = false;
            alert(msg.message || 'Could not join room.');
        }
    });

    // ── Step 1: Name → Step 2 ─────────────────────────────────────────────────
    el.btnNext.onclick = () => {
        myName = el.nameIn.value.trim();
        if (!myName) { el.nameIn.focus(); return; }
        chrome.storage.local.set({ savedUsername: myName });
        el.userNameLbl.textContent = myName;
        showView('action');
    };
    el.nameIn.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnNext.click(); });

    el.btnBack.onclick = () => showView('init');

    // ── Create Room ───────────────────────────────────────────────────────────
    el.btnCreate.onclick = () => {
        el.btnCreate.disabled = true;
        el.connectingMsg.style.display = 'block';
        chrome.runtime.sendMessage({ type: 'CREATE_ROOM', username: myName });
    };

    // ── Join Room ─────────────────────────────────────────────────────────────
    el.btnJoin.onclick = () => {
        const code = el.joinCodeIn.value.trim().toUpperCase();
        if (code.length !== 6) { el.joinCodeIn.focus(); return; }
        el.btnJoin.disabled = true;
        el.connectingMsg.style.display = 'block';
        chrome.runtime.sendMessage({ type: 'JOIN_ROOM', roomId: code, username: myName });
    };
    el.joinCodeIn.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnJoin.click(); });
    // Auto-uppercase as you type
    el.joinCodeIn.addEventListener('input', () => { el.joinCodeIn.value = el.joinCodeIn.value.toUpperCase(); });

    // ── Leave Room ────────────────────────────────────────────────────────────
    el.btnLeave.onclick = () => {
        chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
        showView('init');
    };

    // ── Copy Code ─────────────────────────────────────────────────────────────
    el.btnCopy.onclick = () => {
        const code = el.roomCodeDsp.textContent;
        navigator.clipboard.writeText(code).then(() => {
            el.btnCopy.textContent = '✓ COPIED';
            setTimeout(() => { el.btnCopy.textContent = 'Copy Code'; }, 2000);
        });
    };

    // ── Share Link ────────────────────────────────────────────────────────────
    el.btnShare.onclick = () => {
        const link = el.btnShare.dataset.link;
        if (!link) return;
        navigator.clipboard.writeText(link).then(() => {
            el.btnShare.textContent = '✓ Link Copied';
            setTimeout(() => { el.btnShare.textContent = 'Share Link'; }, 2000);
        });
    };

    // ── Host control toggle ───────────────────────────────────────────────────
    el.hostToggle.onchange = () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_HOST_CONTROL', value: el.hostToggle.checked });
    };

    // ── Update room view ──────────────────────────────────────────────────────
    function updateRoomUI(room) {
        showView('room');
        el.connectingMsg.style.display = 'none';
        el.btnCreate.disabled = false;
        el.btnJoin.disabled   = false;
        el.roomCodeDsp.textContent = room.roomId;
        el.npTitle.textContent = room.nowPlaying || 'Watching together...';
        el.npTitle.href = room.nowPlayingUrl || '#';

        // Build shareable invite link from current tab URL
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            try {
                const url = new URL(tabs[0]?.url || '');
                url.hash = 'ss_room=' + room.roomId;
                el.btnShare.dataset.link = url.toString();
            } catch (_) { el.btnShare.dataset.link = ''; }
        });

        el.userList.innerHTML = '';
        (room.users || []).forEach(u => {
            const item = document.createElement('div');
            item.className = 'user-item';
            
            // Server-assigned Avatar (Strict Source of Truth)
            const avatar = u.avatar || '👤';

            const isMe = u.id === room.myId || u.username === room.myUsername;

            const av = document.createElement('div');
            av.className   = 'user-av';
            av.style.background = 'rgba(255,255,255,0.05)';
            av.style.fontSize = '14px';
            av.style.display = 'flex';
            av.style.alignItems = 'center';
            av.style.justifyContent = 'center';
            av.textContent = avatar;

            const name = document.createElement('span');
            name.textContent = (isMe ? 'You' : u.username)
                + (isMe && u.username !== 'You' ? ` (${u.username})` : '')
                + (u.isHost   ? ' 👑' : '')
                + (u.isInCall ? ' 🎤' : '');
            item.appendChild(av);
            item.appendChild(name);
            el.userList.appendChild(item);
        });

        if (room.isHost) {
            el.hostControls.style.display = 'flex';
            el.hostToggle.checked = room.hostControlOnly;
        } else {
            el.hostControls.style.display = 'none';
        }
    }
});
