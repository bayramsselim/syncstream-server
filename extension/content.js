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
let videoFound      = false;
let lastHostId      = null;
let isAway          = false;
let awayTimer       = null;

const IS_TOP_FRAME = (window === window.top);
const ICE_SERVERS  = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302'  },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'turn:freestun.net:3478',  username: 'free', credential: 'free' },
        { urls: 'turns:freestun.net:5349', username: 'free', credential: 'free' },
        { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
    if (res?.myId) {
        roomState = res;
        // Signal content-main.js (MAIN world) in THIS frame — works in iframes too
        document.documentElement.setAttribute('data-ss-active', '1');
        if (IS_TOP_FRAME) {
            injectUI();
            syncAvatarTiles(res.users || []);
            initPeers();
            try {
                chrome.storage.session.get(['ssMicOn', 'ssCamOn'], (stored) => {
                    if (chrome.runtime.lastError || !stored) return;
                    if (stored.ssMicOn || stored.ssCamOn) {
                        isMicOn = stored.ssMicOn || false;
                        isCamOn = stored.ssCamOn || false;
                        updateMedia();
                    }
                });
            } catch (_) { /* storage.session unavailable in this context */ }
        }
    } else if (IS_TOP_FRAME) {
        try {
            const hash = window.location.hash;
            const code = hash.match(/ss_room=([A-Z0-9]+)/i)?.[1];
            if (code) setTimeout(() => showJoinPrompt(code.toUpperCase()), 1500);
        } catch (_) {}
    }
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SYNC_STATE') { applyRemoteSync(msg); return; }

    // Keep data-ss-active in sync in ALL frames (needed by content-main.js intercept)
    if (msg.type === 'ROOM_STATE' && msg.data?.roomId) {
        document.documentElement.setAttribute('data-ss-active', '1');
    } else if (msg.type === 'ROOM_STATE' && !msg.data?.roomId) {
        document.documentElement.removeAttribute('data-ss-active');
    }

    if (!IS_TOP_FRAME) return;

    if      (msg.type === 'ROOM_STATE')    {
        const prevHostId = lastHostId;
        roomState = msg.data;
        if (roomState.myId) initPeers();
        updateParticipantPanel();
        syncAvatarTiles(roomState.users || []);
        // Close & remove peer connections for users who left
        const activeIds = new Set((roomState.users || []).map(u => u.id));
        Object.keys(peerConnections).forEach(peerId => {
            if (!activeIds.has(peerId)) {
                peerConnections[peerId]?.pc?.close();
                delete peerConnections[peerId];
            }
        });
        const _rt = document.getElementById('ss-reconnect-toast'); if (_rt) _rt.remove();
        // Host change notification
        const newHost = (roomState.users || []).find(u => u.isHost);
        if (newHost && prevHostId && newHost.id !== prevHostId) {
            if (newHost.id === roomState.myId) showToast('👑 You are now the host!', '#f59e0b');
            else showToast(`👑 ${newHost.username} is the new host`, '#f59e0b');
        }
        lastHostId = newHost?.id || null;
    }
    else if (msg.type === 'SIGNALING')     enqueueSignaling(msg.fromId, msg.payload);
    else if (msg.type === 'CHAT_MESSAGE')  handleIncomingChat(msg.username, msg.text, msg.color);
    else if (msg.type === 'REACTION')      animateEmoji(msg.emoji);
    else if (msg.type === 'TOAST') {
        // Server emits TOAST for membership/host events. Route those into the
        // chat history (system message) instead of as a transient on-screen
        // toast, so the chat scroll becomes the persistent timeline.
        const text = String(msg.message || '');
        const m = text.match(/^(.+?)\s+(joined|left|disconnected)\b/i);
        if (m) {
            const verb = m[2].toLowerCase();
            const phrase = verb === 'joined' ? 'joined the party 🎉'
                         : verb === 'left'   ? 'left the party'
                         :                     'disconnected';
            addSystemMessage(phrase, msg.color, { actor: m[1] });
        } else {
            // Generic toast still goes on-screen (errors, transient notices)
            showToast(text, msg.color);
        }
    }
    else if (msg.type === 'NOW_PLAYING') {
        const el = document.getElementById('ss-np-title');
        if (el) el.textContent = msg.title || '—';
        // Add to chat history when title actually changes (skip first set)
        if (msg.title && lastTitle && lastTitle !== msg.title) {
            addSystemMessage(`now playing: ${msg.title}`, '#6366f1', { actor: '' });
        }
        if (msg.title) lastTitle = msg.title;
    }
    else if (msg.type === 'RECONNECTING')  { if (roomState) showReconnectToast(msg.seconds); }
    else if (msg.type === 'CONNECTION_STATUS' && msg.connected) { const rt = document.getElementById('ss-reconnect-toast'); if (rt) rt.remove(); }
    else if (msg.type === 'HOST_NAVIGATE') showNavigateToast(msg.url, msg.title, msg.username);
    else if (msg.type === 'JOIN_ERROR')    showToast(`❌ ${msg.message || 'Could not join room'}`, '#ef4444');
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

    const diff = Math.abs(videoElement.currentTime - msg.time);
    const wasPaused = videoElement.paused;

    // If the difference is negligible, don't trigger a seek (prevents micro-loops)
    if (msg.event === 'seek' && diff < 0.2) {
        isSyncing = false;
        return;
    }

    if (msg.event === 'pause') {
        videoElement.currentTime = msg.time; 
        if (!videoElement.paused) videoElement.pause();
    } else if (msg.event === 'play') {
        if (diff > 0.5) videoElement.currentTime = msg.time;
        if (videoElement.paused) videoElement.play().catch(() => {});
    } else if (msg.event === 'seek' || diff > 0.5) {
        videoElement.currentTime = msg.time;
    }

    if (msg.playbackRate) videoElement.playbackRate = msg.playbackRate;
    
    // Increased lock time from 150ms to 800ms to allow the video player 
    // to finish buffering and firing its own events before we listen again.
    setTimeout(() => { isSyncing = false; }, 800); 

    // Add a system event line in chat (Netflix Party style):
    //   "Selim paused the video at 1:37"
    //   "Ali jumped to 12:34"
    //   "Beni started playing the video"
    const actor = msg.byUsername || '';
    const userColor = (roomState?.users || []).find(u => u.username === actor)?.color;
    const t = fmtTime(msg.time);
    let line = '';
    if      (msg.event === 'play')   line = wasPaused ? 'started playing the video' : 'resumed at ' + t;
    else if (msg.event === 'pause')  line = 'paused the video at ' + t;
    else if (msg.event === 'seek')   line = 'jumped to ' + t;
    else if (msg.event === 'rate')   line = `changed speed to ${msg.playbackRate}x`;
    if (line) addSystemMessage(line, userColor, { actor });
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
    const pc   = new RTCPeerConnection({ ...ICE_SERVERS, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const pObj = { pc, polite: roomState.myId < tid, makingOffer: false };
    peerConnections[tid] = pObj;

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { candidate } });
    };
    pc.ontrack = (event) => {
        const s = event.streams[0]; if (!s) return;
        addVideoTile(tid, s, name);
        const track = event.track;
        if (track.kind !== 'video') return;
        // Sender-side track.enabled = false → in modern Chrome the receiver's
        // track fires `mute` after a brief no-frames period. Use that to flip
        // the tile to its avatar instead of leaving a frozen last frame.
        const showAvatar = () => {
            const vEl = document.getElementById(`ss-v-${tid}`);
            const av  = document.getElementById(`ss-av-${tid}`);
            if (vEl) vEl.style.display = 'none';
            if (av)  av.style.display = 'flex';
        };
        const showVideo = () => {
            const vEl = document.getElementById(`ss-v-${tid}`);
            const av  = document.getElementById(`ss-av-${tid}`);
            if (vEl) vEl.style.display = 'block';
            if (av)  av.style.display = 'none';
        };
        track.onmute   = showAvatar;
        track.onunmute = showVideo;
        track.onended  = showAvatar;
    };
    pc.onnegotiationneeded = async () => {
        try {
            pObj.makingOffer = true;
            await pc.setLocalDescription();
            chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { description: pc.localDescription } });
        } catch (e) { console.error('[SS] Negotiation:', e); } finally { pObj.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    startStatsMonitor(tid, pc);
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
                    audio: { echoCancellation: true, noiseSuppression: true, latency: 0, channelCount: 1 },
                    video: { width: 320, height: 240, frameRate: 24, facingMode: 'user' }
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
    chrome.storage.session.set({ ssMicOn: isMicOn, ssCamOn: isCamOn }).catch(() => {});
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
            screenTrack.onended = () => toggleScreenShare();
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
    if (!gallery.classList.contains('ss-user-hidden')) gallery.style.display = 'flex';

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
function createTileShell(id, name, color) {
    const inner = document.getElementById('ss-grid-inner');
    if (!inner) return null;

    const tile = document.createElement('div');
    tile.id = `ss-vid-${id}`;
    tile.style.cssText = 'background:#111;border-radius:10px;overflow:hidden;position:relative;flex-shrink:0;transition:width 0.3s,height 0.3s,opacity 0.25s;opacity:0;';

    // Video element — hidden until stream arrives
    const v = document.createElement('video');
    v.id = `ss-v-${id}`; v.autoplay = true; v.playsInline = true; v.muted = (id === 'local');
    v.disableRemotePlayback = true;
    v.style.cssText = `width:100%;height:100%;object-fit:cover;display:none;${id === 'local' ? 'transform:scaleX(-1);' : ''}`;
    tile.appendChild(v);

    // Avatar overlay (remote only) — shown until video stream arrives
    if (id !== 'local') {
        const av = document.createElement('div');
        av.id = `ss-av-${id}`;
        av.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#111;z-index:1;';
        const avCircle = document.createElement('div');
        avCircle.style.cssText = `width:54px;height:54px;border-radius:50%;background:${color||'#6366f1'};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#111;`;
        avCircle.textContent = (name||'?').charAt(0).toUpperCase();
        av.appendChild(avCircle);
        tile.appendChild(av);

        // Signal quality dot
        const sig = document.createElement('div');
        sig.className = 'ss-signal';
        sig.title = 'Awaiting stream';
        sig.style.cssText = 'position:absolute;top:6px;left:6px;width:7px;height:7px;border-radius:50%;background:#555;z-index:3;transition:background 0.5s,box-shadow 0.5s;';
        tile.appendChild(sig);
    }

    // Name label
    const lbl = document.createElement('div');
    lbl.className = 'ss-name-lbl';
    lbl.textContent = name;
    lbl.style.cssText = 'position:absolute;bottom:6px;left:8px;font-size:10px;color:#fff;background:rgba(0,0,0,0.6);padding:2px 7px;border-radius:4px;pointer-events:none;letter-spacing:0.02em;z-index:3;';
    tile.appendChild(lbl);

    // Hide button
    const hideBtn = document.createElement('button');
    hideBtn.textContent = '✕'; hideBtn.title = 'Hide';
    hideBtn.style.cssText = 'position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.55);border:none;color:#fff;font-size:10px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:background 0.15s;z-index:3;';
    hideBtn.onclick = (e) => { e.stopPropagation(); tile.style.opacity = '0'; setTimeout(() => { tile.style.display = 'none'; updateGalleryLayout(); }, 280); };
    tile.appendChild(hideBtn);

    // Volume bar (remote only)
    if (id !== 'local') {
        const savedVol = parseFloat(localStorage.getItem(`ss-vol-${id}`) || '1');
        const volBar = document.createElement('div');
        volBar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:6px 8px;display:flex;align-items:center;gap:6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));opacity:0;transition:opacity 0.2s;pointer-events:auto;z-index:3;';
        const volIcon = document.createElement('span');
        volIcon.textContent = savedVol === 0 ? '🔇' : '🔊';
        volIcon.style.cssText = 'font-size:11px;cursor:pointer;flex-shrink:0;color:#fff;';
        const volSlider = document.createElement('input');
        volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.05';
        volSlider.value = String(savedVol);
        volSlider.style.cssText = 'flex:1;height:3px;cursor:pointer;accent-color:#6366f1;';
        volSlider.oninput = () => {
            const vEl = document.getElementById(`ss-v-${id}`);
            const vol = parseFloat(volSlider.value);
            if (vEl) { vEl.volume = vol; vEl.muted = vol === 0; }
            volIcon.textContent = vol === 0 ? '🔇' : '🔊';
            localStorage.setItem(`ss-vol-${id}`, String(vol));
        };
        volIcon.onclick = () => {
            const vEl = document.getElementById(`ss-v-${id}`);
            if (!vEl) return;
            vEl.muted = !vEl.muted;
            volSlider.value = vEl.muted ? '0' : '1';
            volIcon.textContent = vEl.muted ? '🔇' : '🔊';
            localStorage.setItem(`ss-vol-${id}`, volSlider.value);
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
    requestAnimationFrame(() => { tile.style.opacity = '1'; });
    return tile;
}

function addVideoTile(id, stream, name) {
    if (!document.getElementById('ss-grid-inner')) {
        // UI not yet injected — retry after injectUI has a chance to run
        setTimeout(() => addVideoTile(id, stream, name), 200);
        return;
    }
    const inner = document.getElementById('ss-grid-inner');

    let tile = document.getElementById(`ss-vid-${id}`);
    if (tile && tile.style.display === 'none') {
        tile.style.display = '';
        requestAnimationFrame(() => { tile.style.opacity = '1'; });
        updateGalleryLayout();
    }
    if (!tile) {
        const userColor = roomState?.users?.find(u => u.id === id)?.color;
        tile = createTileShell(id, name, userColor);
        if (!tile) return;
        updateGalleryLayout();
    }

    // Hide avatar overlay, show video
    const av = document.getElementById(`ss-av-${id}`);
    if (av) av.style.display = 'none';

    const vEl = document.getElementById(`ss-v-${id}`);
    if (!vEl) return;
    vEl.style.display = 'block';

    // Apply saved volume
    if (id !== 'local') {
        const vol = parseFloat(localStorage.getItem(`ss-vol-${id}`) || '1');
        vEl.volume = vol; vEl.muted = vol === 0;
    }

    if (vEl.srcObject !== stream) {
        vEl.srcObject = stream;
        vEl.play().catch(() => { vEl.muted = true; vEl.play().then(() => { if (id !== 'local') vEl.muted = false; }).catch(() => {}); });
    }
}

function syncAvatarTiles(users) {
    const inner = document.getElementById('ss-grid-inner');
    if (!inner || !roomState?.myId) return;

    const activeIds = new Set();
    users.forEach(u => {
        if (u.id === roomState.myId) return;
        activeIds.add(u.id);
        if (!document.getElementById(`ss-vid-${u.id}`)) {
            createTileShell(u.id, u.username, u.color);
            updateGalleryLayout();
        } else {
            // Update name label with away/host status
            const lbl = document.querySelector(`#ss-vid-${u.id} .ss-name-lbl`);
            if (lbl) lbl.textContent = u.username + (u.isAway ? ' 😴' : '') + (u.isHost ? ' 👑' : '');
        }
    });

    // Remove tiles for users who left
    inner.querySelectorAll('[id^="ss-vid-"]').forEach(tile => {
        const id = tile.id.replace('ss-vid-', '');
        if (id !== 'local' && !activeIds.has(id)) {
            tile.style.opacity = '0';
            setTimeout(() => { tile.remove(); updateGalleryLayout(); }, 280);
        }
    });
}

function removeVideoTile(id) {
    if (id === 'local') {
        const el = document.getElementById('ss-vid-local');
        if (!el) return;
        el.style.opacity = '0';
        setTimeout(() => { el.remove(); updateGalleryLayout(); }, 280);
        return;
    }
    // Remote: revert to avatar instead of full removal
    const vEl = document.getElementById(`ss-v-${id}`);
    const av  = document.getElementById(`ss-av-${id}`);
    if (vEl) { vEl.srcObject = null; vEl.style.display = 'none'; }
    if (av)  av.style.display = 'flex';
    const tile = document.getElementById(`ss-vid-${id}`);
    if (tile) {
        const sig = tile.querySelector('.ss-signal');
        if (sig) { sig.style.background = '#555'; sig.style.boxShadow = 'none'; sig.title = 'Awaiting stream'; }
    }
}

// ─── STATS MONITOR ────────────────────────────────────────────────────────────
function startStatsMonitor(tid, pc) {
    let lastQuality = 'good';
    const BITRATE = { good: undefined, medium: 400_000, poor: 120_000 };

    const timer = setInterval(async () => {
        const tile = document.getElementById(`ss-vid-${tid}`);
        if (!tile || pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
            clearInterval(timer); return;
        }
        const sig = tile.querySelector('.ss-signal');
        if (!sig) return;
        try {
            const stats = await pc.getStats();
            let quality = 'good';
            stats.forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    const fps  = r.framesPerSecond || 0;
                    const loss = (r.packetsLost || 0) / Math.max(1, (r.packetsLost || 0) + (r.packetsReceived || 1));
                    if (fps < 5  || loss > 0.15) quality = 'poor';
                    else if (fps < 15 || loss > 0.05) quality = 'medium';
                }
            });

            // Auto-adjust outgoing bandwidth when our quality is poor
            if (quality !== lastQuality) {
                lastQuality = quality;
                pc.getSenders().forEach(sender => {
                    if (sender.track?.kind !== 'video') return;
                    try {
                        const params = sender.getParameters();
                        if (!params.encodings?.length) return;
                        params.encodings[0].maxBitrate = BITRATE[quality];
                        sender.setParameters(params).catch(() => {});
                    } catch (_) {}
                });
            }

            const clr  = { good: '#10b981', medium: '#f59e0b', poor: '#ef4444' }[quality];
            const tips = { good: 'Good connection', medium: 'Unstable connection', poor: 'Poor connection' }[quality];
            sig.style.background = clr;
            sig.style.boxShadow  = `0 0 5px ${clr}`;
            sig.title = tips;
        } catch (_) {}
    }, 3000);
}

