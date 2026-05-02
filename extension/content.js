/**
 * SyncStream Pro - Content Script
 * Version 5.0 - Root Cause Fix Edition
 *
 * KEY FIXES:
 * 1. Guard: createPeer only runs AFTER myId is confirmed from server
 * 2. Perfect Negotiation: polite/impolite collision prevention working correctly
 * 3. Sync and WebRTC are 100% isolated - no shared state
 * 4. Button clicks never bubble to YouTube player
 * 5. Remote video plays independently from YouTube player state
 */

// ─── STATE ────────────────────────────────────────────────────────────────────
let videoElement = null;
let isSyncing    = false;
let roomState    = null;

let localStream      = null;
let peerConnections  = {};  // peerId → { pc, polite, makingOffer }
let hiddenVideos     = new Set();

let isMicOn      = false;
let isCamOn      = false;
let isChatOpen   = false;
let isEmojiOpen  = false;
let isMirror     = true;   // mirror local camera by default
let isSoundOn    = true;   // UI notification sounds

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

// ─── FRAME GUARD ────────────────────────────────────────────────────────────────
// UI + WebRTC: only in the top (main) frame
// Video Sync: in ALL frames (iframe players like dizigom)
const IS_TOP_FRAME = (window === window.top);

console.log(`[SyncStream] v5.1 loaded | top=${IS_TOP_FRAME} | ${location.hostname}`);

// ─── INIT ──────────────────────────────────────────────────────────────────────
// Only init WebRTC/peers from top frame to avoid duplicate connections
if (IS_TOP_FRAME) {
    chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        roomState = res;
        if (roomState.myId) initPeers();
        if (roomState.isHost && videoElement) broadcastState();
    });
} else {
    // In iframe: still need roomState for sync guard (hostControlOnly check)
    chrome.runtime.sendMessage({ type: 'GET_ROOM_STATE' }, (res) => {
        if (!chrome.runtime.lastError && res) roomState = res;
    });
}

// ─── VIDEO SYNC ────────────────────────────────────────────────────────────────
function findMainVideo() {
    // Exclude our own conference videos
    const all = Array.from(document.querySelectorAll('video')).filter(v => !v.id.startsWith('ss-v-'));
    if (!all.length) return null;
    return all.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
}

function attachSyncListeners() {
    if (!videoElement) return;
    videoElement.addEventListener('play',   () => { if (!isSyncing && roomState && !blockedByHostControl()) broadcastState('play');  });
    videoElement.addEventListener('pause',  () => { if (!isSyncing && roomState && !blockedByHostControl()) broadcastState('pause'); });
    videoElement.addEventListener('seeked', () => { if (!isSyncing && roomState && !blockedByHostControl()) broadcastState('seek');  });
}

function blockedByHostControl() {
    return roomState.hostControlOnly && !roomState.isHost;
}

function broadcastState(event = 'sync') {
    if (!videoElement) return;
    chrome.runtime.sendMessage({
        type:  'PLAYER_EVENT',
        event: event,
        time:  videoElement.currentTime
    }).catch(() => {});
}

function applyRemoteSync(msg) {
    if (!videoElement) return;
    isSyncing = true;
    const diff = Math.abs(videoElement.currentTime - msg.time);
    if (msg.event === 'seek' || diff > 2) videoElement.currentTime = msg.time;
    if (msg.event === 'play')  videoElement.play().catch(() => {});
    if (msg.event === 'pause') videoElement.pause();
    setTimeout(() => { isSyncing = false; }, 1000);
}

// ─── ADAPTIVE BITRATE ──────────────────────────────────────────────────────────
// Quality levels: high (good connection) → low (poor connection)
const VIDEO_QUALITY = {
    high:   { width: 320, height: 240, frameRate: 15, bitrate: 350000 },
    medium: { width: 240, height: 180, frameRate: 10, bitrate: 150000 },
    low:    { width: 160, height: 120, frameRate: 7,  bitrate:  60000 }
};
let currentQuality = 'high';

async function setEncodingParams(pc, bitrate) {
    const senders = pc.getSenders().filter(s => s.track?.kind === 'video');
    for (const sender of senders) {
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.encodings[0].maxBitrate = bitrate;
            await sender.setParameters(params);
        } catch(e) {}
    }
}

