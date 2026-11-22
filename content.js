'use strict';

/**
 * Private Course & Stream Saver — CodeByAzim
 * Content Script (all_frames: true)
 */

(() => {
  if (window.__umsContentLoaded) return;
  window.__umsContentLoaded = true;

  const MIN_IMG_DIM = 250;
  const STREAM_URL_RE = /\.(m3u8|mpd|mp4)(\?|#|$)/i;
  const SEGMENT_NOISE_RE = /(\.(m4s|aac|vtt|srt|key)(\?|$)|init\.mp4(\?|$)|\/seg[-_]?\d*|\/fragment|\/chunk)/i;
  const TS_SEGMENT_RE = /((?:seg|chunk|frag|slice|part)[-_]?\d+|\d{3,}\.ts)(\?|#|$)/i;

  const IS_TOP_FRAME = (() => {
    try {
      return window.top === window.self;
    } catch (_) {
      return false;
    }
  })();

  const GENERIC_TITLES = new Set([
    'master',
    'playlist',
    'index',
    'manifest',
    'stream',
    'video',
    'player',
    'embed',
    'vimeo',
    'bunny',
    'cloudflare',
    'jwplayer',
    'untitled',
    'loading',
    'overview',
    'description',
    'comments',
    'top cast',
    'related',
    'course content',
    'curriculum',
    'reviews',
    'notes',
    'quiz',
    'home',
    'dashboard',
    'iframe',
    'video player',
    'watch',
    'media',
    'lessons',
    'up next'
  ]);

  const CHAPTER_COUNTER_RE = /\b\d+\s*(Lessons?|Chapters?|Modules?|Videos?|hr|min)\b/i;
  const CHAPTER_DURATION_RE = /\b\d+\s*hr\s*\d+\s*min\b/i;
  const RANDOM_HASH_RE = /^[a-zA-Z0-9_-]{14,}$/;
  const SITE_SUFFIX_RE = /\s*[-–—|·•]\s*(Lead Academy|Udemy|Vimeo|Coursera|Teachable|Thinkific|Kajabi|Podia|Skillshare|Pluralsight|Udacity|MasterClass|edX|Khan Academy|Hotmart|LearnDash|LifterLMS|Tutor LMS|MemberPress|Mighty Networks|Wistia|Bunny|JWPlayer)[^|\-–—]*$/i;

  const SIGNED_PARAM_KEYS = new Set([
    'sig',
    'signature',
    'token',
    'auth',
    'policy',
    'x-amz-signature',
    'x-amz-credential',
    'x-goog-signature',
    'hmac',
    'hash',
    's',
    'k',
    'exp',
    'expires',
    'verify',
    'key-pair-id'
  ]);

  const LOWRES_PARAM_KEYS = new Set([
    'w',
    'h',
    'width',
    'height',
    'resize',
    'fit',
    'quality',
    'q',
    'dpr',
    'auto'
  ]);

  const reportedUrls = new Set();
  const reportedImages = new Set();
  const pendingTimers = new Set();
  let orphaned = false;
  let observer = null;
  let lastReportedCaption = '';
  let lastReportedDuration = 0;
  let lastKnownHref = location.href;

  function isContextValid() {
    try {
      return !orphaned && Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function scheduleTimer(fn, delayMs) {
    if (!isContextValid()) return null;
    const id = setTimeout(() => {
      pendingTimers.delete(id);
      if (!isContextValid()) {
        teardownOrphanedScript();
        return;
      }
      fn();
    }, delayMs);
    pendingTimers.add(id);
    return id;
  }

  function teardownOrphanedScript() {
    if (orphaned) return;
    orphaned = true;
    try {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    } catch (_) {}
    for (const id of pendingTimers) {
      try { clearTimeout(id); } catch (_) {}
    }
    pendingTimers.clear();
    if (scanTimer) {
      try { clearTimeout(scanTimer); } catch (_) {}
      scanTimer = null;
    }
    if (hideTimer) {
      try { clearTimeout(hideTimer); } catch (_) {}
      hideTimer = null;
    }
    try { window.removeEventListener('message', onWindowMessage); } catch (_) {}
    try { window.removeEventListener('popstate', handleSpaNavigation); } catch (_) {}
    try { window.removeEventListener('hashchange', handleSpaNavigation); } catch (_) {}
    try { document.removeEventListener('load', onCaptureImgLoad, true); } catch (_) {}
    try { document.removeEventListener('mouseover', onDocMouseOver, true); } catch (_) {}
    try { document.removeEventListener('mouseout', onDocMouseOut, true); } catch (_) {}
    try { document.removeEventListener('play', onDocPlay, true); } catch (_) {}
    try { document.removeEventListener('emptied', onDocEmptied, true); } catch (_) {}
    try { document.removeEventListener('loadstart', onDocLoadStart, true); } catch (_) {}
    try {
      if (overlayHost && overlayHost.parentNode) {
        overlayHost.parentNode.removeChild(overlayHost);
      }
      overlayHost = null;
      overlayBtn = null;
      activeTarget = null;
    } catch (_) {}
  }

  function safeSendMessage(payload) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    try {
      chrome.runtime.sendMessage(payload).catch((err) => {
        if (err && /Extension context invalidated/i.test(String(err.message || err))) {
          teardownOrphanedScript();
        }
      });
    } catch (err) {
      if (err && /Extension context invalidated/i.test(String(err.message || err))) {
        teardownOrphanedScript();
      }
    }
  }

  function isGarbageCaption(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 3) return true;
    if (/http/i.test(s) || /\.(m3u8|mpd|mp4|ts)(\?|#|$|\b)/i.test(s)) return true;
    if (CHAPTER_COUNTER_RE.test(s) || CHAPTER_DURATION_RE.test(s)) return true;
    if (GENERIC_TITLES.has(s.toLowerCase())) return true;
    const segments = s.split(/\s*[-–—|·•]\s*/).map((part) => part.trim()).filter(Boolean);
    if (segments.length > 1 && segments.every((part) => GENERIC_TITLES.has(part.toLowerCase()))) return true;
    if (/^\d+$/.test(s)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    if (!/\s/.test(s) && RANDOM_HASH_RE.test(s)) return true;
    return false;
  }

  function cleanCaptionTitle(raw, stripTimestamps = false) {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\(\d+\)\s+/, '')
      .trim();
    if (stripTimestamps) {
      text = text.replace(/(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return text;
  }

  function isMeaningfulTitle(raw, stripTimestamps = false) {
    const cleaned = cleanCaptionTitle(raw, stripTimestamps);
    if (!cleaned || cleaned.length < 3 || cleaned.length > 220) return false;
    return !isGarbageCaption(cleaned);
  }

  function extractTextCandidate(el, stripTimestamps = false) {
    if (!el) return '';
    const cleaned = cleanCaptionTitle(el.textContent || '', stripTimestamps);
    return isMeaningfulTitle(cleaned, stripTimestamps) ? cleaned : '';
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
    } catch (_) {}
    return true;
  }

  function isInsideExcludedSidebar(el) {
    if (!el || !el.closest) return false;
    return Boolean(
      el.closest(
        'aside, nav, header, footer, [role="complementary"], [role="navigation"], [class*="sidebar" i], [class*="drawer" i], [class*="accordion" i]'
      )
    );
  }

  function isChapterSummaryText(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    return CHAPTER_COUNTER_RE.test(s) || CHAPTER_DURATION_RE.test(s);
  }

  function getTabBarCutoffTop(mainRoot, playerRect) {
    const scope = mainRoot || document.body || document.documentElement;
    if (!scope) return Infinity;
    const tabContainers = scope.querySelectorAll(
      '[role="tablist"], .nav-tabs, [class*="tab-bar" i], [class*="tabbar" i], [class*="tabs" i]'
    );
    let cutoff = Infinity;
    const minTop = playerRect ? Math.max(0, playerRect.top) : 0;
    for (const bar of tabContainers) {
      if (isInsideExcludedSidebar(bar) || !isElementVisible(bar)) continue;
      const barText = (bar.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/\b(description|notes|overview|comments|reviews|curriculum|quiz)\b/i.test(barText)) continue;
      const rect = bar.getBoundingClientRect();
      if (rect.top >= minTop - 10 && rect.top < cutoff) {
        cutoff = rect.top;
      }
    }
    return cutoff;
  }

  function findMainPlayerElement() {
    const candidates = Array.from(
      document.querySelectorAll(
        'video, iframe[src*="vimeo" i], iframe[src*="bunny" i], iframe[src*="wistia" i], iframe[src*="cloudflare" i], iframe[src*="jwplayer" i], iframe[src*="player" i], [class*="video-player" i], [class*="player-wrapper" i], [class*="player-container" i]'
      )
    ).filter((el) => !isInsideExcludedSidebar(el) && isElementVisible(el));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return candidates[0];
  }

  function findHeadingNearPlayer() {
    const playerEl = findMainPlayerElement();
    const mainColumn =
      (playerEl && playerEl.closest('main, [role="main"], article, [class*="player-section" i], [class*="content" i]')) ||
      document.querySelector('main, [role="main"]') ||
      (playerEl && playerEl.parentElement && playerEl.parentElement.parentElement) ||
      document.body;

    if (!mainColumn) return '';
    const videoRect = playerEl ? playerEl.getBoundingClientRect() : null;
    const tabBarCutoffTop = getTabBarCutoffTop(mainColumn, videoRect);

    const candidates = Array.from(
      mainColumn.querySelectorAll(
        'h1, h2, h3, .lesson-title, .video-title, [class*="lesson-title" i], [class*="video-title" i]'
      )
    );

    let bestText = '';
    let bestScore = Infinity;

    for (const node of candidates) {
      if (playerEl && playerEl.contains(node)) continue;
      if (isInsideExcludedSidebar(node) || !isElementVisible(node)) continue;
      if (node.children && node.children.length > 4) continue;

      const rawText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (isChapterSummaryText(rawText)) continue;

      const text = extractTextCandidate(node, false);
      if (!text) continue;

      const rect = node.getBoundingClientRect();
      if (rect.top >= tabBarCutoffTop - 4) continue;

      let score = rect.top;
      if (videoRect) {
        const belowDist = rect.top - videoRect.bottom;
        const aboveDist = videoRect.top - rect.bottom;
        if (belowDist >= -24 && belowDist <= 340) {
          score = Math.max(0, belowDist);
        } else if (aboveDist >= -24 && aboveDist <= 220) {
          score = Math.max(0, aboveDist) + 80;
        } else {
          continue;
        }
      }

      if (node.matches('.lesson-title, .video-title, [class*="lesson-title" i], [class*="video-title" i]')) {
        score -= 25;
      }

      if (score < bestScore) {
        bestScore = score;
        bestText = text;
      }
    }

    return bestText;
  }

  function findActiveCurriculumLeafCaption() {
    const leafSelectors = [
      '[aria-current="true"]',
      '.active-lesson',
      '.current-lesson',
      '[aria-current="page"][class*="lesson" i]',
      '[aria-current="page"][class*="lecture" i]',
      '[class*="lesson" i].active [class*="title" i]',
      '[class*="lecture" i].active [class*="title" i]',
      '[class*="lesson" i].active',
      '[class*="lecture" i].active',
      'li.active [class*="title" i]'
    ];

    for (const sel of leafSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.querySelector && el.querySelector('ul, ol')) continue;
        if (el.closest && el.closest('[class*="accordion-header" i], [class*="chapter-header" i], [class*="module-header" i]')) continue;
        if (el.hasAttribute && el.hasAttribute('aria-expanded')) continue;

        const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (isChapterSummaryText(rawText)) continue;

        const cleaned = extractTextCandidate(el, true);
        if (cleaned) return cleaned;
      }
    }
    return '';
  }

  /**
   * Top-frame only caption extraction:
   * 1. Main player column visible heading (below/above player, before Description/Notes/Overview tabs).
   * 2. Active leaf lesson item in curriculum (stripping timestamps, rejecting chapter summaries).
   * 3. Cleaned document.title (stripping counts and trailing LMS/site names).
   */
  function extractTopLevelCaption() {
    if (!IS_TOP_FRAME) return '';

    const playerAdjacentHeading = findHeadingNearPlayer();
    if (playerAdjacentHeading) return playerAdjacentHeading;

    const leafCaption = findActiveCurriculumLeafCaption();
    if (leafCaption) return leafCaption;

    const rawDocTitle = cleanCaptionTitle(document.title || '', false)
      .replace(SITE_SUFFIX_RE, '')
      .trim();
    if (rawDocTitle && !isChapterSummaryText(rawDocTitle) && !isGarbageCaption(rawDocTitle)) {
      return rawDocTitle;
    }

    return '';
  }

  function sanitizeFilenameBase(raw) {
    let text = cleanCaptionTitle(raw || 'Media', false)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) text = 'Media';
    if (text.length > 110) text = text.slice(0, 110).trim();
    return text;
  }

  function emitCaptionIfChanged(force = false) {
    if (!IS_TOP_FRAME) return;
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const caption = extractTopLevelCaption();
    if (force || caption !== lastReportedCaption) {
      lastReportedCaption = caption;
      safeSendMessage({
        type: 'PAGE_CAPTION_UPDATED',
        caption,
        pageUrl: location.href
      });
    }
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

  function getActiveVideoDuration() {
    let bestDur = 0;
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      const d = normalizeDurationSeconds(v.duration);
      if (d > bestDur) bestDur = d;
    }
    return bestDur;
  }

  function emitDurationIfChanged(duration, force = false) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const d = normalizeDurationSeconds(duration);
    if (d <= 0) return;
    if (force || Math.abs(d - lastReportedDuration) >= 1) {
      lastReportedDuration = d;
      safeSendMessage({
        type: 'PAGE_DURATION_UPDATED',
        duration: d,
        pageUrl: location.href
      });
    }
  }

  function normalizeVideoUrl(rawUrl) {
    try {
      return new URL(rawUrl, location.href).href;
    } catch (_) {
      return rawUrl;
    }
  }

  function isDetectableStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    if (!/^https?:\/\//i.test(rawUrl)) return false;
    if (SEGMENT_NOISE_RE.test(rawUrl)) return false;
    if (/\.ts(\?|#|$)/i.test(rawUrl)) {
      return !TS_SEGMENT_RE.test(rawUrl);
    }
    return STREAM_URL_RE.test(rawUrl);
  }

  function parseBestSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return '';
    let bestUrl = '';
    let bestScore = -1;
    const parts = srcset.split(',');
    for (const part of parts) {
      const tokens = part.trim().split(/\s+/);
      if (!tokens[0]) continue;
      const url = tokens[0];
      const desc = tokens[1] || '';
      let score = 1;
      if (desc.endsWith('w')) {
        score = parseFloat(desc) || 1;
      } else if (desc.endsWith('x')) {
        score = (parseFloat(desc) || 1) * 1000;
      }
      if (score > bestScore) {
        bestScore = score;
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  function stripUnsignedLowResParams(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      if (!/^https?:$/i.test(u.protocol)) return u.href;
      for (const [k] of u.searchParams.entries()) {
        if (SIGNED_PARAM_KEYS.has(k.toLowerCase())) {
          return u.href;
        }
      }
      const toDelete = [];
      for (const [k] of u.searchParams.entries()) {
        if (LOWRES_PARAM_KEYS.has(k.toLowerCase())) {
          toDelete.push(k);
        }
      }
      for (const k of toDelete) u.searchParams.delete(k);
      return u.href;
    } catch (_) {
      return rawUrl;
    }
  }

  function resolveHighResImageUrl(img) {
    const attrCandidates = [
      img.getAttribute('data-original'),
      img.getAttribute('data-full-src'),
      img.getAttribute('data-zoom-image'),
      img.getAttribute('data-hi-res'),
      img.getAttribute('data-src'),
      img.getAttribute('data-lazy-src')
    ].filter(Boolean);

    if (attrCandidates.length > 0) {
      return stripUnsignedLowResParams(attrCandidates[0]);
    }

    const picture = img.closest('picture');
    if (picture) {
      const sources = Array.from(picture.querySelectorAll('source[srcset]'));
      for (const srcEl of sources) {
        const best = parseBestSrcset(srcEl.getAttribute('srcset'));
        if (best) return stripUnsignedLowResParams(best);
      }
    }

    if (img.srcset) {
      const best = parseBestSrcset(img.srcset);
      if (best) return stripUnsignedLowResParams(best);
    }

    const raw = img.currentSrc || img.src;
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
    return stripUnsignedLowResParams(raw);
  }

  function buildImageRecord(img, fallbackCaption) {
    if (!img || img.naturalWidth < MIN_IMG_DIM || img.naturalHeight < MIN_IMG_DIM) return null;
    const hqUrl = resolveHighResImageUrl(img);
    if (!hqUrl || !/^https?:\/\//i.test(hqUrl)) return null;
    if (reportedImages.has(hqUrl)) return null;
    reportedImages.add(hqUrl);
    return {
      url: hqUrl,
      thumbUrl: img.currentSrc || img.src || hqUrl,
      width: img.naturalWidth,
      height: img.naturalHeight,
      alt: (img.alt || '').trim() || fallbackCaption || 'Image'
    };
  }

  function scanPerformanceResources(streams, duration) {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        const name = entry && entry.name;
        if (!name || !isDetectableStreamUrl(name)) continue;
        const normalized = normalizeVideoUrl(name);
        if (reportedUrls.has(normalized)) continue;
        reportedUrls.add(normalized);
        streams.push({
          url: normalized,
          height: 0,
          duration,
          sizeBytes: entry.decodedBodySize || entry.transferSize || 0
        });
      }
    } catch (_) {}
  }

  function scanDomMedia(forceCaptionEmit = false) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const pageTitle = IS_TOP_FRAME ? extractTopLevelCaption() : '';
    const activeDuration = getActiveVideoDuration();
    if (IS_TOP_FRAME) {
      safeSendMessage({
        type: 'CONTENT_PAGE_INFO',
        pageTitle,
        pageUrl: location.href,
        duration: activeDuration
      });
      emitCaptionIfChanged(forceCaptionEmit);
    }
    if (activeDuration > 0) {
      emitDurationIfChanged(activeDuration, forceCaptionEmit);
    }

    const streams = [];
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      attachVideoListeners(v);
      const vDur = normalizeDurationSeconds(v.duration) || activeDuration;
      const srcs = [v.currentSrc, v.src, v.getAttribute('data-src')];
      for (const s of v.querySelectorAll('source')) {
        srcs.push(s.src, s.getAttribute('src'));
      }
      for (const raw of srcs) {
        if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) continue;
        try {
          const abs = normalizeVideoUrl(new URL(raw, location.href).href);
          if (isDetectableStreamUrl(abs) && !reportedUrls.has(abs)) {
            reportedUrls.add(abs);
            streams.push({
              url: abs,
              height: v.videoHeight || 0,
              duration: vDur
            });
          }
        } catch (_) {}
      }
    }

    scanPerformanceResources(streams, activeDuration);

    const images = [];
    const imgEls = document.querySelectorAll('img');
    for (const img of imgEls) {
      const rec = buildImageRecord(img, pageTitle);
      if (rec) images.push(rec);
    }

    if (streams.length > 0 || images.length > 0) {
      safeSendMessage({
        type: 'PAGE_MEDIA_DETECTED',
        streams,
        images,
        duration: activeDuration,
        pageUrl: location.href,
        frameUrl: location.href,
        pageTitle
      });
    }
  }

  const boundVideos = new WeakSet();
  function attachVideoListeners(video) {
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);

    const onVideoSwitch = () => {
      reportedUrls.clear();
      scheduleTimer(() => scanDomMedia(true), 120);
    };

    video.addEventListener('emptied', onVideoSwitch);
    video.addEventListener('loadstart', () => {
      scheduleTimer(() => scanDomMedia(true), 120);
    });
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        emitDurationIfChanged(video.duration, false);
      }
      scanDomMedia(false);
    });
    video.addEventListener('durationchange', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        emitDurationIfChanged(video.duration, false);
      }
    });
    video.addEventListener('playing', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        emitDurationIfChanged(video.duration, false);
      }
      scanDomMedia(false);
    });
  }

  // Bridge MAIN-world page_hook.js -> Background Service Worker
  function onWindowMessage(event) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    if (event.source !== window || !event.data || event.data.source !== 'UMS_PAGE_HOOK') return;
    const msg = event.data;

    if (msg.type === 'STREAM_DETECTED' && msg.url) {
      const caption = extractTopLevelCaption();
      const dur = normalizeDurationSeconds(msg.duration) || getActiveVideoDuration();
      safeSendMessage({
        type: 'PAGE_MEDIA_DETECTED',
        streams: [
          {
            url: msg.url,
            contentType: msg.contentType || '',
            sizeBytes: msg.sizeBytes || 0,
            height: msg.height || 0,
            duration: dur || 0
          }
        ],
        images: [],
        duration: dur || 0,
        pageUrl: location.href,
        frameUrl: location.href,
        pageTitle: caption
      });
    } else if (msg.type === 'DURATION_DETECTED' && msg.duration > 0) {
      emitDurationIfChanged(msg.duration, false);
    } else if (msg.type === 'MSE_DETECTED') {
      scheduleTimer(() => scanDomMedia(false), 180);
    }
  }
  window.addEventListener('message', onWindowMessage);

  // Capture-phase load listener for instant live detection of newly loaded/lazy-loaded HQ images
  function onCaptureImgLoad(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (target && target.tagName === 'IMG') {
      const caption = extractTopLevelCaption();
      const rec = buildImageRecord(target, caption);
      if (rec) {
        safeSendMessage({
          type: 'PAGE_MEDIA_DETECTED',
          streams: [],
          images: [rec],
          pageUrl: location.href,
          frameUrl: location.href,
          pageTitle: caption
        });
      }
    }
  }
  document.addEventListener('load', onCaptureImgLoad, true);

  // SPA Navigation detection: history.pushState, history.replaceState, popstate, hashchange
  function handleSpaNavigation() {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    if (location.href !== lastKnownHref) {
      lastKnownHref = location.href;
      reportedUrls.clear();
      lastReportedDuration = 0;
    }
    scheduleTimer(() => scanDomMedia(true), 150);
    scheduleTimer(() => emitCaptionIfChanged(false), 600);
  }

  try {
    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      handleSpaNavigation();
      return ret;
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      handleSpaNavigation();
      return ret;
    };
  } catch (_) {}

  window.addEventListener('popstate', handleSpaNavigation);
  window.addEventListener('hashchange', handleSpaNavigation);

  // Non-intrusive Shadow DOM hover overlay button for HQ Images and Playing Videos
  let overlayHost = null;
  let overlayBtn = null;
  let activeTarget = null;
  let activeType = null;
  let hideTimer = null;

  function ensureOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-ums-overlay', '1');
    overlayHost.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;display:none;top:0;left:0;';
    const shadow = overlayHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 11px;
        border: 1px solid rgba(255,255,255,0.22);
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.92);
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        transition: background 0.15s ease, transform 0.15s ease;
      }
      button:hover {
        background: #2563eb;
        transform: translateY(-1px);
      }
      svg {
        width: 13px;
        height: 13px;
        flex-shrink: 0;
      }
    `;
    overlayBtn = document.createElement('button');
    overlayBtn.type = 'button';
    overlayBtn.addEventListener('mouseenter', () => {
      if (hideTimer) clearTimeout(hideTimer);
    });
    overlayBtn.addEventListener('mouseleave', () => {
      scheduleHide();
    });
    overlayBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleOverlayClick();
    });
    shadow.appendChild(style);
    shadow.appendChild(overlayBtn);
    (document.body || document.documentElement).appendChild(overlayHost);
  }

  function showOverlayFor(el, type, label) {
    ensureOverlay();
    if (hideTimer) clearTimeout(hideTimer);
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) return;

    activeTarget = el;
    activeType = type;

    overlayBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>${label}</span>
    `;

    const top = Math.max(8, Math.min(window.innerHeight - 40, rect.top + 10));
    const left = Math.max(8, Math.min(window.innerWidth - 140, rect.right - 130));
    overlayHost.style.top = `${top}px`;
    overlayHost.style.left = `${left}px`;
    overlayHost.style.display = 'block';
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (overlayHost) overlayHost.style.display = 'none';
      activeTarget = null;
      activeType = null;
    }, 220);
  }

  function guessImageExtension(url) {
    const m = url.match(/\.(png|webp|jpeg|jpg|avif|gif)(\?|#|$)/i);
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    return 'jpg';
  }

  function handleOverlayClick() {
    if (!activeTarget) return;
    if (activeType === 'image') {
      const hqUrl = resolveHighResImageUrl(activeTarget);
      if (!hqUrl) return;
      const base = sanitizeFilenameBase(activeTarget.alt || extractTopLevelCaption() || 'HQ_Image');
      const ext = guessImageExtension(hqUrl);
      const filename = `${base} [CodeByAzim].${ext}`;
      safeSendMessage({
        type: 'DOWNLOAD_DIRECT_MEDIA',
        url: hqUrl,
        filename,
        isBatch: false
      });
      overlayBtn.querySelector('span').textContent = 'Saving...';
      scheduleTimer(() => {
        if (overlayBtn) overlayBtn.querySelector('span').textContent = 'Download HQ';
      }, 1200);
    } else if (activeType === 'video') {
      const src = activeTarget.currentSrc || activeTarget.src;
      const base = sanitizeFilenameBase(extractTopLevelCaption() || 'Video');
      const containerMatch = src && !src.startsWith('blob:') ? src.match(/\.(mp4)(\?|#|$)/i) : null;
      if (containerMatch) {
        const ext = containerMatch[1].toLowerCase();
        safeSendMessage({
          type: 'DOWNLOAD_DIRECT_MEDIA',
          url: src,
          filename: `${base} [CodeByAzim].${ext}`,
          isBatch: false
        });
        overlayBtn.querySelector('span').textContent = 'Saving...';
      } else {
        overlayBtn.querySelector('span').textContent = 'Open Extension';
      }
      scheduleTimer(() => {
        if (overlayBtn) overlayBtn.querySelector('span').textContent = 'Download';
      }, 1400);
    }
  }

  function onDocMouseOver(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    if (target.closest && target.closest('[data-ums-overlay]')) return;

    const video = target.tagName === 'VIDEO' ? target : target.closest('video');
    if (video && (!video.paused || video.readyState >= 2)) {
      showOverlayFor(video, 'video', 'Download');
      return;
    }

    if (target.tagName === 'IMG') {
      if (target.naturalWidth >= MIN_IMG_DIM && target.naturalHeight >= MIN_IMG_DIM) {
        showOverlayFor(target, 'image', 'Download HQ');
      }
    }
  }

  function onDocMouseOut(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    if (target === activeTarget) {
      scheduleHide();
    }
  }

  function onDocPlay(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (target && target.tagName === 'VIDEO') {
      scanDomMedia(false);
      showOverlayFor(target, 'video', 'Download');
    }
  }

  function onDocEmptied(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (target && target.tagName === 'VIDEO') {
      reportedUrls.clear();
      scheduleTimer(() => scanDomMedia(true), 120);
    }
  }

  function onDocLoadStart(e) {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    const target = e.target;
    if (target && target.tagName === 'VIDEO') {
      scheduleTimer(() => scanDomMedia(true), 120);
    }
  }

  document.addEventListener('mouseover', onDocMouseOver, true);
  document.addEventListener('mouseout', onDocMouseOut, true);
  document.addEventListener('play', onDocPlay, true);
  document.addEventListener('emptied', onDocEmptied, true);
  document.addEventListener('loadstart', onDocLoadStart, true);

  if (isContextValid() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isContextValid()) {
        teardownOrphanedScript();
        return;
      }
      if (msg && msg.type === 'RESCAN_DOM_MEDIA') {
        reportedUrls.clear();
        try {
          window.postMessage({ source: 'UMS_CONTENT_SCRIPT', type: 'RESCAN_PAGE_HOOK' }, '*');
        } catch (_) {}
        scanDomMedia(true);
        sendResponse({ ok: true });
      }
    });
  }

  // Initial scan + MutationObserver for SPA lesson & lazy-media changes
  scanDomMedia(true);
  let scanTimer = null;
  observer = new MutationObserver(() => {
    if (!isContextValid()) {
      teardownOrphanedScript();
      return;
    }
    if (location.href !== lastKnownHref) {
      lastKnownHref = location.href;
      reportedUrls.clear();
      lastReportedDuration = 0;
    }
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (!isContextValid()) {
        teardownOrphanedScript();
        return;
      }
      emitCaptionIfChanged(false);
      scanDomMedia(false);
    }, 350);
  });
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    characterData: true
  });
})();
