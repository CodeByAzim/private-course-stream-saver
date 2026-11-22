'use strict';

/**
 * Private Course & Stream Saver — CodeByAzim
 * Manifest V3 Service Worker (background.js)
 */

const MIN_PROGRESSIVE_BYTES = 500 * 1024; // 500 KB minimum for passive sniffer
const OCTET_STREAM_MIN_BYTES = 1024 * 1024; // 1 MB minimum for application/octet-stream
const LEGACY_DNR_REFERER_RULE_ID = 9001;
const NOISE_PATTERN = /(\.(m4s|aac|vtt|srt|key)(\?|$)|init\.mp4(\?|$)|\/seg-|\/fragment|\/chunk|[?&]range=)/i;
const TS_SEGMENT_NOISE_RE = /((?:seg|chunk|frag|slice|part)[-_]?\d+|\d{3,}\.ts)(\?|#|$)/i;
const STREAM_EXT_PATTERN = /\.(m3u8|mpd|mp4|ts)(\?|#|$)/i;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
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
  'media'
]);
const CHAPTER_COUNTER_RE = /\b\d+\s*(Lessons?|Chapters?|Modules?|Videos?|hr|min)\b/i;
const CHAPTER_DURATION_RE = /\b\d+\s*hr\s*\d+\s*min\b/i;
const RANDOM_HASH_RE = /^[a-zA-Z0-9_-]{14,}$/;
const SITE_TITLE_SUFFIX_RE = /\s*[-–—|·•]\s*(Lead Academy|Udemy|Vimeo|Coursera|Teachable|Thinkific|Kajabi|Podia|Skillshare|Pluralsight|Udacity|MasterClass|edX|Khan Academy|Hotmart|LearnDash|LifterLMS|Tutor LMS|MemberPress|Mighty Networks|Wistia|Bunny|JWPlayer)[^|\-–—]*$/i;

/** @type {Map<number, any>} */
const tabStore = new Map();
/** @type {Map<number, { blobUrl: string | null, filename: string, jobId: string }>} */
const pendingBlobDownloads = new Map();
/** @type {Set<string>} */
const inspectingPlaylists = new Set();

/** @type {Map<string, any>} */
const jobsMap = new Map();
/** @type {Map<string, any>} */
const jobPayloads = new Map();

let jobsHydrated = false;
let detectionSeq = 0;

function getOrCreateTabState(tabId) {
  if (!tabStore.has(tabId)) {
    tabStore.set(tabId, {
      tabId,
      pageTitle: '',
      pageUrl: '',
      origin: '',
      pageDuration: 0,
      streams: new Map(),
      suppressedChildKeys: new Set(),
      suppressedHostGroups: new Set(),
      images: new Map()
    });
  }
  return tabStore.get(tabId);
}

async function persistTabState(tabId) {
  const state = tabStore.get(tabId);
  if (!state) return;
  try {
    const serialized = {
      tabId: state.tabId,
      pageTitle: state.pageTitle,
      pageUrl: state.pageUrl,
      origin: state.origin,
      pageDuration: state.pageDuration || 0,
      streams: Array.from(state.streams.entries()),
      suppressedChildKeys: Array.from(state.suppressedChildKeys),
      suppressedHostGroups: Array.from(state.suppressedHostGroups),
      images: Array.from(state.images.entries())
    };
    await chrome.storage.session.set({ [`tab_${tabId}`]: serialized });
  } catch (_) {}
  updateBadge(tabId);
}

async function loadTabState(tabId) {
  if (tabStore.has(tabId)) return tabStore.get(tabId);
  try {
    const key = `tab_${tabId}`;
    const res = await chrome.storage.session.get(key);
    if (res && res[key]) {
      const raw = res[key];
      const state = {
        tabId: raw.tabId,
        pageTitle: raw.pageTitle || '',
        pageUrl: raw.pageUrl || '',
        origin: raw.origin || '',
        pageDuration: raw.pageDuration || 0,
        streams: new Map(raw.streams || []),
        suppressedChildKeys: new Set(raw.suppressedChildKeys || []),
        suppressedHostGroups: new Set(raw.suppressedHostGroups || []),
        images: new Map(raw.images || [])
      };
      tabStore.set(tabId, state);
      return state;
    }
  } catch (_) {}
  return getOrCreateTabState(tabId);
}

async function ensureJobsHydrated() {
  if (jobsHydrated) return;
  jobsHydrated = true;
  try {
    const res = await chrome.storage.local.get(['ums_jobs_map', 'ums_job_payloads']);
    if (Array.isArray(res.ums_jobs_map)) {
      for (const item of res.ums_jobs_map) {
        if (item && item.jobId && !jobsMap.has(item.jobId)) {
          jobsMap.set(item.jobId, item);
        }
      }
    }
    if (Array.isArray(res.ums_job_payloads)) {
      for (const p of res.ums_job_payloads) {
        if (p && p.jobId && !jobPayloads.has(p.jobId)) {
          jobPayloads.set(p.jobId, p);
        }
      }
    }
  } catch (_) {}
}

function getSerializedJobs() {
  return Array.from(jobsMap.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

async function persistJobsState() {
  try {
    await chrome.storage.local.set({
      ums_jobs_map: getSerializedJobs(),
      ums_job_payloads: Array.from(jobPayloads.values())
    });
  } catch (_) {}
}

function broadcastJobsProgress(latestJob = null) {
  const jobs = getSerializedJobs();
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    job: latestJob || jobs[0] || null,
    jobs
  }).catch(() => {});
}

function updateBadge(tabId) {
  const state = tabStore.get(tabId);
  if (!state) return;
  const videos = getRankedStreams(state);
  const count = videos.length + state.images.size;
  chrome.action.setBadgeText({
    tabId,
    text: count > 0 ? String(count > 99 ? '99+' : count) : ''
  }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: '#2563eb'
  }).catch(() => {});
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

function isNoiseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return true;
  if (!/^https?:\/\//i.test(rawUrl)) return true;
  if (NOISE_PATTERN.test(rawUrl)) return true;
  if (/\.ts(\?|#|$)/i.test(rawUrl) && TS_SEGMENT_NOISE_RE.test(rawUrl)) return true;
  return false;
}

function getCanonicalStreamKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const pathname = u.pathname.replace(/\/+$/, '');
    const leaf = pathname.split('/').pop() || '';
    const uuidMatch = leaf.match(UUID_PATTERN);
    if (uuidMatch) {
      const extMatch = leaf.match(/\.(m3u8|mp4|mpd|ts)$/i);
      return `uuid:${uuidMatch[0].toLowerCase()}:${extMatch ? extMatch[1].toLowerCase() : ''}`;
    }
    return `${u.origin}${pathname}`;
  } catch (_) {
    return rawUrl.split('?')[0];
  }
}

function getVideoGroupKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const uuidMatch = u.pathname.match(UUID_PATTERN);
    if (uuidMatch) return `uuid:${uuidMatch[0].toLowerCase()}`;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `host:${u.hostname}/${parts.slice(0, -1).join('/')}`;
    }
    return `host:${u.hostname}`;
  } catch (_) {
    return '';
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

function cleanCaptionCandidate(rawCaption) {
  let text = String(rawCaption || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\(\d+\)\s+/, '')
    .replace(SITE_TITLE_SUFFIX_RE, '')
    .trim();
  if (isGarbageCaption(text)) return '';
  if (text.length > 140) {
    text = text.slice(0, 140).trim();
  }
  return text;
}

function sanitizeCaption(rawCaption) {
  let text = cleanCaptionCandidate(rawCaption);
  if (!text) return '';
  text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (isGarbageCaption(text)) return '';
  if (text.length > 110) {
    text = text.slice(0, 110).trim();
  }
  return text;
}

function sanitizeSubfolder(rawFolder) {
  let folder = String(rawFolder || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (folder.length > 64) {
    folder = folder.slice(0, 64).trim();
  }
  return folder;
}

function sanitizeLeafFilename(rawFilename) {
  return String(rawFilename || 'Media Download [CodeByAzim].mp4')
    .replace(/^[/\\]+/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getSaveSettings() {
  const local = await chrome.storage.local.get(['ums_save_settings', 'ums_ask_location']);
  if (local.ums_save_settings && typeof local.ums_save_settings === 'object') {
    const mode = local.ums_save_settings.saveMode;
    const validMode = mode === 'subfolder' || mode === 'ask' ? mode : 'default';
    return {
      saveMode: validMode,
      subfolder: sanitizeSubfolder(local.ums_save_settings.subfolder || '')
    };
  }
  return {
    saveMode: local.ums_ask_location ? 'ask' : 'default',
    subfolder: ''
  };
}

function resolveDownloadDestination(cleanFilename, saveSettings, isBatch = false) {
  const safeLeaf = sanitizeLeafFilename(cleanFilename);
  if (!isBatch && saveSettings.saveMode === 'ask') {
    return { filename: safeLeaf, saveAs: true };
  }
  if (saveSettings.saveMode === 'subfolder' && saveSettings.subfolder) {
    const safeFolder = sanitizeSubfolder(saveSettings.subfolder);
    if (safeFolder) {
      return { filename: `${safeFolder}/${safeLeaf}`, saveAs: false };
    }
  }
  return { filename: safeLeaf, saveAs: false };
}

function parseContentLength(headers) {
  if (!Array.isArray(headers)) return 0;
  let contentRangeTotal = 0;
  let contentLength = 0;
  for (const h of headers) {
    const name = (h.name || '').toLowerCase();
    const val = (h.value || '').trim();
    if (name === 'content-range') {
      const m = val.match(/\/(\d+)\s*$/);
      if (m) contentRangeTotal = parseInt(m[1], 10) || 0;
    } else if (name === 'content-length') {
      contentLength = parseInt(val, 10) || 0;
    }
  }
  return contentRangeTotal || contentLength || 0;
}

function getHeaderValue(headers, targetName) {
  if (!Array.isArray(headers)) return '';
  const needle = targetName.toLowerCase();
  for (const h of headers) {
    if ((h.name || '').toLowerCase() === needle) {
      return (h.value || '').trim();
    }
  }
  return '';
}

function getContentType(headers) {
  return getHeaderValue(headers, 'content-type').toLowerCase().split(';')[0].trim();
}

function detectStreamKind(rawUrl, contentType, sizeBytes = 0, acceptRanges = '') {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (
    ct === 'application/vnd.apple.mpegurl' ||
    ct === 'application/x-mpegurl' ||
    ct === 'audio/mpegurl' ||
    ct === 'audio/x-mpegurl'
  ) {
    return 'hls';
  }
  if (ct === 'application/dash+xml') return 'dash';
  if (ct === 'video/mp2t') return 'ts';
  if (ct === 'video/mp4') return 'mp4';

  const m = rawUrl.match(STREAM_EXT_PATTERN);
  if (m) {
    const ext = m[1].toLowerCase();
    if (ext === 'm3u8') return 'hls';
    if (ext === 'mpd') return 'dash';
    return ext;
  }

  if (ct === 'application/octet-stream' && sizeBytes > OCTET_STREAM_MIN_BYTES && /bytes/i.test(acceptRanges || '')) {
    return 'mp4';
  }
  return null;
}

function inferHeightFromUrl(rawUrl) {
  const m = rawUrl.match(/(?:^|[^0-9])(4320|2160|1440|1080|720|540|480|360|240)p?(?:[^0-9]|$)/i);
  if (m) return parseInt(m[1], 10);
  if (/4k|uhd/i.test(rawUrl)) return 2160;
  if (/2k|qhd/i.test(rawUrl)) return 1440;
  if (/fhd/i.test(rawUrl)) return 1080;
  if (/hd/i.test(rawUrl)) return 720;
  return 0;
}

function formatQualityLabel(height, isBest) {
  let base = '';
  if (height >= 4320) base = '8K UHD (4320p)';
  else if (height >= 2160) base = '4K UHD (2160p)';
  else if (height >= 1440) base = '2K QHD (1440p)';
  else if (height >= 1080) base = '1080p Full HD';
  else if (height >= 720) base = '720p HD';
  else if (height >= 540) base = '540p qHD';
  else if (height >= 480) base = '480p SD';
  else if (height >= 360) base = '360p';
  else if (height > 0) base = `${height}p`;
  else base = 'Original Quality';
  return isBest ? `${base} (★ Best)` : base;
}

function parseHlsAttributes(attrStr) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = regex.exec(attrStr)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function resolveUrl(baseUrl, relUrl) {
  try {
    return new URL(relUrl, baseUrl).href;
  } catch (_) {
    return relUrl;
  }
}

function parseFrameRate(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const s = String(raw).trim();
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (den > 0 && num > 0) return Number((num / den).toFixed(2));
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n <= 240 ? Number(n.toFixed(2)) : 0;
}

function analyzeHlsMediaPlaylist(text) {
  if (!text || typeof text !== 'string') {
    return { totalDuration: 0, segmentCount: 0, isVod: true, streamStatus: 'VOD', container: 'MPEG-TS' };
  }
  let totalDuration = 0;
  let segmentCount = 0;
  const extinfRe = /#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)/gi;
  let m;
  while ((m = extinfRe.exec(text)) !== null) {
    totalDuration += parseFloat(m[1]) || 0;
    segmentCount++;
  }
  const hasEndList = /#EXT-X-ENDLIST\b/i.test(text);
  const playlistTypeMatch = text.match(/#EXT-X-PLAYLIST-TYPE:\s*([A-Z]+)/i);
  const isVod = hasEndList || (playlistTypeMatch ? playlistTypeMatch[1].toUpperCase() === 'VOD' : true);
  const hasFmp4Map = /#EXT-X-MAP:/i.test(text) || /\.(m4s|mp4)(\?|#|$)/im.test(text);
  return {
    totalDuration: normalizeDurationSeconds(totalDuration),
    segmentCount,
    isVod,
    streamStatus: isVod ? 'VOD' : 'Live',
    container: hasFmp4Map ? 'fMP4' : 'MPEG-TS'
  };
}

function parseHlsMediaDuration(text) {
  return analyzeHlsMediaPlaylist(text).totalDuration;
}

function parseIso8601Duration(raw) {
  if (!raw || typeof raw !== 'string') return 0;
  const m = raw.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([0-9.]+)S)?/i);
  if (!m) return 0;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  const mins = parseInt(m[3] || '0', 10);
  const secs = parseFloat(m[4] || '0');
  return normalizeDurationSeconds(days * 86400 + hours * 3600 + mins * 60 + secs);
}

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  if (!isMaster) {
    return { isMaster: false, variants: [], audioTracks: [], subtitleTracks: [], childUrls: [] };
  }

  const variants = [];
  const audioTracks = [];
  const subtitleTracks = [];
  const childUrls = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseHlsAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = (attrs.TYPE || '').toUpperCase();
      const uri = attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '';
      if (uri) childUrls.push(uri);
      const track = {
        groupId: attrs['GROUP-ID'] || 'default',
        name: attrs.NAME || attrs.LANGUAGE || 'Track',
        language: attrs.LANGUAGE || '',
        isDefault: attrs.DEFAULT === 'YES' || attrs.AUTOSELECT === 'YES',
        uri
      };
      if (type === 'AUDIO' && uri) {
        audioTracks.push(track);
      } else if (type === 'SUBTITLES' && uri) {
        subtitleTracks.push(track);
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseHlsAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let nextUri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          nextUri = resolveUrl(baseUrl, lines[j]);
          i = j;
          break;
        }
      }
      if (!nextUri) continue;
      childUrls.push(nextUri);

      let width = 0;
      let height = 0;
      if (attrs.RESOLUTION) {
        const parts = attrs.RESOLUTION.split('x');
        width = parseInt(parts[0], 10) || 0;
        height = parseInt(parts[1], 10) || 0;
      }
      if (!height) {
        height = inferHeightFromUrl(nextUri);
      }
      const bandwidth = parseInt(attrs.BANDWIDTH || '0', 10) || 0;
      const averageBandwidth = parseInt(attrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0;
      const frameRate = parseFrameRate(attrs['FRAME-RATE']);
      variants.push({
        url: nextUri,
        width,
        height,
        frameRate,
        bandwidth: bandwidth || averageBandwidth,
        averageBandwidth: averageBandwidth || bandwidth,
        codecs: attrs.CODECS || '',
        audioGroup: attrs.AUDIO || '',
        subtitleGroup: attrs.SUBTITLES || '',
        estimatedBytes: 0,
        isBest: false,
        label: ''
      });
    }
  }

  // Keep distinct (height, bandwidth, url) variants so same-resolution Data Saver variants are preserved
  const seenKeys = new Map();
  for (const v of variants) {
    const bw = v.averageBandwidth || v.bandwidth || 0;
    const key = `h:${v.height}:b:${bw}:${v.url}`;
    if (!seenKeys.has(key)) {
      seenKeys.set(key, v);
    }
  }
  const sorted = Array.from(seenKeys.values()).sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return (b.averageBandwidth || b.bandwidth) - (a.averageBandwidth || a.bandwidth);
  });

  let bestHeight = 0;
  if (sorted.some((v) => v.height === 1080)) bestHeight = 1080;
  else if (sorted.some((v) => v.height === 720)) bestHeight = 720;
  else if (sorted.length > 0) bestHeight = sorted[0].height;

  const bestIdx = sorted.findIndex((v) => v.height === bestHeight);
  sorted.forEach((v, idx) => {
    v.isBest = idx === bestIdx;
    v.label = formatQualityLabel(v.height, v.isBest);
  });

  return { isMaster: true, variants: sorted, audioTracks, subtitleTracks, childUrls };
}