// ─── RECONNECT TOAST ──────────────────────────────────────────────────────────
function showReconnectToast(sec) {
    let t = document.getElementById('ss-reconnect-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'ss-reconnect-toast';
        t.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(239,68,68,0.95);color:#fff;padding:10px 22px;border-radius:20px;font-size:12px;font-weight:600;z-index:2147483646;pointer-events:none;letter-spacing:0.04em;border:1px solid rgba(255,255,255,0.15);box-shadow:0 4px 24px rgba(0,0,0,0.5);white-space:nowrap;';
        (document.getElementById('ss-root') || document.body).appendChild(t);
    }
    let s = sec;
    clearInterval(t._timer);
    const update = () => { t.textContent = `⚡ Disconnected — reconnecting in ${s}s...`; };
    update();
    t._timer = setInterval(() => { s--; if (s <= 0) { clearInterval(t._timer); t.remove(); } else update(); }, 1000);
}

// ─── AUTO JOIN PROMPT ─────────────────────────────────────────────────────────
function showJoinPrompt(code) {
    if (document.getElementById('ss-join-prompt') || roomState?.roomId) return;

    const box = document.createElement('div');
    box.id = 'ss-join-prompt';
    box.style.cssText = 'position:absolute;top:20px;right:20px;background:rgba(6,6,14,0.97);border:1px solid rgba(99,102,241,0.3);border-radius:16px;padding:20px;width:280px;z-index:2147483646;box-shadow:0 12px 40px rgba(0,0,0,0.7);pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;display:flex;flex-direction:column;gap:12px;';

    const ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:13px;font-weight:700;color:#fff;';
    ttl.textContent = '🎬 You have been invited to a room';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#555;margin-top:-6px;';
    sub.textContent = `Room code: ${code}`;

    const inp = document.createElement('input');
    inp.placeholder = 'Your name...'; inp.maxLength = 24; inp.autocomplete = 'off';
    inp.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:10px 12px;border-radius:10px;font-size:13px;outline:none;width:100%;box-sizing:border-box;transition:border-color 0.2s;';
    inp.onfocus = () => { inp.style.borderColor = '#6366f1'; };
    inp.onblur  = () => { inp.style.borderColor = 'rgba(255,255,255,0.1)'; };

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    const noBtn = document.createElement('button');
    noBtn.textContent = 'No Thanks';
    noBtn.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:none;color:#aaa;padding:10px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;transition:background 0.15s;';
    noBtn.onmouseenter = () => { noBtn.style.background = 'rgba(255,255,255,0.13)'; };
    noBtn.onmouseleave = () => { noBtn.style.background = 'rgba(255,255,255,0.07)'; };
    noBtn.onclick = () => box.remove();

    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join →';
    joinBtn.style.cssText = 'flex:2;background:#6366f1;border:none;color:#fff;padding:10px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:700;transition:background 0.15s;';
    joinBtn.onmouseenter = () => { joinBtn.style.background = '#4f46e5'; };
    joinBtn.onmouseleave = () => { joinBtn.style.background = '#6366f1'; };
    joinBtn.onclick = () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        chrome.storage.local.set({ savedUsername: name });
        chrome.runtime.sendMessage({ type: 'JOIN_ROOM', roomId: code, username: name });
        box.remove();
    };
    inp.addEventListener('keypress', e => { e.stopPropagation(); if (e.key === 'Enter') joinBtn.click(); });
    inp.addEventListener('keydown',  e => e.stopPropagation());

    row.appendChild(noBtn); row.appendChild(joinBtn);
    box.appendChild(ttl); box.appendChild(sub); box.appendChild(inp); box.appendChild(row);
    (document.getElementById('ss-root') || document.body).appendChild(box);

    chrome.storage.local.get(['savedUsername'], (res) => {
        if (res.savedUsername) inp.value = res.savedUsername;
        setTimeout(() => inp.focus(), 50);
    });
}

