/**
 * SyncStream Pro - Page Context Fullscreen Intercept
 * Runs in MAIN world at document_start.
 *
 * Top frame  → normal fullscreen, content.js moves ss-root into the element.
 * Iframe     → intercept requestFullscreen, ask top frame to do body fullscreen.
 *              Also fake fullscreenElement + exitFullscreen so the player's
 *              toggle logic (e.g. dblclick to exit) keeps working correctly.
 */
(function () {
    if (window.__ssFullscreenPatched) return;
    window.__ssFullscreenPatched = true;

    var isActive   = function() { return document.documentElement.hasAttribute('data-ss-active'); };
    var isTopFrame = function() { return window === window.top; };

    // ── Capture originals before any patching ──────────────────────────────
    var originals = {};
    ['requestFullscreen','webkitRequestFullscreen','mozRequestFullScreen','msRequestFullscreen'].forEach(function(k){
        if (HTMLElement.prototype[k]) originals[k] = HTMLElement.prototype[k];
    });

    function callOrigBodyFullscreen() {
        var fn = originals.requestFullscreen || originals.webkitRequestFullscreen ||
                 originals.mozRequestFullScreen || originals.msRequestFullscreen;
        return fn ? fn.call(document.body) : Promise.reject();
    }

    // ── IFRAME context ─────────────────────────────────────────────────────
    if (!isTopFrame()) {
        var ssActive = false; // true when top frame's body is fullscreen because of us

        // 1. Intercept requestFullscreen — redirect to top frame
        Object.keys(originals).forEach(function(k) {
            var orig = originals[k];
            HTMLElement.prototype[k] = function() {
                if (!isActive()) return orig.apply(this, arguments);
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch(_){}
                return Promise.resolve();
            };
        });

        var origWEFS = HTMLVideoElement && HTMLVideoElement.prototype.webkitEnterFullscreen;
        if (origWEFS) {
            HTMLVideoElement.prototype.webkitEnterFullscreen = function() {
                if (!isActive()) return origWEFS.apply(this, arguments);
                try { window.top.postMessage({ type: 'SS_FS_REQUEST' }, '*'); } catch(_){}
            };
        }

        // 2. Fake document.fullscreenElement so player toggle logic works
        var fakeEl = null;
        ['fullscreenElement','webkitFullscreenElement','mozFullScreenElement'].forEach(function(prop) {
            var desc = Object.getOwnPropertyDescriptor(Document.prototype, prop) ||
                       Object.getOwnPropertyDescriptor(document, prop);
            if (!desc || !desc.get) return;
            var orig = desc.get;
            Object.defineProperty(document, prop, {
                get: function() { return ssActive ? fakeEl || document.documentElement : orig.call(this); },
                configurable: true
            });
        });

        // 3. Intercept exitFullscreen — ask top frame to exit
        var origExit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
        if (origExit) {
            var doExit = function() {
                if (ssActive) {
                    try { window.top.postMessage({ type: 'SS_FS_EXIT' }, '*'); } catch(_){}
                    return Promise.resolve();
                }
                return origExit.call(document);
            };
            document.exitFullscreen           = doExit;
            document.webkitExitFullscreen      = doExit;
            document.mozCancelFullScreen       = doExit;
        }

        // 4. Receive fullscreen state changes from top frame
        window.addEventListener('message', function(e) {
            if (!e.data) return;
            if (e.data.type === 'SS_FS_ENTER') {
                ssActive = true;
                fakeEl   = document.documentElement;
                // Dispatch a synthetic fullscreenchange so player UI updates
                try { document.dispatchEvent(new Event('fullscreenchange')); } catch(_){}
                try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch(_){}
            } else if (e.data.type === 'SS_FS_LEAVE') {
                ssActive = false;
                fakeEl   = null;
                try { document.dispatchEvent(new Event('fullscreenchange')); } catch(_){}
                try { document.dispatchEvent(new Event('webkitfullscreenchange')); } catch(_){}
            }
        });
    }

    // ── TOP FRAME ──────────────────────────────────────────────────────────
    if (isTopFrame()) {
        // Receive SS_FS_REQUEST from iframe
        window.addEventListener('message', function(e) {
            if (!e.data || e.data.type !== 'SS_FS_REQUEST') return;
            if (!isActive()) return;

            // Mark the source iframe (for CSS expansion) and remember it
            var targetIframe = null;
            try {
                var iframes = document.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    if (iframes[i].contentWindow === e.source) {
                        iframes[i].setAttribute('data-ss-fs', '1');
                        targetIframe = iframes[i];
                        break;
                    }
                }
                if (!targetIframe && iframes.length) {
                    // fallback: largest iframe
                    targetIframe = iframes[0];
                    for (var j = 1; j < iframes.length; j++) {
                        if (iframes[j].offsetWidth * iframes[j].offsetHeight >
                            targetIframe.offsetWidth * targetIframe.offsetHeight) targetIframe = iframes[j];
                    }
                    targetIframe.setAttribute('data-ss-fs', '1');
                }
            } catch(_){}

            callOrigBodyFullscreen();
        });

        // Notify iframe when fullscreen state changes
        document.addEventListener('fullscreenchange', function() {
            var entering = document.fullscreenElement === document.body;
            document.querySelectorAll('iframe[data-ss-fs]').forEach(function(iframe) {
                try { iframe.contentWindow.postMessage({ type: entering ? 'SS_FS_ENTER' : 'SS_FS_LEAVE' }, '*'); } catch(_){}
            });
            // Clean up marker when exiting
            if (!entering) {
                document.querySelectorAll('iframe[data-ss-fs]').forEach(function(iframe) {
                    iframe.removeAttribute('data-ss-fs');
                });
            }
        });

        // Receive exit request from iframe
        window.addEventListener('message', function(e) {
            if (!e.data || e.data.type !== 'SS_FS_EXIT') return;
            if (!isActive()) return;
            try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch(_){}
        });
    }
})();
