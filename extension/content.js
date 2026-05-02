/**
 * SyncStream Pro - Content Script
 * UX: draggable dock + tiles, auto-hide dock, notification sound,
 *     unread badge, mute per-tile, smooth animations
 */

let videoElement = null;
let isSyncing    = false;
let roomState    = null;
let localStream  = null;
let peerConnections = {};
let signalingQueue = [];
let processingSignaling = false;

let isMicOn    = false;
let isCamOn    = false;
let isChatOpen = false;
let unreadCount = 0;

const IS_TOP_FRAME = (window === window.top);
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

// ─── INITIALIZATION ───────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
    if (res) {
        roomState = res;
        if (IS_TOP_FRAME && roomState.myId) initPeers();
    }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SYNC_STATE') { applyRemoteSync(msg); return; }
    if (!IS_TOP_FRAME) return;

    if      (msg.type === 'ROOM_STATE')    { roomState = msg.data; if (roomState.myId) initPeers(); updateParticipantPanel(); }
    else if (msg.type === 'SIGNALING')     enqueueSignaling(msg.fromId, msg.payload);
    else if (msg.type === 'CHAT_MESSAGE')  handleIncomingChat(msg.username, msg.text, msg.color);
    else if (msg.type === 'REACTION')      animateEmoji(msg.emoji);
    else if (msg.type === 'TOAST')         showToast(msg.message, msg.color);
});

// ─── SYNC ─────────────────────────────────────────────────────────────────────
function findMainVideo() {
    return Array.from(document.querySelectorAll('video'))
        .filter(v => v.offsetWidth > 100 && !v.id.startsWith('ss-v-'))
        .sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
}

function broadcastState(event = 'sync') {
    if (!videoElement || isSyncing || !roomState) return;
    chrome.runtime.sendMessage({
        type: 'PLAYER_EVENT', event,
        time: videoElement.currentTime,
        playbackRate: videoElement.playbackRate
    }).catch(() => {});
}

function applyRemoteSync(msg) {
    if (!videoElement) videoElement = findMainVideo();
    if (!videoElement) return;
    isSyncing = true;
    const diff = Math.abs(videoElement.currentTime - msg.time);
    if (msg.event === 'seek' || diff > 1.2) videoElement.currentTime = msg.time;
    if (msg.playbackRate) videoElement.playbackRate = msg.playbackRate;
    if (msg.event === 'play'  && videoElement.paused)  videoElement.play().catch(() => {});
    if (msg.event === 'pause' && !videoElement.paused) videoElement.pause();
    setTimeout(() => { isSyncing = false; }, 500);
}

// ─── WEBRTC ───────────────────────────────────────────────────────────────────
function initPeers() {
    if (!roomState?.users || !roomState.myId) return;
    roomState.users.forEach(u => {
        if (u.id !== roomState.myId && !peerConnections[u.id]) createPeer(u.id, u.username);
    });
}

async function createPeer(tid, name) {
    if (peerConnections[tid]) return peerConnections[tid];
    const pc   = new RTCPeerConnection(ICE_SERVERS);
    const pObj = { pc, polite: roomState.myId < tid, makingOffer: false };
    peerConnections[tid] = pObj;

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { candidate } });
    };
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) addVideoTile(tid, stream, name);
    };
    pc.onnegotiationneeded = async () => {
        try {
            pObj.makingOffer = true;
            await pc.setLocalDescription();
            chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { description: pc.localDescription } });
        } catch (e) { console.error('[SyncStream] Negotiation error:', e); }
        finally { pObj.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    return pObj;
}

function enqueueSignaling(fromId, payload) {
    signalingQueue.push({ fromId, payload });
    processQueue();
}

async function processQueue() {
    if (processingSignaling || signalingQueue.length === 0) return;
    processingSignaling = true;
    const { fromId, payload } = signalingQueue.shift();
    try {
        let p = peerConnections[fromId];
        if (!p) {
            const u = roomState?.users?.find(x => x.id === fromId);
            p = await createPeer(fromId, u ? u.username : 'User');
        }
        if (payload.description) {
            const offerCollision = (payload.description.type === 'offer') &&
                                   (p.makingOffer || p.pc.signalingState !== 'stable');
            if (offerCollision && !p.polite) { processingSignaling = false; processQueue(); return; }
            await p.pc.setRemoteDescription(payload.description);
            if (payload.description.type === 'offer') {
                await p.pc.setLocalDescription();
                chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: fromId, payload: { description: p.pc.localDescription } });
            }
        } else if (payload.candidate) {
            await p.pc.addIceCandidate(payload.candidate).catch(() => {});
        }
    } catch (e) { console.error('[SyncStream] Signaling error:', e); }
    processingSignaling = false;
    processQueue();
}