// ─── NAVIGATE TOAST ───────────────────────────────────────────────────────────
function showNavigateToast(url, title, username) {
    if (!url || window.location.href === url) return;

    let t = document.getElementById('ss-nav-toast');
    if (t) { clearInterval(t._timer); t.remove(); }

    t = document.createElement('div');
    t.id = 'ss-nav-toast';
    t.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);background:rgba(6,6,14,0.97);color:#fff;padding:14px 18px;border-radius:16px;font-size:13px;z-index:2147483646;border:1px solid rgba(255,255,255,0.1);box-shadow:0 8px 32px rgba(0,0,0,0.65);display:flex;flex-direction:column;gap:10px;min-width:300px;max-width:420px;pointer-events:auto;';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa;';
    top.innerHTML = `<span style="font-size:18px;">🎬</span><span><b style="color:#fff;">${username || 'Host'}</b> is navigating to a new video</span>`;

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:12px;color:#818cf8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleEl.textContent = title || url;

    const bottom = document.createElement('div');
    bottom.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    const countdown = document.createElement('span');
    countdown.style.cssText = 'font-size:11px;color:#555;flex:1;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:rgba(255,255,255,0.08);border:none;color:#fff;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:background 0.15s;flex-shrink:0;';
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = 'rgba(255,255,255,0.16)'; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = 'rgba(255,255,255,0.08)'; };

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Go Now';
    goBtn.style.cssText = 'background:#6366f1;border:none;color:#fff;padding:7px 16px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:background 0.15s;flex-shrink:0;';
    goBtn.onmouseenter = () => { goBtn.style.background = '#4f46e5'; };
    goBtn.onmouseleave = () => { goBtn.style.background = '#6366f1'; };

    bottom.appendChild(countdown);
    bottom.appendChild(cancelBtn);
    bottom.appendChild(goBtn);
    t.appendChild(top);
    t.appendChild(titleEl);
    t.appendChild(bottom);
    (document.getElementById('ss-root') || document.body).appendChild(t);

    let s = 5;
    const update = () => { countdown.textContent = `Auto-navigating in ${s}s`; };
    update();

    const navigate = () => { clearInterval(t._timer); t.remove(); window.location.href = url; };
    cancelBtn.onclick = (e) => { e.stopPropagation(); clearInterval(t._timer); t.remove(); };
    goBtn.onclick     = (e) => { e.stopPropagation(); navigate(); };
    t._timer = setInterval(() => { s--; if (s <= 0) navigate(); else update(); }, 1000);
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
        // Flash the panel toggle so user notices the new message even if panel
        // is closed (replaces old dock chat-button flash).
        const tog = document.getElementById('ss-panel-toggle');
        if (tog) {
            const orig = tog.style.background;
            tog.style.background = 'rgba(245,158,11,0.85)';
            setTimeout(() => { tog.style.background = orig || ''; }, 900);
        }
    }
}

