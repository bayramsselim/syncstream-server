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
let lastSeekTime    = 0;
let lastHostId      = null;
let isAway          = false;
let awayTimer       = null;
let lastSyncTime    = 0;
let wasPaused       = true; 
let isInitialLoad   = true; 
let userAvatars     = {};   // Global ID -> Avatar map
let userColors      = {};   // Global ID -> Color map

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getAvatar(id, nameFallback) {
    if (!id || id === 'local') return roomState?.myAvatar || '🐱';
    if (userAvatars[id]) return userAvatars[id];
    const avatars = ['🐱', '🐶', '🦊', '🐨', '🐼', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉', '🦄', '🐝', '🐙', '🐢', '🦖', '🦋', '🐘', '🦒', '🦓'];
    const idStr = String(id || nameFallback || 'anon');
    const idx = Math.abs(idStr.split('').reduce((a, b) => a + b.charCodeAt(0), 0)) % avatars.length;
    return avatars[idx];
}

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
            
            // Logic Fix: Persistent Media Recovery (Local + Session fallback)
            chrome.storage.local.get(['ssMicOn', 'ssCamOn', 'ssInCall'], (data) => {
                if (data.ssMicOn || data.ssCamOn || data.ssInCall) {
                    isMicOn = !!data.ssMicOn;
                    isCamOn = !!data.ssCamOn;
                    console.log('[SyncStream] Fast-recovering media session...');
                    // No delay for faster recovery
                    updateMedia(); 
                }
            });
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
    if (msg.type === 'SYNC_STATE') { 
        // Logic Fix: Immediate host protection
        if (roomState?.isHost) return;
        applyRemoteSync(msg); 
        return; 
    }

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
        if (roomState.users) {
            roomState.users.forEach(u => {
                userAvatars[u.id] = u.avatar;
                userColors[u.id] = u.color;
            });
        }
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
        
        const newHost = (roomState.users || []).find(u => u.isHost);
        if (newHost && prevHostId && newHost.id !== prevHostId) {
            if (newHost.id === roomState.myId) showToast('👑 You are now the host!', '#f59e0b');
            else showToast(`👑 ${newHost.username} is the new host`, '#f59e0b');
        }
        lastHostId = newHost?.id || null;

        // Logic Fix: Robust Auto-sync on Join/Update
        // ONLY non-hosts should ever auto-sync to the room state
        if (roomState && !roomState.isHost && roomState.currentTime !== undefined) {
            const v = findMainVideo();
            if (v) {
                const doSync = () => {
                    if (Date.now() - lastSyncTime < 500) return; // Prevent spam
                    lastSyncTime = Date.now();
                    applyRemoteSync({
                        event: roomState.isPaused ? 'pause' : 'play',
                        time: roomState.currentTime,
                        playbackRate: roomState.playbackRate || 1
                    });
                };
                if (v.readyState >= 2) doSync();
                else {
                    v.addEventListener('loadedmetadata', doSync, { once: true });
                    v.addEventListener('canplay', doSync, { once: true });
                }
                // Force a sync attempt after a small delay regardless
                setTimeout(doSync, 2000);
            }
        }
    }
    else if (msg.type === 'SIGNALING')     enqueueSignaling(msg.fromId, msg.payload);
    else if (msg.type === 'CHAT_MESSAGE')  handleIncomingChat(msg.username, msg.text, msg.color, msg.avatar, msg.userId);
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
            if (verb === 'joined') {
                playNotifSound();
                // Logic Fix: Host broadcasts current state to help newcomer sync instantly
                if (roomState?.isHost) setTimeout(() => broadcastState('sync'), 1000);
            }
        } else {
            // Generic toast still goes on-screen (errors, transient notices)
            showToast(text, msg.color);
        }
    }
    else if (msg.type === 'UPDATE_NOW_PLAYING' || msg.type === 'NOW_PLAYING') {
        // Logic Fix: Align with server's 'NOW_PLAYING' message type
        // Only show message if title actually changed to prevent chat spam
        const npEl = document.getElementById('ss-np-title');
        const oldTitle = npEl ? npEl.textContent : '';
        if (msg.title && msg.title !== oldTitle) {
            addSystemMessage(`now playing: ${msg.title}`, '#6366f1', { actor: '' });
        }
        if (npEl) npEl.textContent = msg.title || '—';
    }
    else if (msg.type === 'RECONNECTING')  { if (roomState) showReconnectToast(msg.seconds); }
    else if (msg.type === 'CONNECTION_STATUS' && msg.connected) { const rt = document.getElementById('ss-reconnect-toast'); if (rt) rt.remove(); }
    else if (msg.type === 'HOST_NAVIGATE') {
        // Logic Fix: Host should ignore their own navigation messages to prevent loops
        if (roomState?.isHost) return;

        if (msg.url && window.location.href !== msg.url) {
            window.location.href = msg.url;
        }
    }
    else if (msg.type === 'JOIN_ERROR')    showToast(`❌ ${msg.message || 'Could not join room'}`, '#ef4444');
});