async function updateMedia() {
    try {
        if (isMicOn || isCamOn) {
            if (!localStream) {
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true },
                    video: { width: 320, height: 240, frameRate: 15 }
                });
                Object.values(peerConnections).forEach(({ pc }) => {
                    localStream.getTracks().forEach(track => {
                        const existing = pc.getSenders().find(s => s.track?.kind === track.kind);
                        if (existing) existing.replaceTrack(track);
                        else pc.addTrack(track, localStream);
                    });
                });
            }
            localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
            localStream.getVideoTracks().forEach(t => t.enabled = isCamOn);
            if (isCamOn) addVideoTile('local', localStream, 'You');
            else removeVideoTile('local');
        } else {
            if (localStream) {
                localStream.getTracks().forEach(t => t.stop());
                localStream = null;
                Object.values(peerConnections).forEach(({ pc }) => {
                    pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch (_) {} });
                });
            }
            removeVideoTile('local');
        }
    } catch (e) { console.error('[SyncStream] Media error:', e); isMicOn = false; isCamOn = false; }
    updateButtons();
}

// ─── DRAG HELPER ─────────────────────────────────────────────────────────────
function makeDraggable(el, handle) {
    handle = handle || el;
    handle.style.cursor = 'grab';
    let ox, oy, startL, startT;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        // Snap to fixed coords, clear any centering transforms
        el.style.left      = r.left + 'px';
        el.style.top       = r.top  + 'px';
        el.style.bottom    = 'auto';
        el.style.right     = 'auto';
        el.style.transform = 'none';
        ox = e.clientX; oy = e.clientY;
        startL = r.left; startT = r.top;
        handle.style.cursor = 'grabbing';

        const onMove = (e) => {
            const nx = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startL + e.clientX - ox));
            const ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startT + e.clientY - oy));
            el.style.left = nx + 'px';
            el.style.top  = ny + 'px';
        };
        const onUp = () => {
            handle.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

// ─── VIDEO TILES ──────────────────────────────────────────────────────────────
function addVideoTile(id, stream, name) {
    // Tiles are fixed on the page, grid is just a logical anchor
    let tile = document.getElementById(`ss-vid-${id}`);
    if (!tile) {
        const grid = document.getElementById('ss-grid');
        if (!grid) return;

        tile = document.createElement('div');
        tile.id = `ss-vid-${id}`;

        // Starting position: stack from top-right
        const existingTiles = document.querySelectorAll('[id^="ss-vid-"]').length;
        const startTop  = 20 + existingTiles * 145;
        const startRight = 20;

        tile.style.cssText = `
            position:fixed;
            top:${startTop}px;
            right:${startRight}px;
            width:180px;height:135px;
            background:#000;
            border-radius:12px;
            overflow:visible;
            border:1px solid rgba(255,255,255,0.15);
            pointer-events:auto;
            box-shadow:0 8px 24px rgba(0,0,0,0.6);
            z-index:2147483640;
            transition:box-shadow 0.2s, opacity 0.3s;
            opacity:0;
        `;
        // Clip the video inside
        const inner = document.createElement('div');
        inner.style.cssText = 'width:100%;height:100%;border-radius:12px;overflow:hidden;position:relative;';
        tile.appendChild(inner);

        const v = document.createElement('video');
        v.id = `ss-v-${id}`;
        v.autoplay = true; v.playsInline = true;
        v.muted = (id === 'local');
        v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        inner.appendChild(v);

        // Label
        const lbl = document.createElement('div');
        lbl.textContent = name;
        lbl.style.cssText = 'position:absolute;bottom:6px;left:8px;font-size:10px;color:#fff;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px;pointer-events:none;letter-spacing:0.03em;';
        inner.appendChild(lbl);

        // Drag handle (top bar)
        const handle = document.createElement('div');
        handle.style.cssText = 'position:absolute;top:0;left:0;right:0;height:28px;z-index:2;';
        tile.appendChild(handle);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'position:absolute;top:-8px;right:-8px;width:22px;height:22px;border-radius:50%;background:#ef4444;border:none;color:#fff;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:3;box-shadow:0 2px 8px rgba(0,0,0,0.4);transition:transform 0.15s;';
        closeBtn.onmouseenter = () => closeBtn.style.transform = 'scale(1.15)';
        closeBtn.onmouseleave = () => closeBtn.style.transform = 'scale(1)';
        closeBtn.onclick = (e) => { e.stopPropagation(); tile.style.opacity = '0'; setTimeout(() => tile.remove(), 300); };
        tile.appendChild(closeBtn);

        // Mute button (remote tiles only)
        if (id !== 'local') {
            const muteBtn = document.createElement('button');
            muteBtn.textContent = '🔊';
            muteBtn.title = 'Mute/unmute this person';
            muteBtn.style.cssText = 'position:absolute;bottom:-8px;right:-8px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:3;transition:transform 0.15s;';
            muteBtn.onmouseenter = () => muteBtn.style.transform = 'scale(1.15)';
            muteBtn.onmouseleave = () => muteBtn.style.transform = 'scale(1)';
            muteBtn.onclick = (e) => {
                e.stopPropagation();
                const vEl = document.getElementById(`ss-v-${id}`);
                if (!vEl) return;
                vEl.muted = !vEl.muted;
                muteBtn.textContent = vEl.muted ? '🔇' : '🔊';
            };
            tile.appendChild(muteBtn);
        }

        makeDraggable(tile, handle);
        grid.appendChild(tile);

        // Fade in
        requestAnimationFrame(() => { tile.style.opacity = '1'; });
    }

    const vEl = document.getElementById(`ss-v-${id}`);
    if (vEl && vEl.srcObject !== stream) {
        vEl.srcObject = stream;
        vEl.play().catch(() => {
            vEl.muted = true;
            vEl.play().then(() => { if (id !== 'local') vEl.muted = false; }).catch(() => {});
        });
    }
}

function removeVideoTile(id) {
    const el = document.getElementById(`ss-vid-${id}`);
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
}

// ─── NOTIFICATION SOUND ───────────────────────────────────────────────────────
function playNotifSound() {
    try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880,  ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
    } catch (_) {}
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function handleIncomingChat(user, text, color) {
    addChatMessage(user, text, color);
    if (!isChatOpen) {
        unreadCount++;
        updateUnreadBadge();
        playNotifSound();
        // Flash chat button
        const btn = document.getElementById('ss-b-chat');
        if (btn) {
            btn.style.background = '#f59e0b';
            setTimeout(() => updateButtons(), 800);
        }
    }
}

function updateUnreadBadge() {
    const badge = document.getElementById('ss-chat-badge');
    if (!badge) return;
    if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

function addChatMessage(user, text, color) {
    const msgs = document.getElementById('ss-msgs');
    if (!msgs) return;
    const m = document.createElement('div');
    m.style.cssText = 'font-size:12px;word-wrap:break-word;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);animation:ss-fadein 0.2s ease;';
    const b = document.createElement('b');
    b.style.color = color || '#6366f1';
    b.textContent = user + ':';
    const s = document.createElement('span');
    s.style.color = '#ddd';
    s.textContent = ' ' + text;
    m.appendChild(b);
    m.appendChild(s);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
}

// ─── EMOJI / TOAST ────────────────────────────────────────────────────────────
function animateEmoji(emoji) {
    const e = document.createElement('div');
    e.textContent = emoji;
    e.style.cssText = `position:fixed;bottom:100px;left:${38 + Math.random() * 24}%;font-size:44px;z-index:999999;pointer-events:none;transition:transform 1.8s cubic-bezier(0.2,0.8,0.4,1),opacity 1.8s ease;opacity:1;`;
    document.body.appendChild(e);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        e.style.transform = `translateY(-380px) rotate(${(Math.random()-0.5)*30}deg) scale(1.4)`;
        e.style.opacity   = '0';
    }));
    setTimeout(() => e.remove(), 2000);
}