// =========================================================================
// Pure-JS MPEG-DASH (.mpd) Manifest Parser (Service-Worker safe, no DOMParser)
// =========================================================================

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseXmlAttrs(attrText) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText || '')) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function extractFirstTagText(xml, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function findTagBlocks(xml, tagName) {
  const blocks = [];
  const re = new RegExp(`<${tagName}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagName}>)`, 'gi');
  let m;
  while ((m = re.exec(xml || '')) !== null) {
    blocks.push({
      attrs: parseXmlAttrs(m[1] || ''),
      inner: m[2] || ''
    });
  }
  return blocks;
}

function expandDashTemplate(template, repId, bandwidth, numberVal, timeVal) {
  if (!template) return '';
  let out = template
    .replace(/\$RepresentationID\$/g, String(repId || ''))
    .replace(/\$Bandwidth\$/g, String(bandwidth || 0));

  out = out.replace(/\$Number(?:%0(\d+)d)?\$/g, (_m, width) => {
    const s = String(numberVal || 0);
    return width ? s.padStart(parseInt(width, 10), '0') : s;
  });

  out = out.replace(/\$Time(?:%0(\d+)d)?\$/g, (_m, width) => {
    const s = String(timeVal || 0);
    return width ? s.padStart(parseInt(width, 10), '0') : s;
  });

  return out;
}

function extractSegmentInfoForRep(repBlock, adaptBlock, adaptBaseUrl, repAttrs, totalDuration) {
  const repBaseRaw = extractFirstTagText(repBlock.inner, 'BaseURL');
  const effectiveBase = repBaseRaw ? resolveUrl(adaptBaseUrl, repBaseRaw) : adaptBaseUrl;

  const repTpl = findTagBlocks(repBlock.inner, 'SegmentTemplate')[0];
  const adaptTpl = findTagBlocks(adaptBlock.inner, 'SegmentTemplate')[0];
  const tpl = repTpl || adaptTpl;

  if (tpl) {
    const attrs = { ...(adaptTpl ? adaptTpl.attrs : {}), ...(repTpl ? repTpl.attrs : {}) };
    const timelineXml = (repTpl && repTpl.inner.includes('SegmentTimeline') ? repTpl.inner : '') || (adaptTpl ? adaptTpl.inner : '');
    const repId = repAttrs.id || '';
    const bw = parseInt(repAttrs.bandwidth || '0', 10) || 0;
    const startNumber = parseInt(attrs.startNumber || '1', 10) || 1;
    const timescale = parseInt(attrs.timescale || '1', 10) || 1;
    const segDuration = parseInt(attrs.duration || '0', 10) || 0;

    let init = null;
    if (attrs.initialization) {
      const initRel = expandDashTemplate(attrs.initialization, repId, bw, startNumber, 0);
      init = { url: resolveUrl(effectiveBase, initRel), range: null };
    }

    const segments = [];
    if (attrs.media) {
      const sBlocks = findTagBlocks(timelineXml, 'S');
      if (sBlocks.length > 0) {
        let curTime = 0;
        let curNum = startNumber;
        for (const s of sBlocks) {
          if (s.attrs.t !== undefined) curTime = parseInt(s.attrs.t, 10) || 0;
          const d = parseInt(s.attrs.d || '0', 10) || 0;
          let repeat = parseInt(s.attrs.r || '0', 10);
          if (repeat < 0 && totalDuration > 0 && d > 0) {
            repeat = Math.max(0, Math.ceil((totalDuration * timescale - curTime) / d) - 1);
          }
          if (repeat < 0) repeat = 0;
          for (let r = 0; r <= repeat; r++) {
            const segRel = expandDashTemplate(attrs.media, repId, bw, curNum, curTime);
            segments.push({ url: resolveUrl(effectiveBase, segRel), range: null });
            curTime += d;
            curNum++;
          }
        }
      } else if (segDuration > 0 && totalDuration > 0) {
        const count = Math.max(1, Math.ceil((totalDuration * timescale) / segDuration));
        for (let idx = 0; idx < count; idx++) {
          const num = startNumber + idx;
          const segRel = expandDashTemplate(attrs.media, repId, bw, num, idx * segDuration);
          segments.push({ url: resolveUrl(effectiveBase, segRel), range: null });
        }
      }
    }

    return { init, segments, directUrl: '' };
  }

  const segList = findTagBlocks(repBlock.inner, 'SegmentList')[0] || findTagBlocks(adaptBlock.inner, 'SegmentList')[0];
  if (segList) {
    const initBlock = findTagBlocks(segList.inner, 'Initialization')[0];
    const init = initBlock && initBlock.attrs.sourceURL
      ? { url: resolveUrl(effectiveBase, initBlock.attrs.sourceURL), range: initBlock.attrs.range || null }
      : null;
    const segUrls = findTagBlocks(segList.inner, 'SegmentURL')
      .map((s) => (s.attrs.media ? { url: resolveUrl(effectiveBase, s.attrs.media), range: s.attrs.mediaRange || null } : null))
      .filter(Boolean);
    return { init, segments: segUrls, directUrl: '' };
  }

  // Single BaseURL progressive representation
  const segBase = findTagBlocks(repBlock.inner, 'SegmentBase')[0];
  if (!segBase && repBaseRaw) {
    return { init: null, segments: [], directUrl: effectiveBase };
  }
  if (repBaseRaw) {
    return { init: null, segments: [], directUrl: effectiveBase };
  }
  return { init: null, segments: [], directUrl: '' };
}

function parseMpdManifest(xmlText, baseUrl) {
  const mpdOpen = xmlText.match(/<MPD\b([^>]*)>/i);
  const mpdAttrs = parseXmlAttrs(mpdOpen ? mpdOpen[1] : '');
  const periodBlocks = findTagBlocks(xmlText, 'Period');
  const firstPeriodAttrs = periodBlocks[0] ? periodBlocks[0].attrs : {};
  const totalDuration = parseIso8601Duration(mpdAttrs.mediaPresentationDuration || firstPeriodAttrs.duration || '');

  const mpdBaseRaw = extractFirstTagText(xmlText.split(/<Period\b/i)[0] || '', 'BaseURL');
  const mpdBase = mpdBaseRaw ? resolveUrl(baseUrl, mpdBaseRaw) : baseUrl;

  const firstPeriodInner = periodBlocks[0] ? periodBlocks[0].inner : xmlText;
  const periodBaseRaw = extractFirstTagText(firstPeriodInner.split(/<AdaptationSet\b/i)[0] || '', 'BaseURL');
  const periodBase = periodBaseRaw ? resolveUrl(mpdBase, periodBaseRaw) : mpdBase;

  const adaptationSets = findTagBlocks(firstPeriodInner, 'AdaptationSet');
  const videoReps = [];
  const audioReps = [];

  for (const adapt of adaptationSets) {
    const adaptBaseRaw = extractFirstTagText(adapt.inner.split(/<Representation\b/i)[0] || '', 'BaseURL');
    const adaptBase = adaptBaseRaw ? resolveUrl(periodBase, adaptBaseRaw) : periodBase;
    const reps = findTagBlocks(adapt.inner, 'Representation');
    const aContentType = (adapt.attrs.contentType || '').toLowerCase();
    const aMime = (adapt.attrs.mimeType || '').toLowerCase();

    for (const rep of reps) {
      const mime = (rep.attrs.mimeType || aMime).toLowerCase();
      const isAudio = aContentType === 'audio' || mime.startsWith('audio/');
      const isVideo = aContentType === 'video' || mime.startsWith('video/') || (!isAudio && (rep.attrs.height || adapt.attrs.height));

      const segInfo = extractSegmentInfoForRep(rep, adapt, adaptBase, rep.attrs, totalDuration);
      const bandwidth = parseInt(rep.attrs.bandwidth || '0', 10) || 0;
      const width = parseInt(rep.attrs.width || adapt.attrs.width || '0', 10) || 0;
      const height = parseInt(rep.attrs.height || adapt.attrs.height || '0', 10) || 0;

      const frameRate = parseFrameRate(rep.attrs.frameRate || adapt.attrs.frameRate || '');

      if (isAudio) {
        audioReps.push({
          id: rep.attrs.id || `audio_${audioReps.length}`,
          lang: adapt.attrs.lang || 'default',
          bandwidth,
          codecs: rep.attrs.codecs || adapt.attrs.codecs || '',
          ...segInfo
        });
      } else if (isVideo) {
        videoReps.push({
          id: rep.attrs.id || `video_${videoReps.length}`,
          bandwidth,
          width,
          height,
          frameRate,
          codecs: rep.attrs.codecs || adapt.attrs.codecs || '',
          ...segInfo
        });
      }
    }
  }

  audioReps.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const primaryAudio = audioReps[0] || null;
  const primaryAudioBandwidth = primaryAudio ? primaryAudio.bandwidth || 128000 : 0;
  const primaryAudioCodecs = primaryAudio ? primaryAudio.codecs || '' : '';

  videoReps.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));

  let bestHeight = 0;
  if (videoReps.some((v) => v.height === 1080)) bestHeight = 1080;
  else if (videoReps.some((v) => v.height === 720)) bestHeight = 720;
  else if (videoReps.length > 0) bestHeight = videoReps[0].height;
  const bestIdx = videoReps.findIndex((v) => v.height === bestHeight);
  const streamStatus = (mpdAttrs.type || 'static').toLowerCase() === 'dynamic' ? 'Live' : 'VOD';

  const variants = videoReps.map((v, idx) => {
    const isBest = idx === bestIdx;
    const estBytes = totalDuration > 0 && v.bandwidth > 0
      ? Math.round(((v.bandwidth + primaryAudioBandwidth) / 8) * totalDuration)
      : 0;
    const combinedCodecs = v.codecs && primaryAudioCodecs && !v.codecs.includes(',')
      ? `${v.codecs},${primaryAudioCodecs}`
      : (v.codecs || primaryAudioCodecs || '');
    const segCount = (v.segments && v.segments.length) || (v.directUrl ? 1 : 0);
    return {
      url: v.directUrl || baseUrl,
      width: v.width,
      height: v.height,
      frameRate: v.frameRate || 0,
      bandwidth: v.bandwidth,
      averageBandwidth: v.bandwidth,
      codecs: combinedCodecs,
      container: 'fMP4',
      segmentCount: segCount,
      streamStatus,
      audioGroup: primaryAudio ? 'dash-audio' : '',
      subtitleGroup: '',
      estimatedBytes: estBytes,
      isBest,
      label: formatQualityLabel(v.height, isBest),
      dashVideoRepId: v.id,
      dashData: {
        videoInit: v.init,
        videoSegments: v.segments,
        directUrl: v.directUrl
      }
    };
  });

  const audioTracks = audioReps.map((a, idx) => ({
    groupId: 'dash-audio',
    name: a.lang && a.lang !== 'default' ? `Audio (${a.lang})` : `Audio Track ${idx + 1}`,
    language: a.lang || '',
    isDefault: idx === 0,
    uri: `dash-audio://${a.id}`,
    dashAudioData: {
      audioInit: a.init,
      audioSegments: a.segments,
      directUrl: a.directUrl
    }
  }));

  const estimatedAudioBytes = totalDuration > 0 && primaryAudioBandwidth > 0
    ? Math.round((primaryAudioBandwidth / 8) * totalDuration)
    : 0;
  const topSegCount = variants[bestIdx]?.segmentCount || variants[0]?.segmentCount || 0;
  const topFps = variants[bestIdx]?.frameRate || variants[0]?.frameRate || 0;

  return {
    totalDuration,
    primaryAudioBandwidth,
    estimatedAudioBytes,
    segmentCount: topSegCount,
    frameRate: topFps,
    streamStatus,
    container: 'fMP4',
    variants,
    audioTracks
  };
}