async function applyQuality(level) {
    if (currentQuality === level) return;
    currentQuality = level;
    const q = VIDEO_QUALITY[level];
    console.log(`[SyncStream] Network quality → ${level}`);
    // ONLY touch video bitrate - never audio (audio dropout fix)
    Object.values(peerConnections).forEach(({ pc }) => setEncodingParams(pc, q.bitrate));
}

// Monitor each peer connection's stats and adapt quality (video only)
async function monitorConnectionQuality(tid, pc) {
    try {
        const stats = await pc.getStats();
        let rtt = 0;
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
                rtt = report.currentRoundTripTime;
            }
        });
        // Only adjust bitrate based on RTT - do NOT call applyConstraints (causes audio glitches)
        if (rtt > 0.4)      applyQuality('low');
        else if (rtt > 0.2) applyQuality('medium');
        else                applyQuality('high');
    } catch(e) {}
}

// ─── WEBRTC MEDIA ─────────────────────────────────────────────────────────────
async function updateMedia() {
    try {
        if (isMicOn || isCamOn) {
            if (!localStream) {
                const q = VIDEO_QUALITY[currentQuality];
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: { width: q.width, height: q.height, frameRate: q.frameRate }
                });
            }
            // Enable/disable tracks (no stop/restart = no renegotiation storm)
            localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
            localStream.getVideoTracks().forEach(t => t.enabled = isCamOn);

            // Push tracks to existing peers
            Object.values(peerConnections).forEach(({ pc }) => {
                localStream.getTracks().forEach(track => {
                    const existing = pc.getSenders().find(s => s.track?.kind === track.kind);
                    if (!existing) {
                        const sender = pc.addTrack(track, localStream);
                        // Set initial bitrate limit
                        if (track.kind === 'video') {
                            setTimeout(() => setEncodingParams(pc, VIDEO_QUALITY[currentQuality].bitrate), 1000);
                        }
                    } else if (existing.track !== track) {
                        existing.replaceTrack(track);
                    }
                });
            });

            if (isCamOn) addVideoTile('local', localStream, 'You');
            else removeVideoTile('local');

            chrome.runtime.sendMessage({ type: 'TOGGLE_CALL', enabled: true });
        } else {
            // Both off: stop stream
            if (localStream) {
                localStream.getTracks().forEach(t => t.stop());
                localStream = null;
                Object.values(peerConnections).forEach(({ pc }) => pc.getSenders().forEach(s => pc.removeTrack(s)));
                removeVideoTile('local');
                chrome.runtime.sendMessage({ type: 'TOGGLE_CALL', enabled: false });
            }
        }
    } catch (err) {
        console.error('[SyncStream] Media error:', err);
        isMicOn = false; isCamOn = false;
    }
    updateButtons();
}

function initPeers() {
    if (!roomState?.users || !roomState.myId) return;
    roomState.users.forEach(u => {
        if (u.username !== roomState.myUsername) createPeer(u.id, u.username);
    });
}

