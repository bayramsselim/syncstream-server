/**
 * SyncStream Pro - Content Script v2.0
 * Features: draggable dock/tiles, auto-hide, screen share, keyboard shortcuts,
 *           sync indicator, volume slider, now playing, notification sound,
 *           unread badge, perf-optimized interval
 */

// ─── STATE ────────────────────────────────────────────────────────────────────
let videoElement    = null;
let isSyncing       = false;
let roomState       = null;
let localStream     = null;
let screenStream    = null;
let peerConnections = {};
let signalingQueue  = [];
let processingSignaling = false;

let isMicOn         = false;
let isCamOn         = false;
let isScreenSharing = false;
let isChatOpen      = false;
let unreadCount     = 0;
let lastTitle       = '';
let videoFound      = false; // slows interval after first attach

const IS_TOP_FRAME = (window === window.top);
const ICE_SERVERS  = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
    if (res) { roomState = res; if (IS_TOP_FRAME && roomState.myId) initPeers(); }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SYNC_STATE') { applyRemoteSync(msg); return; }
    if (!IS_TOP_FRAME) return;

    if      (msg.type === 'ROOM_STATE')    { roomState = msg.data; if (roomState.myId) initPeers(); updateParticipantPanel(); }
    else if (msg.type === 'SIGNALING')     enqueueSignaling(msg.fromId, msg.payload);
    else if (msg.type === 'CHAT_MESSAGE')  handleIncomingChat(msg.username, msg.text, msg.color);
    else if (msg.type === 'REACTION')      animateEmoji(msg.emoji);
    else if (msg.type === 'TOAST')         showToast(msg.message, msg.color);
    else if (msg.type === 'NOW_PLAYING')   { const el = document.getElementById('ss-np-title'); if (el) el.textContent = msg.title; }
});

// ─── VIDEO SYNC ───────────────────────────────────────────────────────────────
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

    // Show sync indicator with who triggered it
    showSyncIndicator(msg.byUsername);

    const diff = Math.abs(videoElement.currentTime - msg.time);
    if (msg.event === 'seek' || diff > 1.2) videoElement.currentTime = msg.time;
    if (msg.playbackRate) videoElement.playbackRate = msg.playbackRate;
    if (msg.event === 'play'  && videoElement.paused)  videoElement.play().catch(() => {});
    if (msg.event === 'pause' && !videoElement.paused) videoElement.pause();
    setTimeout(() => { isSyncing = false; }, 500);
}

function showSyncIndicator(byUser) {
    const ind = document.getElementById('ss-sync-ind');
    if (!ind) return;
    ind.textContent = byUser ? `⟳ synced by ${byUser}` : '⟳ syncing...';
    ind.style.opacity = '1';
    clearTimeout(ind._t);
    ind._t = setTimeout(() => { ind.style.opacity = '0'; }, 2000);
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
    pc.ontrack = (event) => { const s = event.streams[0]; if (s) addVideoTile(tid, s, name); };
    pc.onnegotiationneeded = async () => {
        try {
            pObj.makingOffer = true;
            await pc.setLocalDescription();
            chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { description: pc.localDescription } });
        } catch (e) { console.error('[SS] Negotiation:', e); } finally { pObj.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    return pObj;
}

function enqueueSignaling(fromId, payload) { signalingQueue.push({ fromId, payload }); processQueue(); }

async function processQueue() {
    if (processingSignaling || !signalingQueue.length) return;
    processingSignaling = true;
    const { fromId, payload } = signalingQueue.shift();
    try {
        let p = peerConnections[fromId];
        if (!p) { const u = roomState?.users?.find(x => x.id === fromId); p = await createPeer(fromId, u?.username || 'User'); }
        if (payload.description) {
            const collision = payload.description.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
            if (collision && !p.polite) { processingSignaling = false; processQueue(); return; }
            await p.pc.setRemoteDescription(payload.description);
            if (payload.description.type === 'offer') {
                await p.pc.setLocalDescription();
                chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: fromId, payload: { description: p.pc.localDescription } });
            }
        } else if (payload.candidate) { await p.pc.addIceCandidate(payload.candidate).catch(() => {}); }
    } catch (e) { console.error('[SS] Signaling:', e); }
    processingSignaling = false;
    processQueue();
}

