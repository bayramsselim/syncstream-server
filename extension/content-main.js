/**
 * SyncStream Pro - Page Context Fullscreen Intercept
 * Runs in MAIN world at document_start.
 *
 * Strategy:
 *   - TOP FRAME: do NOT intercept — let the site go fullscreen normally.
 *     content.js fullscreenchange handler will move ss-root into the element.
 *   - IFRAME: intercept and ask the top frame to go fullscreen on body instead,
 *     so ss-root (child of body) remains visible. CSS expands the iframe.
 */
(function () {
    if (window.__ssFullscreenPatched) return;
    window.__ssFullscreenPatched = true;

    const isActive   = () => document.documentElement.hasAttribute('data-ss-active');
    const isTopFrame = () => window === window.top;

    // Capture originals before any patching
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

    // Only patch for IFRAME context — top frame gets normal fullscreen behaviour
    if (!isTopFrame()) {
        Object.keys(originals).forEach(function (k) {
            var orig = originals[k];
            HTMLElement.prototype[k] = function () {
                if (!isActive()) return orig.apply(this, arguments);
                // Ask top frame to go fullscreen so ss-root stays visible
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {}
                return Promise.resolve();
            };
        });

        var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
        if (origWEFS) {
            HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
                if (!isActive()) return origWEFS.apply(this, arguments);
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch (_) {}
            };
        }
    }

    // Top frame: receive SS_FS_REQUEST from a child iframe
    if (isTopFrame()) {
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'SS_FS_REQUEST') return;
            if (!isActive()) return;

            // Mark the source iframe so CSS expands it to fill the viewport
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