function showToast(text, color) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-8px);background:rgba(15,15,25,0.95);color:${color||'#fff'};padding:8px 18px;border-radius:20px;z-index:999999;font-size:12px;font-weight:600;letter-spacing:0.04em;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:none;transition:transform 0.3s ease,opacity 0.3s ease;opacity:0;`;
    document.body.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        t.style.transform = 'translateX(-50%) translateY(0)';
        t.style.opacity   = '1';
    }));
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(-8px)'; }, 2700);
    setTimeout(() => t.remove(), 3100);
}

// ─── BUTTONS ─────────────────────────────────────────────────────────────────
function updateButtons() {
    const set = (id, c) => { const el = document.getElementById(id); if (el) el.style.background = c ? '#6366f1' : 'rgba(255,255,255,0.1)'; };
    set('ss-b-chat', isChatOpen);
    set('ss-b-mic',  isMicOn);
    set('ss-b-cam',  isCamOn);
}

function updateParticipantPanel() {
    const p = document.getElementById('ss-participants');
    if (!p || !roomState?.users) return;
    p.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:700;color:#6366f1;margin-bottom:8px;letter-spacing:0.05em;';
    title.textContent = `ONLINE (${roomState.users.length})`;
    p.appendChild(title);
    roomState.users.forEach(u => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:8px;';
        const av = document.createElement('div');
        av.style.cssText = `width:24px;height:24px;border-radius:50%;background:${u.color||'#6366f1'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#111;flex-shrink:0;`;
        av.textContent = u.username.charAt(0).toUpperCase();
        const name = document.createElement('span');
        name.style.cssText = 'color:#ddd;flex:1;';
        name.textContent = u.username + (u.isHost ? ' 👑' : '') + (u.isInCall ? ' 🎤' : '');
        row.appendChild(av);
        row.appendChild(name);
        p.appendChild(row);
    });
}