// ─── MEDIA ────────────────────────────────────────────────────────────────────
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
                        const ex = pc.getSenders().find(s => s.track?.kind === track.kind);
                        if (ex) ex.replaceTrack(track); else pc.addTrack(track, localStream);
                    });
                });
            }
            localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
            localStream.getVideoTracks().forEach(t => t.enabled = isCamOn && !isScreenSharing);
            if (isCamOn && !isScreenSharing) addVideoTile('local', localStream, 'You');
            else if (!isScreenSharing) removeVideoTile('local');
        } else {
            if (localStream && !isScreenSharing) {
                localStream.getTracks().forEach(t => t.stop());
                localStream = null;
                Object.values(peerConnections).forEach(({ pc }) => {
                    pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch (_) {} });
                });
                removeVideoTile('local');
            }
        }
    } catch (e) { console.error('[SS] Media:', e); isMicOn = false; isCamOn = false; }
    updateButtons();
}

async function toggleScreenShare() {
    if (isScreenSharing) {
        if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
        isScreenSharing = false;
        // Restore camera track if cam is on
        Object.values(peerConnections).forEach(({ pc }) => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            const camTrack = localStream?.getVideoTracks()[0];
            if (sender && camTrack) sender.replaceTrack(camTrack);
            else if (sender) pc.removeTrack(sender);
        });
        if (isCamOn && localStream) addVideoTile('local', localStream, 'You');
        else removeVideoTile('local');
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            isScreenSharing = true;
            const screenTrack = screenStream.getVideoTracks()[0];

            Object.values(peerConnections).forEach(({ pc }) => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(screenTrack);
                else pc.addTrack(screenTrack, screenStream);
            });
            addVideoTile('local', screenStream, '🖥 Screen');

            // Auto-stop when browser chrome "Stop sharing" is clicked
            screenTrack.onended = () => { isScreenSharing = false; toggleScreenShare(); };
        } catch (e) {
            console.error('[SS] Screen share:', e);
            isScreenSharing = false;
        }
    }
    updateButtons();
}

// ─── DRAG HELPER ──────────────────────────────────────────────────────────────
function makeDraggable(el, handle) {
    handle = handle || el;
    handle.style.cursor = 'grab';
    let ox, oy, startL, startT;
    handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
        el.style.bottom = 'auto'; el.style.right = 'auto'; el.style.transform = 'none';
        ox = e.clientX; oy = e.clientY; startL = r.left; startT = r.top;
        handle.style.cursor = 'grabbing';
        const onMove = (e) => {
            el.style.left = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startL + e.clientX - ox)) + 'px';
            el.style.top  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startT + e.clientY - oy)) + 'px';
        };
        const onUp = () => { handle.style.cursor = 'grab'; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
}

// ─── GALLERY LAYOUT ───────────────────────────────────────────────────────────
// Returns grid columns and tile dimensions based on participant count
function getLayout(count) {
    if (count <= 1) return { cols: 1, tw: 300, th: 225 };
    if (count <= 2) return { cols: 2, tw: 220, th: 165 };
    if (count <= 4) return { cols: 2, tw: 190, th: 143 };
    if (count <= 6) return { cols: 3, tw: 160, th: 120 };
    if (count <= 9) return { cols: 3, tw: 148, th: 111 };
    return              { cols: 4, tw: 130, th:  98 };
}

const GAP = 6, PAD = 8, HEADER_H = 34;

