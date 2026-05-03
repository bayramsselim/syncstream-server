/**
 * SyncStream Pro — Fullscreen intercept (MAIN world, document_start, all_frames)
 *
 * Real browser fullscreen of a cross-origin iframe (or an element containing one)
 * hides ALL top-frame content including ss-root. Solution: CSS fake-fullscreen.
 *
 * Five layers of defense (top frame):
 *   L1. Intercept HTMLElement.requestFullscreen — if target is, OR contains, an
 *       <iframe>, do CSS fake-FS on that iframe. Otherwise pass through to real
 *       fullscreen (so YouTube and other in-page players still work).
 *   L2. Receive SS_FS_REQ message from iframe's own intercept.
 *   L3. fullscreenchange fallback — if real iframe-FS slips through, abort.
 *   L4. When entering fake-FS, force ss-root to be the last child of <body> and
 *       set max z-index, so it always paints above the expanded iframe.
 *   L5. Forward SS_FS_ON/OFF down the iframe tree (handles nested iframes).
 */
(function () {
    if (window.__ssFS) return;
    window.__ssFS = true;
    window.__ssFSVersion = 'BANNER-HIDE-2026-05-04';
    console.log('[SS-FS] content-main.js loaded — version:', window.__ssFSVersion, 'frame:', window === window.top ? 'TOP' : 'IFRAME', location.origin);

    /* Track active state independently of content.js (which runs at document_idle
       and might miss the moment of intercept). Top frame broadcasts SS_ACTIVE to
       all iframes whenever ss-root exists; iframes also fall back to data-ss-active. */
    var msgActive = false;
    var isActive = function () {
        return msgActive || document.documentElement.hasAttribute('data-ss-active');
    };

    /* ── TOP FRAME ─────────────────────────────────────────────────────── */
    if (window === window.top) {
        var fakeEl     = null;
        var savedAnc   = null;
        var savedBody  = null;  /* hidden body-level siblings during fake-fs */

        /* Capture original requestFullscreen on HTMLElement BEFORE we patch it,
           so we can call it bypassing our own intercept (used to enter real
           browser fullscreen on documentElement when iframe delegates capability). */
        var ORIG_RFS = HTMLElement.prototype.requestFullscreen ||
                       HTMLElement.prototype.webkitRequestFullscreen;

        /* Stylesheet-based fake-fs. Inline styles are vulnerable to site JS
           overwriting (`iframe.style.position = 'absolute'` strips !important).
           A stylesheet rule with !important wins over normal inline styles, so
           we just toggle data-ss-fs on the iframe and let the cascade do its
           job. Inserted at <html> level so it's always available, even before
           <body> exists. */
        var styleEl = document.createElement('style');
        styleEl.id = 'ss-fake-fs-style';
        styleEl.textContent =
            'iframe[data-ss-fs="1"] {' +
                'position: fixed !important;' +
                'top: 0 !important;' +
                'left: 0 !important;' +
                'right: 0 !important;' +
                'bottom: 0 !important;' +
                'width: 100vw !important;' +
                'height: 100vh !important;' +
                'max-width: none !important;' +
                'max-height: none !important;' +
                'min-width: 0 !important;' +
                'min-height: 0 !important;' +
                'margin: 0 !important;' +
                'padding: 0 !important;' +
                'z-index: 2147483646 !important;' +
                'border: none !important;' +
                'border-radius: 0 !important;' +
                'transform: none !important;' +
                'transition: none !important;' +
                'clip: auto !important;' +
                'clip-path: none !important;' +
                'display: block !important;' +
                'visibility: visible !important;' +
                'opacity: 1 !important;' +
                'pointer-events: auto !important;' +
            '}';
        function injectStyle() {
            if (document.getElementById('ss-fake-fs-style')) return;
            (document.head || document.documentElement).appendChild(styleEl);
        }
        injectStyle();
        /* If <head> wasn't ready, retry once DOM is parseable */
        if (!document.getElementById('ss-fake-fs-style')) {
            new MutationObserver(function (_, obs) {
                if (document.head) { injectStyle(); obs.disconnect(); }
            }).observe(document.documentElement, { childList: true, subtree: true });
        }

        function findFrameByWindow(source) {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentWindow === source) return iframes[i]; } catch (_) {}
            }
            if (!iframes.length) return null;
            var big = iframes[0];
            for (var j = 1; j < iframes.length; j++) {
                if (iframes[j].offsetWidth * iframes[j].offsetHeight >
                    big.offsetWidth  * big.offsetHeight) big = iframes[j];
            }
            return big;
        }

        function bumpSsRoot() {
            var r = document.getElementById('ss-root');
            if (!r) return;
            if (r.parentElement !== document.body) document.body.appendChild(r);
            else if (r !== document.body.lastElementChild) document.body.appendChild(r);
            r.style.setProperty('z-index', '2147483647', 'important');
            r.style.setProperty('position', 'fixed', 'important');
            r.style.setProperty('inset',    '0',     'important');
        }
        /* Continuous bump — even when no fake-fs is active, so if a site uses
           CSS-only fake-fullscreen (own position:fixed overlay) ss-root still
           paints on top. Cheap (single getElementById + appendChild check). */
        setInterval(bumpSsRoot, 500);

        /* Properties on ancestor elements that create a containing block for
           position:fixed children. Without resetting these, our 100vw/100vh
           iframe would be sized relative to the transformed ancestor instead
           of the viewport — so "fullscreen" came out tiny. */
        var ANC_PROPS = ['transform','filter','backdrop-filter','perspective',
                         'will-change','contain'];

        function enterFake(fr) {
            if (fakeEl === fr) return;
            if (fakeEl) exitFake();
            fakeEl = fr;

            /* Try real browser fullscreen on <html> first — uses delegated
               activation if iframe sent SS_FS_REQ with `delegate: 'fullscreen'`.
               If it succeeds, browser chrome (address bar, tabs) hides too.
               If it fails (no activation, unsupported browser, etc.) the CSS
               fake-fs below still gives a viewport-sized video. */
            if (ORIG_RFS) {
                try {
                    ORIG_RFS.call(document.documentElement)
                        .then(function(){ console.log('[SS-FS] real FS ✓'); })
                        .catch(function(e){ console.log('[SS-FS] real FS ✗', e && e.message); });
                } catch (_) {}
            }

            /* Apply visual state via attribute → stylesheet rules with
               !important. Site JS can't easily strip this since data-ss-fs
               attribute survives style.cssText / style.position assignments. */
            fr.setAttribute('data-ss-fs', '1');

            /* Neutralise ancestor transforms/filters so the iframe's
               position:fixed is relative to the viewport, not some parent. */
            savedAnc = [];
            var node = fr.parentElement;
            while (node && node !== document.documentElement) {
                var rec = { el: node, props: {} };
                ANC_PROPS.forEach(function (p) {
                    rec.props[p] = { v: node.style.getPropertyValue(p), pri: node.style.getPropertyPriority(p) };
                });
                node.style.setProperty('transform',       'none', 'important');
                node.style.setProperty('filter',          'none', 'important');
                node.style.setProperty('backdrop-filter', 'none', 'important');
                node.style.setProperty('perspective',     'none', 'important');
                node.style.setProperty('will-change',     'auto', 'important');
                node.style.setProperty('contain',         'none', 'important');
                savedAnc.push(rec);
                node = node.parentElement;
            }

            /* Hide site-level overlays (nav bars, banners) at the body level so
               they can't paint above the iframe. We only touch direct body
               children that are NOT in the iframe's path and NOT ss-root. The
               iframe's wrapper chain stays visible; ss-root stays visible. */
            savedBody = [];
            if (document.body) {
                var topAncestor = fr;
                while (topAncestor.parentElement && topAncestor.parentElement !== document.body) {
                    topAncestor = topAncestor.parentElement;
                }
                if (topAncestor.parentElement === document.body) {
                    Array.prototype.forEach.call(document.body.children, function (child) {
                        if (child === topAncestor) return;
                        if (child.id === 'ss-root') return;
                        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
                        savedBody.push({
                            el: child,
                            v:  child.style.getPropertyValue('display'),
                            pri: child.style.getPropertyPriority('display')
                        });
                        child.style.setProperty('display', 'none', 'important');
                    });
                }
            }

            bumpSsRoot();
            try { fr.contentWindow.postMessage({ type: 'SS_FS_ON' }, '*'); } catch (_) {}
        }

        function exitFake() {
            if (!fakeEl) return;
            var fr = fakeEl; fakeEl = null;
            fr.removeAttribute('data-ss-fs');
            if (savedAnc) {
                savedAnc.forEach(function (rec) {
                    ANC_PROPS.forEach(function (p) {
                        var s = rec.props[p];
                        if (s && s.v) rec.el.style.setProperty(p, s.v, s.pri);
                        else          rec.el.style.removeProperty(p);
                    });
                });
                savedAnc = null;
            }
            /* Restore body-level siblings */
            if (savedBody) {
                savedBody.forEach(function (r) {
                    if (r.v) r.el.style.setProperty('display', r.v, r.pri);
                    else     r.el.style.removeProperty('display');
                });
                savedBody = null;
            }
            /* Exit real browser fullscreen too (if we entered it) */
            if (document.fullscreenElement === document.documentElement) {
                try { document.exitFullscreen().catch(function(){}); } catch (_) {}
            }
            try { fr.contentWindow.postMessage({ type: 'SS_FS_OFF' }, '*'); } catch (_) {}
        }

        /* Find an iframe inside `el` that covers ≥70% of el's area. Used to
           detect "player wrapper" divs (e.g. webteizle's #embed, semantic UI
           .ui.embed) without false-positives on YouTube-style players that
           may contain small ad iframes. */
        function dominantIframe(el) {
            var iframes = el.querySelectorAll('iframe');
            if (!iframes.length) return null;
            var rEl = el.getBoundingClientRect();
            var aEl = Math.max(1, rEl.width * rEl.height);
            for (var i = 0; i < iframes.length; i++) {
                var ri = iframes[i].getBoundingClientRect();
                if ((ri.width * ri.height) / aEl >= 0.7) return iframes[i];
            }
            return null;
        }

        /* ── L1: intercept requestFullscreen for <iframe> elements AND
           player-wrapper divs that contain a dominant iframe.
           Pure CSS fake-fs path — never touches the Fullscreen API, so no
           race condition with the player's fullscreenchange handler. */
        ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(function (k) {
            var orig = HTMLElement.prototype[k];
            if (!orig) return;
            HTMLElement.prototype[k] = function () {
                if (!isActive()) return orig.apply(this, arguments);
                if (this.tagName === 'IFRAME') { enterFake(this); return Promise.resolve(); }
                var inner = dominantIframe(this);
                if (inner) { enterFake(inner); return Promise.resolve(); }
                /* No dominant iframe → real fullscreen (YouTube/Vimeo in-page) */
                return orig.apply(this, arguments);
            };
        });

        /* ── L2: receive SS_FS_REQ from iframe's intercept ── */
        window.addEventListener('message', function (e) {
            if (!e.data || !isActive()) return;
            if (e.data.type === 'SS_FS_REQ') {
                var fr = findFrameByWindow(e.source);
                if (fr) enterFake(fr);
            }
            else if (e.data.type === 'SS_FS_EXIT') { exitFake(); }
        });

        /* ── L3: fullscreenchange fallback — last resort if real iframe-FS
           somehow slips past L1 and L2 (e.g. native video controls path). */
        document.addEventListener('fullscreenchange', function () {
            var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (!fsEl || !isActive()) return;
            var inner = fsEl.tagName === 'IFRAME' ? fsEl : dominantIframe(fsEl);
            if (!inner) return;
            try { inner.contentWindow.postMessage({ type: 'SS_FS_ON' }, '*'); } catch (_) {}
            try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
            enterFake(inner);
        });

        /* Escape exits fake-FS from top frame */
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && fakeEl) exitFake();
        });

        /* Broadcast SS_ACTIVE state to all iframes, so their intercepts can fire
           even if content.js (isolated world, document_idle) hasn't run yet or
           failed to set data-ss-active. Repeats so late-loaded iframes catch up. */
        function broadcastActive() {
            var on = isActive();
            var msg = { type: on ? 'SS_ACTIVE' : 'SS_INACTIVE' };
            document.querySelectorAll('iframe').forEach(function (fr) {
                try { fr.contentWindow.postMessage(msg, '*'); } catch (_) {}
            });
        }
        /* Force fullscreen permission on every iframe: ensures Chrome's
           Capability Delegation can succeed across cross-origin iframes (some
           sites only set the legacy `allowfullscreen` boolean attribute, which
           grants fullscreen but not necessarily the delegation capability).
           Three layers:
             a) document.createElement intercept — catches iframes created via JS
                BEFORE they're attached and navigate, so allow is on element when
                browser sets up permission policy.
             b) MutationObserver — catches iframes from innerHTML / templates.
             c) Initial sweep + interval — catches anything we missed. */
        function ensureFullscreenAllowed(fr) {
            if (!fr || fr.tagName !== 'IFRAME') return;
            var allow = fr.getAttribute('allow') || '';
            if (allow.indexOf('fullscreen') === -1) {
                fr.setAttribute('allow', (allow ? allow + '; ' : '') + 'fullscreen *');
            }
            if (!fr.hasAttribute('allowfullscreen')) fr.setAttribute('allowfullscreen', '');
        }

        /* a) createElement intercept */
        var origCreateElement = Document.prototype.createElement;
        Document.prototype.createElement = function (tag) {
            var el = origCreateElement.apply(this, arguments);
            try {
                if (typeof tag === 'string' && tag.toLowerCase() === 'iframe') {
                    el.setAttribute('allow', 'fullscreen *');
                    el.setAttribute('allowfullscreen', '');
                }
            } catch (_) {}
            return el;
        };

        /* c) initial + observer */
        function sweepIframes() {
            document.querySelectorAll('iframe').forEach(ensureFullscreenAllowed);
        }
        sweepIframes();
        new MutationObserver(function (muts) {
            muts.forEach(function (m) {
                m.addedNodes && m.addedNodes.forEach(function (n) {
                    if (n.tagName === 'IFRAME') ensureFullscreenAllowed(n);
                    if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(ensureFullscreenAllowed);
                });
            });
        }).observe(document.documentElement, { childList: true, subtree: true });

        /* Reply to iframes asking on init (avoids 1.5s broadcast race). */
        window.addEventListener('message', function (e) {
            if (!e.data) return;
            if (e.data.type === 'SS_ASK') {
                try { e.source.postMessage({ type: isActive() ? 'SS_ACTIVE' : 'SS_INACTIVE' }, '*'); } catch (_) {}
            } else if (e.data.type === 'SS_ACTIVITY') {
                /* Iframe (in real fullscreen) is forwarding mousemove because the
                   cross-origin event boundary blocks them from reaching us
                   directly. Dispatch synthetic mousemove so dock auto-hide
                   resets its idle timer and shows the dock. */
                try { document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); } catch (_) {}
            }
        });
        setInterval(broadcastActive, 1500);
        new MutationObserver(broadcastActive).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-ss-active']
        });
        /* Also catch new iframes appearing in the DOM */
        new MutationObserver(broadcastActive).observe(document.body || document.documentElement, {
            childList: true, subtree: true
        });

        return;
    }

    /* ── IFRAME ─────────────────────────────────────────────────────────── */
    var fsOn              = false;
    var pendingResolve    = null;
    var fsRequestedElement = null;  /* what the player called requestFullscreen on,
                                       so document.fullscreenElement returns the
                                       same element the player expects (not
                                       documentElement, which makes the player
                                       think fullscreen failed and immediately
                                       call exitFullscreen). */

    function broadcastDown(msg) {
        document.querySelectorAll('iframe').forEach(function (fr) {
            try { fr.contentWindow.postMessage(msg, '*'); } catch (_) {}
        });
    }

    /* Ask the parent (and ultimately top frame) for the current SS_ACTIVE state.
       Closes the broadcast race for late-loaded iframes — by the time we ask,
       the top frame's listener is already in place. */
    try { window.parent.postMessage({ type: 'SS_ASK' }, '*'); } catch (_) {}
    /* Forward SS_ASK from descendant iframes up the chain */
    window.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'SS_ASK') {
            try { window.parent.postMessage({ type: 'SS_ASK' }, '*'); } catch (_) {}
        }
    });

    /* Forward mouse activity to top frame while in fake-fs.
       In real browser fullscreen of a cross-origin iframe (e.g. izlesene's
       player), mousemove events don't cross the frame boundary, so the top
       frame's dock auto-hide logic never sees activity and keeps the dock
       hidden. Throttled to ~200ms so we don't flood postMessage. */
    var lastActivity = 0;
    function fwdActivity() {
        if (!fsOn) return;
        var now = Date.now();
        if (now - lastActivity < 200) return;
        lastActivity = now;
        try { window.top.postMessage({ type: 'SS_ACTIVITY' }, '*'); } catch (_) {}
    }
    document.addEventListener('mousemove', fwdActivity, { passive: true, capture: true });
    document.addEventListener('mousedown', fwdActivity, { passive: true, capture: true });
    document.addEventListener('keydown',   fwdActivity, { passive: true, capture: true });

    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === 'SS_ACTIVE') {
            msgActive = true;
            broadcastDown(e.data);  /* propagate to nested iframes */
            return;
        }
        if (e.data.type === 'SS_INACTIVE') {
            msgActive = false;
            broadcastDown(e.data);
            return;
        }
        if (e.data.type === 'SS_FS_ON') {
            broadcastDown(e.data);  /* L5: forward to nested iframes */
            if (!fsOn) {
                fsOn = true;
                if (pendingResolve) { pendingResolve(); pendingResolve = null; }
                try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
                try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
            }
        } else if (e.data.type === 'SS_FS_OFF') {
            broadcastDown(e.data);
            if (fsOn) {
                fsOn = false;
                fsRequestedElement = null;
                try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
                try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
            }
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && fsOn) fakeExit();
    });

    /* Fake document.fullscreenElement — return the element the player itself
       requested. Returning documentElement instead made players check
       `document.fullscreenElement === requestedEl`, see false, conclude
       fullscreen failed, and call exitFullscreen on us. */
    ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement'].forEach(function (prop) {
        var d = Object.getOwnPropertyDescriptor(Document.prototype, prop) ||
                Object.getOwnPropertyDescriptor(document, prop);
        if (!d) return;
        var origGet = d.get || function () { return null; };
        try {
            Object.defineProperty(document, prop, {
                get: function () {
                    if (!fsOn) return origGet.call(this);
                    return fsRequestedElement || document.documentElement;
                },
                configurable: true
            });
        } catch (_) {}
    });

    /* Fake document.fullscreenEnabled — some players gate on it */
    try {
        Object.defineProperty(document, 'fullscreenEnabled', { get: function () { return true; }, configurable: true });
    } catch (_) {}
    try {
        Object.defineProperty(document, 'webkitFullscreenEnabled', { get: function () { return true; }, configurable: true });
    } catch (_) {}

    /* Fake exitFullscreen — proxy to top frame */
    var origExit = Document.prototype.exitFullscreen || Document.prototype.webkitExitFullscreen;
    var fakeExit = function () {
        if (fsOn) {
            try { window.top.postMessage({ type: 'SS_FS_EXIT' }, '*'); } catch (_) {}
            return Promise.resolve();
        }
        return origExit ? origExit.call(document) : Promise.resolve();
    };
    try { Object.defineProperty(document, 'exitFullscreen',       { value: fakeExit, writable: true, configurable: true }); } catch (_) {}
    try { Object.defineProperty(document, 'webkitExitFullscreen', { value: fakeExit, writable: true, configurable: true }); } catch (_) {}
    try { Object.defineProperty(document, 'mozCancelFullScreen',  { value: fakeExit, writable: true, configurable: true }); } catch (_) {}

    /* Intercept requestFullscreen.
       NOTE: when fsOn is already true, we MUST NOT treat the second call as
       a toggle-off. Many players (hdfilmcehennemi's player, video.js with
       certain plugins, etc.) call requestFullscreen a second time defensively
       AFTER fullscreenchange to confirm/re-apply state. Treating that as an
       exit caused the "enter then immediately exit" symptom. Just resolve. */
    function patchMethod(k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            if (!isActive()) return orig.apply(this, arguments);
            if (fsOn) return Promise.resolve();          /* already in fake-fs — no-op */
            fsRequestedElement = this;                   /* remember what player asked for */
            /* Delegate fullscreen capability so top frame can call real requestFullscreen
   (Chrome Capability Delegation, since 109). Falls back to plain postMessage
   if browser doesn't support delegation. */
try { window.top.postMessage({ type: 'SS_FS_REQ' }, { targetOrigin: '*', delegate: 'fullscreen' }); }
catch (_) { try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (__) {} }
            return new Promise(function (resolve) {
                pendingResolve = resolve;
                setTimeout(function () {
                    if (pendingResolve === resolve) { pendingResolve = null; resolve(); }
                }, 1000);
            });
        };
    }
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(patchMethod);

    /* webkitEnterFullscreen on video elements (Safari path) */
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (fsOn) return;
            fsRequestedElement = this;
            /* Delegate fullscreen capability so top frame can call real requestFullscreen
   (Chrome Capability Delegation, since 109). Falls back to plain postMessage
   if browser doesn't support delegation. */
try { window.top.postMessage({ type: 'SS_FS_REQ' }, { targetOrigin: '*', delegate: 'fullscreen' }); }
catch (_) { try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (__) {} }
        };
    }
})();
