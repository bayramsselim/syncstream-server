/**
 * SyncStream Pro — Fullscreen intercept (MAIN world, document_start, all_frames)
 *
 * Cross-origin iframes cannot transfer user-activation via postMessage, so
 * document.body.requestFullscreen() would be rejected by the browser.
 *
 * Solution: CSS fake-fullscreen — position the iframe fixed over the viewport
 * without touching the Fullscreen API. No user-activation needed.
 *
 * Top frame : receives SS_FS_REQ → expands iframe via inline CSS, sends SS_FS_ON.
 * Iframe    : intercepts requestFullscreen → signals top frame, resolves when confirmed.
 */
(function () {
    if (window.__ssFS) return;
    window.__ssFS = true;

    var isActive = function () { return document.documentElement.hasAttribute('data-ss-active'); };

    /* ── TOP FRAME ─────────────────────────────────────────────────────── */
    if (window === window.top) {
        var fakeEl    = null;
        var savedSt   = null;
        var CSS_PROPS = ['position','top','left','right','bottom','width','height',
                         'z-index','border','border-radius','transform','transition',
                         'max-width','max-height'];

        function findFrame(source) {
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

        function enterFake(fr) {
            if (fakeEl) exitFake();
            fakeEl   = fr;
            savedSt  = {};
            CSS_PROPS.forEach(function (p) {
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
            fr.style.setProperty('z-index',       '2147483646', 'important');
            fr.style.setProperty('border',        'none',       'important');
            fr.style.setProperty('border-radius', '0',          'important');
            fr.style.setProperty('transform',     'none',       'important');
            fr.style.setProperty('transition',    'none',       'important');
            fr.setAttribute('data-ss-fs', '1');
            try { fr.contentWindow.postMessage({ type: 'SS_FS_ON' }, '*'); } catch (_) {}
        }

        function exitFake() {
            if (!fakeEl) return;
            var fr = fakeEl; fakeEl = null;
            CSS_PROPS.forEach(function (p) {
                if (savedSt[p] && savedSt[p].v) {
                    fr.style.setProperty(p, savedSt[p].v, savedSt[p].pri);
                } else {
                    fr.style.removeProperty(p);
                }
            });
            savedSt = null;
            fr.removeAttribute('data-ss-fs');
            try { fr.contentWindow.postMessage({ type: 'SS_FS_OFF' }, '*'); } catch (_) {}
        }

        window.addEventListener('message', function (e) {
            if (!e.data || !isActive()) return;
            if      (e.data.type === 'SS_FS_REQ')  { var fr = findFrame(e.source); if (fr) enterFake(fr); }
            else if (e.data.type === 'SS_FS_EXIT') { exitFake(); }
        });

        /* Escape from top frame (e.g. when iframe doesn't have focus) */
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && fakeEl) exitFake();
        });

        return;
    }

    /* ── IFRAME ─────────────────────────────────────────────────────────── */
    var fsOn          = false;
    var pendingResolve = null;

    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === 'SS_FS_ON' && !fsOn) {
            fsOn = true;
            if (pendingResolve) { pendingResolve(); pendingResolve = null; }
            try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
            try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
        } else if (e.data.type === 'SS_FS_OFF' && fsOn) {
            fsOn = false;
            try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
            try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
        }
    });

    /* Escape key inside the iframe */
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && fsOn) fakeExit();
    });

    /* 1. Fake document.fullscreenElement */
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

    /* 2. Fake exitFullscreen — proxy to top frame */
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

    /* 3. Intercept requestFullscreen — promise resolves once top frame confirms */
    function patchMethod(k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            if (!isActive()) return orig.apply(this, arguments);
            if (fsOn) { fakeExit(); return Promise.resolve(); }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
            return new Promise(function (resolve) {
                pendingResolve = resolve;
                /* Safety: resolve after 1 s so player never hangs */
                setTimeout(function () {
                    if (pendingResolve === resolve) { pendingResolve = null; resolve(); }
                }, 1000);
            });
        };
    }
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(patchMethod);

    /* 4. webkitEnterFullscreen on video elements (Safari / some players) */
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (fsOn) { fakeExit(); return; }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
        };
    }
})();