function updateGalleryLayout() {
    const inner   = document.getElementById('ss-grid-inner');
    const gallery = document.getElementById('ss-gallery');
    const counter = document.getElementById('ss-gallery-count');
    if (!inner || !gallery) return;

    const allTiles     = Array.from(inner.querySelectorAll('[id^="ss-vid-"]'));
    const visibleTiles = allTiles.filter(t => t.style.display !== 'none');
    const hiddenCount  = allTiles.length - visibleTiles.length;
    const count        = visibleTiles.length;

    // Show/hide "Show All" button in gallery header
    const showAllBtn = document.getElementById('ss-gallery-showall');
    if (showAllBtn) showAllBtn.style.display = hiddenCount > 0 ? 'inline-block' : 'none';

    if (allTiles.length === 0) { gallery.style.display = 'none'; return; }
    gallery.style.display = 'flex';

    if (count === 0) {
        // All hidden — show just the header
        gallery.style.height = HEADER_H + 'px';
        if (counter) counter.textContent = `0/${allTiles.length}`;
        return;
    }

    const { cols, tw, th } = getLayout(count);
    const rows = Math.ceil(count / cols);

    const panelW = cols * tw + (cols - 1) * GAP + PAD * 2;
    const panelH = rows * th + (rows - 1) * GAP + PAD * 2 + HEADER_H;
    gallery.style.width = panelW + 'px';

    const isMinimized = inner.style.display === 'none';
    if (!isMinimized) gallery.style.height = panelH + 'px';

    inner.style.gridTemplateColumns = `repeat(${cols}, ${tw}px)`;

    visibleTiles.forEach(tile => {
        tile.style.width  = tw + 'px';
        tile.style.height = th + 'px';
        tile.style.opacity = '1';
    });

    if (counter) counter.textContent = hiddenCount > 0 ? `${count}/${allTiles.length}` : String(count);
}

// ─── VIDEO TILES ──────────────────────────────────────────────────────────────
function addVideoTile(id, stream, name) {
    const inner = document.getElementById('ss-grid-inner');
    if (!inner) return;

    let tile = document.getElementById(`ss-vid-${id}`);
    // If tile was manually hidden, restore it
    if (tile && tile.style.display === 'none') {
        tile.style.display = '';
        requestAnimationFrame(() => { tile.style.opacity = '1'; });
        updateGalleryLayout();
    }
    if (!tile) {
        tile = document.createElement('div');
        tile.id = `ss-vid-${id}`;
        tile.style.cssText = 'background:#000;border-radius:10px;overflow:hidden;position:relative;flex-shrink:0;transition:width 0.3s,height 0.3s,opacity 0.25s;opacity:0;';

        const v = document.createElement('video');
        v.id = `ss-v-${id}`; v.autoplay = true; v.playsInline = true; v.muted = (id === 'local');
        v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        tile.appendChild(v);

        // Name label
        const lbl = document.createElement('div');
        lbl.textContent = name;
        lbl.style.cssText = 'position:absolute;bottom:6px;left:8px;font-size:10px;color:#fff;background:rgba(0,0,0,0.6);padding:2px 7px;border-radius:4px;pointer-events:none;letter-spacing:0.02em;';
        tile.appendChild(lbl);

        // Hide button (top-right)
        const hideBtn = document.createElement('button');
        hideBtn.textContent = '✕';
        hideBtn.title = 'Hide';
        hideBtn.style.cssText = 'position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.55);border:none;color:#fff;font-size:10px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:background 0.15s;z-index:2;';
        hideBtn.onclick = (e) => { e.stopPropagation(); tile.style.opacity = '0'; setTimeout(() => { tile.style.display = 'none'; updateGalleryLayout(); }, 280); };
        tile.appendChild(hideBtn);

        // Volume overlay (bottom, remote only) — appears on hover
        if (id !== 'local') {
            const volBar = document.createElement('div');
            volBar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:6px 8px;display:flex;align-items:center;gap:6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));opacity:0;transition:opacity 0.2s;pointer-events:auto;';
            const volIcon = document.createElement('span');
            volIcon.textContent = '🔊'; volIcon.style.cssText = 'font-size:11px;cursor:pointer;flex-shrink:0;color:#fff;';
            const volSlider = document.createElement('input');
            volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05'; volSlider.value = '1';
            volSlider.style.cssText = 'flex:1;height:3px;cursor:pointer;accent-color:#6366f1;';
            volSlider.oninput = () => {
                const vEl = document.getElementById(`ss-v-${id}`);
                if (vEl) { vEl.volume = parseFloat(volSlider.value); vEl.muted = vEl.volume === 0; }
                volIcon.textContent = parseFloat(volSlider.value) === 0 ? '🔇' : '🔊';
            };
            volIcon.onclick = () => {
                const vEl = document.getElementById(`ss-v-${id}`);
                if (!vEl) return;
                vEl.muted = !vEl.muted;
                volSlider.value = vEl.muted ? '0' : '1';
                volIcon.textContent = vEl.muted ? '🔇' : '🔊';
            };
            volBar.appendChild(volIcon); volBar.appendChild(volSlider);
            tile.appendChild(volBar);

            tile.onmouseenter = () => { volBar.style.opacity = '1'; hideBtn.style.display = 'flex'; };
            tile.onmouseleave = () => { volBar.style.opacity = '0'; hideBtn.style.display = 'none'; };
        } else {
            tile.onmouseenter = () => { hideBtn.style.display = 'flex'; };
            tile.onmouseleave = () => { hideBtn.style.display = 'none'; };
        }

        inner.appendChild(tile);
        updateGalleryLayout();
    }

    const vEl = document.getElementById(`ss-v-${id}`);
    if (vEl && vEl.srcObject !== stream) {
        vEl.srcObject = stream;
        vEl.play().catch(() => { vEl.muted = true; vEl.play().then(() => { if (id !== 'local') vEl.muted = false; }).catch(() => {}); });
    }
}