// ─── UI INJECTION ─────────────────────────────────────────────────────────────
function injectUI() {
    if (!IS_TOP_FRAME || document.getElementById('ss-root')) return;

    const root = document.createElement('div');
    root.id = 'ss-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;';
    document.body.appendChild(root);

    // Global styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes ss-fadein { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
        #ss-dock { transition: opacity 0.35s ease, transform 0.35s ease; }
        #ss-dock.ss-hidden { opacity:0 !important; transform:translateX(-50%) translateY(12px) !important; pointer-events:none !important; }
        #ss-msgs::-webkit-scrollbar { width:4px; }
        #ss-msgs::-webkit-scrollbar-track { background:transparent; }
        #ss-msgs::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.15); border-radius:4px; }
    `;
    document.head.appendChild(style);

    // ── DOCK ──────────────────────────────────────────────────────────────────
    const dock = document.createElement('div');
    dock.id = 'ss-dock';
    dock.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 14px;background:rgba(8,8,16,0.92);backdrop-filter:blur(24px);border-radius:32px;display:flex;gap:8px;align-items:center;pointer-events:auto;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 32px rgba(0,0,0,0.6);';

    const mkBtn = (emoji, id, h, tip) => {
        const b = document.createElement('button');
        b.id = id; b.innerHTML = emoji; b.title = tip || '';
        b.style.cssText = 'background:rgba(255,255,255,0.08);border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.15s;position:relative;flex-shrink:0;';
        b.onmouseenter = () => { b.style.transform = 'scale(1.12)'; b.style.background = 'rgba(255,255,255,0.18)'; };
        b.onmouseleave = () => { b.style.transform = 'scale(1)'; updateButtons(); };
        b.onclick = (e) => { e.stopPropagation(); h(); };
        return b;
    };

    // Chat button with unread badge
    const chatBtn = mkBtn('💬', 'ss-b-chat', () => {
        isChatOpen = !isChatOpen;
        chatPanel.style.display = isChatOpen ? 'flex' : 'none';
        if (isChatOpen) { unreadCount = 0; updateUnreadBadge(); }
        updateButtons();
    }, 'Chat');
    const badge = document.createElement('div');
    badge.id = 'ss-chat-badge';
    badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center;pointer-events:none;';
    chatBtn.appendChild(badge);
    dock.appendChild(chatBtn);

    dock.appendChild(mkBtn('🎤', 'ss-b-mic',  () => { isMicOn = !isMicOn; updateMedia(); }, 'Mic'));
    dock.appendChild(mkBtn('📷', 'ss-b-cam',  () => { isCamOn = !isCamOn; updateMedia(); }, 'Camera'));
    dock.appendChild(mkBtn('👥', 'ss-b-people', () => {
        const p = document.getElementById('ss-participants');
        if (p) { p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
    }, 'Participants'));

    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:22px;background:rgba(255,255,255,0.1);margin:0 2px;';
    dock.appendChild(sep);

    ['❤️', '😂', '🔥', '😮', '👏'].forEach(em => {
        dock.appendChild(mkBtn(em, '', () => chrome.runtime.sendMessage({ type: 'REACTION', emoji: em })));
    });

    root.appendChild(dock);
    makeDraggable(dock);

    // ── AUTO-HIDE DOCK ────────────────────────────────────────────────────────
    let hideTimer = null;
    const showDock = () => {
        dock.classList.remove('ss-hidden');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            // Don't hide if mouse is over the dock
            if (!dock.matches(':hover')) dock.classList.add('ss-hidden');
        }, 3000);
    };
    document.addEventListener('mousemove', showDock, { passive: true });
    dock.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    dock.addEventListener('mouseleave', () => {
        hideTimer = setTimeout(() => dock.classList.add('ss-hidden'), 3000);
    });
    // Start visible
    showDock();

    // ── CHAT PANEL ────────────────────────────────────────────────────────────
    const chatPanel = document.createElement('div');
    chatPanel.id = 'ss-chat';
    chatPanel.style.cssText = 'position:fixed;bottom:90px;right:24px;width:290px;height:360px;background:rgba(8,8,16,0.96);border:1px solid rgba(255,255,255,0.1);border-radius:16px;display:none;flex-direction:column;pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,0.6);overflow:hidden;';
    root.appendChild(chatPanel);
    makeDraggable(chatPanel);

    const chatHeader = document.createElement('div');
    chatHeader.style.cssText = 'padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.07);color:#fff;font-size:12px;font-weight:700;letter-spacing:0.06em;display:flex;justify-content:space-between;align-items:center;cursor:grab;';
    chatHeader.textContent = 'CHAT';
    const closeChat = document.createElement('button');
    closeChat.textContent = '✕';
    closeChat.style.cssText = 'background:none;border:none;color:#555;cursor:pointer;font-size:13px;padding:0;';
    closeChat.onclick = () => { isChatOpen = false; chatPanel.style.display = 'none'; updateButtons(); };
    chatHeader.appendChild(closeChat);
    chatPanel.appendChild(chatHeader);

    const msgs = document.createElement('div');
    msgs.id = 'ss-msgs';
    msgs.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:2px;';
    chatPanel.appendChild(msgs);

    const chatFooter = document.createElement('div');
    chatFooter.style.cssText = 'padding:10px 12px;display:flex;gap:8px;border-top:1px solid rgba(255,255,255,0.06);';
    const chatInput = document.createElement('input');
    chatInput.id = 'ss-chat-in';
    chatInput.placeholder = 'Message...';
    chatInput.autocomplete = 'off';
    chatInput.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.08);color:#fff;padding:9px 12px;border-radius:20px;font-size:12px;outline:none;';
    const sendBtn = document.createElement('button');
    sendBtn.textContent = '↑';
    sendBtn.style.cssText = 'background:#6366f1;color:#fff;border:none;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s,transform 0.15s;';
    sendBtn.onmouseenter = () => { sendBtn.style.background = '#4f46e5'; sendBtn.style.transform = 'scale(1.08)'; };
    sendBtn.onmouseleave = () => { sendBtn.style.background = '#6366f1'; sendBtn.style.transform = 'scale(1)'; };
    chatFooter.appendChild(chatInput);
    chatFooter.appendChild(sendBtn);
    chatPanel.appendChild(chatFooter);

    const sendMessage = () => {
        const text = chatInput.value.trim();
        if (text) { chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text }); chatInput.value = ''; }
    };
    sendBtn.onclick = sendMessage;
    chatInput.addEventListener('keydown',  e => e.stopPropagation());
    chatInput.addEventListener('keypress', e => { e.stopPropagation(); if (e.key === 'Enter') sendMessage(); });

    // ── PARTICIPANTS PANEL ────────────────────────────────────────────────────
    const pP = document.createElement('div');
    pP.id = 'ss-participants';
    pP.style.cssText = 'position:fixed;bottom:90px;left:24px;width:210px;background:rgba(8,8,16,0.96);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:14px;display:none;color:#fff;pointer-events:auto;box-shadow:0 8px 30px rgba(0,0,0,0.5);';
    root.appendChild(pP);
    makeDraggable(pP);

    // ── VIDEO GRID (logical container for draggable tiles) ────────────────────
    const grid = document.createElement('div');
    grid.id = 'ss-grid';
    grid.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;';
    root.appendChild(grid);
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
setInterval(() => {
    if (IS_TOP_FRAME && !document.getElementById('ss-root')) injectUI();
    const v = findMainVideo();
    if (v && v !== videoElement) {
        videoElement = v;
        v.onplay       = () => broadcastState('play');
        v.onpause      = () => broadcastState('pause');
        v.onseeked     = () => broadcastState('seek');
        v.onratechange = () => broadcastState('rate');
    }
}, 500);