function updateUnreadBadge() {
    const b = document.getElementById('ss-chat-badge');
    if (!b) return;
    b.textContent  = unreadCount > 9 ? '9+' : unreadCount;
    b.style.display = unreadCount > 0 ? 'flex' : 'none';
}

let _ssRestoring = false;
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
    if (_ssRestoring) return;
    try {
        const history = JSON.parse(sessionStorage.getItem('ss-chat') || '[]');
        history.push({ kind: 'msg', user, text, color });
        if (history.length > 200) history.shift();
        sessionStorage.setItem('ss-chat', JSON.stringify(history));
    } catch (_) {}
}

// System events appear in the chat history (Netflix Party style):
//   "Selim started playing the video"
//   "Ali jumped to 12:34"
//   "Beni joined the party 🎉"
// Distinct visual style — italic, dimmer, no avatar bubble — so they don't get
// confused with user-typed chat messages.
function addSystemMessage(text, color, opts) {
    const msgs = document.getElementById('ss-msgs');
    if (!msgs) return;
    const o = opts || {};
    const m = document.createElement('div');
    m.style.cssText = 'font-size:11px;color:#888;font-style:italic;padding:4px 2px;animation:ss-fadein 0.2s ease;letter-spacing:0.01em;';
    if (o.actor) {
        const a = document.createElement('span');
        a.style.cssText = `color:${color || '#6366f1'};font-weight:600;font-style:normal;`;
        a.textContent = o.actor;
        m.appendChild(a);
        m.appendChild(document.createTextNode(' '));
    }
    m.appendChild(document.createTextNode(text));
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    if (_ssRestoring) return;
    try {
        const history = JSON.parse(sessionStorage.getItem('ss-chat') || '[]');
        history.push({ kind: 'sys', actor: o.actor || '', text, color });
        if (history.length > 200) history.shift();
        sessionStorage.setItem('ss-chat', JSON.stringify(history));
    } catch (_) {}

    // Intentionally NO unread badge / no toggle flash / no sound — system events
    // are passive timeline entries, not actionable like chat messages. Only
    // human-typed CHAT_MESSAGE bumps unread (handled in handleIncomingChat).
}

