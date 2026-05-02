/**
 * SyncStream Pro — Fullscreen intercept (MAIN world, document_start, all_frames)
 *
 * Top frame : normal fullscreen — content.js fullscreenchange moves ss-root.
 * Iframe    : requestFullscreen → ask top frame to make BODY fullscreen so
 *             ss-root (child of body) stays visible. CSS expands the iframe.
 *             Also fake document.fullscreenElement and document.exitFullscreen
 *             so the player's toggle logic (e.g. dblclick) keeps working.
 */
(function () {
    if (window.__ssFS) return;
    window.__ssFS = true;

    var active   = function () { return document.documentElement.hasAttribute('data-ss-active'); };
    var isTop    = function () { return window === window.top; };

    /* ── Capture originals BEFORE patching ─────────────────────────────── */
    var origRFS = HTMLElement.prototype.requestFullscreen       ||
                  HTMLElement.prototype.webkitRequestFullscreen ||
                  HTMLElement.prototype.mozRequestFullScreen    ||
                  HTMLElement.prototype.msRequestFullscreen;

    function bodyFullscreen() {
        if (origRFS) return origRFS.call(document.body);
        return Promise.reject();
    }

    /* ── TOP FRAME ──────────────────────────────────────────────────────── */
    if (isTop()) {
        /* Receive fullscreen request from an iframe */
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_REQ' || !active()) return;

            /* Mark the source iframe so CSS can expand it */
            var target = null;
            try {
                var frames = document.querySelectorAll('iframe');
                for (var i = 0; i < frames.length; i++) {
                    if (frames[i].contentWindow === e.source) { target = frames[i]; break; }
                }
                if (!target && frames.length) {
                    target = frames[0];
                    for (var j = 1; j < frames.length; j++) {
                        if (frames[j].offsetWidth * frames[j].offsetHeight >
                            target.offsetWidth  * target.offsetHeight) target = frames[j];
                    }
                }
                if (target) target.setAttribute('data-ss-fs', '1');
            } catch (_) {}

            bodyFullscreen();
        });

        /* Receive exit request from an iframe */
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_EXIT' || !active()) return;
            try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
        });

        /* Notify iframes when our body fullscreen state changes */
        document.addEventListener('fullscreenchange', function () {
            var entering = document.fullscreenElement === document.body;
            document.querySelectorAll('iframe[data-ss-fs]').forEach(function (fr) {
                try { fr.contentWindow.postMessage({ type: entering ? 'SS_FS_ON' : 'SS_FS_OFF' }, '*'); } catch (_) {}
            });
            if (!entering) {
                document.querySelectorAll('iframe[data-ss-fs]').forEach(function (fr) {
                    fr.removeAttribute('data-ss-fs');
                });
            }
        });
        return; /* top-frame done */
    }

    /* ── IFRAME ─────────────────────────────────────────────────────────── */
    var fsOn = false; /* true while top-frame body is fullscreen for us */

    /* 1. Fake document.fullscreenElement so player toggle sees correct state */
    function defineGetter(prop) {
        var d = Object.getOwnPropertyDescriptor(Document.prototype, prop) ||
                Object.getOwnPropertyDescriptor(document, prop);
        if (!d || !d.get) return;
        var orig = d.get;
        try {
            Object.defineProperty(document, prop, {
                get: function () { return fsOn ? document.documentElement : orig.call(this); },
                configurable: true
            });
        } catch (_) {}
    }
    defineGetter('fullscreenElement');
    defineGetter('webkitFullscreenElement');
    defineGetter('mozFullScreenElement');

    /* 2. Fake exitFullscreen — proxy to top frame */
    function fakeExit() {
        if (fsOn) {
            try { window.top.postMessage({ type: 'SS_FS_EXIT' }, '*'); } catch (_) {}
            return Promise.resolve();
        }
        var origExit = Document.prototype.exitFullscreen || Document.prototype.webkitExitFullscreen;
        return origExit ? origExit.call(document) : Promise.resolve();
    }
    try { Object.defineProperty(document, 'exitFullscreen',          { value: fakeExit, writable: true, configurable: true }); } catch (_) {}
    try { Object.defineProperty(document, 'webkitExitFullscreen',    { value: fakeExit, writable: true, configurable: true }); } catch (_) {}
    try { Object.defineProperty(document, 'mozCancelFullScreen',     { value: fakeExit, writable: true, configurable: true }); } catch (_) {}

    /* 3. Intercept requestFullscreen — enter OR exit based on current state */
    function patchRFS(k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            if (!active()) return orig.apply(this, arguments);
            if (fsOn) {
                /* Player calls requestFullscreen while already in fake-FS → treat as exit */
                fakeExit();
                return Promise.resolve();
            }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
            return Promise.resolve();
        };
    }
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(patchRFS);

    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!active()) return origWEFS.apply(this, arguments);
            if (fsOn) { fakeExit(); return; }
            try { window.top.postMessage({ type: 'SS_FS_REQ' }, '*'); } catch (_) {}
        };
    }

    /* 4. Receive state changes from top frame */
    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === 'SS_FS_ON' && !fsOn) {
            fsOn = true;
            try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
            try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
        } else if (e.data.type === 'SS_FS_OFF' && fsOn) {
            fsOn = false;
            try { document.dispatchEvent(new Event('fullscreenchange')); } catch (_) {}
            try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch (_) {}
        }
    });
})();