function removeVideoTile(id) {
    const el = document.getElementById(`ss-vid-${id}`);
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => { el.remove(); updateGalleryLayout(); }, 280);
}

// ─── NOTIFICATION SOUND ───────────────────────────────────────────────────────
function playNotifSound() {
    try {
        const ctx  = new AudioContext();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880,  ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(); osc.stop(ctx.currentTime + 0.35);
    } catch (_) {}
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function handleIncomingChat(user, text, color) {
    addChatMessage(user, text, color);
    if (!isChatOpen) {
        unreadCount++;
        updateUnreadBadge();
        playNotifSound();
        const btn = document.getElementById('ss-b-chat');
        if (btn) { btn.style.background = '#f59e0b'; setTimeout(() => updateButtons(), 900); }
    }
}

function updateUnreadBadge() {
    const b = document.getElementById('ss-chat-badge');
    if (!b) return;
    b.textContent  = unreadCount > 9 ? '9+' : unreadCount;
    b.style.display = unreadCount > 0 ? 'flex' : 'none';
}

function addChatMessage(user, text, color) {
    const msgs = document.getElementById('ss-msgs');
    if (!msgs) return;
    const m = document.createElement('div');
    m.style.cssText = 'font-size:12px;word-wrap:break-word;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);animation:ss-fadein 0.2s ease;';
    const b = document.createElement('b');
    b.style.color = color || '#6366f1'; b.textContent = user + ':';
    const s = document.createElement('span');
    s.style.color = '#ddd'; s.textContent = ' ' + text;
    m.appendChild(b); m.appendChild(s);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
}

// ─── EMOJI & TOAST ────────────────────────────────────────────────────────────
function animateEmoji(emoji) {
    const e = document.createElement('div');
    e.textContent = emoji;
    e.style.cssText = `position:fixed;bottom:100px;left:${38+Math.random()*24}%;font-size:44px;z-index:999999;pointer-events:none;transition:transform 1.8s cubic-bezier(0.2,0.8,0.4,1),opacity 1.8s ease;opacity:1;`;
    document.body.appendChild(e);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        e.style.transform = `translateY(-380px) rotate(${(Math.random()-.5)*30}deg) scale(1.4)`;
        e.style.opacity   = '0';
    }));
    setTimeout(() => e.remove(), 2000);
}

