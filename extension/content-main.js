/**
 * SyncStream Pro - Page Context Fullscreen Intercept
 * Runs in MAIN world at document_start (before any site scripts).
 * Redirects requestFullscreen to document.body so ss-root stays visible.
 */
(function () {
    if (window.__ssFullscreenPatched) return;
    window.__ssFullscreenPatched = true;

    const isActive  = () => document.documentElement.hasAttribute('data-ss-active');
    const isTopFrame = () => window === window.top;

    function requestBodyFullscreen() {
        const b  = document.body;
        const fn = b.requestFullscreen || b.webkitRequestFullscreen || b.mozRequestFullScreen || b.msRequestFullscreen;
        if (fn) return fn.call(b);
        return Promise.reject();
    }

    // Patch all fullscreen methods
    ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen'].forEach(function (k) {
        var orig = HTMLElement.prototype[k];
        if (!orig) return;
        HTMLElement.prototype[k] = function () {
            if (!isActive()) return orig.apply(this, arguments);
            if (isTopFrame()) {
                return requestBodyFullscreen();
            } else {
                // Inside iframe — ask top frame to go fullscreen instead
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {}
                return Promise.resolve();
            }
        };
    });

    // Also patch webkitEnterFullscreen on video elements (used by some mobile/Safari players)
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (isTopFrame()) requestBodyFullscreen();
            else { try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {} }
        };
    }

    // Top frame: receive SS_FS_REQUEST from child iframe and go fullscreen on body
    if (isTopFrame()) {
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_REQUEST') return;
            if (!isActive()) return;

            // Mark the source iframe so CSS can expand it to fill the screen
            try {
                var frames = document.querySelectorAll('iframe');
                for (var i = 0; i < frames.length; i++) {
                    if (frames[i].contentWindow === e.source) {
                        frames[i].setAttribute('data-ss-fs', '1');
                        break;
                    }
                }
            } catch (_) {}

            requestBodyFullscreen();
        });
    }
})();