// Format seconds to MM:SS (e.g. 67 → "01:07")
function fmtTime(sec) {
    if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ─── EMOJI & TOAST ────────────────────────────────────────────────────────────
function animateEmoji(emoji) {
    const e = document.createElement('div');
    e.textContent = emoji;
    e.style.cssText = `position:absolute;bottom:100px;left:${38+Math.random()*24}%;font-size:44px;z-index:999999;pointer-events:none;transition:transform 1.8s cubic-bezier(0.2,0.8,0.4,1),opacity 1.8s ease;opacity:1;`;
    (document.getElementById('ss-root') || document.body).appendChild(e);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        e.style.transform = `translateY(-380px) rotate(${(Math.random()-.5)*30}deg) scale(1.4)`;
        e.style.opacity   = '0';
    }));
    setTimeout(() => e.remove(), 2000);
}

function showToast(text, color) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = `position:absolute;top:16px;left:50%;transform:translateX(-50%) translateY(-10px);background:rgba(10,10,20,0.95);color:${color||'#fff'};padding:8px 18px;border-radius:20px;z-index:999999;font-size:12px;font-weight:600;letter-spacing:0.04em;border:1px solid rgba(255,255,255,0.1);box-shadow:0 4px 20px rgba(0,0,0,0.5);pointer-events:none;transition:transform 0.3s ease,opacity 0.3s ease;opacity:0;`;
    (document.getElementById('ss-root') || document.body).appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => { t.style.transform = 'translateX(-50%) translateY(0)'; t.style.opacity = '1'; }));
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(-10px)'; }, 2700);
    setTimeout(() => t.remove(), 3100);
}

// ─── BUTTONS ─────────────────────────────────────────────────────────────────
function updateButtons() {
    const active = '#6366f1', idle = 'rgba(255,255,255,0.08)';
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.style.background = on ? active : idle; };
    set('ss-b-mic',    isMicOn);
    set('ss-b-cam',    isCamOn);
    set('ss-b-screen', isScreenSharing);
}

function updateParticipantPanel() {
    // Update the side panel header subtitle with room ID + user count.
    // The old #ss-participants standalone panel is removed; participants are
    // shown via the camera gallery (which contains avatar tiles for everyone).
    if (!roomState) return;
    const sub = document.getElementById('ss-panel-sub');
    if (sub) {
        const userCount = (roomState.users || []).length;
        const roomId = roomState.roomId || '';
        const label = userCount === 1 ? 'user' : 'users';
        sub.textContent = roomId ? `${roomId} · ${userCount} ${label}` : `${userCount} ${label}`;
    }
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
        't': () => { if (window.__ssTogglePanel) window.__ssTogglePanel(); },
        'p': () => { const g = document.getElementById('ss-gallery'); if (g) { const h = !g.classList.contains('ss-user-hidden'); g.classList.toggle('ss-user-hidden', h); g.style.display = h ? 'none' : 'flex'; } }
    };

    const handler = actions[e.key.toLowerCase()];
    if (handler) { e.preventDefault(); handler(); }
}, true);