async function createPeer(tid, name) {
    if (peerConnections[tid]) return;

    // Guard: we MUST have myId to determine polite/impolite
    if (!roomState?.myId) {
        console.warn('[SyncStream] createPeer called before myId set, skipping', tid);
        return;
    }

    const pc     = new RTCPeerConnection(ICE_SERVERS);
    const polite = roomState.myId < tid;   // smaller ID = polite peer
    const pObj   = { pc, polite, makingOffer: false };
    peerConnections[tid] = pObj;

    console.log(`[SyncStream] Creating peer ${tid}, I am ${polite ? 'POLITE' : 'IMPOLITE'}`);

    // ICE candidates
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { candidate } });
    };

    // Remote track received → show video tile immediately
    pc.ontrack = ({ streams: [stream] }) => {
        console.log('[SyncStream] Remote track received from', name);
        addVideoTile(tid, stream, name);
        // Force play immediately regardless of YouTube player state
        const v = document.getElementById(`ss-v-${tid}`);
        if (v) { v.muted = false; v.volume = 1.0; v.play().catch(() => {}); }
    };

    // Perfect Negotiation: automatic renegotiation
    pc.onnegotiationneeded = async () => {
        try {
            pObj.makingOffer = true;
            await pc.setLocalDescription();
            chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: tid, payload: { description: pc.localDescription } });
        } catch (e) {
            console.error('[SyncStream] Negotiation error:', e);
        } finally {
            pObj.makingOffer = false;
            // CRITICAL FIX: After renegotiation, force all remote streams back on
            // This handles the case where pausing YouTube + opening camera kills audio
            setTimeout(() => {
                document.querySelectorAll('video[id^="ss-v-"]').forEach(v => {
                    if (v.id !== 'ss-v-local' && v.srcObject) {
                        v.muted = false;
                        v.volume = 1.0;
                        if (v.paused) v.play().catch(() => {});
                    }
                });
            }, 500);
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`[SyncStream] ICE state ${tid}:`, state);
        if (state === 'failed' || state === 'disconnected') {
            console.log('[SyncStream] Connection degraded, restarting ICE...');
            pc.restartIce();
            // Force resume remote audio after reconnect
            setTimeout(() => {
                document.querySelectorAll('video[id^="ss-v-"]').forEach(v => {
                    if (v.id !== 'ss-v-local' && v.srcObject) {
                        v.muted = false; v.volume = 1.0;
                        if (v.paused) v.play().catch(() => {});
                    }
                });
            }, 1500);
        }
    };

    // Monitor connection quality every 5 seconds
    const qualityInterval = setInterval(() => {
        if (!peerConnections[tid]) { clearInterval(qualityInterval); return; }
        monitorConnectionQuality(tid, pc);
    }, 5000);

    // Add local tracks if camera/mic already on
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
}

async function handleSignaling(fromId, payload) {
    // If we don't have a peer for this sender yet, create one (they initiated)
    if (!peerConnections[fromId]) {
        const fromUser = roomState?.users?.find(u => u.id === fromId);
        if (fromUser) createPeer(fromId, fromUser.username);
        else {
            // We don't know who this is yet, create peer with unknown name
            if (!roomState?.myId) return;
            const pc2 = new RTCPeerConnection(ICE_SERVERS);
            const polite2 = roomState.myId < fromId;
            peerConnections[fromId] = { pc: pc2, polite: polite2, makingOffer: false };
            pc2.onicecandidate = ({ candidate }) => { if (candidate) chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: fromId, payload: { candidate } }); };
            pc2.ontrack = ({ streams: [s] }) => addVideoTile(fromId, s, 'User');
            pc2.onnegotiationneeded = async () => {
                try { peerConnections[fromId].makingOffer = true; await pc2.setLocalDescription(); chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: fromId, payload: { description: pc2.localDescription } }); }
                catch(e) {} finally { peerConnections[fromId].makingOffer = false; }
            };
            if (localStream) localStream.getTracks().forEach(t => pc2.addTrack(t, localStream));
        }
    }

    const p  = peerConnections[fromId];
    if (!p) return;
    const pc = p.pc;

    try {
        if (payload.description) {
            const isOffer    = payload.description.type === 'offer';
            const notStable  = pc.signalingState !== 'stable';
            const collision  = isOffer && (p.makingOffer || notStable);

            // Impolite peer: ignore colliding offers
            if (!p.polite && collision) {
                console.log('[SyncStream] Ignoring colliding offer (impolite)');
                return;
            }

            await pc.setRemoteDescription(payload.description);

            if (isOffer) {
                await pc.setLocalDescription();
                chrome.runtime.sendMessage({ type: 'SIGNALING', targetId: fromId, payload: { description: pc.localDescription } });
            }
        } else if (payload.candidate) {
            await pc.addIceCandidate(payload.candidate).catch(() => {});
        }
    } catch (err) {
        console.error('[SyncStream] Signaling error:', err);
    }
}

