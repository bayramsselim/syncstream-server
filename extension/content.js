/**
 * SyncStream Pro - Content Script
 * Fixed: IS_TOP_FRAME guards, PLAYER_EVENT sync type, WebRTC media toggle,
 *        XSS in chat, chat keyboard events, addVideoTile null guard, TURN servers
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
    // Video sync runs in ALL frames (catches iframe players like dizigom)
    if (msg.type === 'SYNC_STATE') {
        applyRemoteSync(msg);
        return;
    }

    // Everything else: top frame only
    if (!IS_TOP_FRAME) return;

    if (msg.type === 'ROOM_STATE') {
        roomState = msg.data;
        if (roomState.myId) initPeers();
        updateParticipantPanel();
    }
    else if (msg.type === 'SIGNALING')    enqueueSignaling(msg.fromId, msg.payload);
    else if (msg.type === 'CHAT_MESSAGE') addChatMessage(msg.username, msg.text, msg.color);
    else if (msg.type === 'REACTION')     animateEmoji(msg.emoji);
    else if (msg.type === 'TOAST')        showToast(msg.message, msg.color);
});

// ─── SYNC ─────────────────────────────────────────────────────────────────────
function findMainVideo() {
    return Array.from(document.querySelectorAll('video'))
        .filter(v => v.offsetWidth > 100 && !v.id.startsWith('ss-v-'))
        .sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
}

function broadcastState(event = 'sync') {
    if (!videoElement || isSyncing || !roomState) return;
    // Must be PLAYER_EVENT — background.js forwards this to the server
    chrome.runtime.sendMessage({
        type: 'PLAYER_EVENT',
        event,
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

    console.log('[SyncStream] Creating peer:', name);
    const pc   = new RTCPeerConnection(ICE_SERVERS);
    const pObj = { pc, polite: roomState.myId < tid, makingOffer: false };
    peerConnections[tid] = pObj;

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { candidate } });
    };

    pc.ontrack = (event) => {
        console.log('[SyncStream] Remote track received from:', name);
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

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

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
            if (offerCollision && !p.polite) {
                processingSignaling = false;
                processQueue();
                return;
            }
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
                // Acquire stream once; use track.enabled to toggle without renegotiation
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
            // Enable/disable tracks — no renegotiation on every toggle
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
    } catch (e) {
        console.error('[SyncStream] Media error:', e);
        isMicOn = false; isCamOn = false;
    }
    updateButtons();
}

// ─── VIDEO TILES ──────────────────────────────────────────────────────────────
function addVideoTile(id, stream, name) {
    const grid = document.getElementById('ss-grid');
    if (!grid) return;

    let tile = document.getElementById(`ss-vid-${id}`);
    if (!tile) {
        tile = document.createElement('div');
        tile.id = `ss-vid-${id}`;
        tile.style.cssText = 'width:160px;height:120px;background:#000;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.2);pointer-events:auto;position:relative;';

        const v = document.createElement('video');
        v.id = `ss-v-${id}`;
        v.autoplay = true;
        v.playsInline = true;
        v.muted = (id === 'local');
        v.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        tile.appendChild(v);

        const lbl = document.createElement('div');
        lbl.textContent = name;
        lbl.style.cssText = 'position:absolute;bottom:5px;left:5px;font-size:10px;color:#fff;background:rgba(0,0,0,0.5);padding:2px 5px;border-radius:3px;pointer-events:none;';
        tile.appendChild(lbl);

        grid.appendChild(tile);
    }

    const vEl = document.getElementById(`ss-v-${id}`);
    if (vEl && vEl.srcObject !== stream) {
        vEl.srcObject = stream;
        // Retry with muted fallback to bypass autoplay policy
        vEl.play().catch(() => {
            vEl.muted = true;
            vEl.play().then(() => {
                if (id !== 'local') vEl.muted = false;
            }).catch(() => {});
        });
    }
}

function removeVideoTile(id) {
    const el = document.getElementById(`ss-vid-${id}`);
    if (el) el.remove();
}

// ─── CHAT & UI HELPERS ────────────────────────────────────────────────────────
function addChatMessage(user, text, color) {
    const msgs = document.getElementById('ss-msgs');
    if (!msgs) return;
    const m = document.createElement('div');
    m.style.cssText = 'font-size:12px;word-wrap:break-word;';
    const b = document.createElement('b');
    b.style.color = color || '#6366f1';
    b.textContent = user + ':';
    const s = document.createElement('span');
    s.style.color = '#fff';
    s.textContent = ' ' + text;
    m.appendChild(b);
    m.appendChild(s);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
}

function animateEmoji(emoji) {
    const e = document.createElement('div');
    e.textContent = emoji;
    e.style.cssText = `position:fixed;bottom:50px;left:${40 + Math.random() * 20}%;font-size:40px;transition:2s;opacity:1;z-index:999999;pointer-events:none;`;
    document.body.appendChild(e);
    setTimeout(() => { e.style.transform = 'translateY(-400px)'; e.style.opacity = '0'; }, 50);
    setTimeout(() => e.remove(), 2100);
}

function showToast(text, color) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#111;color:${color || '#fff'};padding:8px 16px;border-radius:10px;z-index:999999;font-size:13px;border:1px solid rgba(255,255,255,0.1);pointer-events:none;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function updateButtons() {
    const set = (id, c) => { const el = document.getElementById(id); if (el) el.style.background = c ? '#6366f1' : 'rgba(255,255,255,0.1)'; };
    set('ss-b-chat', isChatOpen);
    set('ss-b-mic', isMicOn);
    set('ss-b-cam', isCamOn);
}

function updateParticipantPanel() {
    const p = document.getElementById('ss-participants');
    if (!p || !roomState?.users) return;
    p.innerHTML = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:700;color:#6366f1;margin-bottom:8px;letter-spacing:0.05em;';
    title.textContent = 'USERS ONLINE';
    p.appendChild(title);
    roomState.users.forEach(u => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12px;margin-bottom:5px;display:flex;align-items:center;gap:6px;';
        const dot = document.createElement('div');
        dot.style.cssText = 'width:6px;height:6px;background:#10b981;border-radius:50%;flex-shrink:0;';
        const name = document.createElement('span');
        name.textContent = u.username + (u.isHost ? ' 👑' : '');
        row.appendChild(dot);
        row.appendChild(name);
        p.appendChild(row);
    });
}

// ─── UI INJECTION ─────────────────────────────────────────────────────────────
function injectUI() {
    if (!IS_TOP_FRAME || document.getElementById('ss-root')) return;

    const root = document.createElement('div');
    root.id = 'ss-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:sans-serif;';
    document.body.appendChild(root);

    // Dock
    const dock = document.createElement('div');
    dock.id = 'ss-dock';
    dock.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px;background:rgba(0,0,0,0.9);backdrop-filter:blur(20px);border-radius:30px;display:flex;gap:10px;align-items:center;pointer-events:auto;border:1px solid rgba(255,255,255,0.1);';

    const mkBtn = (emoji, id, h) => {
        const b = document.createElement('button');
        b.id = id; b.innerHTML = emoji;
        b.style.cssText = 'background:rgba(255,255,255,0.1);border:none;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:0.2s;';
        b.onclick = (e) => { e.stopPropagation(); h(); };
        return b;
    };

    dock.appendChild(mkBtn('💬', 'ss-b-chat', () => {
        isChatOpen = !isChatOpen;
        document.getElementById('ss-chat').style.display = isChatOpen ? 'flex' : 'none';
        updateButtons();
    }));
    dock.appendChild(mkBtn('🎤', 'ss-b-mic', () => { isMicOn = !isMicOn; updateMedia(); }));
    dock.appendChild(mkBtn('📷', 'ss-b-cam', () => { isCamOn = !isCamOn; updateMedia(); }));
    dock.appendChild(mkBtn('👥', 'ss-b-people', () => {
        const p = document.getElementById('ss-participants');
        if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
    }));

    ['❤️', '😂', '🔥', '😮', '👏'].forEach(em => {
        dock.appendChild(mkBtn(em, '', () => chrome.runtime.sendMessage({ type: 'REACTION', emoji: em })));
    });

    root.appendChild(dock);

    // Chat panel (built with DOM — no innerHTML with user data)
    const chat = document.createElement('div');
    chat.id = 'ss-chat';
    chat.style.cssText = 'position:fixed;bottom:90px;right:24px;width:280px;height:350px;background:rgba(0,0,0,0.95);border:1px solid rgba(255,255,255,0.1);border-radius:15px;display:none;flex-direction:column;pointer-events:auto;';
    root.appendChild(chat);

    const chatHeader = document.createElement('div');
    chatHeader.style.cssText = 'padding:10px;border-bottom:1px solid #333;color:#fff;font-size:12px;font-weight:700;';
    chatHeader.textContent = 'CHAT';
    chat.appendChild(chatHeader);

    const msgs = document.createElement('div');
    msgs.id = 'ss-msgs';
    msgs.style.cssText = 'flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:5px;';
    chat.appendChild(msgs);

    const chatFooter = document.createElement('div');
    chatFooter.style.cssText = 'padding:10px;display:flex;gap:5px;';
    const chatInput = document.createElement('input');
    chatInput.id = 'ss-chat-in';
    chatInput.placeholder = 'Type...';
    chatInput.autocomplete = 'off';
    chatInput.style.cssText = 'flex:1;background:#222;border:none;color:#fff;padding:8px;border-radius:8px;font-size:12px;outline:none;';
    const sendBtn = document.createElement('button');
    sendBtn.id = 'ss-chat-send';
    sendBtn.textContent = '>';
    sendBtn.style.cssText = 'background:#6366f1;color:#fff;border:none;padding:0 12px;border-radius:8px;cursor:pointer;font-weight:700;';
    chatFooter.appendChild(chatInput);
    chatFooter.appendChild(sendBtn);
    chat.appendChild(chatFooter);

    const sendMessage = () => {
        const text = chatInput.value.trim();
        if (text) {
            chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text });
            chatInput.value = '';
        }
    };
    sendBtn.onclick = sendMessage;
    // Prevent page hotkeys from firing while typing in chat
    chatInput.addEventListener('keydown', e => e.stopPropagation());
    chatInput.addEventListener('keypress', e => { e.stopPropagation(); if (e.key === 'Enter') sendMessage(); });

    // Participants panel
    const pP = document.createElement('div');
    pP.id = 'ss-participants';
    pP.style.cssText = 'position:fixed;bottom:90px;left:24px;width:200px;background:rgba(0,0,0,0.95);border:1px solid rgba(255,255,255,0.1);border-radius:15px;padding:12px;display:none;color:#fff;pointer-events:auto;';
    root.appendChild(pP);

    // Video grid
    const grid = document.createElement('div');
    grid.id = 'ss-grid';
    grid.style.cssText = 'position:fixed;top:20px;right:20px;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
    root.appendChild(grid);
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
setInterval(() => {
    if (IS_TOP_FRAME && !document.getElementById('ss-root')) injectUI();

    const v = findMainVideo();
    if (v && v !== videoElement) {
        videoElement = v;
        v.onplay      = () => broadcastState('play');
        v.onpause     = () => broadcastState('pause');
        v.onseeked    = () => broadcastState('seek');
        v.onratechange = () => broadcastState('rate');
    }
}, 500);