function showToast(text, color) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-10px);background:rgba(10,10,20,0.95);color:${color||'#fff'};padding:8px 18px;border-radius:20px;z-index:999999;font-size:12px;font-weight:600;letter-spacing:0.04em;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:none;transition:transform 0.3s ease,opacity 0.3s ease;opacity:0;`;
    document.body.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => { t.style.transform = 'translateX(-50%) translateY(0)'; t.style.opacity = '1'; }));
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(-10px)'; }, 2700);
    setTimeout(() => t.remove(), 3100);
}

// ─── BUTTONS ─────────────────────────────────────────────────────────────────
function updateButtons() {
    const active = '#6366f1', idle = 'rgba(255,255,255,0.08)';
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.style.background = on ? active : idle; };
    set('ss-b-chat',   isChatOpen);
    set('ss-b-mic',    isMicOn);
    set('ss-b-cam',    isCamOn);
    set('ss-b-screen', isScreenSharing);
}

function updateParticipantPanel() {
    const p = document.getElementById('ss-participants');
    if (!p || !roomState?.users) return;
    p.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:700;color:#6366f1;margin-bottom:10px;letter-spacing:0.05em;';
    title.textContent = `ONLINE (${roomState.users.length})`;
    p.appendChild(title);
    roomState.users.forEach(u => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12px;margin-bottom:7px;display:flex;align-items:center;gap:8px;';
        const av = document.createElement('div');
        av.style.cssText = `width:26px;height:26px;border-radius:50%;background:${u.color||'#6366f1'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#111;flex-shrink:0;`;
        av.textContent = u.username.charAt(0).toUpperCase();
        const name = document.createElement('span');
        name.style.cssText = 'color:#ddd;flex:1;';
        name.textContent = u.username + (u.isHost ? ' 👑' : '') + (u.isInCall ? ' 🎤' : '');
        row.appendChild(av); row.appendChild(name);
        p.appendChild(row);
    });
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const actions = {
        'm': () => { isMicOn = !isMicOn; updateMedia(); showToast(isMicOn ? '🎤 Mic ON' : '🎤 Mic OFF'); },
        'c': () => { isCamOn = !isCamOn; updateMedia(); showToast(isCamOn ? '📷 Camera ON' : '📷 Camera OFF'); },
        's': () => { toggleScreenShare(); showToast(isScreenSharing ? '🖥 Screen Share ON' : '🖥 Screen Share OFF'); },
        't': () => {
            isChatOpen = !isChatOpen;
            const chat = document.getElementById('ss-chat');
            if (chat) { chat.style.display = isChatOpen ? 'flex' : 'none'; if (isChatOpen) { unreadCount = 0; updateUnreadBadge(); } }
            updateButtons();
        },
        'p': () => { const p = document.getElementById('ss-participants'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
    };

    const handler = actions[e.key.toLowerCase()];
    if (handler) { e.preventDefault(); handler(); }
}, true);