// ─── VIDEO SYNC ───────────────────────────────────────────────────────────────
function findMainVideo() {
    // Logic Fix: Filter out small videos (ads, previews) and hidden ones
    const videos = Array.from(document.querySelectorAll('video')).filter(v => {
        const r = v.getBoundingClientRect();
        return r.width > 200 && r.height > 100 && v.offsetParent !== null && !v.id.startsWith('ss-v-');
    });
    if (!videos.length) return null;
    return videos.sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
}

function broadcastState(event = 'sync') {
    if (!videoElement || isSyncing || !roomState) return;

    // Democratic Control: If not host-only, participants can broadcast their actions
    const isHost = roomState.isHost;
    if (roomState.hostControlOnly && !isHost) return;

    if (!isHost && roomState.nowPlayingUrl) {
        try {
            const hostUrl = new URL(roomState.nowPlayingUrl);
            const myUrl   = new URL(window.location.href);
            if (hostUrl.origin !== myUrl.origin || hostUrl.pathname !== myUrl.pathname) return;
        } catch(e) {}
    }
    
    const time = videoElement.currentTime;
    const rate = videoElement.playbackRate;

    chrome.runtime.sendMessage({
        type: 'PLAYER_EVENT', event,
        time: time,
        playbackRate: rate
    }).catch(() => {});

    let line = '';
    const t = fmtTime(time);
    if      (event === 'play')   line = wasPaused ? 'started playing' : 'resumed at ' + t;
    else if (event === 'pause') {
        if (Date.now() - lastSeekTime < 500) return;
        line = 'paused at ' + t;
    }
    else if (event === 'seek') {
        lastSeekTime = Date.now();
        line = 'jumped to ' + t;
    }

    if (line && !isInitialLoad) {
        // Show as "You" locally
        addSystemMessage(line, roomState?.myColor || '#6366f1', { actor: 'You' });
    }
    
    if (event === 'play' || event === 'pause') wasPaused = (event === 'pause');
    isInitialLoad = false;

    // Echo Lock: 600ms is standard to prevent local action -> server -> remote-apply -> broadcast loop
    isSyncing = true;
    setTimeout(() => { isSyncing = false; }, 600); 
}

// ─── HEARTBEAT (INDUSTRY STANDARD: 3s) ────────────────────────────────────────
setInterval(() => {
    if (roomState?.isHost && videoElement && !videoElement.paused) {
        broadcastState('sync');
    }
}, 3000); 

function applyRemoteSync(msg) {
    if (!videoElement) videoElement = findMainVideo();
    if (!videoElement || !roomState || roomState.isHost) return;

    if (roomState?.nowPlayingUrl) {
        try {
            const hostUrl = new URL(roomState.nowPlayingUrl);
            const myUrl   = new URL(window.location.href);
            if (hostUrl.origin !== myUrl.origin || hostUrl.pathname !== myUrl.pathname) return;
        } catch(e) {}
    }

    // Latency Compensation
    const latency = msg.sentAt ? (Date.now() - msg.sentAt) / 1000 : 0;
    const targetTime = msg.time + (hostPaused ? 0 : latency);
    
    const drift = Math.abs(videoElement.currentTime - targetTime);

    const doApply = () => {
        isSyncing = true;
        
        // 1. Play/Pause Mismatch -> Instant Fix
        if (msg.event === 'play' || (msg.event === 'sync' && !hostPaused && videoElement.paused)) {
            videoElement.currentTime = targetTime;
            videoElement.play().catch(() => {
                setTimeout(() => videoElement.play().catch(() => {}), 500);
            });
        } 
        else if (msg.event === 'pause' || (msg.event === 'sync' && hostPaused && !videoElement.paused)) {
            videoElement.pause();
            videoElement.currentTime = targetTime;
        }
        // 2. Large Drift (> 1.5s) or Manual Seek -> Hard Jump
        else if (msg.event === 'seek' || drift > 1.5) {
            videoElement.currentTime = targetTime;
            videoElement.playbackRate = msg.playbackRate || 1;
        }
        // 3. Minor Drift (0.2s - 1.5s) -> Smooth Catch-up (Premium Feature)
        else if (drift > 0.2) {
            const baseRate = msg.playbackRate || 1;
            const adjustment = (videoElement.currentTime < targetTime) ? 0.05 : -0.05;
            videoElement.playbackRate = baseRate + adjustment;
            
            showSyncInd('⚡ Catching up...', '#f59e0b', 1500);

            setTimeout(() => {
                if (Math.abs(videoElement.currentTime - targetTime) < 0.1) {
                    videoElement.playbackRate = baseRate;
                }
            }, 2000);
        }
        // 4. Perfect Sync -> Just ensure playback rate is correct
        else {
            videoElement.playbackRate = msg.playbackRate || 1;
        }

        setTimeout(() => { isSyncing = false; }, 600);
    };

    if (videoElement.readyState >= 2) doApply();
    else {
        videoElement.addEventListener('loadedmetadata', doApply, { once: true });
        videoElement.addEventListener('canplay', doApply, { once: true });
    }

    if (msg.event !== 'sync' && !isInitialLoad) {
        const actor = msg.byUsername || 'Host';
        let line = '';
        const t = fmtTime(msg.time);
        if      (msg.event === 'play')   line = 'started playing';
        else if (msg.event === 'pause')  line = 'paused at ' + t;
        else if (msg.event === 'seek')   line = 'jumped to ' + t;
        if (line) addSystemMessage(line, msg.color || '#6366f1', { actor });
    }
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
    chrome.storage.local.set({ ssMicOn: isMicOn, ssCamOn: isCamOn, ssInCall: (isMicOn || isCamOn) }).catch(() => {});
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

    if (counter) {
        const total = visibleTiles.length + (hiddenCount); // All known users
        counter.textContent = String(allTiles.length + (document.getElementById('ss-vid-local') ? 1 : 0));
    }
}