// =========================================================================
// Domain-Scoped DNR Rules (Multi-Domain Simultaneous Downloads)
// =========================================================================

function ruleIdForDomain(hostname) {
  let hash = 0;
  const str = String(hostname || '').toLowerCase();
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 9002 + (Math.abs(hash) % 20000);
}

async function applyRefererDnrRule(refererUrl, targetUrls = []) {
  if (!refererUrl || !/^https?:\/\//i.test(refererUrl)) return;
  try {
    const refUrl = new URL(refererUrl);
    const origin = refUrl.origin;

    const domains = new Set();
    for (const raw of targetUrls) {
      if (!raw || typeof raw !== 'string') continue;
      try {
        const host = new URL(raw).hostname;
        if (host) domains.add(host);
      } catch (_) {}
    }

    if (domains.size === 0 && refUrl.hostname) {
      domains.add(refUrl.hostname);
    }

    const removeIds = [LEGACY_DNR_REFERER_RULE_ID];
    const addRules = [];
    for (const domain of domains) {
      const id = ruleIdForDomain(domain);
      removeIds.push(id);
      addRules.push({
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: refererUrl },
            { header: 'Origin', operation: 'set', value: origin }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          requestDomains: [domain],
          resourceTypes: ['xmlhttprequest', 'other', 'media']
        }
      });
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: removeIds,
      addRules
    });
  } catch (_) {}
}

async function corsSafeFetchText(url) {
  let res = await fetch(url, { credentials: 'omit' });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { credentials: 'include' });
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

function markOlderStreamsStale(state, activeKey, nowTs, progressiveOnlySameBatchWindow = false) {
  for (const [k, existing] of state.streams.entries()) {
    if (k === activeKey) continue;
    if (progressiveOnlySameBatchWindow && nowTs - (existing.detectedAt || 0) <= 1500 && existing.kind !== 'hls') {
      continue;
    }
    existing.isStale = true;
  }
}

async function populateMasterDurationsAndSizes(item, parsed) {
  if (!parsed || !parsed.variants || parsed.variants.length === 0) return;
  const targetVariant = parsed.variants.find((v) => v.isBest) || parsed.variants[0];
  let mediaMeta = { totalDuration: 0, segmentCount: 0, isVod: true, streamStatus: 'VOD', container: 'MPEG-TS' };
  try {
    const mediaText = await corsSafeFetchText(targetVariant.url);
    mediaMeta = analyzeHlsMediaPlaylist(mediaText);
  } catch (_) {}

  const totalDuration = mediaMeta.totalDuration;
  const hasAudio = Array.isArray(parsed.audioTracks) && parsed.audioTracks.length > 0;
  const audioBw = hasAudio ? 128000 : 0;

  item.totalDuration = totalDuration;
  item.segmentCount = mediaMeta.segmentCount || 0;
  item.isVod = mediaMeta.isVod;
  item.streamStatus = mediaMeta.streamStatus || 'VOD';
  item.container = mediaMeta.container || 'MPEG-TS';
  item.frameRate = targetVariant.frameRate || (parsed.variants.find((v) => v.frameRate > 0)?.frameRate) || 0;
  item.primaryAudioBandwidth = audioBw || 128000;
  if (totalDuration > 0) {
    item.estimatedAudioBytes = Math.round(((audioBw || 128000) / 8) * totalDuration);
  }
  item.variants = parsed.variants.map((v) => {
    const bw = v.averageBandwidth || v.bandwidth || 0;
    const includeAudio = Boolean(v.audioGroup) || hasAudio;
    const est = totalDuration > 0 && bw > 0
      ? Math.round(((bw + (includeAudio ? audioBw : 0)) / 8) * totalDuration)
      : 0;
    return {
      ...v,
      estimatedBytes: est,
      container: mediaMeta.container || 'MPEG-TS',
      segmentCount: mediaMeta.segmentCount || 0,
      streamStatus: mediaMeta.streamStatus || 'VOD'
    };
  });
}

async function inspectHlsStream(tabId, streamKey, streamUrl, refererUrl) {
  const inspectKey = `${tabId}:${streamKey}`;
  if (inspectingPlaylists.has(inspectKey)) return;
  inspectingPlaylists.add(inspectKey);
  try {
    if (refererUrl) await applyRefererDnrRule(refererUrl, [streamUrl]);
    const text = await corsSafeFetchText(streamUrl);
    const parsed = parseMasterPlaylist(text, streamUrl);
    const state = await loadTabState(tabId);
    const item = state.streams.get(streamKey);
    if (!item) return;

    if (parsed.isMaster) {
      item.isMaster = true;
      item.variants = parsed.variants;
      item.audioTracks = parsed.audioTracks;
      item.subtitleTracks = parsed.subtitleTracks;
      item.inspected = true;
      item.isStale = false;
      item.detectedAt = Date.now();
      item.detectionSeq = ++detectionSeq;

      if (refererUrl) {
        await applyRefererDnrRule(refererUrl, [streamUrl, ...parsed.variants.map((v) => v.url)]);
      }
      await populateMasterDurationsAndSizes(item, parsed);

      markOlderStreamsStale(state, streamKey, item.detectedAt, false);

      for (const childUrl of parsed.childUrls) {
        const cKey = getCanonicalStreamKey(childUrl);
        state.suppressedChildKeys.add(cKey);
        if (cKey !== streamKey) {
          state.streams.delete(cKey);
        }
      }

      const masterGroup = getVideoGroupKey(streamUrl);
      if (masterGroup) state.suppressedHostGroups.add(masterGroup);
      for (const [k, existing] of state.streams.entries()) {
        if (k === streamKey) continue;
        if (existing.kind !== 'hls') {
          const g = getVideoGroupKey(existing.url);
          if ((masterGroup && g === masterGroup) || (item.frameUrl && existing.frameUrl && existing.frameUrl === item.frameUrl)) {
            state.streams.delete(k);
          }
        }
      }
      await persistTabState(tabId);
      broadcastTabUpdate(tabId);
    } else {
      if (state.suppressedChildKeys.has(streamKey)) {
        state.streams.delete(streamKey);
      } else {
        const mediaMeta = analyzeHlsMediaPlaylist(text);
        const totalDuration = mediaMeta.totalDuration;
        item.inspected = true;
        item.isMaster = false;
        item.totalDuration = totalDuration;
        item.segmentCount = mediaMeta.segmentCount || 0;
        item.isVod = mediaMeta.isVod;
        item.streamStatus = mediaMeta.streamStatus;
        item.container = mediaMeta.container;
        item.primaryAudioBandwidth = 128000;
        item.estimatedAudioBytes = totalDuration > 0 ? Math.round((128000 / 8) * totalDuration) : 0;
        const h = inferHeightFromUrl(streamUrl);
        item.variants = [
          {
            url: streamUrl,
            width: 0,
            height: h,
            frameRate: 0,
            bandwidth: 0,
            averageBandwidth: 0,
            codecs: '',
            container: mediaMeta.container,
            segmentCount: mediaMeta.segmentCount || 0,
            streamStatus: mediaMeta.streamStatus,
            audioGroup: '',
            subtitleGroup: '',
            estimatedBytes: 0,
            isBest: true,
            label: formatQualityLabel(h, true)
          }
        ];
      }
      await persistTabState(tabId);
      broadcastTabUpdate(tabId);
    }
  } catch (_) {
  } finally {
    inspectingPlaylists.delete(inspectKey);
  }
}

async function inspectDashStream(tabId, streamKey, streamUrl, refererUrl) {
  const inspectKey = `${tabId}:${streamKey}`;
  if (inspectingPlaylists.has(inspectKey)) return;
  inspectingPlaylists.add(inspectKey);
  try {
    if (refererUrl) await applyRefererDnrRule(refererUrl, [streamUrl]);
    const xmlText = await corsSafeFetchText(streamUrl);
    const parsed = parseMpdManifest(xmlText, streamUrl);
    const state = await loadTabState(tabId);
    const item = state.streams.get(streamKey);
    if (!item) return;

    item.isMaster = parsed.variants.length > 1;
    item.variants = parsed.variants;
    item.audioTracks = parsed.audioTracks;
    item.subtitleTracks = [];
    item.totalDuration = parsed.totalDuration;
    item.primaryAudioBandwidth = parsed.primaryAudioBandwidth;
    item.estimatedAudioBytes = parsed.estimatedAudioBytes;
    item.segmentCount = parsed.segmentCount || 0;
    item.frameRate = parsed.frameRate || 0;
    item.streamStatus = parsed.streamStatus || 'VOD';
    item.container = parsed.container || 'fMP4';
    item.inspected = true;
    item.isStale = false;
    item.detectedAt = Date.now();
    item.detectionSeq = ++detectionSeq;

    markOlderStreamsStale(state, streamKey, item.detectedAt, false);
    await persistTabState(tabId);
    broadcastTabUpdate(tabId);
  } catch (_) {
  } finally {
    inspectingPlaylists.delete(inspectKey);
  }
}

function deriveTitleFromUrl(rawUrl, fallback) {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    const cleaned = decodeURIComponent(last)
      .replace(/\.(m3u8|mp4|mpd|ts)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const validLeaf = cleanCaptionCandidate(cleaned);
    if (validLeaf) return validLeaf;

    if (segs.length >= 2) {
      const parent = decodeURIComponent(segs[segs.length - 2]).replace(/[-_]+/g, ' ').trim();
      const validParent = cleanCaptionCandidate(parent);
      if (validParent) return validParent;
    }
  } catch (_) {}
  return cleanCaptionCandidate(fallback || '');
}

