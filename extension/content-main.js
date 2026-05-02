/**
 * SyncStream Pro — Fullscreen intercept (MAIN world, document_start, all_frames)
 *
 * Problem: cross-origin iframes can go fullscreen via two paths:
 *   A) player INSIDE the iframe calls element.requestFullscreen()
 *   B) top-frame JS calls iframeElement.requestFullscreen()
 *
 * Both paths cause real browser fullscreen which hides ss-root.
 * Solution: CSS fake-fullscreen (position:fixed on the iframe) — no Fullscreen
 * API needed, no user-activation requirement.
 *
 * Three layers of defense:
 *   1. Top frame: intercept requestFullscreen on <iframe> elements → CSS fake-FS
 *   2. Top frame: receive SS_FS_REQ from iframe → CSS fake-FS
 *   3. Top frame: fullscreenchange fallback — if real iframe-FS slips through, abort + CSS fake-FS
 *   Iframe: intercept requestFullscreen → send SS_FS_REQ → wait for SS_FS_ON
 */
(function () {
    if (window.__ssFS) return;
    window.__ssFS = true;

    var isActive = function () { return document.documentElement.hasAttribute('data-ss-active'); };

    /* ── TOP FRAME ─────────────────────────────────────────────────────── */
    if (window === window.top) {
        var fakeEl  = null;
        var savedSt = null;
        var PROPS   = ['position','top','left','right','bottom','width','height',
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
            PROPS.forEach(function (p) {
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

        /* ── Layer 1: intercept requestFullscreen in top frame for <iframe> elements ── */
        ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(function (k) {
            var orig = HTMLElement.prototype[k];
            if (!orig) return;
            HTMLElement.prototype[k] = function () {
                if (!isActive() || this.tagName !== 'IFRAME') return orig.apply(this, arguments);
                enterFake(this);
                return Promise.resolve();
            };
        });

        /* ── Layer 2: receive SS_FS_REQ from iframe's own intercept ── */
        window.addEventListener('message', function (e) {
            if (!e.data || !isActive()) return;
            if      (e.data.type === 'SS_FS_REQ')  { var fr = findFrame(e.source); if (fr) enterFake(fr); }
            else if (e.data.type === 'SS_FS_EXIT') { exitFake(); }
        });

        /* ── Layer 3: fullscreenchange fallback — abort real iframe-FS ── */
        document.addEventListener('fullscreenchange', function () {
            var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (!fsEl || fsEl.tagName !== 'IFRAME' || !isActive()) return;
            /* Real browser fullscreen with an iframe slipped through.
               Notify iframe FIRST (so faked fullscreenElement is true before
               the exit-fullscreenchange fires inside it), then abort. */
            try { fsEl.contentWindow.postMessage({ type: 'SS_FS_ON' }, '*'); } catch (_) {}
            try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
            enterFake(fsEl);
        });

        /* Escape key exits fake-FS from top frame */
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && fakeEl) exitFake();
        });

        return;
    }

    /* ── IFRAME ─────────────────────────────────────────────────────────── */
    var fsOn           = false;
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

    /* Escape inside iframe */
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

    /* 2. Fake exitFullscreen */
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

    /* 3. Intercept requestFullscreen */
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

    /* 4. webkitEnterFullscreen on video elements */
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (fsOn) { fakeExit(); return; }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
        };
    }
})();