// ─── VIDEO TILES ──────────────────────────────────────────────────────────────
function createTileShell(id, name, color, avatar) {
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

    // Avatar overlay (ALL users) — shown until video stream arrives or when camera is off
    const av = document.createElement('div');
    av.id = `ss-av-${id}`;
    av.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1c2e;z-index:1;';
    
    const displayAvatar = avatar || getAvatar(id, name);

    const avCircle = document.createElement('div');
    avCircle.style.cssText = `font-size:48px;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.5));`;
    avCircle.textContent = displayAvatar;
    av.appendChild(avCircle);
    tile.appendChild(av);

    if (id !== 'local') {
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
    requestAnimationFrame(() => { tile.style.opacity = '1'; updateGalleryLayout(); });
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
        const isMe = (u.id === roomState.myId);
        const tileId = isMe ? 'local' : u.id;
        activeIds.add(tileId);

        if (!document.getElementById(`ss-vid-${tileId}`)) {
            createTileShell(tileId, u.username, u.color, u.avatar);
            updateGalleryLayout();
        } else {
            // Update name label with away/host status
            const lbl = document.querySelector(`#ss-vid-${tileId} .ss-name-lbl`);
            if (lbl) {
                let nameStr = isMe ? 'You' : u.username;
                if (u.isAway) nameStr += ' 😴';
                if (u.isHost) nameStr += ' 👑';
                lbl.textContent = nameStr;
            }
            
            // Update avatar if it changed
            const avCircle = document.querySelector(`#ss-av-${tileId} > div`);
            if (avCircle && u.avatar) avCircle.textContent = u.avatar;
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

    const counter = document.getElementById('ss-gallery-count');
    if (counter) counter.textContent = String(users.length);
}

function removeVideoTile(id) {
    // Revert to avatar instead of full removal
    const vEl = document.getElementById(`ss-v-${id}`);
    const av  = document.getElementById(`ss-av-${id}`);
    if (vEl) { vEl.srcObject = null; vEl.style.display = 'none'; }
    if (av)  av.style.display = 'flex';
    const tile = document.getElementById(`ss-vid-${id}`);
    if (tile) {
        tile.style.display = ''; // Ensure it's not display:none
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
    const goBtn = document.createElement('button');
    goBtn.style.cssText = 'background:#6366f1;color:#fff;border:none;padding:8px 14px;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;';
    goBtn.textContent = 'SWITCH NOW';
    goBtn.onclick = () => { clearInterval(t._timer); window.location.href = url; };

    const stayBtn = document.createElement('button');
    stayBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:11px;cursor:pointer;';
    stayBtn.textContent = 'Stay here';
    stayBtn.onclick = () => { clearInterval(t._timer); t.remove(); };

    bottom.appendChild(stayBtn);
    bottom.appendChild(goBtn);
    t.appendChild(top);
    t.appendChild(titleEl);
    t.appendChild(bottom);
    (document.getElementById('ss-root') || document.body).appendChild(t);

    t._timer = setTimeout(() => { t.remove(); }, 15000);
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
function handleIncomingChat(user, text, color, avatar, userId) {
    if (text && text.startsWith('gif:')) {
        const url = text.replace('gif:', '');
        addSystemMessage(`<img src="${url}" style="width:100%;border-radius:12px;margin-top:6px;box-shadow:0 8px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);display:block;">`, color, { actor: user, isHtml: true });
    } else {
        addChatMessage(user, text, color, avatar, userId);
    }

    if (!isChatOpen) {
        unreadCount++;
        updateUnreadBadge();
        playNotifSound();
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
function addChatMessage(user, text, color, avatar, userId) {
    const msgs = document.getElementById('ss-msgs');
    if (!msgs) return;

    // Logic Fix: Always use the centralized map for avatars to ensure consistency
    const displayAvatar = avatar || getAvatar(userId, user);

    const m = document.createElement('div');
    m.style.cssText = 'display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);animation:ss-fadein 0.25s ease;align-items:flex-start;';
    
    const av = document.createElement('div');
    av.style.cssText = `flex-shrink:0;width:28px;height:28px;background:rgba(255,255,255,0.05);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;border:1px solid rgba(255,255,255,0.1);`;
    av.textContent = displayAvatar;

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const b = document.createElement('div');
    b.style.cssText = `font-size:11px;font-weight:700;color:${color || '#6366f1'};margin-bottom:2px;display:flex;align-items:center;gap:4px;`;
    b.textContent = user;
    
    const s = document.createElement('div');
    s.style.cssText = 'color:#eee;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;';
    s.textContent = text;

    content.appendChild(b);
    content.appendChild(s);
    m.appendChild(av);
    m.appendChild(content);
    
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    if (_ssRestoring) return;
    saveToPersistentHistory({ kind: 'msg', user, text, color, avatar });
}

function saveToPersistentHistory(item) {
    if (!roomState?.roomId) return;
    const key = `ss-chat-${roomState.roomId}`;
    chrome.storage.local.get([key], (res) => {
        const history = res[key] || [];
        history.push(item);
        if (history.length > 300) history.shift();
        chrome.storage.local.set({ [key]: history });
    });
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
    m.style.cssText = 'font-size:11px;color:#888;font-style:italic;padding:6px 2px;animation:ss-fadein 0.2s ease;letter-spacing:0.01em;';
    if (o.actor) {
        const a = document.createElement('span');
        a.style.cssText = `color:${color || '#6366f1'};font-weight:700;font-style:normal;`;
        a.textContent = o.actor;
        m.appendChild(a);
        m.appendChild(document.createTextNode(' '));
    }
    
    if (o.isHtml) {
        const span = document.createElement('span');
        span.innerHTML = text;
        m.appendChild(span);
    } else {
        m.appendChild(document.createTextNode(text));
    }
    
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    if (_ssRestoring) return;
    saveToPersistentHistory({ kind: 'sys', actor: o.actor || '', text, color, isHtml: !!o.isHtml });

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

function showSyncInd(text, color, ms = 2000) {
    const ind = document.getElementById('ss-sync-ind');
    if (!ind) return;
    ind.textContent = text;
    ind.style.background = color || 'rgba(99,102,241,0.95)';
    ind.style.opacity = '1';
    ind.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(ind._timer);
    ind._timer = setTimeout(() => {
        ind.style.opacity = '0';
        ind.style.transform = 'translateX(-50%) translateY(-20px)';
    }, ms);
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
    if (!roomState) return;
    const countEl = document.getElementById('ss-panel-user-count');
    if (countEl) {
        countEl.textContent = String((roomState.users || []).length);
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
    panel.style.cssText = 'position:absolute;top:0;right:0;width:320px;height:100%;max-width:80vw;background:rgba(6,6,14,0.98);backdrop-filter:blur(24px);border-left:1px solid rgba(255,255,255,0.1);box-shadow:-8px 0 32px rgba(0,0,0,0.5);transform:translateX(100%);pointer-events:auto;display:flex;flex-direction:column;color:#fff;z-index:2;';
    root.appendChild(panel);

    // Header
    const pHeader = document.createElement('div');
    pHeader.style.cssText = 'padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    
    // Left side: App Logo/Name
    const pHeaderLeft = document.createElement('div');
    pHeaderLeft.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const logoIcon = document.createElement('div');
    logoIcon.style.cssText = 'width:24px;height:24px;background:linear-gradient(135deg, #6366f1, #a855f7);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#fff;';
    logoIcon.textContent = 'S';
    const pHeaderTitle = document.createElement('div');
    pHeaderTitle.style.cssText = 'font-size:14px;font-weight:700;letter-spacing:0.02em;color:#fff;';
    pHeaderTitle.textContent = 'SyncStream';
    pHeaderLeft.appendChild(logoIcon);
    pHeaderLeft.appendChild(pHeaderTitle);
    pHeader.appendChild(pHeaderLeft);

    // Right side: Controls (Users, Share, Exit)
    const pHeaderRight = document.createElement('div');
    pHeaderRight.style.cssText = 'display:flex;align-items:center;gap:12px;';
    
    // User Count
    const userCountBox = document.createElement('div');
    userCountBox.style.cssText = 'display:flex;align-items:center;gap:4px;color:#aaa;font-size:12px;font-weight:600;background:rgba(255,255,255,0.05);padding:4px 8px;border-radius:6px;';
    userCountBox.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg> <span id="ss-panel-user-count">1</span>`;
    pHeaderRight.appendChild(userCountBox);

    // Share Button
    const shareBtn = document.createElement('button');
    shareBtn.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;padding:4px;display:flex;align-items:center;transition:color 0.2s;';
    shareBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>`;
    shareBtn.title = 'Share Party Link';
    shareBtn.onmouseenter = () => shareBtn.style.color = '#fff';
    shareBtn.onmouseleave = () => shareBtn.style.color = '#aaa';
    pHeaderRight.appendChild(shareBtn);

    // Leave Button
    const leaveBtn = document.createElement('button');
    leaveBtn.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;padding:4px;display:flex;align-items:center;transition:color 0.2s;';
    leaveBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`;
    leaveBtn.title = 'Leave Room';
    leaveBtn.onmouseenter = () => leaveBtn.style.color = '#ef4444';
    leaveBtn.onmouseleave = () => leaveBtn.style.color = '#aaa';
    leaveBtn.onclick = () => { if(confirm('Leave the party?')) chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' }); };
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
    npTitle.style.cssText = 'font-size:12px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;';
    npTitle.textContent = 'Scanning...';
    npRow.appendChild(npLabel);
    npRow.appendChild(npTitle);

    // Follow Host Banner (Hidden by default, shown if URL mismatch)
    const followHost = document.createElement('div');
    followHost.id = 'ss-follow-host';
    followHost.style.cssText = 'padding:8px 16px;background:rgba(99,102,241,0.2);border-bottom:1px solid rgba(99,102,241,0.3);display:none;align-items:center;justify-content:space-between;gap:8px;animation:ss-fadein 0.3s ease;';
    followHost.innerHTML = `
        <div style="font-size:11px;color:#818cf8;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">
            Host is on another video
        </div>
        <button id="ss-join-host-btn" style="background:#6366f1;border:none;color:#fff;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;transition:transform 0.2s;">JOIN HOST</button>
    `;
    panel.appendChild(followHost);
    panel.appendChild(npRow);

    // ── SHARE MODAL ───────────────────────────────────────────────────────────
    const shareModal = document.createElement('div');
    shareModal.id = 'ss-share-modal';
    shareModal.style.cssText = 'position:absolute;top:54px;left:50%;transform:translateX(-50%);width:280px;background:#1a1c2e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:20px;box-shadow:0 12px 48px rgba(0,0,0,0.8);display:none;flex-direction:column;gap:16px;z-index:100;animation:ss-slideDown 0.3s ease;';
    
    const modalTitle = document.createElement('div');
    modalTitle.style.cssText = 'font-size:14px;font-weight:700;text-align:center;margin-bottom:4px;';
    modalTitle.textContent = 'Share this Party';
    shareModal.appendChild(modalTitle);

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = 'width:100%;padding:12px;background:none;border:1px solid #6366f1;border-radius:10px;color:#818cf8;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s;';
    copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> COPY LINK`;
    copyBtn.onclick = () => {
        const url = new URL(window.location.href);
        url.hash = `ss_room=${roomState.roomId}`;
        navigator.clipboard.writeText(url.toString()).then(() => {
            copyBtn.textContent = '✓ COPIED';
            copyBtn.style.borderColor = '#10b981';
            copyBtn.style.color = '#10b981';
            setTimeout(() => {
                copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> COPY LINK`;
                copyBtn.style.borderColor = '#6366f1';
                copyBtn.style.color = '#818cf8';
            }, 2000);
        });
    };
    shareModal.appendChild(copyBtn);

    const socialRow = document.createElement('div');
    socialRow.style.cssText = 'display:flex;justify-content:center;gap:20px;padding-top:4px;';
    
    const createSocial = (icon, color, link) => {
        const a = document.createElement('a');
        a.href = link; a.target = '_blank';
        a.style.cssText = `color:${color};opacity:0.8;transition:transform 0.2s, opacity 0.2s;cursor:pointer;`;
        a.innerHTML = icon;
        a.onmouseenter = () => { a.style.opacity = '1'; a.style.transform = 'scale(1.2)'; };
        a.onmouseleave = () => { a.style.opacity = '0.8'; a.style.transform = 'scale(1)'; };
        return a;
    };

    const getLink = () => {
        const url = new URL(window.location.href);
        url.hash = `ss_room=${roomState.roomId}`;
        return encodeURIComponent(url.toString());
    };

    const whatsapp = createSocial(`<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.414 0 .018 5.396.015 12.03c0 2.12.554 4.189 1.604 6.04L0 24l6.104-1.602a11.803 11.803 0 005.942 1.6h.005c6.634 0 12.032-5.396 12.035-12.032a11.761 11.761 0 00-3.473-8.497"/></svg>`, '#25D366', '');
    whatsapp.onclick = (e) => { e.preventDefault(); window.open(`https://api.whatsapp.com/send?text=Join my party! ${getLink()}`, '_blank'); };
    
    const telegram = createSocial(`<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18.717-3.931 16.326-4.131 17.151-.2.825-.46 1.013-.744 1.038-.614.053-1.079-.41-1.674-.8l-2.619-1.921-1.411-1.144c-.046-.037-.09-.074-.132-.112l-.082-.072c-.1-.088-.19-.177-.28-.27l4.316-4.088c.038-.036.074-.074.11-.112l.142-.152c.036-.041.066-.085.093-.131.063-.105.097-.225.098-.348-.001-.132-.036-.26-.102-.375-.125-.218-.383-.342-.644-.31l-5.69 2.158c-.105.04-.213.076-.324.108l-.29.082c-.443.125-.873.188-1.288.188-.415 0-.811-.063-1.186-.188l-.29-.096c-.161-.054-.319-.115-.472-.182l-.181-.078c-.37-.16-.723-.338-1.054-.531.428-.152.923-.314 1.48-.485 3.336-1.026 12.019-4.524 14.186-5.405.813-.331 1.62-.48 2.401-.444.78.036 1.503.22 2.156.551.493.25.922.585 1.28.995.358.411.644.895.852 1.442.208.547.332 1.155.37 1.81.038.655-.001 1.353-.118 2.083z"/></svg>`, '#0088cc', '');
    telegram.onclick = (e) => { e.preventDefault(); window.open(`https://t.me/share/url?url=${getLink()}&text=Join my party!`, '_blank'); };
    
    const mail = createSocial(`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`, '#fff', '');
    mail.onclick = (e) => { e.preventDefault(); window.open(`mailto:?subject=Join my SyncStream Party&body=Join here: ${getLink()}`, '_blank'); };

    socialRow.appendChild(whatsapp);
    socialRow.appendChild(telegram);
    socialRow.appendChild(mail);
    shareModal.appendChild(socialRow);
    
    panel.appendChild(shareModal);

    shareBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = shareModal.style.display === 'flex';
        shareModal.style.display = isOpen ? 'none' : 'flex';
    };
    document.addEventListener('click', (e) => { if(!shareModal.contains(e.target)) shareModal.style.display = 'none'; });

    // CSS for modal animation
    const styleModal = document.createElement('style');
    styleModal.textContent = `
        @keyframes ss-slideDown { from { opacity:0; transform:translate(-50%, -10px); } to { opacity:1; transform:translate(-50%, 0); } }
    `;
    document.head.appendChild(styleModal);

    // Chat scroll area
    const msgs = document.createElement('div');
    msgs.id = 'ss-msgs';
    msgs.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-height:0;';
    panel.appendChild(msgs);

    // Restore chat history from persistent storage
    if (roomState?.roomId) {
        _ssRestoring = true;
        const key = `ss-chat-${roomState.roomId}`;
        chrome.storage.local.get([key], (res) => {
            const history = res[key] || [];
            history.forEach(m => {
                if (m.kind === 'sys') addSystemMessage(m.text, m.color, { actor: m.actor, isHtml: m.isHtml });
                else                  addChatMessage(m.user, m.text, m.color, m.avatar);
            });
            _ssRestoring = false;
        });
    }

    // ── REACTIONS ROW ────────────────────────────────────────────────────────
    const reactionsRow = document.createElement('div');
    reactionsRow.id = 'ss-reactions-row';
    reactionsRow.style.cssText = 'padding:8px 14px 6px;display:flex;justify-content:space-around;align-items:center;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;transition:all 0.3s ease;';
    
    const REACTIONS = ['🥰','😡','😭','😂','🥳','🔥'];
    REACTIONS.forEach(em => {
        const rb = document.createElement('button');
        rb.textContent = em;
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

    // ── EMOJI PICKER ─────────────────────────────────────────────────────────
    const emojiPicker = document.createElement('div');
    emojiPicker.id = 'ss-emoji-picker';
    emojiPicker.style.cssText = 'position:absolute;bottom:48px;right:8px;width:240px;max-height:200px;overflow-y:auto;background:rgba(20,20,30,0.98);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:8px;display:none;grid-template-columns:repeat(7,1fr);gap:2px;z-index:5;box-shadow:0 4px 20px rgba(0,0,0,0.6);animation:ss-pop 0.18s ease;';
    const CHAT_EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😗','😋','😛','😜','🤪','😎','🤓','🧐','🤔','🤨','😐','😑','😶','🙄','😏','😒','😔','😪','😴','🤤','😵','🤯','🥳','🤠','🥸','😢','😭','😱','😨','😰','😥','😓','🤗','🤭','🤫','😬','🙃','😡','🤬','👍','👎','👏','🙏','💪','✊','🤝','❤️','💔','💖','💯','🔥','✨','⭐','🎉','🎊','🎁','🎂','☕','🍕','🍔','🎬','🎵','🎮','⚽','🏆','💡','✅'];
    CHAT_EMOJIS.forEach(em => {
        const eb = document.createElement('button');
        eb.textContent = em;
        eb.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;padding:5px;border-radius:6px;transition:background 0.12s,transform 0.12s;line-height:1;';
        eb.onmouseenter = () => { eb.style.background = 'rgba(255,255,255,0.12)'; eb.style.transform = 'scale(1.18)'; };
        eb.onmouseleave = () => { eb.style.background = 'none'; eb.style.transform = 'scale(1)'; };
        eb.onclick = (ev) => {
            ev.stopPropagation();
            const start = chatInput.selectionStart || chatInput.value.length;
            const end   = chatInput.selectionEnd   || chatInput.value.length;
            chatInput.value = chatInput.value.slice(0, start) + em + chatInput.value.slice(end);
            chatInput.focus();
            chatInput.setSelectionRange(start + em.length, start + em.length);
        };
        emojiPicker.appendChild(eb);
    });
    inputRow.appendChild(emojiPicker);

    // ── BOTTOM CONTROLS ──────────────────────────────────────────────────────
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
        b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,0.16)'; b.style.transform='scale(1.08)'; };
        b.onmouseleave = () => { b.style.transform='scale(1)'; updateButtons(); };
        b.onclick = (e) => { e.stopPropagation(); handler(); };
        return b;
    };

    leftCtrls.appendChild(mkSmallBtn('📷', 'ss-b-cam',    () => { isCamOn = !isCamOn; updateMedia(); },  'Camera (Alt+C)'));
    leftCtrls.appendChild(mkSmallBtn('🎤', 'ss-b-mic',    () => { isMicOn = !isMicOn; updateMedia(); },  'Mic (Alt+M)'));
    leftCtrls.appendChild(mkSmallBtn('🖥', 'ss-b-screen', () => toggleScreenShare(),                     'Screen (Alt+S)'));

    const emojiBtn = mkSmallBtn('😊', null, () => {
        emojiPicker.style.display = emojiPicker.style.display === 'grid' ? 'none' : 'grid';
    }, 'Emojis');

    // Reaction Row Toggle
    const reactToggleBtn = mkSmallBtn('🎭', 'ss-b-react-tog', () => {
        const isHidden = reactionsRow.style.display === 'none';
        reactionsRow.style.display = isHidden ? 'flex' : 'none';
        reactToggleBtn.style.color = isHidden ? '#fff' : '#666';
    }, 'Toggle Reactions Row');
    reactToggleBtn.style.color = '#fff'; // Active by default
    
    const partyBtn = mkSmallBtn('🎉', null, () => {
        chrome.runtime.sendMessage({ type: 'REACTION', emoji: '🎉' });
    }, 'Quick Party!');

    // GIF PICKER UI
    const gifPicker = document.createElement('div');
    gifPicker.id = 'ss-gif-picker';
    gifPicker.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;height:320px;background:#131422;border-top:1px solid #3f3f46;display:none;flex-direction:column;z-index:1000;box-shadow:0 -12px 32px rgba(0,0,0,0.6);border-radius:20px 20px 0 0;overflow:hidden;';
    
    const gifHeader = document.createElement('div');
    gifHeader.style.cssText = 'padding:12px;display:flex;gap:8px;border-bottom:1px solid rgba(255,255,255,0.05);';
    const gifSearch = document.createElement('input');
    gifSearch.placeholder = 'Search GIFs...';
    gifSearch.style.cssText = 'flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:8px 12px;color:#fff;font-size:12px;outline:none;';
    gifHeader.appendChild(gifSearch);
    gifPicker.appendChild(gifHeader);

    const gifGrid = document.createElement('div');
    gifGrid.style.cssText = 'flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:12px;';
    gifPicker.appendChild(gifGrid);
    
    const searchGifs = async (q = '') => {
        gifGrid.innerHTML = '<div style="grid-column:span 2;text-align:center;padding:40px;color:#666;font-size:11px;">Searching Tenor...</div>';
        try {
            const res = await fetch(`https://g.tenor.com/v1/search?q=${q || 'trending'}&key=LIVDSRZULEUB&limit=16&media_filter=minimal`);
            const data = await res.json();
            gifGrid.innerHTML = '';
            if (!data.results?.length) {
                gifGrid.innerHTML = '<div style="grid-column:span 2;text-align:center;padding:40px;color:#666;font-size:11px;">No GIFs found</div>';
                return;
            }
            data.results.forEach(g => {
                const img = document.createElement('img');
                img.src = g.media[0].tinygif.url;
                img.style.cssText = 'width:100%;height:90px;object-fit:cover;border-radius:10px;cursor:pointer;transition:transform 0.2s, border-color 0.2s;border:2px solid transparent;';
                img.onclick = () => {
                    chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text: `gif:${g.media[0].gif.url}` });
                    gifPicker.style.display = 'none';
                };
                img.onmouseenter = () => { img.style.transform = 'scale(1.02)'; img.style.borderColor = '#6366f1'; };
                img.onmouseleave = () => { img.style.transform = 'scale(1)'; img.style.borderColor = 'transparent'; };
                gifGrid.appendChild(img);
            });
        } catch(e) { gifGrid.innerHTML = '<div style="color:#ef4444;grid-column:span 2;text-align:center;padding:20px;">Error loading GIFs</div>'; }
    };

    let searchTimeout;
    gifSearch.oninput = () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => searchGifs(gifSearch.value), 400);
    };

    const gifBtn = mkSmallBtn('🖼️', 'ss-b-gif', () => {
        const isHidden = gifPicker.style.display === 'none';
        gifPicker.style.display = isHidden ? 'grid' : 'none';
        if (isHidden) searchGifs();
    }, 'Send GIF');

    rightCtrls.appendChild(gifBtn);
    rightCtrls.appendChild(emojiBtn);
    rightCtrls.appendChild(partyBtn);
    
    panel.insertBefore(gifPicker, inputRow);
    bottomRow.appendChild(leftCtrls);
    bottomRow.appendChild(rightCtrls);
    panel.appendChild(bottomRow);

    // ── PANEL TOGGLE ─────────────────────────────────────────────────────────
    const toggle = document.createElement('div');
    toggle.id = 'ss-panel-toggle';
    toggle.style.cssText = 'position:absolute;top:50%;right:0;transform:translateY(-50%);width:42px;height:60px;background:rgba(6,6,14,0.95);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-right:none;border-radius:12px 0 0 12px;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:auto;box-shadow:-4px 4px 16px rgba(0,0,0,0.5);z-index:2147483646;';
    const toggleIcon = document.createElement('span');
    toggleIcon.style.cssText = 'font-size:18px;line-height:1;';
    toggleIcon.textContent = '💬';
    toggle.appendChild(toggleIcon);

    const badge = document.createElement('div');
    badge.id = 'ss-chat-badge';
    badge.style.cssText = 'position:absolute;top:5px;right:4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:none;align-items:center;justify-content:center;pointer-events:none;padding:0 4px;border:1px solid rgba(6,6,14,0.95);box-sizing:content-box;';
    toggle.appendChild(badge);
    root.appendChild(toggle);

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
    window.__ssTogglePanel = () => setPanelOpen(!isChatOpen);

    // Logic Fix: Ensure local participant tile is always visible (as requested)
    if (roomState?.myId) {
        createTileShell('local', roomState.myUsername || 'You', roomState.myColor, roomState.myAvatar);
    }

    // ── UTILS / EVENTS ───────────────────────────────────────────────────────
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

    setInterval(() => {
        if (roomState?.roomId) chrome.runtime.sendMessage({ type: 'HEARTBEAT' }).catch(() => {});
    }, 30000);

    // Initial Media Recovery: Check if we were in a call before page load
    if (roomState?.users) {
        const me = roomState.users.find(u => u.id === roomState.myId);
        if (me?.isInCall && !localStream) {
            console.log('[SyncStream] Initializing auto-resume media...');
            setTimeout(updateMedia, 1500); // Give page some time to settle
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && roomState?.roomId) {
            chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
                if (res?.roomId) {
                    roomState = res;
                    updateParticipantPanel();
                    syncAvatarTiles(res.users || []);
                    
                    // Logic Fix: Aggressive Hard-Sync on Visibility
                    if (!roomState.isHost && roomState.currentTime !== undefined) {
                        applyRemoteSync({
                            event: 'sync',
                            time: roomState.currentTime,
                            playbackRate: roomState.playbackRate || 1,
                            isPaused: roomState.isPaused,
                            sentAt: Date.now()
                        });
                    }
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

    // Now Playing — Only the HOST reports the title to the room to avoid loops
    if (IS_TOP_FRAME && roomState && roomState.isHost) {
        let title = document.title;
        const h1 = document.querySelector('h1.ytd-video-primary-info-renderer, h1[class*="title"], .video-title, #video-title');
        if (h1?.innerText) title = h1.innerText.trim();
        
        if (title && title !== lastTitle && title !== document.location.hostname) {
            lastTitle = title;
            chrome.runtime.sendMessage({ type: 'UPDATE_NOW_PLAYING', title, url: window.location.href }).catch(() => {});
            const npEl = document.getElementById('ss-np-title');
            if (npEl) npEl.textContent = title;
        }
    }

    // Non-host: If we are on a different URL than the room, show a warning
    if (IS_TOP_FRAME && roomState && !roomState.isHost && roomState.nowPlayingUrl) {
        try {
            const hostUrl = new URL(roomState.nowPlayingUrl);
            const myUrl   = new URL(window.location.href);
            
            const followBanner = document.getElementById('ss-follow-host');
            const joinBtn      = document.getElementById('ss-join-host-btn');

            // Check if base URL (origin + path) is different
            if (hostUrl.origin !== myUrl.origin || hostUrl.pathname !== myUrl.pathname) {
                // Show Follow Banner in panel
                if (followBanner) {
                    followBanner.style.display = 'flex';
                    if (joinBtn) joinBtn.onclick = () => { window.location.href = roomState.nowPlayingUrl; };
                }
                
                // Also show a toast if not already there
                if (!document.getElementById('ss-nav-toast')) {
                    showNavigateToast(roomState.nowPlayingUrl, roomState.nowPlaying, 'Host');
                }
            } else {
                // We are on the right page!
                if (followBanner) followBanner.style.display = 'none';
                const existing = document.getElementById('ss-nav-toast');
                if (existing) existing.remove();
            }
        } catch(_) {}
    }
}

loopInterval = setInterval(mainLoop, 400); // Increased frequency from 500ms to 400ms

// Logic Fix: Graceful cleanup when navigating away
window.addEventListener('beforeunload', () => {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
    }
    Object.values(peerConnections).forEach(pc => pc.close());
});