// ─── VIDEO TILES ───────────────────────────────────────────────────────────────
function addVideoTile(id, stream, label) {
    if (hiddenVideos.has(id)) return;
    const grid = document.getElementById('ss-grid');
    if (!grid) return;

    let tile = document.getElementById(`ss-vid-${id}`);
    if (!tile) {
        tile = document.createElement('div');
        tile.id = `ss-vid-${id}`;
        tile.style.cssText = 'width:200px;height:150px;background:#111;border-radius:10px;overflow:hidden;position:relative;border:1px solid rgba(255,255,255,0.15);pointer-events:auto;';

        const vid = document.createElement('video');
        vid.id = `ss-v-${id}`;
        vid.autoplay = true; vid.playsInline = true;
        vid.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
        tile.appendChild(vid);

        const lbl = document.createElement('div');
        lbl.style.cssText = 'position:absolute;bottom:5px;left:5px;background:rgba(0,0,0,0.7);color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;pointer-events:none;';
        lbl.textContent = label;
        tile.appendChild(lbl);

        const x = document.createElement('button');
        x.innerHTML = '✕';
        x.style.cssText = 'position:absolute;top:5px;right:5px;background:rgba(0,0,0,0.5);border:none;color:#fff;border-radius:50%;width:20px;height:20px;cursor:pointer;line-height:1;';
        x.onclick = (e) => { e.stopPropagation(); hiddenVideos.add(id); tile.remove(); };
        tile.appendChild(x);

        grid.appendChild(tile);
    }

    const v = document.getElementById(`ss-v-${id}`);
    if (v && v.srcObject !== stream) {
        v.srcObject = stream;
        v.muted = (id === 'local');
        v.volume = 1.0;
        // Mirror local camera (selfie view)
        if (id === 'local') v.style.transform = 'scaleX(-1)';
        v.play().catch(() => {});
    }
}

function removeVideoTile(id) {
    const el = document.getElementById(`ss-vid-${id}`);
    if (el) el.remove();
}

// ─── UI ────────────────────────────────────────────────────────────────────────
function injectUI() {
    if (document.getElementById('ss-root')) return;

    const root = document.createElement('div');
    root.id = 'ss-root';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;font-family:system-ui,sans-serif;';
    document.body.appendChild(root);

    // Dock
    const dock = document.createElement('div');
    dock.id = 'ss-dock';
    dock.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:rgba(10,10,20,0.88);backdrop-filter:blur(12px);padding:10px 18px;border-radius:40px;border:1px solid rgba(255,255,255,0.12);display:flex;gap:12px;align-items:center;pointer-events:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);z-index:2147483647;';

    const mkBtn = (emoji, id, handler) => {
        const b = document.createElement('button');
        b.id = id; b.textContent = emoji;
        b.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:background 0.2s;outline:none;';
        // CRITICAL: stopPropagation prevents YouTube from catching the click
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handler(); }, true);
        return b;
    };

    dock.appendChild(mkBtn('💬', 'ss-b-chat',  () => { isChatOpen = !isChatOpen;  document.getElementById('ss-chat').style.display = isChatOpen ? 'flex' : 'none'; updateButtons(); }));
    dock.appendChild(mkBtn('🎤', 'ss-b-mic',   () => { isMicOn = !isMicOn;  updateMedia(); }));
    dock.appendChild(mkBtn('📷', 'ss-b-cam',   () => { isCamOn = !isCamOn;  updateMedia(); }));
    dock.appendChild(mkBtn('😊', 'ss-b-emoji', () => { isEmojiOpen = !isEmojiOpen; document.getElementById('ss-emoji').style.display = isEmojiOpen ? 'flex' : 'none'; updateButtons(); }));
    dock.appendChild(mkBtn('👥', 'ss-b-people', () => { const pp = document.getElementById('ss-participants'); if(pp) pp.style.display = pp.style.display === 'none' ? 'block' : 'none'; }));
    // Keyboard shortcut hint
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.25);white-space:nowrap;';
    hint.textContent = 'Alt+M/C/E/T/P';
    dock.appendChild(hint);
    root.appendChild(dock);

    // Video grid
    const grid = document.createElement('div');
    grid.id = 'ss-grid';
    grid.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:12px;align-items:flex-end;pointer-events:none;';
    root.appendChild(grid);

    // Participants panel (Alt+P or 👥 button)
    const pPanel = document.createElement('div');
    pPanel.id = 'ss-participants';
    pPanel.style.cssText = 'position:fixed;bottom:90px;left:24px;width:180px;background:rgba(10,10,20,0.9);backdrop-filter:blur(12px);border-radius:10px;border:1px solid rgba(255,255,255,0.1);padding:10px;pointer-events:auto;display:none;';
    pPanel.innerHTML = '<div style="font-size:11px;color:#818cf8;">No participants yet</div>';
    root.appendChild(pPanel);

    // Chat
    const chat = document.createElement('div');
    chat.id = 'ss-chat';
    chat.style.cssText = 'position:fixed;bottom:90px;right:24px;width:290px;height:380px;background:rgba(10,10,20,0.95);backdrop-filter:blur(16px);border-radius:12px;border:1px solid rgba(255,255,255,0.1);display:none;flex-direction:column;pointer-events:auto;';
    chat.innerHTML = `
        <div style="padding:10px 12px;background:rgba(255,255,255,0.04);color:#fff;font-weight:600;font-size:13px;display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span>Chat</span>
            <button id="ss-chat-x" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:16px;line-height:1;">✕</button>
        </div>
        <div id="ss-msgs" style="flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;"></div>
        <div style="padding:8px;display:flex;gap:6px;border-top:1px solid rgba(255,255,255,0.06);">
            <input id="ss-chat-in" placeholder="Message…" style="flex:1;background:rgba(255,255,255,0.06);border:none;color:#fff;padding:7px 10px;border-radius:6px;font-size:12px;outline:none;">
            <button id="ss-chat-send" style="background:#6366f1;border:none;color:#fff;padding:7px 12px;border-radius:6px;cursor:pointer;font-size:12px;">Send</button>
        </div>`;
    root.appendChild(chat);

    document.getElementById('ss-chat-x').onclick    = () => { isChatOpen = false; chat.style.display = 'none'; updateButtons(); };
    document.getElementById('ss-chat-in').onkeydown  = e => e.stopPropagation();
    document.getElementById('ss-chat-in').onkeypress = e => { e.stopPropagation(); if (e.key === 'Enter') document.getElementById('ss-chat-send').click(); };
    document.getElementById('ss-chat-send').onclick  = () => {
        const inp = document.getElementById('ss-chat-in');
        if (inp.value.trim()) { chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text: inp.value.trim() }); inp.value = ''; }
    };

    // Emoji bar
    const emojiBar = document.createElement('div');
    emojiBar.id = 'ss-emoji';
    emojiBar.style.cssText = 'position:fixed;bottom:85px;left:50%;transform:translateX(-50%);display:none;gap:8px;background:rgba(10,10,20,0.88);backdrop-filter:blur(12px);padding:8px 14px;border-radius:30px;border:1px solid rgba(255,255,255,0.1);pointer-events:auto;';
    ['😂','❤️','😮','👏','😡'].forEach(em => {
        const b = document.createElement('button');
        b.textContent = em;
        b.style.cssText = 'background:none;border:none;font-size:20px;cursor:pointer;line-height:1;';
        b.onclick = (e) => { e.stopPropagation(); chrome.runtime.sendMessage({ type: 'REACTION', emoji: em }); };
        emojiBar.appendChild(b);
    });
    root.appendChild(emojiBar);

    updateButtons();
}