function isSameSiteUrl(urlA, urlB) {
  try {
    const a = new URL(urlA).hostname.toLowerCase();
    const b = new URL(urlB).hostname.toLowerCase();
    if (a === b) return true;
    const partsA = a.split('.');
    const partsB = b.split('.');
    if (partsA.length >= 2 && partsB.length >= 2) {
      return partsA.slice(-2).join('.') === partsB.slice(-2).join('.');
    }
  } catch (_) {}
  return false;
}

async function probeUrlWithRange(url) {
  const tryFetch = async (method, headers = {}) => {
    let res = await fetch(url, { method, headers, credentials: 'omit', redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, { method, headers, credentials: 'include', redirect: 'follow' });
    }
    return res;
  };

  let res = null;
  let contentType = '';
  let sizeBytes = 0;
  let finalUrl = url;

  try {
    res = await tryFetch('HEAD');
    if (res.ok) {
      finalUrl = res.url || url;
      contentType = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      sizeBytes = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    }
  } catch (_) {}

  if (!res || !res.ok || (!contentType && !sizeBytes)) {
    try {
      const rangeRes = await tryFetch('GET', { Range: 'bytes=0-0' });
      if (rangeRes.ok || rangeRes.status === 206) {
        finalUrl = rangeRes.url || finalUrl;
        const ct = (rangeRes.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
        if (ct) contentType = ct;
        const cr = rangeRes.headers.get('content-range') || '';
        const crMatch = cr.match(/\/(\d+)\s*$/);
        const cl = parseInt(rangeRes.headers.get('content-length') || '0', 10) || 0;
        sizeBytes = (crMatch ? parseInt(crMatch[1], 10) : 0) || (rangeRes.status === 200 ? cl : 0) || sizeBytes;
      }
    } catch (_) {}
  }

  return { contentType, sizeBytes, finalUrl };
}

async function handleInspectLinkUrl(tabId, rawInputUrl) {
  const trimmed = String(rawInputUrl || '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (_) {
    throw new Error('Enter a valid http:// or https:// video link.');
  }
  if (!/^https?:$/i.test(parsedUrl.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const effectiveTabId = tabId >= 0 ? tabId : 0;
  const state = await loadTabState(effectiveTabId);
  const referer = state.pageUrl && isSameSiteUrl(state.pageUrl, parsedUrl.href)
    ? state.pageUrl
    : `${parsedUrl.origin}/`;

  await applyRefererDnrRule(referer, [parsedUrl.href]);

  let kind = detectStreamKind(parsedUrl.href, '');
  let probe = { contentType: '', sizeBytes: 0, acceptRanges: '', finalUrl: parsedUrl.href };

  if (!kind || (kind !== 'hls' && kind !== 'dash')) {
    try {
      const tryHead = async () => {
        let r = await fetch(parsedUrl.href, { method: 'HEAD', credentials: 'omit', redirect: 'follow' });
        if (r.status === 401 || r.status === 403) {
          r = await fetch(parsedUrl.href, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
        }
        return r;
      };
      const headRes = await tryHead();
      if (headRes.ok) {
        probe.acceptRanges = headRes.headers.get('accept-ranges') || '';
      }
    } catch (_) {}
    const ranged = await probeUrlWithRange(parsedUrl.href);
    probe = { ...probe, ...ranged };
    const detected = detectStreamKind(probe.finalUrl, probe.contentType, probe.sizeBytes, probe.acceptRanges);
    if (detected) kind = detected;
  }

  if (!kind) {
    throw new Error('Could not recognize a playable video, HLS (.m3u8), or DASH (.mpd) stream at that URL.');
  }

  const targetUrl = probe.finalUrl || parsedUrl.href;
  await applyRefererDnrRule(referer, [targetUrl]);

  const canonicalKey = `pasted:${getCanonicalStreamKey(targetUrl)}`;
  const now = Date.now();
  const titleHint = deriveTitleFromUrl(targetUrl, state.pageTitle);

  const item = {
    id: canonicalKey,
    canonicalKey,
    url: targetUrl,
    kind,
    sizeBytes: probe.sizeBytes || 0,
    height: inferHeightFromUrl(targetUrl),
    isMaster: false,
    inspected: true,
    isStale: false,
    isPasted: true,
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    totalDuration: 0,
    primaryAudioBandwidth: 128000,
    estimatedAudioBytes: 0,
    frameUrl: '',
    referer,
    titleHint,
    detectedAt: now,
    detectionSeq: ++detectionSeq
  };

  if (kind === 'hls') {
    const text = await corsSafeFetchText(targetUrl);
    const parsed = parseMasterPlaylist(text, targetUrl);
    if (parsed.isMaster) {
      item.isMaster = true;
      item.variants = parsed.variants;
      item.audioTracks = parsed.audioTracks;
      item.subtitleTracks = parsed.subtitleTracks;
      await applyRefererDnrRule(referer, [targetUrl, ...parsed.variants.map((v) => v.url)]);
      await populateMasterDurationsAndSizes(item, parsed);
    } else {
      const mediaMeta = analyzeHlsMediaPlaylist(text);
      const totalDuration = mediaMeta.totalDuration;
      item.totalDuration = totalDuration;
      item.segmentCount = mediaMeta.segmentCount || 0;
      item.isVod = mediaMeta.isVod;
      item.streamStatus = mediaMeta.streamStatus;
      item.container = mediaMeta.container;
      item.estimatedAudioBytes = totalDuration > 0 ? Math.round((128000 / 8) * totalDuration) : 0;
      const h = item.height;
      item.variants = [
        {
          url: targetUrl,
          width: 0,
          height: h,
          frameRate: 0,
          bandwidth: 0,
          averageBandwidth: 0,
          codecs: '',
          container: mediaMeta.container,
          segmentCount: mediaMeta.segmentCount || 0,
          streamStatus: mediaMeta.streamStatus,
          audioGroup: '',
          subtitleGroup: '',
          estimatedBytes: 0,
          isBest: true,
          label: formatQualityLabel(h, true)
        }
      ];
    }
  } else if (kind === 'dash') {
    const xmlText = await corsSafeFetchText(targetUrl);
    const parsed = parseMpdManifest(xmlText, targetUrl);
    if (parsed.variants.length === 0) {
      throw new Error('No downloadable video representations found inside MPD manifest.');
    }
    item.isMaster = parsed.variants.length > 1;
    item.variants = parsed.variants;
    item.audioTracks = parsed.audioTracks;
    item.totalDuration = parsed.totalDuration;
    item.primaryAudioBandwidth = parsed.primaryAudioBandwidth;
    item.estimatedAudioBytes = parsed.estimatedAudioBytes;
    item.segmentCount = parsed.segmentCount || 0;
    item.frameRate = parsed.frameRate || 0;
    item.streamStatus = parsed.streamStatus || 'VOD';
    item.container = parsed.container || 'fMP4';
  } else {
    item.container = kind === 'ts' ? 'MPEG-TS' : 'MP4';
    item.streamStatus = 'VOD';
    item.segmentCount = probe.sizeBytes > 0 ? Math.max(1, Math.ceil(probe.sizeBytes / (2 * 1024 * 1024))) : 1;
    item.variants = [
      {
        url: targetUrl,
        width: 0,
        height: item.height || 1080,
        frameRate: 0,
        bandwidth: 0,
        averageBandwidth: 0,
        codecs: '',
        container: item.container,
        segmentCount: item.segmentCount,
        streamStatus: 'VOD',
        audioGroup: '',
        subtitleGroup: '',
        estimatedBytes: probe.sizeBytes || 0,
        isBest: true,
        label: item.height ? formatQualityLabel(item.height, true) : 'Original Quality (★ Best)'
      }
    ];
  }

  markOlderStreamsStale(state, canonicalKey, now, false);
  state.streams.set(canonicalKey, item);
  await persistTabState(effectiveTabId);
  broadcastTabUpdate(effectiveTabId);
  return item;
}

function getRankedStreams(state) {
  if (!state || !state.streams) return [];
  const all = Array.from(state.streams.values()).filter(
    (s) => !state.suppressedChildKeys.has(s.canonicalKey)
  );

  const adaptiveStreams = all.filter((s) => s.kind === 'hls' || s.kind === 'dash');
  const masters = adaptiveStreams.filter((s) => s.isMaster);
  const hasFreshMaster = masters.some((s) => !s.isStale);
  const nonMasterAdaptive = hasFreshMaster
    ? adaptiveStreams.filter((s) => !s.isMaster && s.isPasted && !s.isStale)
    : adaptiveStreams.filter((s) => !s.isMaster && (masters.length === 0 || (!s.isStale && s.inspected)));
  const activeAdaptive = [...masters, ...nonMasterAdaptive];

  const sortedAdaptive = [...activeAdaptive].sort((a, b) => {
    const staleDiff = (a.isStale ? 1 : 0) - (b.isStale ? 1 : 0);
    if (staleDiff !== 0) return staleDiff;
    const tsDiff = (b.detectedAt || 0) - (a.detectedAt || 0);
    if (tsDiff !== 0) return tsDiff;
    return (b.detectionSeq || 0) - (a.detectionSeq || 0);
  });

  const progressiveRaw = all.filter((s) => {
    if (s.kind === 'hls' || s.kind === 'dash') return false;
    if (!s.isPasted && s.sizeBytes > 0 && s.sizeBytes < MIN_PROGRESSIVE_BYTES) return false;
    const g = getVideoGroupKey(s.url);
    if (!s.isPasted && masters.length > 0) {
      if (state.suppressedHostGroups.has(g)) return false;
      if (masters.some((m) => m.frameUrl && s.frameUrl && m.frameUrl === s.frameUrl)) {
        return false;
      }
    }
    return true;
  });

  const freshProg = progressiveRaw.filter((s) => !s.isStale);
  const staleProg = progressiveRaw.filter((s) => s.isStale);

  const dedupeAndSortProg = (list, applyTop3Cap) => {
    const sorted = [...list].sort((a, b) => {
      const pasteDiff = (b.isPasted ? 1 : 0) - (a.isPasted ? 1 : 0);
      if (pasteDiff !== 0) return pasteDiff;
      const hDiff = (b.height || 0) - (a.height || 0);
      if (hDiff !== 0) return hDiff;
      const sDiff = (b.sizeBytes || 0) - (a.sizeBytes || 0);
      if (sDiff !== 0) return sDiff;
      return (b.detectedAt || 0) - (a.detectedAt || 0);
    });
    const seenSizes = new Set();
    const unique = [];
    for (const p of sorted) {
      if (!p.isPasted && p.sizeBytes > 0) {
        if (seenSizes.has(p.sizeBytes)) continue;
        seenSizes.add(p.sizeBytes);
      }
      unique.push(p);
    }
    const top3Labels = ['1080p / Best Quality', '720p / Standard HD', '480p / Data Saver'];
    const capped = applyTop3Cap ? unique.slice(0, 3) : unique;
    return capped.map((p, idx) => ({
      ...p,
      qualityBadge: p.isPasted ? 'Direct Link' : (top3Labels[idx] || top3Labels[2]),
      variants: p.variants && p.variants.length > 0 ? p.variants : [
        {
          url: p.url,
          width: 0,
          height: p.height || (idx === 0 ? 1080 : idx === 1 ? 720 : 480),
          bandwidth: 0,
          estimatedBytes: p.sizeBytes || 0,
          isBest: idx === 0,
          label: top3Labels[idx] || formatQualityLabel(p.height, idx === 0)
        }
      ]
    }));
  };

  const rankedFreshProg = dedupeAndSortProg(freshProg, true);
  const rankedStaleProg = dedupeAndSortProg(staleProg, false).sort(
    (a, b) => (b.detectedAt || 0) - (a.detectedAt || 0)
  );

  const combined = [...sortedAdaptive, ...rankedFreshProg, ...rankedStaleProg];
  combined.sort((a, b) => {
    const staleDiff = (a.isStale ? 1 : 0) - (b.isStale ? 1 : 0);
    if (staleDiff !== 0) return staleDiff;
    const pasteDiff = (b.isPasted ? 1 : 0) - (a.isPasted ? 1 : 0);
    if (pasteDiff !== 0) return pasteDiff;
    const aAdaptive = a.kind === 'hls' || a.kind === 'dash';
    const bAdaptive = b.kind === 'hls' || b.kind === 'dash';
    if (aAdaptive && !bAdaptive) return -1;
    if (bAdaptive && !aAdaptive) return 1;
    const tsDiff = (b.detectedAt || 0) - (a.detectedAt || 0);
    if (tsDiff !== 0) return tsDiff;
    return (b.detectionSeq || 0) - (a.detectionSeq || 0);
  });

  return combined;
}

async function registerDetectedStream(tabId, rawUrl, options = {}) {
  if (tabId < 0 || isNoiseUrl(rawUrl)) return;
  const cleanUrl = rawUrl;

  const state = await loadTabState(tabId);
  const sizeBytes = options.sizeBytes || 0;
  const kind = detectStreamKind(cleanUrl, options.contentType || '', sizeBytes, options.acceptRanges || '');
  if (!kind) return;

  if (kind !== 'hls' && kind !== 'dash' && sizeBytes > 0 && sizeBytes < MIN_PROGRESSIVE_BYTES) {
    return;
  }

  const canonicalKey = getCanonicalStreamKey(cleanUrl);

  if (state.suppressedChildKeys.has(canonicalKey)) {
    return;
  }

  // If .ts arrives while an HLS master already covers that group and size < 10 MB, treat as HLS segment noise
  if (kind === 'ts') {
    const hasHls = Array.from(state.streams.values()).some((s) => s.kind === 'hls');
    if (hasHls && (sizeBytes === 0 || sizeBytes < 10 * 1024 * 1024)) {
      return;
    }
  }

  const duration = normalizeDurationSeconds(options.duration || state.pageDuration || 0);
  if (duration > 0 && (!state.pageDuration || duration > state.pageDuration)) {
    state.pageDuration = duration;
  }

  const now = Date.now();
  const existing = state.streams.get(canonicalKey);
  if (existing) {
    if (sizeBytes > existing.sizeBytes) existing.sizeBytes = sizeBytes;
    if (duration > 0 && !existing.totalDuration) existing.totalDuration = duration;
    if (now - (existing.detectedAt || 0) > 1500) {
      existing.url = cleanUrl;
      existing.detectedAt = now;
      existing.detectionSeq = ++detectionSeq;
      existing.isStale = false;
      markOlderStreamsStale(state, canonicalKey, now, kind !== 'hls' && kind !== 'dash');
      broadcastTabUpdate(tabId);
    }
    if (kind === 'hls' && !existing.inspected) {
      inspectHlsStream(tabId, canonicalKey, cleanUrl, options.referer || state.pageUrl);
    } else if (kind === 'dash' && !existing.inspected) {
      inspectDashStream(tabId, canonicalKey, cleanUrl, options.referer || state.pageUrl);
    }
    await persistTabState(tabId);
    return;
  }

  const height = options.height || inferHeightFromUrl(cleanUrl);
  const item = {
    id: canonicalKey,
    canonicalKey,
    url: cleanUrl,
    kind,
    sizeBytes,
    height,
    isMaster: false,
    inspected: false,
    isStale: false,
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    totalDuration: duration,
    primaryAudioBandwidth: 128000,
    estimatedAudioBytes: duration > 0 ? Math.round((128000 / 8) * duration) : 0,
    frameUrl: options.frameUrl || '',
    referer: options.referer || state.pageUrl || '',
    titleHint: options.titleHint || state.pageTitle || '',
    detectedAt: now,
    detectionSeq: ++detectionSeq
  };

  markOlderStreamsStale(state, canonicalKey, now, kind !== 'hls' && kind !== 'dash');
  state.streams.set(canonicalKey, item);
  await persistTabState(tabId);
  broadcastTabUpdate(tabId);

  if (kind === 'hls') {
    inspectHlsStream(tabId, canonicalKey, cleanUrl, item.referer);
  } else if (kind === 'dash') {
    inspectDashStream(tabId, canonicalKey, cleanUrl, item.referer);
  }
}

function serializeTabResponse(state) {
  const detectedVideos = getRankedStreams(state);
  const hqImages = Array.from(state.images.values());
  return {
    tabId: state.tabId,
    pageTitle: state.pageTitle || '',
    pageUrl: state.pageUrl || '',
    pageDuration: state.pageDuration || 0,
    detectedVideos,
    hqImages,
    streams: detectedVideos,
    images: hqImages
  };
}

function broadcastTabUpdate(tabId) {
  const state = tabStore.get(tabId);
  if (!state) return;
  const payload = serializeTabResponse(state);
  chrome.runtime.sendMessage({
    type: 'MEDIA_UPDATED',
    tabId,
    payload
  }).catch(() => {});
  chrome.runtime.sendMessage({
    type: 'TAB_MEDIA_UPDATED',
    tabId,
    payload
  }).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator && details.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) {
      return;
    }
    if (STREAM_EXT_PATTERN.test(details.url) && !isNoiseUrl(details.url)) {
      registerDetectedStream(details.tabId, details.url, {
        frameUrl: details.documentUrl || details.initiator || ''
      });
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator && details.initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) {
      return;
    }
    if (isNoiseUrl(details.url)) return;

    const contentType = getContentType(details.responseHeaders);
    const acceptRanges = getHeaderValue(details.responseHeaders, 'accept-ranges');
    const sizeBytes = parseContentLength(details.responseHeaders);
    const kind = detectStreamKind(details.url, contentType, sizeBytes, acceptRanges);
    if (!kind) return;

    if (kind !== 'hls' && kind !== 'dash' && sizeBytes > 0 && sizeBytes < MIN_PROGRESSIVE_BYTES) {
      loadTabState(details.tabId).then((state) => {
        const key = getCanonicalStreamKey(details.url);
        if (state.streams.has(key)) {
          state.streams.delete(key);
          persistTabState(details.tabId);
          broadcastTabUpdate(details.tabId);
        }
      });
      return;
    }

    registerDetectedStream(details.tabId, details.url, {
      contentType,
      acceptRanges,
      sizeBytes,
      frameUrl: details.documentUrl || details.initiator || ''
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabStore.delete(tabId);
    chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
    const state = getOrCreateTabState(tabId);
    state.pageUrl = changeInfo.url;
    state.pageTitle = cleanCaptionCandidate(tab.title || '');
    updateBadge(tabId);
  } else if (changeInfo.title) {
    loadTabState(tabId).then((state) => {
      if (!state.pageTitle) {
        const cleanTitle = cleanCaptionCandidate(changeInfo.title);
        if (cleanTitle) {
          state.pageTitle = cleanTitle;
          persistTabState(tabId);
        }
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStore.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
});

let creatingOffscreen = null;
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '32-worker HLS/MP4/DASH fetching, mux.js dual-track remuxing, and Blob URL creation'
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function saveBannerAndHistory(filename) {
  const savedBanner = {
    filename,
    timestamp: Date.now()
  };
  const data = await chrome.storage.local.get(['ums_recent_saved']);
  const recent = Array.isArray(data.ums_recent_saved) ? data.ums_recent_saved : [];
  const nextRecent = [{ filename, timestamp: Date.now() }, ...recent.filter((r) => r.filename !== filename)].slice(0, 5);
  await chrome.storage.local.set({
    ums_saved_banner: savedBanner,
    ums_recent_saved: nextRecent
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await ensureJobsHydrated();
  const entry = pendingBlobDownloads.get(delta.id);
  if (!entry) return;

  const state = delta.state && delta.state.current;
  if (state === 'complete') {
    pendingBlobDownloads.delete(delta.id);
    if (entry.blobUrl) {
      chrome.runtime.sendMessage({
        type: 'REVOKE_BLOB_URL',
        blobUrl: entry.blobUrl
      }).catch(() => {});
    }

    await saveBannerAndHistory(entry.filename);
    const existing = jobsMap.get(entry.jobId);
    if (existing) {
      const updated = {
        ...existing,
        status: 'completed',
        progress: 100,
        etaSeconds: 0,
        isPaused: false,
        offlinePaused: false,
        savedFilename: entry.filename
      };
      jobsMap.set(entry.jobId, updated);
      await persistJobsState();
      broadcastJobsProgress(updated);
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_JOB_DONE', jobId: entry.jobId }).catch(() => {});
    }

    chrome.notifications.create(`ums_saved_${delta.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Private Course & Stream Saver — CodeByAzim',
      message: `Saved: ${entry.filename}`
    });
  } else if (state === 'interrupted') {
    pendingBlobDownloads.delete(delta.id);
    if (entry.blobUrl) {
      chrome.runtime.sendMessage({
        type: 'REVOKE_BLOB_URL',
        blobUrl: entry.blobUrl
      }).catch(() => {});
    }

    const existing = jobsMap.get(entry.jobId);
    if (existing) {
      const updated = {
        ...existing,
        status: 'error',
        error: delta.error && delta.error.current ? `Download interrupted: ${delta.error.current}` : 'Download interrupted'
      };
      jobsMap.set(entry.jobId, updated);
      await persistJobsState();
      broadcastJobsProgress(updated);
    }
  }
});

function findDuplicateActiveJob(videoUrl, filename) {
  for (const job of jobsMap.values()) {
    const active = job.status === 'downloading' || job.status === 'saving' || job.status === 'fetching' || job.status === 'remuxing';
    if (!active) continue;
    const jobUrl = job.videoUrl || job.streamUrl || '';
    if (videoUrl && filename && jobUrl === videoUrl && job.filename === filename) {
      return job;
    }
  }
  return null;
}

async function handleStartDownload(job) {
  await ensureJobsHydrated();
  const exactVideoUrl = job.videoUrl || job.directUrl || job.videoPlaylistUrl || job.streamUrl || '';
  const exactFilename = job.filename || '';
  const duplicate = findDuplicateActiveJob(exactVideoUrl, exactFilename);
  if (duplicate) {
    return { duplicate: true, message: 'Already downloading this stream', existingJob: duplicate };
  }

  const saveSettings = await getSaveSettings();
  const target = resolveDownloadDestination(job.filename, saveSettings, false);
  const enrichedJob = {
    ...job,
    videoUrl: exactVideoUrl,
    streamSignature: `${exactVideoUrl}::${exactFilename}`,
    saveMode: saveSettings.saveMode,
    subfolder: saveSettings.subfolder,
    resolvedFilename: target.filename,
    saveAs: target.saveAs
  };

  await chrome.storage.local.remove('ums_saved_banner');

  const dnrUrls = [
    enrichedJob.directUrl,
    enrichedJob.audioDirectUrl,
    enrichedJob.videoPlaylistUrl,
    enrichedJob.audioPlaylistUrl,
    enrichedJob.streamUrl
  ].filter(Boolean);
  if (enrichedJob.dashData && enrichedJob.dashData.videoInit && enrichedJob.dashData.videoInit.url) {
    dnrUrls.push(enrichedJob.dashData.videoInit.url);
  }
  if (enrichedJob.referer) {
    await applyRefererDnrRule(enrichedJob.referer, dnrUrls);
  }

  await ensureOffscreenDocument();
  const jobRecord = {
    jobId: enrichedJob.jobId,
    status: 'downloading',
    filename: enrichedJob.filename,
    resolvedFilename: enrichedJob.resolvedFilename,
    videoUrl: exactVideoUrl,
    streamUrl: enrichedJob.streamUrl || exactVideoUrl,
    qualityKey: enrichedJob.qualityKey || '',
    streamSignature: enrichedJob.streamSignature,
    progress: 0,
    speedMBps: 0,
    downloadedBytes: 0,
    totalBytes: Number(enrichedJob.knownTotalBytes || 0),
    knownTotalBytes: Number(enrichedJob.knownTotalBytes || 0),
    etaSeconds: 0,
    isPaused: false,
    offlinePaused: false,
    error: null,
    startedAt: Date.now()
  };

  jobsMap.set(enrichedJob.jobId, jobRecord);
  jobPayloads.set(enrichedJob.jobId, enrichedJob);
  await persistJobsState();
  broadcastJobsProgress(jobRecord);

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_JOB', job: enrichedJob }).catch(() => {});
  return { duplicate: false, job: jobRecord };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  (async () => {
    try {
      await ensureJobsHydrated();

      if (msg.type === 'CONTENT_PAGE_INFO') {
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        if (tabId >= 0) {
          const state = await loadTabState(tabId);
          const isTopFrame = !sender.tab ? true : sender.frameId === 0;
          if (isTopFrame) {
            if (msg.pageUrl) state.pageUrl = msg.pageUrl;
            if (typeof msg.pageTitle === 'string') {
              state.pageTitle = cleanCaptionCandidate(msg.pageTitle);
            }
            const validDur = normalizeDurationSeconds(msg.duration);
            if (validDur > 0) {
              state.pageDuration = validDur;
            }
          }
          await persistTabState(tabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'PAGE_CAPTION_UPDATED') {
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const isTopFrame = !sender.tab ? true : sender.frameId === 0;
        if (tabId >= 0 && isTopFrame) {
          const cleanCap = cleanCaptionCandidate(msg.caption || '');
          const state = await loadTabState(tabId);
          state.pageTitle = cleanCap;
          if (msg.pageUrl) state.pageUrl = msg.pageUrl;
          const ranked = getRankedStreams(state);
          if (ranked[0] && !ranked[0].isPasted) {
            const topItem = state.streams.get(ranked[0].canonicalKey);
            if (topItem) topItem.titleHint = cleanCap;
          }
          await persistTabState(tabId);
          chrome.runtime.sendMessage({
            type: 'PAGE_CAPTION_UPDATED',
            tabId,
            caption: state.pageTitle,
            pageUrl: state.pageUrl
          }).catch(() => {});
          broadcastTabUpdate(tabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'PAGE_DURATION_UPDATED') {
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        const dur = normalizeDurationSeconds(msg.duration || 0);
        if (tabId >= 0 && dur > 0) {
          const state = await loadTabState(tabId);
          state.pageDuration = dur;
          let changed = false;
          for (const item of state.streams.values()) {
            if (!item.totalDuration || item.totalDuration <= 0) {
              item.totalDuration = dur;
              if (!item.estimatedAudioBytes) {
                item.estimatedAudioBytes = Math.round(((item.primaryAudioBandwidth || 128000) / 8) * dur);
              }
              changed = true;
            }
          }
          await persistTabState(tabId);
          if (changed) broadcastTabUpdate(tabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'PAGE_MEDIA_DETECTED' || msg.type === 'CONTENT_MEDIA_FOUND') {
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        if (tabId >= 0) {
          const state = await loadTabState(tabId);
          const isTopFrame = !sender.tab ? true : sender.frameId === 0;
          if (isTopFrame && typeof msg.pageTitle === 'string') {
            const cleanTop = cleanCaptionCandidate(msg.pageTitle);
            if (cleanTop) state.pageTitle = cleanTop;
          }
          const validMsgDur = normalizeDurationSeconds(msg.duration);
          if (validMsgDur > 0) {
            state.pageDuration = validMsgDur;
          }
          const frameUrl = (sender && sender.url) || msg.frameUrl || '';
          if (Array.isArray(msg.streams)) {
            for (const s of msg.streams) {
              await registerDetectedStream(tabId, s.url, {
                frameUrl,
                referer: msg.pageUrl || frameUrl,
                contentType: s.contentType || '',
                sizeBytes: s.sizeBytes || 0,
                height: s.height || 0,
                duration: normalizeDurationSeconds(s.duration) || validMsgDur || state.pageDuration || 0,
                titleHint: isTopFrame ? (cleanCaptionCandidate(msg.pageTitle) || state.pageTitle) : state.pageTitle
              });
            }
          }
          let imagesAdded = false;
          if (Array.isArray(msg.images)) {
            for (const img of msg.images) {
              const key = img.url.split('#')[0];
              if (!state.images.has(key)) {
                state.images.set(key, img);
                imagesAdded = true;
              }
            }
          }
          if (imagesAdded) {
            await persistTabState(tabId);
            broadcastTabUpdate(tabId);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'CONTENT_IMAGES_FOUND') {
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        if (tabId >= 0 && Array.isArray(msg.images)) {
          const state = await loadTabState(tabId);
          for (const img of msg.images) {
            const key = img.url.split('#')[0];
            if (!state.images.has(key)) {
              state.images.set(key, img);
            }
          }
          await persistTabState(tabId);
          broadcastTabUpdate(tabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'INSPECT_LINK_URL') {
        const stream = await handleInspectLinkUrl(msg.tabId, msg.url);
        sendResponse({ ok: true, stream });
        return;
      }

      if (msg.type === 'GET_TAB_MEDIA') {
        const tabId = msg.tabId;
        if (tabId >= 0) {
          chrome.tabs.sendMessage(tabId, { type: 'RESCAN_DOM_MEDIA' }).catch(() => {});
        }
        const state = await loadTabState(tabId);
        if (!state.pageTitle || !state.pageUrl) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab) {
              if (!state.pageUrl && tab.url) state.pageUrl = tab.url;
              if (!state.pageTitle && tab.title) {
                state.pageTitle = cleanCaptionCandidate(tab.title);
              }
            }
          } catch (_) {}
        }
        const [saveSettings, local] = await Promise.all([
          getSaveSettings(),
          chrome.storage.local.get(['ums_saved_banner', 'ums_recent_saved'])
        ]);
        const jobs = getSerializedJobs();
        sendResponse({
          ok: true,
          media: serializeTabResponse(state),
          saveSettings,
          askLocation: saveSettings.saveMode === 'ask',
          activeJob: jobs[0] || null,
          jobs,
          savedBanner: local.ums_saved_banner || null,
          recentSaved: Array.isArray(local.ums_recent_saved) ? local.ums_recent_saved : []
        });
        return;
      }

      if (msg.type === 'GET_ACTIVE_JOBS') {
        sendResponse({ ok: true, jobs: getSerializedJobs() });
        return;
      }

      if (msg.type === 'GET_DASHBOARD_INIT') {
        const allTabs = await chrome.tabs.query({});
        const mediaTabs = [];
        for (const t of allTabs) {
          if (!t.id || t.id < 0) continue;
          if (!t.url || t.url.startsWith(`chrome-extension://${chrome.runtime.id}`) || t.url.startsWith('chrome://')) {
            continue;
          }
          const st = await loadTabState(t.id);
          const streams = getRankedStreams(st);
          mediaTabs.push({
            tabId: t.id,
            title: st.pageTitle || t.title || 'Untitled Tab',
            url: st.pageUrl || t.url || '',
            videoCount: streams.length,
            imageCount: st.images.size,
            active: Boolean(t.active)
          });
        }
        mediaTabs.sort((a, b) => (b.videoCount - a.videoCount) || (b.imageCount - a.imageCount) || ((b.active ? 1 : 0) - (a.active ? 1 : 0)));

        let targetTabId = typeof msg.tabId === 'number' && msg.tabId >= 0 ? msg.tabId : -1;
        if (targetTabId < 0 && mediaTabs.length > 0) {
          targetTabId = mediaTabs[0].tabId;
        }
        const targetState = targetTabId >= 0 ? await loadTabState(targetTabId) : null;
        const [saveSettings, local] = await Promise.all([
          getSaveSettings(),
          chrome.storage.local.get(['ums_saved_banner', 'ums_recent_saved'])
        ]);
        const jobs = getSerializedJobs();
        sendResponse({
          ok: true,
          tabId: targetTabId,
          mediaTabs,
          media: targetState ? serializeTabResponse(targetState) : { pageTitle: '', pageUrl: '', detectedVideos: [], hqImages: [], streams: [], images: [] },
          saveSettings,
          askLocation: saveSettings.saveMode === 'ask',
          jobs,
          savedBanner: local.ums_saved_banner || null,
          recentSaved: Array.isArray(local.ums_recent_saved) ? local.ums_recent_saved : []
        });
        return;
      }

      if (msg.type === 'REFRESH_TAB_SCAN') {
        const tabId = msg.tabId;
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'RESCAN_DOM_MEDIA' });
        } catch (_) {}
        const state = await loadTabState(tabId);
        sendResponse({ ok: true, media: serializeTabResponse(state) });
        return;
      }

      if (msg.type === 'CLEAR_TAB_MEDIA') {
        const tabId = msg.tabId;
        tabStore.delete(tabId);
        await chrome.storage.session.remove(`tab_${tabId}`);
        const fresh = getOrCreateTabState(tabId);
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab) {
            fresh.pageUrl = tab.url || '';
            fresh.pageTitle = cleanCaptionCandidate(tab.title || '');
          }
        } catch (_) {}
        await persistTabState(tabId);
        sendResponse({ ok: true, media: serializeTabResponse(fresh) });
        return;
      }

      if (msg.type === 'START_DOWNLOAD') {
        const result = await handleStartDownload(msg.job);
        if (result.duplicate) {
          sendResponse({ ok: false, duplicate: true, error: result.message, existingJob: result.existingJob });
        } else {
          sendResponse({ ok: true, job: result.job, jobs: getSerializedJobs() });
        }
        return;
      }

      if (msg.type === 'PAUSE_DOWNLOAD' || msg.type === 'RESUME_DOWNLOAD' || msg.type === 'CANCEL_DOWNLOAD') {
        await ensureOffscreenDocument();
        const targetId = msg.jobId;
        const payload = targetId ? jobPayloads.get(targetId) || null : null;
        if (msg.type === 'PAUSE_DOWNLOAD' && targetId && jobsMap.has(targetId)) {
          const cur = jobsMap.get(targetId);
          jobsMap.set(targetId, { ...cur, isPaused: true, status: 'paused' });
          await persistJobsState();
          broadcastJobsProgress(jobsMap.get(targetId));
        } else if (msg.type === 'RESUME_DOWNLOAD' && targetId && jobsMap.has(targetId)) {
          const cur = jobsMap.get(targetId);
          jobsMap.set(targetId, { ...cur, isPaused: false, offlinePaused: false, status: 'downloading', error: null });
          await persistJobsState();
          broadcastJobsProgress(jobsMap.get(targetId));
        } else if (msg.type === 'CANCEL_DOWNLOAD' && targetId) {
          jobsMap.delete(targetId);
          jobPayloads.delete(targetId);
          await persistJobsState();
          broadcastJobsProgress();
        }
        chrome.runtime.sendMessage({
          type: `OFFSCREEN_${msg.type}`,
          jobId: targetId,
          job: payload
        }).catch(() => {});
        sendResponse({ ok: true, jobs: getSerializedJobs() });
        return;
      }

      if (msg.type === 'PAUSE_ALL_DOWNLOADS') {
        await ensureOffscreenDocument();
        for (const [id, j] of jobsMap.entries()) {
          if (j.status === 'downloading') {
            jobsMap.set(id, { ...j, isPaused: true, status: 'paused' });
          }
        }
        await persistJobsState();
        broadcastJobsProgress();
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE_ALL' }).catch(() => {});
        sendResponse({ ok: true, jobs: getSerializedJobs() });
        return;
      }

      if (msg.type === 'RESUME_ALL_DOWNLOADS') {
        await ensureOffscreenDocument();
        const payloads = [];
        for (const [id, j] of jobsMap.entries()) {
          if (j.status === 'paused' || j.status === 'error') {
            jobsMap.set(id, { ...j, isPaused: false, offlinePaused: false, status: 'downloading', error: null });
            const p = jobPayloads.get(id);
            if (p) payloads.push(p);
          }
        }
        await persistJobsState();
        broadcastJobsProgress();
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESUME_ALL', jobs: payloads }).catch(() => {});
        sendResponse({ ok: true, jobs: getSerializedJobs() });
        return;
      }

      if (msg.type === 'CLEAR_DONE_DOWNLOADS') {
        for (const [id, j] of jobsMap.entries()) {
          if (j.status === 'completed' || j.status === 'error' || j.status === 'cancelled') {
            jobsMap.delete(id);
            jobPayloads.delete(id);
          }
        }
        await persistJobsState();
        broadcastJobsProgress();
        sendResponse({ ok: true, jobs: getSerializedJobs() });
        return;
      }

      if (msg.type === 'OFFSCREEN_PROGRESS') {
        const incoming = msg.job;
        if (incoming && incoming.jobId) {
          const prev = jobsMap.get(incoming.jobId) || {};
          const merged = {
            ...prev,
            ...incoming,
            startedAt: prev.startedAt || Date.now()
          };
          jobsMap.set(incoming.jobId, merged);
          await persistJobsState();
          broadcastJobsProgress(merged);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'OFFSCREEN_HEARTBEAT') {
        sendResponse({ ok: true, ts: Date.now() });
        return;
      }

      if (msg.type === 'SAVE_BLOB_URL') {
        const { blobUrl, filename, jobId, sizeBytes } = msg;
        if (typeof sizeBytes === 'number' && sizeBytes < 10240) {
          sendResponse({ ok: false, error: 'Error: Stream blocked or empty (< 10 KB) — refresh the page and try again.' });
          return;
        }
        const saveSettings = await getSaveSettings();
        const target = resolveDownloadDestination(filename, saveSettings, false);

        const downloadId = await chrome.downloads.download({
          url: blobUrl,
          filename: target.filename,
          saveAs: target.saveAs,
          conflictAction: 'uniquify'
        });

        pendingBlobDownloads.set(downloadId, {
          blobUrl,
          filename: target.filename,
          jobId
        });
        sendResponse({ ok: true, downloadId });
        return;
      }

      if (msg.type === 'DOWNLOAD_DIRECT_MEDIA') {
        const { url, filename, isBatch } = msg;
        const saveSettings = await getSaveSettings();
        const target = resolveDownloadDestination(
          filename || 'HQ_Image [CodeByAzim].jpg',
          saveSettings,
          Boolean(isBatch)
        );
        const downloadId = await chrome.downloads.download({
          url,
          filename: target.filename,
          saveAs: target.saveAs,
          conflictAction: 'uniquify'
        });
        pendingBlobDownloads.set(downloadId, {
          blobUrl: null,
          filename: target.filename,
          jobId: `direct_${downloadId}`
        });
        sendResponse({ ok: true, downloadId });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();

  return true;
});
