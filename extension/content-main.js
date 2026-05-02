/**
 * SyncStream Pro — Fullscreen intercept (MAIN world, document_start, all_frames)
 *
 * Top frame : no intercept — normal fullscreen, content.js moves ss-root.
 * Iframe    : redirect requestFullscreen to top-frame body fullscreen so
 *             ss-root (child of body) stays visible. The returned promise
 *             resolves only after body fullscreen is confirmed, so the
 *             player's toggle logic stays correct.
 */
(function () {
    if (window.__ssFS) return;
    window.__ssFS = true;

    var isActive = function () { return document.documentElement.hasAttribute('data-ss-active'); };

    /* ── TOP FRAME: no patching, just messaging ─────────────────────────── */
    if (window === window.top) {
        /* Receive enter request from iframe */
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_REQ' || !isActive()) return;

            /* Mark the source iframe so CSS expands it */
            try {
                var found = false;
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    if (iframes[i].contentWindow === e.source) {
                        iframes[i].setAttribute('data-ss-fs', '1');
                        found = true; break;
                    }
                }
                if (!found && iframes.length) {
                    var big = iframes[0];
                    for (var j = 1; j < iframes.length; j++)
                        if (iframes[j].offsetWidth * iframes[j].offsetHeight > big.offsetWidth * big.offsetHeight) big = iframes[j];
                    big.setAttribute('data-ss-fs', '1');
                }
            } catch (_) {}

            /* Request body fullscreen using the original unpatched method */
            var orig = HTMLElement.prototype.requestFullscreen       ||
                       HTMLElement.prototype.webkitRequestFullscreen ||
                       HTMLElement.prototype.mozRequestFullScreen;
            if (orig) orig.call(document.body).catch(function () {});
        });

        /* Receive exit request from iframe */
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_EXIT' || !isActive()) return;
            try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
        });

        /* Notify iframes of fullscreen state */
        document.addEventListener('fullscreenchange', function () {
            var entering = document.fullscreenElement === document.body;
            document.querySelectorAll('iframe[data-ss-fs]').forEach(function (fr) {
                try { fr.contentWindow.postMessage({ type: entering ? 'SS_FS_ON' : 'SS_FS_OFF' }, '*'); } catch (_) {}
            });
            if (!entering)
                document.querySelectorAll('iframe[data-ss-fs]').forEach(function (fr) { fr.removeAttribute('data-ss-fs'); });
        });
        return;
    }

    /* ── IFRAME ─────────────────────────────────────────────────────────── */
    var fsOn = false;
    var pendingResolve = null; /* resolves the requestFullscreen promise */

    /* Receive state from top frame */
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

    /* 3. Intercept requestFullscreen — promise resolves AFTER body enters FS */
    var origRFS = HTMLElement.prototype.requestFullscreen       ||
                  HTMLElement.prototype.webkitRequestFullscreen ||
                  HTMLElement.prototype.mozRequestFullScreen;

    function patchMethod(k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            if (!isActive()) return orig.apply(this, arguments);

            /* Already in fake-fullscreen → treat as exit */
            if (fsOn) { fakeExit(); return Promise.resolve(); }

            /* Request top frame to go body-fullscreen */
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}

            /* Return a promise that resolves when SS_FS_ON arrives */
            return new Promise(function (resolve) {
                pendingResolve = resolve;
                /* Safety timeout: if body FS fails for any reason, resolve so
                   player doesn't hang, and fall back to original behavior */
                setTimeout(function () {
                    if (pendingResolve === resolve) {
                        pendingResolve = null;
                        /* Body FS failed — try original so player works normally */
                        if (!fsOn) orig.apply(this, arguments);
                        resolve();
                    }
                }.bind(this), 800);
            });
        };
    }
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(patchMethod);

    /* Also patch webkitEnterFullscreen on video elements */
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (fsOn) { fakeExit(); return; }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
            pendingResolve = function () {};
            setTimeout(function () { if (!fsOn) origWEFS.apply(this, arguments); }.bind(this), 800);
        };
    }
})();
