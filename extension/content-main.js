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
        var savedSt  = null;
        var savedAnc = null;
        var PROPS    = ['position','top','left','right','bottom','width','height',
                       'z-index','border','border-radius','transform','transition',
                       'max-width','max-height','margin','clip','clip-path'];

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

        /* Properties on ancestor elements that create a containing block for
           position:fixed children (so 100vw/100vh would size to the ancestor,
           not the viewport). We must neutralise all of these on every ancestor
           when fake-fs'ing the iframe, otherwise fullscreen will be tiny. */
        var ANC_PROPS = ['transform','filter','backdrop-filter','perspective',
                         'will-change','contain','transform-style','overflow'];

        function enterFake(fr) {
            if (fakeEl === fr) return;
            if (fakeEl) exitFake();
            fakeEl  = fr;
            savedSt = {};
            PROPS.forEach(function (p) {
                savedSt[p] = { v: fr.style.getPropertyValue(p), pri: fr.style.getPropertyPriority(p) };
            });
            fr.style.setProperty('position',      'fixed',      'important');
            fr.style.setProperty('top',           '0',          'important');
            fr.style.setProperty('left',          '0',          'important');
            fr.style.setProperty('right',         '0',          'important');
            fr.style.setProperty('bottom',        '0',          'important');
            fr.style.setProperty('width',         '100vw',      'important');
            fr.style.setProperty('height',        '100vh',      'important');
            fr.style.setProperty('max-width',     'none',       'important');
            fr.style.setProperty('max-height',    'none',       'important');
            fr.style.setProperty('margin',        '0',          'important');
            fr.style.setProperty('z-index',       '2147483646', 'important');
            fr.style.setProperty('border',        'none',       'important');
            fr.style.setProperty('border-radius', '0',          'important');
            fr.style.setProperty('transform',     'none',       'important');
            fr.style.setProperty('transition',    'none',       'important');
            fr.style.setProperty('clip',          'auto',       'important');
            fr.style.setProperty('clip-path',     'none',       'important');
            fr.setAttribute('data-ss-fs', '1');

            /* Walk up ancestors, neutralise containing-block-creating props.
               Without this, a parent with `transform: translateZ(0)` or similar
               makes our position:fixed iframe sized relative to that parent — so
               "fullscreen" comes out as a tiny box. */
            savedAnc = [];
            var node = fr.parentElement;
            while (node && node !== document.documentElement) {
                var rec = { el: node, props: {} };
                ANC_PROPS.forEach(function (p) {
                    rec.props[p] = { v: node.style.getPropertyValue(p), pri: node.style.getPropertyPriority(p) };
                });
                node.style.setProperty('transform',        'none',    'important');
                node.style.setProperty('filter',           'none',    'important');
                node.style.setProperty('backdrop-filter',  'none',    'important');
                node.style.setProperty('perspective',      'none',    'important');
                node.style.setProperty('will-change',      'auto',    'important');
                node.style.setProperty('contain',          'none',    'important');
                node.style.setProperty('transform-style',  'flat',    'important');
                node.style.setProperty('overflow',         'visible', 'important');
                savedAnc.push(rec);
                node = node.parentElement;
            }

            bumpSsRoot();
            try { fr.contentWindow.postMessage({ type: 'SS_FS_ON' }, '*'); } catch (_) {}
        }

        function exitFake() {
            if (!fakeEl) return;
            var fr = fakeEl; fakeEl = null;
            PROPS.forEach(function (p) {
                if (savedSt[p] && savedSt[p].v) {
                    fr.style.setProperty(p, savedSt[p].v, savedSt[p].pri);
                } else {
                    fr.style.removeProperty(p);
                }
            });
            /* Restore ancestor styles */
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
            savedSt = null;
            fr.removeAttribute('data-ss-fs');
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
                if (this.tagName === 'IFRAME') {
                    enterFake(this);
                    return Promise.resolve();
                }
                var inner = dominantIframe(this);
                if (inner) {
                    enterFake(inner);
                    return Promise.resolve();
                }
                /* No iframe → let real fullscreen happen (YouTube path) */
                return orig.apply(this, arguments);
            };
        });

        /* ── L2: receive SS_FS_REQ from iframe's intercept ── */
        window.addEventListener('message', function (e) {
            if (!e.data || !isActive()) return;
            if      (e.data.type === 'SS_FS_REQ')  { var fr = findFrameByWindow(e.source); if (fr) enterFake(fr); }
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
            if (!isActive()) return orig.apply(this, arguments);
            if (fsOn) { fakeExit(); return Promise.resolve(); }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
            return new Promise(function (resolve) {
                pendingResolve = resolve;
                setTimeout(function () {
                    if (pendingResolve === resolve) { pendingResolve = null; resolve(); }
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