// ─── UI INJECTION ─────────────────────────────────────────────────────────────
function injectUI() {
    if (!IS_TOP_FRAME || document.getElementById('ss-root')) return;

    const root = document.createElement('div');
    root.id = 'ss-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;';
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
        @keyframes ss-fadein { from { opacity:0;transform:translateY(4px); } to { opacity:1;transform:none; } }
        #ss-dock { transition: opacity 0.35s ease, transform 0.35s ease; }
        #ss-dock.ss-hidden { opacity:0 !important; transform:translateX(-50%) translateY(14px) !important; pointer-events:none !important; }
        #ss-msgs::-webkit-scrollbar { width:3px; }
        #ss-msgs::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }
    `;
    document.head.appendChild(style);

    // ── DOCK ─────────────────────────────────────────────────────────────────
    const dock = document.createElement('div');
    dock.id = 'ss-dock';
    dock.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 14px;background:rgba(6,6,14,0.93);backdrop-filter:blur(24px);border-radius:32px;display:flex;gap:8px;align-items:center;pointer-events:auto;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 32px rgba(0,0,0,0.65);';

    const mkBtn = (emoji, id, handler, tip) => {
        const b = document.createElement('button');
        b.id = id; b.innerHTML = emoji; b.title = tip || '';
        b.style.cssText = 'background:rgba(255,255,255,0.08);border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:background 0.2s,transform 0.15s;position:relative;flex-shrink:0;';
        b.onmouseenter = () => { b.style.transform='scale(1.12)'; b.style.background='rgba(255,255,255,0.18)'; };
        b.onmouseleave = () => { b.style.transform='scale(1)'; updateButtons(); };
        b.onclick = (e) => { e.stopPropagation(); handler(); };
        return b;
    };

    // Chat btn + badge
    const chatBtn = mkBtn('💬', 'ss-b-chat', () => {
        isChatOpen = !isChatOpen;
        chatPanel.style.display = isChatOpen ? 'flex' : 'none';
        if (isChatOpen) { unreadCount = 0; updateUnreadBadge(); const i = document.getElementById('ss-chat-in'); if (i) i.focus(); }
        updateButtons();
    }, 'Chat (Alt+T)');
    const badge = document.createElement('div');
    badge.id = 'ss-chat-badge';
    badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center;pointer-events:none;';
    chatBtn.appendChild(badge);
    dock.appendChild(chatBtn);

    dock.appendChild(mkBtn('🎤', 'ss-b-mic',    () => { isMicOn = !isMicOn; updateMedia(); },          'Mic (Alt+M)'));
    dock.appendChild(mkBtn('📷', 'ss-b-cam',    () => { isCamOn = !isCamOn; updateMedia(); },          'Camera (Alt+C)'));
    dock.appendChild(mkBtn('🖥',  'ss-b-screen', () => toggleScreenShare(),                             'Screen Share (Alt+S)'));
    dock.appendChild(mkBtn('👥', 'ss-b-people', () => { const p = document.getElementById('ss-participants'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }, 'Participants (Alt+P)'));

    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.1);margin:0 2px;flex-shrink:0;';
    dock.appendChild(sep);

    ['❤️','😂','🔥','😮','👏'].forEach(em => {
        dock.appendChild(mkBtn(em, '', () => chrome.runtime.sendMessage({ type: 'REACTION', emoji: em })));
    });

    // Now Playing label inside dock
    const npLabel = document.createElement('div');
    npLabel.style.cssText = 'margin-left:6px;padding-left:10px;border-left:1px solid rgba(255,255,255,0.1);max-width:160px;flex-shrink:1;overflow:hidden;';
    npLabel.innerHTML = '<div style="font-size:9px;color:#555;letter-spacing:0.06em;text-transform:uppercase;">Now Playing</div>';
    const npTitle = document.createElement('div');
    npTitle.id = 'ss-np-title';
    npTitle.style.cssText = 'font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    npTitle.textContent = '—';
    npLabel.appendChild(npTitle);
    dock.appendChild(npLabel);

    root.appendChild(dock);
    makeDraggable(dock);

    // ── AUTO-HIDE ─────────────────────────────────────────────────────────────
    let hideTimer;
    const showDock = () => {
        dock.classList.remove('ss-hidden');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (!dock.matches(':hover')) dock.classList.add('ss-hidden'); }, 3000);
    };
    document.addEventListener('mousemove', showDock, { passive: true });
    dock.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    dock.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => dock.classList.add('ss-hidden'), 3000); });
    showDock();

    // ── SYNC INDICATOR ────────────────────────────────────────────────────────
    const syncInd = document.createElement('div');
    syncInd.id = 'ss-sync-ind';
    syncInd.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(99,102,241,0.92);color:#fff;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;z-index:999999;pointer-events:none;opacity:0;transition:opacity 0.4s ease;letter-spacing:0.04em;';
    root.appendChild(syncInd);

    // ── CHAT PANEL ────────────────────────────────────────────────────────────
    const chatPanel = document.createElement('div');
    chatPanel.id = 'ss-chat';
    chatPanel.style.cssText = 'position:fixed;bottom:90px;right:24px;width:290px;height:360px;background:rgba(6,6,14,0.97);border:1px solid rgba(255,255,255,0.09);border-radius:16px;display:none;flex-direction:column;pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,0.65);overflow:hidden;';
    root.appendChild(chatPanel);
    makeDraggable(chatPanel);

    const chatHeader = document.createElement('div');
    chatHeader.style.cssText = 'padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.07);color:#fff;font-size:12px;font-weight:700;letter-spacing:0.06em;display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;';
    chatHeader.textContent = 'CHAT';
    const closeChat = document.createElement('button');
    closeChat.textContent = '✕';
    closeChat.style.cssText = 'background:none;border:none;color:#555;cursor:pointer;font-size:13px;padding:0;transition:color 0.2s;';
    closeChat.onmouseenter = () => closeChat.style.color = '#fff';
    closeChat.onmouseleave = () => closeChat.style.color = '#555';
    closeChat.onclick = () => { isChatOpen = false; chatPanel.style.display = 'none'; updateButtons(); };
    chatHeader.appendChild(closeChat);
    chatPanel.appendChild(chatHeader);

    const msgs = document.createElement('div');
    msgs.id = 'ss-msgs';
    msgs.style.cssText = 'flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:2px;';
    chatPanel.appendChild(msgs);

    const chatFooter = document.createElement('div');
    chatFooter.style.cssText = 'padding:10px 12px;display:flex;gap:8px;border-top:1px solid rgba(255,255,255,0.06);';
    const chatInput = document.createElement('input');
    chatInput.id = 'ss-chat-in';
    chatInput.placeholder = 'Message...'; chatInput.autocomplete = 'off';
    chatInput.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.08);color:#fff;padding:9px 12px;border-radius:20px;font-size:12px;outline:none;transition:border-color 0.2s;';
    chatInput.onfocus = () => chatInput.style.borderColor = '#6366f1';
    chatInput.onblur  = () => chatInput.style.borderColor = 'rgba(255,255,255,0.08)';
    const sendBtn = document.createElement('button');
    sendBtn.textContent = '↑';
    sendBtn.style.cssText = 'background:#6366f1;color:#fff;border:none;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.2s,transform 0.15s;';
    sendBtn.onmouseenter = () => { sendBtn.style.background='#4f46e5'; sendBtn.style.transform='scale(1.08)'; };
    sendBtn.onmouseleave = () => { sendBtn.style.background='#6366f1'; sendBtn.style.transform='scale(1)'; };
    chatFooter.appendChild(chatInput); chatFooter.appendChild(sendBtn);
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
    pP.style.cssText = 'position:fixed;bottom:90px;left:24px;width:210px;background:rgba(6,6,14,0.97);border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:14px;display:none;color:#fff;pointer-events:auto;box-shadow:0 8px 30px rgba(0,0,0,0.55);';
    root.appendChild(pP);
    makeDraggable(pP);

    // ── VIDEO GALLERY ─────────────────────────────────────────────────────────
    const gallery = document.createElement('div');
    gallery.id = 'ss-gallery';
    gallery.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(6,6,14,0.92);border:1px solid rgba(255,255,255,0.1);border-radius:14px;display:none;flex-direction:column;pointer-events:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);overflow:hidden;z-index:2147483640;transition:width 0.3s,height 0.3s;min-width:80px;';

    const galleryHeader = document.createElement('div');
    galleryHeader.style.cssText = 'height:34px;padding:0 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;cursor:grab;user-select:none;';
    const galleryTitle = document.createElement('span');
    galleryTitle.style.cssText = 'font-size:10px;font-weight:700;color:#6366f1;letter-spacing:0.08em;';
    galleryTitle.textContent = 'PARTICIPANTS';
    const galleryCount = document.createElement('span');
    galleryCount.id = 'ss-gallery-count';
    galleryCount.style.cssText = 'font-size:10px;color:#555;margin-left:5px;';
    galleryCount.textContent = '0';
    const galleryMinBtn = document.createElement('button');
    galleryMinBtn.textContent = '−';
    galleryMinBtn.title = 'Minimize';
    galleryMinBtn.style.cssText = 'background:none;border:none;color:#555;cursor:pointer;font-size:15px;padding:0 2px;line-height:1;transition:color 0.15s;flex-shrink:0;';
    galleryMinBtn.onmouseenter = () => { galleryMinBtn.style.color = '#fff'; };
    galleryMinBtn.onmouseleave = () => { galleryMinBtn.style.color = '#555'; };
    let galleryMinimized = false;
    galleryMinBtn.onclick = (e) => {
        e.stopPropagation();
        galleryMinimized = !galleryMinimized;
        gridInner.style.display = galleryMinimized ? 'none' : 'grid';
        galleryMinBtn.textContent = galleryMinimized ? '+' : '−';
        if (!galleryMinimized) updateGalleryLayout();
        else gallery.style.height = '34px';
    };

    const showAllBtn = document.createElement('button');
    showAllBtn.id = 'ss-gallery-showall';
    showAllBtn.textContent = 'Hepsini Göster';
    showAllBtn.style.cssText = 'display:none;background:rgba(99,102,241,0.25);border:none;color:#818cf8;cursor:pointer;font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px;letter-spacing:0.04em;transition:background 0.15s;flex-shrink:0;';
    showAllBtn.onmouseenter = () => { showAllBtn.style.background = 'rgba(99,102,241,0.45)'; };
    showAllBtn.onmouseleave = () => { showAllBtn.style.background = 'rgba(99,102,241,0.25)'; };
    showAllBtn.onclick = (e) => {
        e.stopPropagation();
        const gi = document.getElementById('ss-grid-inner');
        if (!gi) return;
        gi.querySelectorAll('[id^="ss-vid-"]').forEach(t => {
            if (t.style.display === 'none') { t.style.display = ''; t.style.opacity = '0'; requestAnimationFrame(() => { t.style.opacity = '1'; }); }
        });
        updateGalleryLayout();
    };

    const titleWrap = document.createElement('span');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:0;';
    titleWrap.appendChild(galleryTitle);
    titleWrap.appendChild(galleryCount);
    const headerRight = document.createElement('span');
    headerRight.style.cssText = 'display:flex;align-items:center;gap:6px;';
    headerRight.appendChild(showAllBtn);
    headerRight.appendChild(galleryMinBtn);
    galleryHeader.appendChild(titleWrap);
    galleryHeader.appendChild(headerRight);
    gallery.appendChild(galleryHeader);

    const gridInner = document.createElement('div');
    gridInner.id = 'ss-grid-inner';
    gridInner.style.cssText = 'display:grid;gap:6px;padding:8px;box-sizing:content-box;';
    gallery.appendChild(gridInner);

    root.appendChild(gallery);
    makeDraggable(gallery, galleryHeader);

    // ── KEYBOARD SHORTCUT TOOLTIP ─────────────────────────────────────────────
    const kbHint = document.createElement('div');
    kbHint.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(255,255,255,0.2);pointer-events:none;white-space:nowrap;';
    kbHint.textContent = 'Alt+M mic · Alt+C cam · Alt+S screen · Alt+T chat · Alt+P people';
    root.appendChild(kbHint);
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
// Runs at 500ms until video is found, then slows to 2000ms to save CPU
let loopInterval = null;

function mainLoop() {
    if (IS_TOP_FRAME && !document.getElementById('ss-root')) injectUI();

    const v = findMainVideo();
    if (v && v !== videoElement) {
        videoElement = v;
        videoFound   = true;
        v.onplay       = () => broadcastState('play');
        v.onpause      = () => broadcastState('pause');
        v.onseeked     = () => broadcastState('seek');
        v.onratechange = () => broadcastState('rate');
        // Slow down now that we have the video
        clearInterval(loopInterval);
        loopInterval = setInterval(mainLoop, 2000);
    }

    // Now Playing — detect title change and report
    if (IS_TOP_FRAME && roomState) {
        let title = document.title;
        const h1 = document.querySelector('h1.ytd-video-primary-info-renderer, h1[class*="title"], .video-title');
        if (h1?.innerText) title = h1.innerText.trim();
        if (title && title !== lastTitle && title !== document.location.hostname) {
            lastTitle = title;
            chrome.runtime.sendMessage({ type: 'UPDATE_NOW_PLAYING', title, url: window.location.href }).catch(() => {});
            const npEl = document.getElementById('ss-np-title');
            if (npEl) npEl.textContent = title;
        }
    }
}

loopInterval = setInterval(mainLoop, 500);
