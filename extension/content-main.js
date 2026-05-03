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
    window.__ssFSVersion = 'STYLESHEET-2026-05-04';
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
        var fakeEl   = null;
        var savedAnc = null;

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
                console.log('[SS-FS] L1 top-frame intercept:', this.tagName, 'id=', this.id, 'class=', this.className, 'isActive=', isActive());
                if (!isActive()) return orig.apply(this, arguments);
                if (this.tagName === 'IFRAME') {
                    console.log('[SS-FS] L1: target IS iframe → fake-fs');
                    enterFake(this);
                    return Promise.resolve();
                }
                var inner = dominantIframe(this);
                if (inner) {
                    console.log('[SS-FS] L1: dominant iframe found → fake-fs');
                    enterFake(inner);
                    return Promise.resolve();
                }
                console.log('[SS-FS] L1: no dominant iframe → REAL fullscreen (YouTube path)');
                return orig.apply(this, arguments);
            };
        });

        /* ── L2: receive SS_FS_REQ from iframe's intercept ── */
        window.addEventListener('message', function (e) {
            if (!e.data || !isActive()) return;
            if (e.data.type === 'SS_FS_REQ') {
                console.log('[SS-FS] L2 received SS_FS_REQ from iframe');
                var fr = findFrameByWindow(e.source);
                console.log('[SS-FS] L2: found iframe?', !!fr, fr);
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
        /* Reply to iframes asking on init (avoids 1.5s broadcast race). */
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_ASK') return;
            try { e.source.postMessage({ type: isActive() ? 'SS_ACTIVE' : 'SS_INACTIVE' }, '*'); } catch (_) {}
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
    var fsOn           = false;
    var pendingResolve = null;

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
                try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
                try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
            }
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && fsOn) fakeExit();
    });

    /* Fake document.fullscreenElement */
    ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement'].forEach(function (prop) {
        var d = Object.getOwnPropertyDescriptor(Document.prototype, prop) ||
                Object.getOwnPropertyDescriptor(document, prop);
        if (!d) return;
        var origGet = d.get || function () { return null; };
        try {
            Object.defineProperty(document, prop, {
                get: function () { return fsOn ? document.documentElement : origGet.call(this); },
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

    /* Intercept requestFullscreen */
    function patchMethod(k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            console.log('[SS-FS] iframe intercept:', this.tagName, 'isActive=', isActive(), 'msgActive=', msgActive, 'origin=', location.origin);
            if (!isActive()) return orig.apply(this, arguments);
            if (fsOn) { fakeExit(); return Promise.resolve(); }
            console.log('[SS-FS] iframe → posting SS_FS_REQ to top');
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
            return new Promise(function (resolve) {
                pendingResolve = resolve;
                setTimeout(function () {
                    if (pendingResolve === resolve) {
                        pendingResolve = null;
                        console.log('[SS-FS] iframe: SS_FS_ON timeout — top frame did not respond');
                        resolve();
                    }
                }, 1000);
            });
        };
    }
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(patchMethod);

    /* webkitEnterFullscreen on video elements */
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (fsOn) { fakeExit(); return; }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
        };
    }
})();