function updateButtons() {
    const active = '#6366f1';
    const idle   = 'rgba(255,255,255,0.08)';
    const setbg  = (id, cond) => { const el = document.getElementById(id); if (el) el.style.background = cond ? active : idle; };
    setbg('ss-b-chat',  isChatOpen);
    setbg('ss-b-emoji', isEmojiOpen);
    setbg('ss-b-mic',   isMicOn);
    setbg('ss-b-cam',   isCamOn);
}

function addChatMessage(username, text, color) {
    const area = document.getElementById('ss-msgs');
    if (!area) return;
    const d = document.createElement('div');
    d.style.cssText = 'background:rgba(255,255,255,0.04);padding:6px 8px;border-radius:6px;font-size:12px;color:#ddd;';
    d.innerHTML = `<b style="color:${color || '#818cf8'}">${username}</b>: ${text}`;
    area.appendChild(d);
    area.scrollTop = area.scrollHeight;
}

function animateEmoji(emoji) {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText = 'position:fixed;bottom:120px;left:50%;font-size:52px;z-index:99999;pointer-events:none;transition:transform 2s ease-out,opacity 2s ease-out;opacity:1;';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.transform = `translateX(${(Math.random()-0.5)*300}px) translateY(-400px) scale(2)`;
        el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 2100);
}

