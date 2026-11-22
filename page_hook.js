'use strict';

/**
 * Private Course & Stream Saver — CodeByAzim
 * MAIN-World Network & MSE Stream Hook (page_hook.js)
 * Registered with "world": "MAIN", "all_frames": true, "run_at": "document_start"
 */

(() => {
  if (window.__umsPageHookLoaded) return;
  window.__umsPageHookLoaded = true;

  const CHANNEL = 'UMS_PAGE_HOOK';
  const STREAM_URL_RE = /\.(m3u8|mpd|mp4)(\?|#|$)/i;
  const SEGMENT_NOISE_RE = /(\.(m4s|aac|vtt|srt|key)(\?|$)|init\.mp4(\?|$)|\/seg[-_]?\d*|\/fragment|\/chunk)/i;
  const TS_SEGMENT_RE = /((?:seg|chunk|frag|slice|part)[-_]?\d+|\d{3,}\.ts)(\?|#|$)/i;

  const postedStreams = new Set();
  let lastPostedDuration = 0;

  function safePost(payload) {
    try {
      window.postMessage({ source: CHANNEL, ...payload }, '*');
    } catch (_) {}
  }

  function normalizeDurationSeconds(raw) {
    let d = Number(raw);
    if (!Number.isFinite(d) || d <= 0) return 0;
    if (d > 86400) {
      if (d <= 86400000) {
        d = d / 1000;
      } else {
        return 0;
      }
    }
    return d > 0 && d <= 86400 ? d : 0;
  }

  function looksLikeMediaUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    if (!/^https?:\/\//i.test(rawUrl)) return false;
    if (SEGMENT_NOISE_RE.test(rawUrl)) return false;
    if (/\.ts(\?|#|$)/i.test(rawUrl)) {
      return !TS_SEGMENT_RE.test(rawUrl);
    }
    return STREAM_URL_RE.test(rawUrl);
  }

  function emitStreamUrl(rawUrl, extra = {}) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    let absUrl = rawUrl;
    try {
      absUrl = new URL(rawUrl, location.href).href;
    } catch (_) {
      return;
    }
    if (!/^https?:\/\//i.test(absUrl)) return;
    if (SEGMENT_NOISE_RE.test(absUrl)) return;

    if (postedStreams.has(absUrl)) return;
    postedStreams.add(absUrl);

    const duration = normalizeDurationSeconds(extra.duration || 0);
    if (duration > 0) {
      emitDuration(duration);
    }

    safePost({
      type: 'STREAM_DETECTED',
      url: absUrl,
      contentType: extra.contentType || '',
      sizeBytes: extra.sizeBytes || 0,
      height: extra.height || 0,
      duration,
      pageUrl: location.href
    });
  }

  function emitDuration(seconds) {
    const dur = normalizeDurationSeconds(seconds);
    if (dur <= 0) return;
    if (Math.abs(dur - lastPostedDuration) < 0.5) return;
    lastPostedDuration = dur;
    safePost({
      type: 'DURATION_DETECTED',
      duration: dur,
      pageUrl: location.href
    });
  }

  // 1. Intercept window.fetch (URL inspection only — zero unsafe header access)
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      let reqUrl = '';
      try {
        reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (looksLikeMediaUrl(reqUrl)) {
          emitStreamUrl(reqUrl);
        }
      } catch (_) {}

      const response = await origFetch.apply(this, args);

      try {
        const finalUrl = (response && response.url) || reqUrl;
        if (looksLikeMediaUrl(finalUrl)) {
          emitStreamUrl(finalUrl);
        }
      } catch (_) {}

      return response;
    };
  }

  // 2. Intercept XMLHttpRequest.prototype.open & send (URL inspection only — zero unsafe header access)
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__umsUrl = typeof url === 'string' ? url : String(url || '');
      if (looksLikeMediaUrl(this.__umsUrl)) {
        emitStreamUrl(this.__umsUrl);
      }
    } catch (_) {}
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener(
        'load',
        () => {
          try {
            const finalUrl = this.responseURL || this.__umsUrl || '';
            if (looksLikeMediaUrl(finalUrl)) {
              emitStreamUrl(finalUrl);
            }
          } catch (_) {}
        },
        { once: true }
      );
    } catch (_) {}
    return origXhrSend.apply(this, args);
  };

  // 3. Intercept MediaSource.prototype.addSourceBuffer for blob:/MSE underlying stream tracking
  if (typeof window.MediaSource === 'function' && window.MediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
    window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
      try {
        safePost({
          type: 'MSE_DETECTED',
          mimeType: String(mimeType || ''),
          pageUrl: location.href
        });
      } catch (_) {}
      return origAddSourceBuffer.call(this, mimeType);
    };
  }

  // Listen for catch-up requests from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'UMS_CONTENT_SCRIPT') return;
    if (event.data.type === 'RESCAN_PAGE_HOOK') {
      postedStreams.clear();
      lastPostedDuration = 0;
    }
  });
})();