// ─── UI INJECTION ─────────────────────────────────────────────────────────────
// Side panel architecture (Netflix Party / Teleparty style):
//   • Chat + room info + media controls live inside a slide-in panel on the right.
//   • Toggle button is permanently pinned to the right edge with an unread badge.
//   • Camera gallery (PARTICIPANTS) is a separate small floating widget, default
//     top-LEFT (avoids common player UI in top-right).
//   • Reactions live in a popover above the chat input (😀 button), no longer
//     a row of always-visible buttons.
function injectUI() {
    if (!IS_TOP_FRAME || document.getElementById('ss-root')) return;

    const root = document.createElement('div');
    root.id = 'ss-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;';
    document.body.appendChild(root);

    // Signal content-main.js (MAIN world) that SyncStream is active
    document.documentElement.setAttribute('data-ss-active', '1');

    const style = document.createElement('style');
    style.textContent = `
        @keyframes ss-fadein { from { opacity:0;transform:translateY(4px); } to { opacity:1;transform:none; } }
        @keyframes ss-pop    { 0% { transform:scale(0.6);opacity:0; } 60% { transform:scale(1.08); } 100% { transform:scale(1);opacity:1; } }
        #ss-msgs::-webkit-scrollbar { width:3px; }
        #ss-msgs::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }
        #ss-panel { transition: transform 0.3s ease; }
        #ss-panel.ss-open { transform: translateX(0) !important; }
        #ss-panel-toggle { transition: right 0.3s ease, background 0.2s, transform 0.15s; }
        #ss-panel-toggle:hover { background: rgba(99,102,241,0.4) !important; }
        #ss-panel-toggle.ss-open { right: 320px !important; }
        #ss-emoji-pop button:hover { background: rgba(255,255,255,0.15) !important; transform: scale(1.25); }
    `;
    document.head.appendChild(style);

    // ── SYNC INDICATOR ────────────────────────────────────────────────────────
    const syncInd = document.createElement('div');
    syncInd.id = 'ss-sync-ind';
    syncInd.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);background:rgba(99,102,241,0.95);color:#fff;padding:10px 24px;border-radius:24px;font-size:16px;font-weight:700;z-index:2147483645;pointer-events:none;opacity:0;transition:opacity 0.3s ease,transform 0.3s ease;letter-spacing:0.05em;box-shadow:0 4px 24px rgba(99,102,241,0.45);white-space:nowrap;';
    root.appendChild(syncInd);

    // ── CAMERA GALLERY (default TOP-LEFT now, away from player UI) ────────────
    const gallery = document.createElement('div');
    gallery.id = 'ss-gallery';
    gallery.style.cssText = 'position:absolute;top:20px;left:20px;background:rgba(6,6,14,0.92);border:1px solid rgba(255,255,255,0.1);border-radius:14px;display:none;flex-direction:column;pointer-events:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);overflow:hidden;z-index:2147483640;transition:width 0.3s,height 0.3s;min-width:80px;';

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
    showAllBtn.textContent = 'Show All';
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

    // ── SIDE PANEL ────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'ss-panel';
    panel.style.cssText = 'position:absolute;top:0;right:0;width:320px;height:100%;max-width:80vw;background:rgba(6,6,14,0.97);backdrop-filter:blur(24px);border-left:1px solid rgba(255,255,255,0.08);box-shadow:-8px 0 32px rgba(0,0,0,0.5);transform:translateX(100%);pointer-events:auto;display:flex;flex-direction:column;color:#fff;';
    root.appendChild(panel);

    // Header
    const pHeader = document.createElement('div');
    pHeader.style.cssText = 'padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    const pHeaderLeft = document.createElement('div');
    pHeaderLeft.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
    const pHeaderTitle = document.createElement('div');
    pHeaderTitle.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.04em;color:#fff;';
    pHeaderTitle.textContent = 'SyncStream';
    const pHeaderSub = document.createElement('div');
    pHeaderSub.id = 'ss-panel-sub';
    pHeaderSub.style.cssText = 'font-size:10px;color:#888;letter-spacing:0.04em;';
    pHeaderSub.textContent = '';
    pHeaderLeft.appendChild(pHeaderTitle);
    pHeaderLeft.appendChild(pHeaderSub);
    pHeader.appendChild(pHeaderLeft);

    const pHeaderRight = document.createElement('div');
    pHeaderRight.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
    const leaveBtn = document.createElement('button');
    leaveBtn.innerHTML = '🚪';
    leaveBtn.title = 'Leave Room';
    leaveBtn.style.cssText = 'background:rgba(239,68,68,0.15);border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:background 0.15s;';
    leaveBtn.onmouseenter = () => { leaveBtn.style.background = 'rgba(239,68,68,0.4)'; };
    leaveBtn.onmouseleave = () => { leaveBtn.style.background = 'rgba(239,68,68,0.15)'; };
    leaveBtn.onclick = () => { chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' }); };
    pHeaderRight.appendChild(leaveBtn);
    pHeader.appendChild(pHeaderRight);
    panel.appendChild(pHeader);

    // Now Playing strip
    const npRow = document.createElement('div');
    npRow.style.cssText = 'padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
    const npLabel = document.createElement('div');
    npLabel.style.cssText = 'font-size:9px;color:#555;letter-spacing:0.06em;text-transform:uppercase;';
    npLabel.textContent = 'Now Playing';
    const npTitle = document.createElement('div');
    npTitle.id = 'ss-np-title';
    npTitle.style.cssText = 'font-size:12px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    npTitle.textContent = '—';
    npRow.appendChild(npLabel);
    npRow.appendChild(npTitle);
    panel.appendChild(npRow);

    // Chat scroll area
    const msgs = document.createElement('div');
    msgs.id = 'ss-msgs';
    msgs.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-height:0;';
    panel.appendChild(msgs);

    // Restore chat history (regular messages and system events)
    try {
        _ssRestoring = true;
        const history = JSON.parse(sessionStorage.getItem('ss-chat') || '[]');
        history.forEach(m => {
            if (m.kind === 'sys') addSystemMessage(m.text, m.color, { actor: m.actor });
            else                  addChatMessage(m.user, m.text, m.color);
        });
    } catch (_) {} finally { _ssRestoring = false; }

    // ── REACTIONS ROW (always visible, screen-wide animated) ────────────────
    const reactionsRow = document.createElement('div');
    reactionsRow.id = 'ss-reactions-row';
    reactionsRow.style.cssText = 'padding:8px 14px 6px;display:flex;justify-content:space-around;align-items:center;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;';
    const REACTIONS = ['🥰','😡','😭','😂','🥳','🔥'];
    REACTIONS.forEach(em => {
        const rb = document.createElement('button');
        rb.textContent = em;
        rb.title = 'Send reaction';
        rb.style.cssText = 'background:none;border:none;font-size:22px;cursor:pointer;padding:4px 6px;border-radius:50%;transition:transform 0.15s,background 0.15s;line-height:1;';
        rb.onmouseenter = () => { rb.style.transform = 'scale(1.25)'; rb.style.background = 'rgba(255,255,255,0.08)'; };
        rb.onmouseleave = () => { rb.style.transform = 'scale(1)'; rb.style.background = 'none'; };
        rb.onclick = (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ type: 'REACTION', emoji: em });
        };
        reactionsRow.appendChild(rb);
    });
    panel.appendChild(reactionsRow);

    // ── INPUT ROW ────────────────────────────────────────────────────────────
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'padding:8px 12px;display:flex;gap:6px;align-items:center;flex-shrink:0;position:relative;';

    const chatInput = document.createElement('input');
    chatInput.id = 'ss-chat-in';
    chatInput.placeholder = 'Type a message...';
    chatInput.autocomplete = 'off';
    chatInput.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.08);color:#fff;padding:9px 14px;border-radius:20px;font-size:12px;outline:none;transition:border-color 0.2s;min-width:0;';
    chatInput.onfocus = () => chatInput.style.borderColor = '#6366f1';
    chatInput.onblur  = () => chatInput.style.borderColor = 'rgba(255,255,255,0.08)';

    const sendBtn = document.createElement('button');
    sendBtn.textContent = '↑';
    sendBtn.title = 'Send';
    sendBtn.style.cssText = 'background:#6366f1;color:#fff;border:none;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.15s,transform 0.15s;';
    sendBtn.onmouseenter = () => { sendBtn.style.background='#4f46e5'; sendBtn.style.transform='scale(1.08)'; };
    sendBtn.onmouseleave = () => { sendBtn.style.background='#6366f1'; sendBtn.style.transform='scale(1)'; };

    inputRow.appendChild(chatInput);
    inputRow.appendChild(sendBtn);
    panel.appendChild(inputRow);

    const sendMessage = () => {
        const text = chatInput.value.trim();
        if (text) { chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text }); chatInput.value = ''; }
    };
    sendBtn.onclick = sendMessage;
    chatInput.addEventListener('keydown',  e => e.stopPropagation());
    chatInput.addEventListener('keypress', e => { e.stopPropagation(); if (e.key === 'Enter') sendMessage(); });

    // ── CHAT EMOJI PICKER (separate from reactions — these get inserted
    //    into the text input, not broadcast as a flying reaction) ──────────
    const emojiPicker = document.createElement('div');
    emojiPicker.id = 'ss-emoji-picker';
    emojiPicker.style.cssText = 'position:absolute;bottom:48px;right:8px;width:240px;max-height:200px;overflow-y:auto;background:rgba(20,20,30,0.98);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:8px;display:none;grid-template-columns:repeat(7,1fr);gap:2px;z-index:5;box-shadow:0 4px 20px rgba(0,0,0,0.6);animation:ss-pop 0.18s ease;';
    const CHAT_EMOJIS = [
        '😀','😃','😄','😁','😆','😅','🤣',
        '😂','🙂','😉','😊','😇','🥰','😍',
        '🤩','😘','😗','😋','😛','😜','🤪',
        '😎','🤓','🧐','🤔','🤨','😐','😑',
        '😶','🙄','😏','😒','😔','😪','😴',
        '🤤','😵','🤯','🥳','😎','🤠','🥸',
        '😢','😭','😱','😨','😰','😥','😓',
        '🤗','🤭','🤫','😬','🙃','😡','🤬',
        '👍','👎','👏','🙏','💪','✊','🤝',
        '❤️','💔','💖','💯','🔥','✨','⭐',
        '🎉','🎊','🎁','🎂','☕','🍕','🍔',
        '🎬','🎵','🎮','⚽','🏆','💡','✅'
    ];
    CHAT_EMOJIS.forEach(em => {
        const eb = document.createElement('button');
        eb.textContent = em;
        eb.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;padding:5px;border-radius:6px;transition:background 0.12s,transform 0.12s;line-height:1;';
        eb.onmouseenter = () => { eb.style.background = 'rgba(255,255,255,0.12)'; eb.style.transform = 'scale(1.18)'; };
        eb.onmouseleave = () => { eb.style.background = 'none'; eb.style.transform = 'scale(1)'; };
        eb.onclick = (ev) => {
            ev.stopPropagation();
            // Insert at cursor position, keep input focused
            const start = chatInput.selectionStart || chatInput.value.length;
            const end   = chatInput.selectionEnd   || chatInput.value.length;
            chatInput.value = chatInput.value.slice(0, start) + em + chatInput.value.slice(end);
            chatInput.focus();
            chatInput.setSelectionRange(start + em.length, start + em.length);
        };
        emojiPicker.appendChild(eb);
    });
    inputRow.appendChild(emojiPicker);

    // ── BOTTOM CONTROLS ROW ──────────────────────────────────────────────────
    //   Left:  📷 🎤 🖥  (media toggles)
    //   Right: 😊 GIF 🎉 (chat emoji picker, GIF, quick-react)
    const bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'padding:6px 12px 10px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';

    const leftCtrls = document.createElement('div');
    leftCtrls.style.cssText = 'display:flex;gap:4px;align-items:center;';
    const rightCtrls = document.createElement('div');
    rightCtrls.style.cssText = 'display:flex;gap:4px;align-items:center;';

    const mkSmallBtn = (content, id, handler, tip, opts) => {
        const b = document.createElement('button');
        if (id) b.id = id;
        b.innerHTML = content; b.title = tip || '';
        const o = opts || {};
        b.style.cssText = `background:${o.bg || 'rgba(255,255,255,0.06)'};border:none;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:background 0.15s,transform 0.12s;flex-shrink:0;`;
        b.onmouseenter = () => { if (!o.disabled) b.style.background = 'rgba(255,255,255,0.16)'; b.style.transform='scale(1.08)'; };
        b.onmouseleave = () => { b.style.transform='scale(1)'; if (id) updateButtons(); else b.style.background = o.bg || 'rgba(255,255,255,0.06)'; };
        b.onclick = (e) => { e.stopPropagation(); handler(); };
        return b;
    };

    leftCtrls.appendChild(mkSmallBtn('📷', 'ss-b-cam',    () => { isCamOn = !isCamOn; updateMedia(); },  'Camera (Alt+C)'));
    leftCtrls.appendChild(mkSmallBtn('🎤', 'ss-b-mic',    () => { isMicOn = !isMicOn; updateMedia(); },  'Mic (Alt+M)'));
    leftCtrls.appendChild(mkSmallBtn('🖥', 'ss-b-screen', () => toggleScreenShare(),                     'Screen (Alt+S)'));

    // Chat emoji picker toggle
    const emojiBtn = mkSmallBtn('😊', null, () => {
        const open = emojiPicker.style.display !== 'grid';
        emojiPicker.style.display = open ? 'grid' : 'none';
        if (open) chatInput.focus();
    }, 'Insert emoji');

    // GIF placeholder (visible for design parity; actual Tenor integration is a future task)
    const gifBtn = mkSmallBtn('<span style="font-size:9px;font-weight:700;letter-spacing:0.04em;">GIF</span>', null,
        () => { showToast('GIF picker coming soon', '#6366f1'); }, 'GIFs (coming soon)');
    gifBtn.style.opacity = '0.55';

    // Quick-reaction shortcut: sends 🎉
    const partyBtn = mkSmallBtn('🎉', null,
        () => { chrome.runtime.sendMessage({ type: 'REACTION', emoji: '🎉' }); }, 'Send 🎉 reaction');

    rightCtrls.appendChild(emojiBtn);
    rightCtrls.appendChild(gifBtn);
    rightCtrls.appendChild(partyBtn);

    bottomRow.appendChild(leftCtrls);
    bottomRow.appendChild(rightCtrls);
    panel.appendChild(bottomRow);

    // Click outside emoji picker to close it
    document.addEventListener('click', (e) => {
        if (emojiPicker.style.display === 'grid' && !emojiPicker.contains(e.target) && e.target !== emojiBtn) {
            emojiPicker.style.display = 'none';
        }
    });

    // ── PANEL TOGGLE ─────────────────────────────────────────────────────────
    const toggle = document.createElement('div');
    toggle.id = 'ss-panel-toggle';
    toggle.style.cssText = 'position:absolute;top:50%;right:0;transform:translateY(-50%);width:42px;height:60px;background:rgba(6,6,14,0.95);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-right:none;border-radius:12px 0 0 12px;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:auto;box-shadow:-4px 4px 16px rgba(0,0,0,0.5);z-index:2147483646;';
    const toggleIcon = document.createElement('span');
    toggleIcon.style.cssText = 'font-size:18px;line-height:1;';
    toggleIcon.textContent = '💬';
    toggle.appendChild(toggleIcon);

    // Unread badge on toggle (replaces old ss-chat-badge in dock)
    const badge = document.createElement('div');
    badge.id = 'ss-chat-badge';
    badge.style.cssText = 'position:absolute;top:5px;right:4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:none;align-items:center;justify-content:center;pointer-events:none;padding:0 4px;border:1px solid rgba(6,6,14,0.95);box-sizing:content-box;';
    toggle.appendChild(badge);
    root.appendChild(toggle);

    // Open/close panel
    const setPanelOpen = (open) => {
        isChatOpen = open;
        if (open) {
            panel.classList.add('ss-open');
            toggle.classList.add('ss-open');
            toggleIcon.textContent = '✕';
            unreadCount = 0;
            updateUnreadBadge();
            setTimeout(() => chatInput.focus(), 200);
        } else {
            panel.classList.remove('ss-open');
            toggle.classList.remove('ss-open');
            toggleIcon.textContent = '💬';
        }
    };
    toggle.onclick = (e) => { e.stopPropagation(); setPanelOpen(!isChatOpen); };

    // Expose so the keyboard shortcut handler can use the same toggle
    window.__ssTogglePanel = () => setPanelOpen(!isChatOpen);

    // ── FULLSCREEN SUPPORT ────────────────────────────────────────────────────
    function syncRootToFullscreen() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (!fsEl) {
            if (root.parentElement !== document.body) document.body.appendChild(root);
            return;
        }
        if (fsEl.contains(root)) return;
        if (fsEl.tagName === 'IFRAME') return;
        let target = fsEl;
        while (target.tagName === 'VIDEO' && target.parentElement) target = target.parentElement;
        if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
        target.style.overflow = 'visible';
        target.appendChild(root);
    }
    document.addEventListener('fullscreenchange',       () => setTimeout(syncRootToFullscreen, 0));
    document.addEventListener('webkitfullscreenchange', () => setTimeout(syncRootToFullscreen, 0));

    // ── AWAY DETECTION ────────────────────────────────────────────────────────
    const AWAY_MS = 3 * 60 * 1000;
    const resetAway = () => {
        clearTimeout(awayTimer);
        if (isAway) {
            isAway = false;
            chrome.runtime.sendMessage({ type: 'USER_STATUS', away: false }).catch(() => {});
        }
        awayTimer = setTimeout(() => {
            isAway = true;
            chrome.runtime.sendMessage({ type: 'USER_STATUS', away: true }).catch(() => {});
        }, AWAY_MS);
    };
    ['mousemove','keydown','click','touchstart'].forEach(ev => document.addEventListener(ev, resetAway, { passive: true }));
    resetAway();

    // ── HEARTBEAT (Keeps background worker and tab alive) ────────────────────
    setInterval(() => {
        if (roomState?.roomId) {
            chrome.runtime.sendMessage({ type: 'HEARTBEAT' }).catch(() => {});
        }
    }, 30000);

    // ── VISIBILITY DETECTION (Re-sync when tab is back in focus) ─────────────
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && roomState?.roomId) {
            // Re-request latest room state and now playing info
            chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
                if (res?.roomId) {
                    roomState = res;
                    updateParticipantPanel();
                    syncAvatarTiles(res.users || []);
                }
            });
        }
    });
}

// ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
// Runs at 500ms until video is found, then slows to 2000ms to save CPU
let loopInterval = null;

function mainLoop() {
    if (IS_TOP_FRAME && !document.getElementById('ss-root')) injectUI();

    // Fullscreen fallback: if event-based approach missed, correct placement now
    if (IS_TOP_FRAME) {
        const root = document.getElementById('ss-root');
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (root) {
            if (!fsEl && root.parentElement !== document.body) {
                document.body.appendChild(root);
            } else if (fsEl && !fsEl.contains(root) && fsEl.tagName !== 'IFRAME') {
                let target = fsEl;
                while (target.tagName === 'VIDEO' && target.parentElement) target = target.parentElement;
                if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
                target.style.overflow = 'visible';
                target.appendChild(root);
            }
        }
    }

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
