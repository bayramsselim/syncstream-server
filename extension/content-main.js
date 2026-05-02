/**
 * SyncStream Pro - Page Context Fullscreen Intercept
 * Runs in MAIN world at document_start (before any site scripts).
 * Redirects requestFullscreen to document.body so ss-root stays visible.
 */
(function () {
    if (window.__ssFullscreenPatched) return;
    window.__ssFullscreenPatched = true;

    const isActive   = () => document.documentElement.hasAttribute('data-ss-active');
    const isTopFrame = () => window === window.top;

    // Capture originals BEFORE patching — used in requestBodyFullscreen to avoid
    // calling the patched version (which would cause infinite recursion).
    var originals = {};
    ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen'].forEach(function (k) {
        if (HTMLElement.prototype[k]) originals[k] = HTMLElement.prototype[k];
    });

    function requestBodyFullscreen() {
        var fn = originals.requestFullscreen || originals.webkitRequestFullscreen ||
                 originals.mozRequestFullScreen || originals.msRequestFullscreen;
        if (fn) return fn.call(document.body);
        return Promise.reject(new Error('no fullscreen api'));
    }

    // Patch each method
    Object.keys(originals).forEach(function (k) {
        var orig = originals[k];
        HTMLElement.prototype[k] = function () {
            if (!isActive()) return orig.apply(this, arguments);
            if (isTopFrame()) {
                return requestBodyFullscreen();
            } else {
                // Inside iframe: ask top frame to go fullscreen
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {}
                return Promise.resolve();
            }
        };
    });

    // webkitEnterFullscreen used by some Safari/mobile players
    var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
    if (origWEFS) {
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            if (!isActive()) return origWEFS.apply(this, arguments);
            if (isTopFrame()) requestBodyFullscreen();
            else { try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {} }
        };
    }

    // Top frame: receive SS_FS_REQUEST from child iframe
    if (isTopFrame()) {
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_REQUEST') return;
            if (!isActive()) return;

            // Mark the source iframe so CSS can expand it to fill the screen
            var marked = false;
            try {
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    if (iframes[i].contentWindow === e.source) {
                        iframes[i].setAttribute('data-ss-fs', '1');
                        marked = true;
                        break;
                    }
                }
                // Fallback: mark the largest iframe if source match failed
                if (!marked && iframes.length) {
                    var largest = iframes[0];
                    for (var j = 1; j < iframes.length; j++) {
                        if (iframes[j].offsetWidth * iframes[j].offsetHeight >
                            largest.offsetWidth * largest.offsetHeight) largest = iframes[j];
                    }
                    largest.setAttribute('data-ss-fs', '1');
                }
            } catch (_) {}

            requestBodyFullscreen();
        });
    }
})();