// ─── MESSAGE ROUTER ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    // SYNC is allowed in all frames
    if (msg.type === 'SYNC_STATE') {
        applyRemoteSync(msg);
        return;
    }

    // EVERYTHING ELSE (WebRTC, UI, Chat) is TOP FRAME ONLY
    if (!IS_TOP_FRAME) return;

    switch (msg.type) {
        case 'CHAT_MESSAGE':
            addChatMessage(msg.username, msg.text, msg.color);
            break;

        case 'REACTION':
            animateEmoji(msg.emoji);
            break;

        case 'ROOM_STATE':
            roomState = msg.data;
            if (roomState.myId) {
                initPeers();
                if (roomState.isHost && videoElement) broadcastState();
            }
            updateParticipantPanel();
            break;

        case 'SIGNALING':
            handleSignaling(msg.fromId, msg.payload);
            break;

        case 'TOAST':
            const t = document.createElement('div');
            t.textContent = msg.message;
            t.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(10,10,20,0.9);color:${msg.color||'#fff'};padding:10px 18px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;`;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 3000);
            break;
    }
});

// ─── MAIN LOOP (1s) ─────────────────────────────────────────────────────────────
setInterval(() => {
    // Only inject UI in top frame (prevents double dock in iframe sites)
    if (IS_TOP_FRAME && !document.getElementById('ss-root')) injectUI();

    // Find video in ANY frame (iframe sites like dizigom need this)
    if (videoElement && !document.body.contains(videoElement)) videoElement = null;
    if (!videoElement) {
        videoElement = findMainVideo();
        if (videoElement) { console.log('[SyncStream] Video found in', location.hostname); attachSyncListeners(); }
    }

    // Keep remote conference videos alive (top frame only)
    if (IS_TOP_FRAME) {
        document.querySelectorAll('video[id^="ss-v-"]').forEach(v => {
            if (v.id !== 'ss-v-local' && v.srcObject && v.paused) {
                v.muted = false; v.volume = 1.0; v.play().catch(() => {});
            }
        });
    }
}, 1000);

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Only trigger if Alt key is held and no input is focused
    if (!e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch(e.key.toLowerCase()) {
        case 'm': // Alt+M → toggle mic
            e.preventDefault();
            isMicOn = !isMicOn;
            updateMedia();
            showShortcutToast(isMicOn ? '🎤 Mic ON' : '🎤 Mic OFF');
            break;
        case 'c': // Alt+C → toggle camera
            e.preventDefault();
            isCamOn = !isCamOn;
            updateMedia();
            showShortcutToast(isCamOn ? '📷 Camera ON' : '📷 Camera OFF');
            break;
        case 'e': // Alt+E → toggle emoji bar
            e.preventDefault();
            isEmojiOpen = !isEmojiOpen;
            const eb = document.getElementById('ss-emoji');
            if (eb) eb.style.display = isEmojiOpen ? 'flex' : 'none';
            updateButtons();
            break;
        case 't': // Alt+T → toggle chat
            e.preventDefault();
            isChatOpen = !isChatOpen;
            const ch = document.getElementById('ss-chat');
            if (ch) ch.style.display = isChatOpen ? 'flex' : 'none';
            updateButtons();
            break;
        case 'p': // Alt+P → toggle participants panel
            e.preventDefault();
            const pp = document.getElementById('ss-participants');
            if (pp) pp.style.display = pp.style.display === 'none' ? 'block' : 'none';
            break;
    }
}, true);

function showShortcutToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(10,10,20,0.88);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;font-family:system-ui;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
}

// ─── PARTICIPANT PANEL ────────────────────────────────────────────────────────
function updateParticipantPanel() {
    const panel = document.getElementById('ss-participants');
    if (!panel || !roomState?.users) return;
    panel.innerHTML = `
        <div style="font-size:11px;font-weight:600;color:#818cf8;margin-bottom:6px;letter-spacing:0.05em;">PARTICIPANTS (${roomState.users.length})</div>
        ${roomState.users.map(u => `
            <div style="display:flex;align-items:center;gap:6px;padding:4px 0;">
                <div style="width:24px;height:24px;border-radius:50%;background:${u.color||'#6366f1'};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#111;">${u.username.substring(0,2).toUpperCase()}</div>
                <span style="font-size:11px;color:#ddd;flex:1;">${u.username}${u.isHost ? ' 👑' : ''}</span>
                <span style="font-size:11px;">${u.isInCall ? '🎤' : ''}</span>
            </div>
        `).join('')}
    `;
}

