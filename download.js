'use strict';

/**
 * Private Course & Stream Saver — CodeByAzimDev
 * Dedicated Full-Page Download & Stream Diagnostics Dashboard (download.js)
 */

(() => {
  const CAPTION_PLACEHOLDER = 'Paste video caption here';
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
    'paste video caption here'
  ]);
  const CHAPTER_COUNTER_RE = /\b\d+\s*(Lessons?|Chapters?|Modules?|Videos?|hr|min)\b/i;
  const CHAPTER_DURATION_RE = /\b\d+\s*hr\s*\d+\s*min\b/i;
  const RANDOM_HASH_RE = /^[a-zA-Z0-9_-]{14,}$/;
  const SITE_TITLE_SUFFIX_RE = /\s*[-–—|·•]\s*(Lead Academy|Udemy|Vimeo|Coursera|Teachable|Thinkific|Kajabi|Podia|Skillshare|Pluralsight|Udacity|MasterClass|edX|Khan Academy|Hotmart|LearnDash|LifterLMS|Tutor LMS|MemberPress|Mighty Networks|Wistia|Bunny|JWPlayer)[^|\-–—]*$/i;

  let currentTabId = -1;
  let mediaTabs = [];
  let activeView = 'videos';
  let locationDrawerOpen = false;
  let saveSettings = { saveMode: 'default', subfolder: '' };
  let mediaState = { pageTitle: '', pageUrl: '', pageDuration: 0, detectedVideos: [], hqImages: [], streams: [], images: [] };
  let jobsList = [];
  let recentSaved = [];

  let selectedStreamId = null;
  let selectedQualityValue = null;
  let activeCaptionValue = '';
  let userEditedCaption = false;
  let simTimer = null;

  const el = {
    workerPoolText: document.getElementById('workerPoolText'),
    tabSelector: document.getElementById('tabSelector'),
    btnToggleLocation: document.getElementById('btnToggleLocation'),
    saveLocationDrawer: document.getElementById('saveLocationDrawer'),
    btnModeDefault: document.getElementById('btnModeDefault'),
    btnModeAsk: document.getElementById('btnModeAsk'),
    subfolderInput: document.getElementById('subfolderInput'),
    btnSetSubfolder: document.getElementById('btnSetSubfolder'),
    locationModeSummary: document.getElementById('locationModeSummary'),
    btnChangeDrive: document.getElementById('btnChangeDrive'),
    btnRefresh: document.getElementById('btnRefresh'),
    btnClear: document.getElementById('btnClear'),
    offlineBanner: document.getElementById('offlineBanner'),
    errorBanner: document.getElementById('errorBanner'),
    errorBannerText: document.getElementById('errorBannerText'),
    dismissErrorBanner: document.getElementById('dismissErrorBanner'),
    savedBanner: document.getElementById('savedBanner'),
    savedBannerText: document.getElementById('savedBannerText'),
    dismissSavedBanner: document.getElementById('dismissSavedBanner'),
    pasteLinkInput: document.getElementById('pasteLinkInput'),
    btnPasteLink: document.getElementById('btnPasteLink'),
    btnLoadLink: document.getElementById('btnLoadLink'),
    pasteLinkStatus: document.getElementById('pasteLinkStatus'),
    btnSwitchVideos: document.getElementById('btnSwitchVideos'),
    btnSwitchPictures: document.getElementById('btnSwitchPictures'),
    videosDiagnosticsBody: document.getElementById('videosDiagnosticsBody'),
    picturesBody: document.getElementById('picturesBody'),
    downloadsHeading: document.getElementById('downloadsHeading'),
    downloadsBulk: document.getElementById('downloadsBulk'),
    btnPauseAll: document.getElementById('btnPauseAll'),
    btnResumeAll: document.getElementById('btnResumeAll'),
    btnClearDone: document.getElementById('btnClearDone'),
    downloadsList: document.getElementById('downloadsList'),
    recentSection: document.getElementById('recentSection'),
    recentHeading: document.getElementById('recentHeading'),
    recentList: document.getElementById('recentList')
  };

  function hasChromeExtensionApi() {
    return typeof chrome !== 'undefined' && chrome.runtime && chrome.tabs && chrome.storage;
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

  function cleanCaptionCandidate(raw) {
    let text = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\(\d+\)\s+/, '')
      .replace(SITE_TITLE_SUFFIX_RE, '')
      .trim();
    if (isGarbageCaption(text)) return '';
    text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (isGarbageCaption(text)) return '';
    if (text.length > 110) text = text.slice(0, 110).trim();
    return text;
  }

  function resolveStreamCaption(stream, pageTitle) {
    const primary = stream && stream.isPasted
      ? (cleanCaptionCandidate(stream.titleHint) || cleanCaptionCandidate(pageTitle))
      : (cleanCaptionCandidate(pageTitle) || cleanCaptionCandidate(stream && stream.titleHint));
    return primary || CAPTION_PLACEHOLDER;
  }

  function sanitizeCaption(raw) {
    let text = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\(\d+\)\s+/, '')
      .trim();
    if (!text || text.toLowerCase() === CAPTION_PLACEHOLDER.toLowerCase()) {
      return CAPTION_PLACEHOLDER;
    }
    text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return CAPTION_PLACEHOLDER;
    if (text.length > 110) text = text.slice(0, 110).trim();
    return text;
  }

  function sanitizeSubfolder(raw) {
    let folder = String(raw || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/^\.+|\.+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (folder.length > 64) folder = folder.slice(0, 64).trim();
    return folder;
  }

  function normalizeDurationSeconds(raw) {
    let d = Number(raw);
    if (!Number.isFinite(d) || d <= 0) return 0;
    if (d > 86400) {
      if (d <= 86400000) d = d / 1000;
      else return 0;
    }
    return d > 0 && d <= 86400 ? d : 0;
  }

  function formatDurationDisplay(seconds) {
    const total = Math.round(normalizeDurationSeconds(seconds));
    if (total <= 0) return '';
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const totalMins = Math.max(1, Math.round(total / 60));
    const clock = hrs > 0
      ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `⏱ ${clock} (${totalMins} min)`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  }

  function formatApproxMb(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `~${(mb / 1024).toFixed(2)} GB`;
    return `~${mb.toFixed(1)} MB`;
  }

  function formatEta(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatBitrateMbps(bps) {
    if (!bps || bps <= 0) return 'Auto';
    if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`;
    return `${Math.round(bps / 1000)} kbps`;
  }

  function formatHumanCodecs(rawCodecs) {
    const raw = String(rawCodecs || '').trim();
    if (!raw) return 'H.264 · AAC';
    const parts = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const labels = [];
    for (const p of parts) {
      if (p.startsWith('avc') || p.includes('h264')) labels.push('H.264');
      else if (p.startsWith('hev') || p.startsWith('hvc') || p.includes('hevc')) labels.push('H.265 / HEVC');
      else if (p.startsWith('vp09') || p.startsWith('vp9')) labels.push('VP9');
      else if (p.startsWith('vp08') || p.startsWith('vp8')) labels.push('VP8');
      else if (p.startsWith('av01')) labels.push('AV1');
      else if (p.startsWith('mp4a')) labels.push('AAC');
      else if (p.startsWith('opus')) labels.push('Opus');
      else if (p.startsWith('ac-3') || p.startsWith('ec-3')) labels.push('Dolby AC-3');
    }
    const unique = Array.from(new Set(labels));
    return unique.length > 0 ? unique.join(' · ') : raw;
  }

  function resolveStreamOutputExt(stream) {
    const k = stream && stream.kind ? String(stream.kind).toLowerCase() : 'mp4';
    if (k === 'ts') {
      return 'ts';
    }
    return 'mp4';
  }

  function formatOutputFilename(caption, outputFormat) {
    const cleanCaption = sanitizeCaption(caption);
    const allowed = new Set(['mp3', 'mp4', 'ts']);
    const fmt = String(outputFormat || 'mp4').toLowerCase();
    const ext = allowed.has(fmt) ? fmt : 'mp4';
    return `${cleanCaption} [CodeByAzimDev].${ext}`;
  }

  function formatQualityBaseLabel(height) {
    if (height >= 4320) return '4320p';
    if (height >= 2160) return '2160p';
    if (height >= 1440) return '1440p';
    if (height >= 1080) return '1080p';
    if (height > 0) return `${height}p`;
    return 'Original';
  }

  function getDetectedVideos() {
    return Array.isArray(mediaState.detectedVideos)
      ? mediaState.detectedVideos
      : (Array.isArray(mediaState.streams) ? mediaState.streams : []);
  }

  function getDetectedImages() {
    return Array.isArray(mediaState.hqImages)
      ? mediaState.hqImages
      : (Array.isArray(mediaState.images) ? mediaState.images : []);
  }

  function buildQualityOptionsForStream(stream) {
    const outExt = resolveStreamOutputExt(stream);
    const duration = normalizeDurationSeconds(stream.totalDuration) || normalizeDurationSeconds(mediaState.pageDuration);
    const audioTracks = Array.isArray(stream.audioTracks) ? stream.audioTracks : [];
    const audioBw = audioTracks.length > 0 ? (stream.primaryAudioBandwidth || 128000) : 0;

    const rawVariants = Array.isArray(stream.variants) && stream.variants.length > 0
      ? [...stream.variants]
      : [{
          url: stream.url,
          width: stream.width || 0,
          height: stream.height || 0,
          frameRate: stream.frameRate || 0,
          bandwidth: stream.bandwidth || 0,
          averageBandwidth: stream.bandwidth || 0,
          codecs: stream.codecs || '',
          container: stream.container || '',
          segmentCount: stream.segmentCount || 0,
          streamStatus: stream.streamStatus || 'VOD',
          audioGroup: '',
          subtitleGroup: '',
          estimatedBytes: stream.sizeBytes || 0,
          isBest: true
        }];

    const byHeight = new Map();
    for (const v of rawVariants) {
      const h = v.height || 0;
      const list = byHeight.get(h) || [];
      list.push(v);
      byHeight.set(h, list);
    }

    const heights = Array.from(byHeight.keys()).sort((a, b) => b - a);
    let bestTargetHeight = 0;
    if (heights.includes(1080)) bestTargetHeight = 1080;
    else if (heights.includes(720)) bestTargetHeight = 720;
    else if (heights.length > 0) bestTargetHeight = heights[0];

    const options = [];
    for (const h of heights) {
      const group = (byHeight.get(h) || []).sort(
        (a, b) => (b.averageBandwidth || b.bandwidth || 0) - (a.averageBandwidth || a.bandwidth || 0)
      );
      const highest = group[0];
      const lowest = group[group.length - 1];
      const highBw = highest.averageBandwidth || highest.bandwidth || 0;
      const lowBw = lowest.averageBandwidth || lowest.bandwidth || 0;

      const highEst = highest.estimatedBytes && highest.estimatedBytes > 0
        ? highest.estimatedBytes
        : (duration > 0 && highBw > 0
            ? Math.round(((highBw + (highest.audioGroup || audioTracks.length > 0 ? audioBw : 0)) / 8) * duration)
            : (stream.kind !== 'hls' && stream.kind !== 'dash' ? (stream.sizeBytes || 0) : 0));

      const isBest = h === bestTargetHeight;
      options.push({
        value: String(options.length),
        shortRes: formatQualityBaseLabel(h),
        width: highest.width || (h > 0 ? Math.round((h * 16) / 9) : 0),
        height: h,
        frameRate: highest.frameRate || stream.frameRate || 0,
        bandwidth: highBw,
        codecs: highest.codecs || stream.codecs || '',
        container: highest.container || stream.container || '',
        segmentCount: highest.segmentCount || stream.segmentCount || 0,
        streamStatus: highest.streamStatus || stream.streamStatus || 'VOD',
        url: highest.url,
        estimatedBytes: highEst,
        isBest,
        isDataSaver: false,
        outputFormat: outExt,
        audioDirectUrl: highest.audioDirectUrl || '',
        dashVideoRepId: highest.dashVideoRepId,
        dashData: highest.dashData || null
      });

      if (
        group.length > 1 &&
        lowest.url !== highest.url &&
        highBw > 0 &&
        lowBw > 0 &&
        lowBw <= highBw * 0.85
      ) {
        const lowEst = lowest.estimatedBytes && lowest.estimatedBytes > 0
          ? lowest.estimatedBytes
          : (duration > 0 ? Math.round(((lowBw + (lowest.audioGroup || audioTracks.length > 0 ? audioBw : 0)) / 8) * duration) : 0);
        options.push({
          value: String(options.length),
          shortRes: formatQualityBaseLabel(h),
          width: lowest.width || (h > 0 ? Math.round((h * 16) / 9) : 0),
          height: h,
          frameRate: lowest.frameRate || stream.frameRate || 0,
          bandwidth: lowBw,
          codecs: lowest.codecs || stream.codecs || '',
          container: lowest.container || stream.container || '',
          segmentCount: lowest.segmentCount || stream.segmentCount || 0,
          streamStatus: lowest.streamStatus || stream.streamStatus || 'VOD',
          url: lowest.url,
          estimatedBytes: lowEst,
          isBest: false,
          isDataSaver: true,
          outputFormat: outExt,
          audioDirectUrl: lowest.audioDirectUrl || '',
          dashVideoRepId: lowest.dashVideoRepId,
          dashData: lowest.dashData || null
        });
      }
    }

    const audioEst = stream.estimatedAudioBytes && stream.estimatedAudioBytes > 0
      ? stream.estimatedAudioBytes
      : (duration > 0 ? Math.round(((stream.primaryAudioBandwidth || 128000) / 8) * duration) : 0);

    options.push({
      value: 'mp3',
      shortRes: 'MP3 Audio',
      width: 0,
      height: 0,
      frameRate: 0,
      bandwidth: stream.primaryAudioBandwidth || 128000,
      codecs: 'mp4a.40.2',
      container: 'MP3 Audio',
      segmentCount: stream.segmentCount || 0,
      streamStatus: stream.streamStatus || 'VOD',
      url: options[0] ? options[0].url : stream.url,
      estimatedBytes: audioEst,
      isBest: false,
      isDataSaver: false,
      outputFormat: 'mp3',
      audioDirectUrl: (audioTracks[0] && audioTracks[0].uri) || (options[0] && options[0].audioDirectUrl) || '',
      dashVideoRepId: options[0] ? options[0].dashVideoRepId : undefined,
      dashData: options[0] ? options[0].dashData : null
    });

    return options;
  }

  function findClientDuplicateJob(videoUrl, filename) {
    return jobsList.find((j) => {
      const active = j.status === 'downloading' || j.status === 'saving' || j.status === 'fetching' || j.status === 'remuxing';
      if (!active) return false;
      const jobUrl = j.videoUrl || j.streamUrl || '';
      return Boolean(videoUrl && filename && jobUrl === videoUrl && j.filename === filename);
    }) || null;
  }

  function updateWorkerPoolBadge() {
    const fetchingCount = jobsList.filter((j) => j && j.status === 'downloading').length;
    if (fetchingCount === 0) {
      el.workerPoolText.textContent = '32-Worker Pool Ready';
      return;
    }
    const perJob = Math.max(4, Math.floor(32 / fetchingCount));
    el.workerPoolText.textContent = `${fetchingCount} Active · ${perJob} Workers/Job (32 Cap)`;
  }

  function updateSaveLocationUi() {
    const { saveMode, subfolder } = saveSettings;
    if (saveMode === 'ask') {
      el.btnToggleLocation.textContent = '📂 Ask Save Location';
      el.locationModeSummary.textContent = 'Save As Dialog';
    } else if (saveMode === 'subfolder' && subfolder) {
      const shortName = subfolder.length > 18 ? `${subfolder.slice(0, 17)}…` : subfolder;
      el.btnToggleLocation.textContent = `📁 ${shortName}`;
      el.locationModeSummary.textContent = `Downloads/${subfolder}/`;
    } else {
      el.btnToggleLocation.textContent = '📁 Default Folder';
      el.locationModeSummary.textContent = 'Downloads/';
    }

    el.btnModeDefault.setAttribute('aria-pressed', saveMode === 'default' ? 'true' : 'false');
    el.btnModeAsk.setAttribute('aria-pressed', saveMode === 'ask' ? 'true' : 'false');
    if (subfolder && document.activeElement !== el.subfolderInput) {
      el.subfolderInput.value = subfolder;
    }

    el.btnToggleLocation.setAttribute('aria-expanded', locationDrawerOpen ? 'true' : 'false');
    el.saveLocationDrawer.classList.toggle('hidden', !locationDrawerOpen);
  }

  async function persistSaveSettings(nextSettings) {
    saveSettings = nextSettings;
    updateSaveLocationUi();
    if (hasChromeExtensionApi()) {
      await chrome.storage.local.set({
        ums_save_settings: saveSettings,
        ums_ask_location: saveSettings.saveMode === 'ask'
      });
    }
  }

  function updateOfflineUi() {
    const hasOfflinePaused = jobsList.some((j) => j && j.offlinePaused);
    const isOffline = !navigator.onLine || hasOfflinePaused;
    el.offlineBanner.classList.toggle('hidden', !isOffline);
  }

  function renderSavedBanner(banner) {
    if (banner && banner.filename) {
      el.savedBannerText.textContent = `✓ Saved: ${banner.filename}`;
      el.savedBanner.classList.remove('hidden');
    } else {
      el.savedBanner.classList.add('hidden');
    }
  }

  function renderErrorBanner(errorMsg) {
    if (errorMsg) {
      el.errorBannerText.textContent = errorMsg;
      el.errorBanner.classList.remove('hidden');
    } else {
      el.errorBanner.classList.add('hidden');
    }
  }

  function renderRecentSaved() {
    if (!Array.isArray(recentSaved) || recentSaved.length === 0) {
      el.recentSection.classList.add('hidden');
      return;
    }
    el.recentSection.classList.remove('hidden');
    el.recentHeading.textContent = `Recent Saved (${recentSaved.length})`;
    el.recentList.innerHTML = '';
    for (const item of recentSaved.slice(0, 5)) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.textContent = `✓ ${item.filename}`;
      li.title = item.filename;
      el.recentList.appendChild(li);
    }
  }

  function renderTabSelector() {
    el.tabSelector.innerHTML = '';
    if (!mediaTabs || mediaTabs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '-1';
      opt.textContent = mediaState.pageTitle || 'Active Page Streams';
      el.tabSelector.appendChild(opt);
      el.tabSelector.disabled = true;
      return;
    }
    el.tabSelector.disabled = false;
    for (const t of mediaTabs) {
      const opt = document.createElement('option');
      opt.value = String(t.tabId);
      const countText = t.videoCount > 0 ? ` (${t.videoCount} video${t.videoCount === 1 ? '' : 's'})` : '';
      const cleanTitle = (t.title || t.url || `Tab ${t.tabId}`).slice(0, 48).trim();
      opt.textContent = `${cleanTitle}${countText}`;
      if (t.tabId === currentTabId) opt.selected = true;
      el.tabSelector.appendChild(opt);
    }
  }

  function upsertJobInList(job) {
    if (!job || !job.jobId) return;
    const idx = jobsList.findIndex((j) => j.jobId === job.jobId);
    if (job.status === 'cancelled') {
      if (idx >= 0) jobsList.splice(idx, 1);
      return;
    }
    if (idx >= 0) {
      jobsList[idx] = { ...jobsList[idx], ...job };
    } else {
      jobsList.unshift(job);
    }
  }

  function renderActiveJobs() {
    updateOfflineUi();
    updateWorkerPoolBadge();

    const visibleJobs = jobsList.filter((j) => j && j.status !== 'cancelled');
    const activeCount = visibleJobs.filter(
      (j) => j.status === 'downloading' || j.status === 'paused' || j.status === 'saving'
    ).length;
    el.downloadsHeading.textContent = `Active & Queued Downloads (${activeCount || visibleJobs.length})`;

    const hasDoneOrError = visibleJobs.some((j) => j.status === 'completed' || j.status === 'error');
    const showBulk = visibleJobs.length >= 2 || hasDoneOrError;
    el.downloadsBulk.classList.toggle('hidden', !showBulk);
    el.btnClearDone.classList.toggle('hidden', !hasDoneOrError);

    el.downloadsList.innerHTML = '';

    if (visibleJobs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <div class="empty-title">No downloads queued yet</div>
        <div>Select a quality pill on the left and click Download Selected to launch up to 32 parallel workers.</div>
      `;
      el.downloadsList.appendChild(empty);
      return;
    }

    for (const job of visibleJobs) {
      const card = document.createElement('div');
      card.className = 'job-card';

      const topRow = document.createElement('div');
      topRow.className = 'job-top';

      const nameEl = document.createElement('div');
      nameEl.className = 'job-name';
      nameEl.textContent = job.resolvedFilename || job.filename || 'Downloading...';
      nameEl.title = nameEl.textContent;

      const badge = document.createElement('span');
      let stateClass = 'active';
      let badgeLabel = job.status === 'saving' ? 'Saving...' : 'Downloading';
      if (job.status === 'completed') {
        stateClass = 'completed';
        badgeLabel = '✓ Saved';
      } else if (job.status === 'error' || job.offlinePaused) {
        stateClass = 'error';
        badgeLabel = job.offlinePaused ? 'Offline' : 'Error';
      } else if (job.isPaused || job.status === 'paused') {
        stateClass = 'paused';
        badgeLabel = 'Paused';
      }
      badge.className = `job-badge ${stateClass}`;
      badge.textContent = badgeLabel;

      topRow.appendChild(nameEl);
      topRow.appendChild(badge);
      card.appendChild(topRow);

      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      const pct = job.status === 'completed' ? 100 : Math.max(0, Math.min(100, job.progress || 0));
      fill.className = `progress-fill ${stateClass}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      card.appendChild(track);

      const meta = document.createElement('div');
      meta.className = 'progress-meta';
      const dlStr = formatBytes(job.downloadedBytes);
      const estStr = job.totalBytes > 0 ? formatBytes(job.totalBytes) : 'Estimating...';
      const speedStr = `${(job.speedMBps || 0).toFixed(2)} MB/s`;
      const statsSpan = document.createElement('span');
      statsSpan.textContent = job.status === 'completed'
        ? `100% · ${formatBytes(job.totalBytes || job.downloadedBytes)}`
        : `${pct}% · ${speedStr} · ${dlStr} / ${estStr}`;
      const etaSpan = document.createElement('span');
      etaSpan.textContent = job.status === 'completed' ? '✓ Saved' : `ETA: ${formatEta(job.etaSeconds)}`;
      meta.appendChild(statsSpan);
      meta.appendChild(etaSpan);
      card.appendChild(meta);

      if (job.status === 'error' && job.error) {
        const errDiv = document.createElement('div');
        errDiv.className = 'job-error-text';
        errDiv.textContent = job.error;
        card.appendChild(errDiv);
      }

      const controls = document.createElement('div');
      controls.className = 'job-controls';

      if (job.status !== 'completed') {
        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'btn-ctrl';
        const shouldResume = Boolean(job.isPaused) || job.status === 'paused' || job.status === 'error';
        pauseBtn.textContent = shouldResume ? 'Resume' : 'Pause';
        pauseBtn.addEventListener('click', () => {
          if (hasChromeExtensionApi()) {
            chrome.runtime.sendMessage({
              type: shouldResume ? 'RESUME_DOWNLOAD' : 'PAUSE_DOWNLOAD',
              jobId: job.jobId
            }, (res) => {
              if (res && Array.isArray(res.jobs)) {
                jobsList = res.jobs;
                renderActiveJobs();
              }
            });
          } else {
            job.status = shouldResume ? 'downloading' : 'paused';
            job.isPaused = !shouldResume;
            renderActiveJobs();
          }
        });
        controls.appendChild(pauseBtn);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = job.status === 'completed' ? 'btn-ctrl' : 'btn-ctrl danger';
      cancelBtn.textContent = job.status === 'completed' ? 'Remove' : 'Cancel';
      cancelBtn.addEventListener('click', () => {
        jobsList = jobsList.filter((j) => j.jobId !== job.jobId);
        renderActiveJobs();
        if (hasChromeExtensionApi()) {
          chrome.runtime.sendMessage({
            type: job.status === 'completed' ? 'CLEAR_DONE_DOWNLOADS' : 'CANCEL_DOWNLOAD',
            jobId: job.jobId
          });
        }
      });
      controls.appendChild(cancelBtn);
      card.appendChild(controls);
      el.downloadsList.appendChild(card);
    }
  }

  function renderVideosDiagnostics() {
    const streams = getDetectedVideos();
    el.btnSwitchVideos.textContent = `Videos (${streams.length})`;
    el.videosDiagnosticsBody.innerHTML = '';

    if (streams.length === 0) {
      el.videosDiagnosticsBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No streams detected on this tab yet</div>
          <div>Play a video in the target tab, click Refresh, or paste any .m3u8 / .mpd / .mp4 link above.</div>
        </div>
      `;
      return;
    }

    let activeStream = streams.find((s) => s.id === selectedStreamId) || streams[0];
    if (selectedStreamId !== activeStream.id) {
      selectedStreamId = activeStream.id;
      selectedQualityValue = null;
      userEditedCaption = false;
      activeCaptionValue = resolveStreamCaption(activeStream, mediaState.pageTitle);
    }

    // 1. Multi-Stream Switcher Chips
    if (streams.length > 0) {
      const strip = document.createElement('div');
      strip.className = 'stream-strip';
      streams.forEach((s, idx) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `stream-tab-chip ${s.id === activeStream.id ? 'active' : ''}`;
        let host = 'Stream';
        try { host = new URL(s.url).hostname; } catch (_) {}
        const dur = formatDurationDisplay(s.totalDuration || mediaState.pageDuration);
        const kindLabel = String(s.kind || 'mp4').toUpperCase();
        const tag = s.isPasted ? '★ Pasted' : (idx === 0 ? '★ #1 Best' : `#${idx + 1}`);
        chip.innerHTML = `
          <div class="chip-top">
            <span>${tag} · ${kindLabel}</span>
            <span>${dur || (s.height ? `${s.height}p` : '')}</span>
          </div>
          <div class="chip-host">${host}</div>
        `;
        chip.addEventListener('click', () => {
          selectedStreamId = s.id;
          selectedQualityValue = null;
          userEditedCaption = false;
          activeCaptionValue = resolveStreamCaption(s, mediaState.pageTitle);
          renderVideosDiagnostics();
        });
        strip.appendChild(chip);
      });
      el.videosDiagnosticsBody.appendChild(strip);
    }

    const options = buildQualityOptionsForStream(activeStream);
    let chosenOpt = options.find((o) => o.value === selectedQualityValue)
      || options.find((o) => o.isBest)
      || options[0];
    selectedQualityValue = chosenOpt.value;

    const kindUpper = String(activeStream.kind || 'mp4').toUpperCase();
    const streamStatus = chosenOpt.streamStatus || activeStream.streamStatus || 'VOD';
    const durationText = formatDurationDisplay(activeStream.totalDuration || mediaState.pageDuration);
    const audioTracks = Array.isArray(activeStream.audioTracks) ? activeStream.audioTracks : [];
    const subtitleTracks = Array.isArray(activeStream.subtitleTracks) ? activeStream.subtitleTracks : [];

    // 2. Hero Badges
    const heroRow = document.createElement('div');
    heroRow.className = 'stream-hero-row';
    const badgeRow = document.createElement('div');
    badgeRow.className = 'badge-row';
    badgeRow.innerHTML = `
      <span class="diag-badge proto">${kindUpper}</span>
      <span class="diag-badge ${streamStatus === 'Live' ? 'live' : 'vod'}">${streamStatus}</span>
      ${durationText ? `<span class="diag-badge">${durationText}</span>` : ''}
      ${activeStream.isMaster ? '<span class="diag-badge">Master Adaptive</span>' : ''}
    `;
    heroRow.appendChild(badgeRow);
    el.videosDiagnosticsBody.appendChild(heroRow);

    const initialResolvedCaption = userEditedCaption
      ? (activeCaptionValue || CAPTION_PLACEHOLDER)
      : (activeCaptionValue || resolveStreamCaption(activeStream, mediaState.pageTitle));

    // 3. Stream Address + Overview Header + Copy URL
    const addrWrap = document.createElement('div');
    const addrLabelRow = document.createElement('div');
    addrLabelRow.className = 'section-label';
    const addrTitleSpan = document.createElement('span');
    addrTitleSpan.textContent = 'Overview & Stream Address';
    const overviewCapEl = document.createElement('span');
    overviewCapEl.className = `overview-caption-pill ${initialResolvedCaption === CAPTION_PLACEHOLDER ? 'is-placeholder' : ''}`;
    overviewCapEl.setAttribute('data-overview-caption', '1');
    overviewCapEl.textContent = initialResolvedCaption;
    overviewCapEl.title = initialResolvedCaption;
    addrLabelRow.appendChild(addrTitleSpan);
    addrLabelRow.appendChild(overviewCapEl);
    addrWrap.appendChild(addrLabelRow);
    const addrBox = document.createElement('div');
    addrBox.className = 'address-box';
    const addrText = document.createElement('span');
    addrText.className = 'address-url';
    addrText.textContent = chosenOpt.url || activeStream.url;
    addrText.title = chosenOpt.url || activeStream.url;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy-url';
    copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(chosenOpt.url || activeStream.url);
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
      } catch (_) {}
    });
    addrBox.appendChild(addrText);
    addrBox.appendChild(copyBtn);
    addrWrap.appendChild(addrBox);
    el.videosDiagnosticsBody.appendChild(addrWrap);

    // 4. 8-Metric Technical Diagnostics Grid
    const resStr = chosenOpt.height > 0
      ? `${chosenOpt.width || Math.round((chosenOpt.height * 16) / 9)}×${chosenOpt.height}`
      : (chosenOpt.outputFormat === 'mp3' ? 'Audio Only' : 'Auto');
    const bitrateStr = formatBitrateMbps(chosenOpt.bandwidth);
    const fpsStr = chosenOpt.frameRate > 0 ? `${chosenOpt.frameRate} fps` : 'Standard';
    const codecsStr = formatHumanCodecs(chosenOpt.codecs || activeStream.codecs);
    const containerStr = chosenOpt.container || activeStream.container || (activeStream.kind === 'hls' ? 'MPEG-TS' : activeStream.kind === 'dash' ? 'fMP4' : 'MP4');
    const segCount = chosenOpt.segmentCount || activeStream.segmentCount || 0;
    const segStr = segCount > 0
      ? (activeStream.kind === 'hls' || activeStream.kind === 'dash' ? `${segCount} segs` : `${segCount} chunks`)
      : (chosenOpt.estimatedBytes > 0 ? formatApproxMb(chosenOpt.estimatedBytes) : 'Stream');
    const trackCountStr = `${audioTracks.length || 1} Audio · ${subtitleTracks.length} Sub`;

    const specsGrid = document.createElement('div');
    specsGrid.className = 'specs-grid';
    const cells = [
      ['Resolution', resStr, 'mono'],
      ['Bitrate', bitrateStr, 'mono'],
      ['Frame Rate', fpsStr, 'mono'],
      ['Codecs', codecsStr, ''],
      ['Container', containerStr, ''],
      ['Segments', segStr, 'mono'],
      ['Status', durationText ? `${streamStatus} · ${durationText.replace('⏱ ', '')}` : streamStatus, ''],
      ['Tracks', trackCountStr, '']
    ];
    for (const [lbl, val, cls] of cells) {
      const cell = document.createElement('div');
      cell.className = 'spec-cell';
      cell.innerHTML = `<span class="spec-label">${lbl}</span><span class="spec-value ${cls}" title="${val}">${val}</span>`;
      specsGrid.appendChild(cell);
    }
    el.videosDiagnosticsBody.appendChild(specsGrid);

    // 5. Horizontal Quality Selector Pills
    const qSection = document.createElement('div');
    qSection.innerHTML = `<div class="section-label"><span>Quality &amp; Format Selector (${options.length} options)</span><span>Exact Bitrate + Pre-Calculated Size</span></div>`;
    const pillsRow = document.createElement('div');
    pillsRow.className = 'quality-pills-row';

    options.forEach((opt) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `quality-pill ${opt.value === chosenOpt.value ? 'selected' : ''}`;
      const bwText = opt.bandwidth > 0 ? formatBitrateMbps(opt.bandwidth) : 'Original';
      const sizeText = opt.estimatedBytes > 0 ? formatApproxMb(opt.estimatedBytes) : 'Auto Size';
      let tagHtml = '';
      if (opt.isBest) tagHtml = `<span class="qpill-tag">★ Best</span>`;
      else if (opt.isDataSaver) tagHtml = `<span class="qpill-tag saver">Data Saver</span>`;
      else if (opt.outputFormat === 'mp3') tagHtml = `<span class="qpill-tag mp3">MP3</span>`;

      pill.innerHTML = `
        <div class="qpill-top">
          <span>${opt.shortRes} · ${bwText}</span>
          ${tagHtml}
        </div>
        <div class="qpill-meta">${sizeText}</div>
      `;
      pill.addEventListener('click', () => {
        selectedQualityValue = opt.value;
        renderVideosDiagnostics();
      });
      pillsRow.appendChild(pill);
    });
    qSection.appendChild(pillsRow);
    el.videosDiagnosticsBody.appendChild(qSection);

    // 6. Audio & Subtitle Track Selectors + Caption + Output Filename Preview
    let selectedAudioUri = audioTracks[0] ? audioTracks[0].uri : '';
    let selectedSubUri = '';

    if (audioTracks.length > 0 || subtitleTracks.length > 0) {
      const tracksGrid = document.createElement('div');
      tracksGrid.className = 'form-grid-2';
      if (audioTracks.length > 0) {
        const aWrap = document.createElement('div');
        aWrap.innerHTML = '<div class="section-label"><span>Audio Track</span></div>';
        const aSel = document.createElement('select');
        aSel.className = 'field-select';
        let defIdx = audioTracks.findIndex((t) => t.isDefault);
        if (defIdx === -1) defIdx = 0;
        selectedAudioUri = audioTracks[defIdx].uri;
        audioTracks.forEach((t, idx) => {
          const o = document.createElement('option');
          o.value = t.uri;
          o.textContent = t.name || t.language || `Audio ${idx + 1}`;
          if (idx === defIdx) o.selected = true;
          aSel.appendChild(o);
        });
        aSel.addEventListener('change', () => { selectedAudioUri = aSel.value; });
        aWrap.appendChild(aSel);
        tracksGrid.appendChild(aWrap);
      }
      if (subtitleTracks.length > 0) {
        const sWrap = document.createElement('div');
        sWrap.innerHTML = '<div class="section-label"><span>Subtitle Track</span></div>';
        const sSel = document.createElement('select');
        sSel.className = 'field-select';
        const noneO = document.createElement('option');
        noneO.value = '';
        noneO.textContent = 'None';
        sSel.appendChild(noneO);
        subtitleTracks.forEach((t, idx) => {
          const o = document.createElement('option');
          o.value = t.uri;
          o.textContent = t.name || t.language || `Subtitle ${idx + 1}`;
          sSel.appendChild(o);
        });
        sSel.addEventListener('change', () => { selectedSubUri = sSel.value; });
        sWrap.appendChild(sSel);
        tracksGrid.appendChild(sWrap);
      }
      el.videosDiagnosticsBody.appendChild(tracksGrid);
    }

    const captionWrap = document.createElement('div');
    captionWrap.innerHTML = '<div class="section-label"><span>Video Caption (Supports Bengali &amp; Unicode)</span></div>';
    const captionRow = document.createElement('div');
    captionRow.className = 'caption-row';
    const captionInput = document.createElement('input');
    captionInput.type = 'text';
    captionInput.className = 'field-input';
    captionInput.setAttribute('data-active-caption', '1');
    captionInput.value = userEditedCaption
      ? activeCaptionValue
      : (activeCaptionValue || resolveStreamCaption(activeStream, mediaState.pageTitle));
    captionInput.placeholder = CAPTION_PLACEHOLDER;
    if (captionInput.value.trim() === CAPTION_PLACEHOLDER) {
      captionInput.classList.add('caption-placeholder');
    }

    const btnPasteCaption = document.createElement('button');
    btnPasteCaption.type = 'button';
    btnPasteCaption.className = 'btn-caption-paste';
    btnPasteCaption.textContent = 'Paste';
    btnPasteCaption.title = 'Paste video caption from clipboard';

    const captionGuardMsg = document.createElement('div');
    captionGuardMsg.className = 'caption-guard-msg hidden';

    captionRow.appendChild(captionInput);
    captionRow.appendChild(btnPasteCaption);
    captionWrap.appendChild(captionRow);
    captionWrap.appendChild(captionGuardMsg);
    el.videosDiagnosticsBody.appendChild(captionWrap);

    const previewWrap = document.createElement('div');
    previewWrap.innerHTML = '<div class="section-label"><span>Output Destination Preview</span></div>';
    const previewBox = document.createElement('div');
    previewBox.className = 'filename-preview';
    const updatePreview = () => {
      const prefix = saveSettings.saveMode === 'subfolder' && saveSettings.subfolder
        ? `${saveSettings.subfolder}/`
        : '';
      previewBox.textContent = `${prefix}${formatOutputFilename(captionInput.value, chosenOpt.outputFormat)}`;
      const trimmedCap = captionInput.value.trim();
      overviewCapEl.textContent = trimmedCap || CAPTION_PLACEHOLDER;
      overviewCapEl.title = overviewCapEl.textContent;
      overviewCapEl.classList.toggle('is-placeholder', !trimmedCap || trimmedCap === CAPTION_PLACEHOLDER);
      captionInput.classList.toggle('caption-placeholder', trimmedCap === CAPTION_PLACEHOLDER);
    };
    updatePreview();

    let selectOnMouseUp = false;
    captionInput.addEventListener('focus', () => {
      if (captionInput.value.trim() === CAPTION_PLACEHOLDER) {
        selectOnMouseUp = true;
        captionInput.select();
      }
    });
    captionInput.addEventListener('mouseup', (e) => {
      if (selectOnMouseUp && captionInput.value.trim() === CAPTION_PLACEHOLDER) {
        e.preventDefault();
        captionInput.select();
      }
      selectOnMouseUp = false;
    });

    captionInput.addEventListener('input', () => {
      userEditedCaption = true;
      activeCaptionValue = captionInput.value;
      captionInput.classList.remove('caption-guard-error');
      captionGuardMsg.classList.add('hidden');
      captionGuardMsg.textContent = '';
      updatePreview();
    });

    btnPasteCaption.addEventListener('click', async () => {
      try {
        const clip = await navigator.clipboard.readText();
        const trimmedClip = String(clip || '').replace(/\s+/g, ' ').trim();
        if (!trimmedClip) {
          captionGuardMsg.textContent = 'Clipboard is empty — type the video caption.';
          captionGuardMsg.classList.remove('hidden');
          captionInput.focus();
          return;
        }
        userEditedCaption = true;
        activeCaptionValue = trimmedClip;
        captionInput.value = trimmedClip;
        captionInput.classList.remove('caption-guard-error');
        captionGuardMsg.classList.add('hidden');
        captionGuardMsg.textContent = '';
        updatePreview();
        captionInput.focus();
      } catch (_) {
        captionGuardMsg.textContent = 'Clipboard denied — press Ctrl+V inside the caption box.';
        captionGuardMsg.classList.remove('hidden');
        captionInput.focus();
        if (captionInput.value.trim() === CAPTION_PLACEHOLDER) {
          captionInput.select();
        }
      }
    });

    previewWrap.appendChild(previewBox);
    el.videosDiagnosticsBody.appendChild(previewWrap);

    const dupNotice = document.createElement('div');
    dupNotice.className = 'dup-notice hidden';
    el.videosDiagnosticsBody.appendChild(dupNotice);

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn-download-lg';
    const sizeBadge = chosenOpt.estimatedBytes > 0 ? ` (${formatApproxMb(chosenOpt.estimatedBytes)})` : '';
    dlBtn.textContent = `Download ${chosenOpt.shortRes}${sizeBadge}`;
    dlBtn.addEventListener('click', () => {
      const rawCaption = captionInput.value.trim();
      if (!rawCaption || rawCaption === CAPTION_PLACEHOLDER) {
        captionInput.classList.add('caption-guard-error');
        captionGuardMsg.textContent = 'Please paste or enter the video caption first';
        captionGuardMsg.classList.remove('hidden');
        captionInput.focus();
        if (rawCaption === CAPTION_PLACEHOLDER) {
          captionInput.select();
        }
        return;
      }
      captionInput.classList.remove('caption-guard-error');
      captionGuardMsg.classList.add('hidden');

      const outExt = chosenOpt.outputFormat;
      const filename = formatOutputFilename(rawCaption, outExt);
      const exactVideoUrl = chosenOpt.url || activeStream.url;
      const existingDup = findClientDuplicateJob(exactVideoUrl, filename);
      if (existingDup) {
        dupNotice.textContent = 'Already downloading this stream';
        dupNotice.classList.remove('hidden');
        return;
      }
      dupNotice.classList.add('hidden');

      const chosenAudioTrack = audioTracks.find((t) => t.uri === selectedAudioUri) || audioTracks[0] || null;
      const isDash = activeStream.kind === 'dash';
      const isHls = activeStream.kind === 'hls';
      const isProgressive = !isDash && !isHls;
      const qualityKey = `${chosenOpt.height || 0}:${chosenOpt.bandwidth || 0}:${outExt}:${chosenOpt.isDataSaver ? 'ds' : 'std'}`;

      let dashData = null;
      if (isDash && chosenOpt.dashData) {
        const vData = chosenOpt.dashData;
        const aData = chosenAudioTrack && chosenAudioTrack.dashAudioData ? chosenAudioTrack.dashAudioData : null;
        dashData = {
          videoInit: vData.videoInit || null,
          videoSegments: vData.videoSegments || [],
          audioInit: aData ? aData.audioInit : null,
          audioSegments: aData ? aData.audioSegments : []
        };
      }

      const job = {
        jobId: `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        filename,
        outputFormat: outExt,
        videoUrl: exactVideoUrl,
        streamUrl: activeStream.url,
        qualityKey,
        streamSignature: `${exactVideoUrl}::${filename}`,
        knownTotalBytes: chosenOpt.estimatedBytes || 0,
        isProgressive: isProgressive || Boolean(isDash && chosenOpt.dashData && chosenOpt.dashData.directUrl && (!dashData || dashData.videoSegments.length === 0)),
        isDash: isDash && Boolean(dashData && (dashData.videoSegments.length > 0 || dashData.audioSegments.length > 0)),
        dashData,
        directUrl: isProgressive
          ? chosenOpt.url
          : (isDash && chosenOpt.dashData && chosenOpt.dashData.directUrl ? chosenOpt.dashData.directUrl : null),
        audioDirectUrl: '',
        videoPlaylistUrl: (!isProgressive && !isDash) ? chosenOpt.url : null,
        audioPlaylistUrl: (!isProgressive && !isDash && selectedAudioUri) ? selectedAudioUri : null,
        subtitleUrl: selectedSubUri || null,
        referer: activeStream.referer || mediaState.pageUrl || ''
      };

      if (hasChromeExtensionApi()) {
        chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', job }, (res) => {
          if (res && res.duplicate) {
            dupNotice.textContent = res.error || 'Already downloading this stream';
            dupNotice.classList.remove('hidden');
          } else if (res && res.ok) {
            if (Array.isArray(res.jobs)) jobsList = res.jobs;
            else if (res.job) upsertJobInList(res.job);
            renderActiveJobs();
          }
        });
      } else {
        launchStandalonePreviewJob(job, saveSettings);
      }
    });
    el.videosDiagnosticsBody.appendChild(dlBtn);
  }

  function renderPictures() {
    const images = getDetectedImages();
    el.btnSwitchPictures.textContent = `HQ Pictures (${images.length})`;
    el.picturesBody.innerHTML = '';

    if (images.length === 0) {
      el.picturesBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No HQ pictures (&ge; 250&times;250px) detected</div>
          <div>Scroll down on the target page and click Refresh to detect high-resolution images.</div>
        </div>
      `;
      return;
    }

    const topBar = document.createElement('div');
    topBar.style.display = 'flex';
    topBar.style.justifyContent = 'flex-end';
    const dlAllBtn = document.createElement('button');
    dlAllBtn.type = 'button';
    dlAllBtn.className = 'btn-primary';
    dlAllBtn.textContent = `Download All HQ (${images.length})`;
    dlAllBtn.addEventListener('click', () => {
      if (!hasChromeExtensionApi()) {
        renderSavedBanner({ filename: `${images.length} HQ Pictures [CodeByAzimDev]` });
        return;
      }
      images.forEach((img, idx) => {
        const m = String(img.url || '').match(/\.(png|webp|jpeg|jpg|avif|gif)(\?|#|$)/i);
        const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
        const filename = `${sanitizeCaption(img.alt || `HQ_Image_${idx + 1}`)} [CodeByAzimDev].${ext}`;
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT_MEDIA', url: img.url, filename, isBatch: true });
      });
    });
    topBar.appendChild(dlAllBtn);
    el.picturesBody.appendChild(topBar);

    const grid = document.createElement('div');
    grid.className = 'pic-grid';
    images.forEach((img, idx) => {
      const card = document.createElement('div');
      card.className = 'pic-card';
      const thumb = document.createElement('img');
      thumb.className = 'pic-thumb';
      thumb.src = img.thumbUrl || img.url;
      thumb.alt = img.alt || `HQ Image ${idx + 1}`;
      thumb.referrerPolicy = 'no-referrer';
      const footer = document.createElement('div');
      footer.className = 'pic-footer';
      const dims = document.createElement('span');
      dims.className = 'pic-dims';
      dims.textContent = `${img.width}×${img.height}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.style.padding = '4px 9px';
      btn.style.fontSize = '11px';
      btn.textContent = 'Save HQ';
      btn.addEventListener('click', () => {
        const m = String(img.url || '').match(/\.(png|webp|jpeg|jpg|avif|gif)(\?|#|$)/i);
        const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
        const filename = `${sanitizeCaption(img.alt || `HQ_Image_${idx + 1}`)} [CodeByAzimDev].${ext}`;
        if (hasChromeExtensionApi()) {
          chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT_MEDIA', url: img.url, filename, isBatch: false });
        } else {
          renderSavedBanner({ filename });
        }
      });
      footer.appendChild(dims);
      footer.appendChild(btn);
      card.appendChild(thumb);
      card.appendChild(footer);
      grid.appendChild(card);
    });
    el.picturesBody.appendChild(grid);
  }

  function switchView(viewName) {
    activeView = viewName;
    el.btnSwitchVideos.classList.toggle('active', viewName === 'videos');
    el.btnSwitchPictures.classList.toggle('active', viewName === 'pictures');
    el.videosDiagnosticsBody.classList.toggle('hidden', viewName !== 'videos');
    el.picturesBody.classList.toggle('hidden', viewName !== 'pictures');
  }

  function renderAll() {
    updateSaveLocationUi();
    renderTabSelector();
    renderVideosDiagnostics();
    renderPictures();
    renderActiveJobs();
    renderRecentSaved();
  }

  function setPasteStatus(text, kind = '') {
    if (!text) {
      el.pasteLinkStatus.textContent = '';
      el.pasteLinkStatus.className = 'paste-status hidden';
      return;
    }
    el.pasteLinkStatus.textContent = text;
    el.pasteLinkStatus.className = `paste-status ${kind}`.trim();
  }

  function inspectPastedUrl(rawUrl) {
    const cleanUrl = String(rawUrl || '').trim();
    if (!cleanUrl) {
      setPasteStatus('Paste a .m3u8, .mpd, .mp4, or stream link first.', 'error');
      el.pasteLinkInput.focus();
      return;
    }

    if (!hasChromeExtensionApi()) {
      let u;
      try {
        u = new URL(cleanUrl);
        if (!/^https?:$/i.test(u.protocol)) throw new Error('protocol');
      } catch (_) {
        setPasteStatus('Enter a valid http:// or https:// stream URL.', 'error');
        return;
      }
      const isMpd = /\.mpd(\?|#|$)/i.test(u.href);
      const isHls = /\.m3u8(\?|#|$)/i.test(u.href);
      const kind = isMpd ? 'dash' : isHls ? 'hls' : 'mp4';
      const pasted = {
        id: `pasted_${Date.now()}`,
        url: u.href,
        kind,
        isPasted: true,
        isMaster: kind === 'hls' || kind === 'dash',
        height: 1080,
        frameRate: 30,
        codecs: 'avc1.640028,mp4a.40.2',
        container: isMpd ? 'fMP4' : isHls ? 'MPEG-TS' : 'MP4',
        segmentCount: 168,
        streamStatus: 'VOD',
        totalDuration: 1840,
        titleHint: 'Direct Pasted Stream',
        variants: [
          {
            url: u.href,
            width: 1920,
            height: 1080,
            frameRate: 30,
            bandwidth: 4700000,
            codecs: 'avc1.640028,mp4a.40.2',
            container: isMpd ? 'fMP4' : isHls ? 'MPEG-TS' : 'MP4',
            segmentCount: 168,
            streamStatus: 'VOD',
            estimatedBytes: 428_500_000,
            isBest: true
          }
        ],
        audioTracks: [],
        subtitleTracks: []
      };
      mediaState.detectedVideos = [pasted, ...getDetectedVideos()];
      selectedStreamId = pasted.id;
      selectedQualityValue = null;
      userEditedCaption = false;
      activeCaptionValue = resolveStreamCaption(pasted, mediaState.pageTitle);
      el.pasteLinkInput.value = '';
      setPasteStatus(`Loaded ${kind.toUpperCase()} stream at #1`, 'ok');
      renderVideosDiagnostics();
      return;
    }

    el.btnLoadLink.disabled = true;
    el.btnPasteLink.disabled = true;
    setPasteStatus('Inspecting stream link...');

    chrome.runtime.sendMessage(
      { type: 'INSPECT_LINK_URL', url: cleanUrl, tabId: currentTabId >= 0 ? currentTabId : 0 },
      (res) => {
        el.btnLoadLink.disabled = false;
        el.btnPasteLink.disabled = false;
        if (chrome.runtime.lastError) {
          setPasteStatus(chrome.runtime.lastError.message || 'Failed to inspect URL.', 'error');
          return;
        }
        if (!res || !res.ok || !res.stream) {
          setPasteStatus((res && res.error) || 'Could not load video link.', 'error');
          return;
        }
        selectedStreamId = res.stream.id;
        selectedQualityValue = null;
        userEditedCaption = false;
        activeCaptionValue = resolveStreamCaption(res.stream, mediaState.pageTitle);
        el.pasteLinkInput.value = '';
        setPasteStatus(`Loaded ${res.stream.kind.toUpperCase()} stream at #1`, 'ok');

        chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTabId >= 0 ? currentTabId : 0 }, (tabRes) => {
          if (tabRes && tabRes.ok && tabRes.media) {
            mediaState = tabRes.media;
            renderAll();
          }
        });
      }
    );
  }

  // Standalone browser preview support (never runs inside Chrome extension)
  function seedStandalonePreviewData() {
    mediaTabs = [
      { tabId: 101, title: 'Module 04 — Dual-Track HLS Architecture', videoCount: 2, imageCount: 2, active: true },
      { tabId: 102, title: 'Course Workshop — MPEG-DASH & Signed MP4', videoCount: 1, imageCount: 0, active: false }
    ];
    currentTabId = 101;
    mediaState = {
      pageTitle: 'Module 04 Dual-Track HLS Architecture & ISO BMFF',
      pageUrl: 'https://cdn.coursehost.example/lesson/04',
      pageDuration: 1320,
      detectedVideos: [
        {
          id: 'master_hls_demo',
          url: 'https://cdn.coursehost.example/hls/module-04/master.m3u8',
          kind: 'hls',
          height: 1080,
          frameRate: 24,
          codecs: 'avc1.640028,mp4a.40.2',
          container: 'MPEG-TS',
          segmentCount: 220,
          streamStatus: 'VOD',
          isMaster: true,
          totalDuration: 1320,
          primaryAudioBandwidth: 128000,
          titleHint: 'Module 04 Dual-Track HLS Architecture & ISO BMFF',
          variants: [
            {
              url: 'https://cdn.coursehost.example/hls/module-04/1080p.m3u8',
              width: 1920,
              height: 1080,
              frameRate: 24,
              bandwidth: 4700000,
              averageBandwidth: 4700000,
              codecs: 'avc1.640028,mp4a.40.2',
              container: 'MPEG-TS',
              segmentCount: 220,
              streamStatus: 'VOD',
              audioGroup: 'audio',
              estimatedBytes: 768_000_000,
              isBest: true
            },
            {
              url: 'https://cdn.coursehost.example/hls/module-04/1080p-saver.m3u8',
              width: 1920,
              height: 1080,
              frameRate: 24,
              bandwidth: 2350000,
              averageBandwidth: 2350000,
              codecs: 'avc1.640028,mp4a.40.2',
              container: 'MPEG-TS',
              segmentCount: 220,
              streamStatus: 'VOD',
              audioGroup: 'audio',
              estimatedBytes: 392_400_000,
              isBest: false
            },
            {
              url: 'https://cdn.coursehost.example/hls/module-04/804p.m3u8',
              width: 1920,
              height: 804,
              frameRate: 50,
              bandwidth: 4600000,
              averageBandwidth: 4600000,
              codecs: 'avc1.64002a,mp4a.40.2',
              container: 'fMP4',
              segmentCount: 220,
              streamStatus: 'VOD',
              audioGroup: 'audio',
              estimatedBytes: 732_500_000,
              isBest: false
            },
            {
              url: 'https://cdn.coursehost.example/hls/module-04/720p.m3u8',
              width: 1280,
              height: 720,
              frameRate: 24,
              bandwidth: 2100000,
              averageBandwidth: 2100000,
              codecs: 'avc1.4d401f,mp4a.40.2',
              container: 'MPEG-TS',
              segmentCount: 220,
              streamStatus: 'VOD',
              audioGroup: 'audio',
              estimatedBytes: 356_200_000,
              isBest: false
            }
          ],
          audioTracks: [
            { groupId: 'audio', name: 'English (Original)', language: 'en', isDefault: true, uri: 'https://cdn.coursehost.example/hls/audio_en.m3u8' },
            { groupId: 'audio', name: 'Bengali Commentary', language: 'bn', isDefault: false, uri: 'https://cdn.coursehost.example/hls/audio_bn.m3u8' }
          ],
          subtitleTracks: [
            { groupId: 'subs', name: 'English CC', language: 'en', uri: 'https://cdn.coursehost.example/hls/subs_en.vtt' }
          ]
        },
        {
          id: 'course_dash_demo',
          url: 'https://cdn.coursehost.example/dash/workshop-09/manifest.mpd?token=sig_2026',
          kind: 'dash',
          height: 1080,
          frameRate: 30,
          codecs: 'avc1.640028,mp4a.40.2',
          container: 'fMP4 / MP4',
          segmentCount: 156,
          streamStatus: 'VOD',
          isMaster: true,
          totalDuration: 2700,
          primaryAudioBandwidth: 128000,
          estimatedAudioBytes: 43_200_000,
          titleHint: 'Course Workshop — MPEG-DASH & Signed MP4 Guide',
          variants: [
            {
              url: 'https://cdn.coursehost.example/dash/workshop-09/1080p.mp4?token=sig_2026',
              width: 1920,
              height: 1080,
              frameRate: 30,
              bandwidth: 4200000,
              codecs: 'avc1.640028,mp4a.40.2',
              container: 'fMP4 / MP4',
              segmentCount: 156,
              streamStatus: 'VOD',
              estimatedBytes: 312_000_000,
              isBest: true
            },
            {
              url: 'https://cdn.coursehost.example/dash/workshop-09/720p.mp4?token=sig_2026',
              width: 1280,
              height: 720,
              frameRate: 30,
              bandwidth: 2100000,
              codecs: 'avc1.4d401f,mp4a.40.2',
              container: 'fMP4 / MP4',
              segmentCount: 156,
              streamStatus: 'VOD',
              estimatedBytes: 158_000_000,
              isBest: false
            }
          ],
          audioTracks: [
            { groupId: 'dash-audio', name: 'Original Audio AAC (128 kbps)', language: 'en', isDefault: true, uri: 'https://cdn.coursehost.example/dash/workshop-09/audio_en.m4a' }
          ],
          subtitleTracks: []
        }
      ],
      hqImages: [
        { url: '/demo/sample-frame-1.png', thumbUrl: '/demo/sample-frame-1.png', width: 1920, height: 1080, alt: 'Course Architecture Slide' },
        { url: '/demo/sample-frame-2.png', thumbUrl: '/demo/sample-frame-2.png', width: 1600, height: 1200, alt: 'Muxer Pipeline Diagram' }
      ]
    };
    recentSaved = [{ filename: 'Module 03 Stream Deduplication [CodeByAzimDev].mp4', timestamp: Date.now() }];
  }

  function launchStandalonePreviewJob(job, settings) {
    const prefix = settings.saveMode === 'subfolder' && settings.subfolder ? `${settings.subfolder}/` : '';
    const record = {
      jobId: job.jobId,
      status: 'downloading',
      filename: job.filename,
      resolvedFilename: `${prefix}${job.filename}`,
      videoUrl: job.videoUrl,
      streamUrl: job.streamUrl,
      progress: 5,
      speedMBps: 24.5,
      downloadedBytes: Math.round((job.knownTotalBytes || 240_000_000) * 0.05),
      totalBytes: job.knownTotalBytes || 240_000_000,
      etaSeconds: 9,
      isPaused: false,
      offlinePaused: false
    };
    upsertJobInList(record);
    renderActiveJobs();

    if (!simTimer) {
      simTimer = setInterval(() => {
        const active = jobsList.filter((j) => j.status === 'downloading');
        if (active.length === 0) {
          clearInterval(simTimer);
          simTimer = null;
          return;
        }
        const perJob = Math.max(4, Math.floor(32 / active.length));
        const speedMBps = Number((perJob * 0.92).toFixed(2));
        const step = Math.round((speedMBps * 1024 * 1024) / 3);
        for (const j of active) {
          j.downloadedBytes = Math.min(j.totalBytes, j.downloadedBytes + step);
          j.progress = Math.min(100, Math.round((j.downloadedBytes / j.totalBytes) * 100));
          j.speedMBps = speedMBps;
          j.etaSeconds = Math.ceil((j.totalBytes - j.downloadedBytes) / (speedMBps * 1024 * 1024));
          if (j.downloadedBytes >= j.totalBytes) {
            j.status = 'completed';
            j.progress = 100;
            j.etaSeconds = 0;
            renderSavedBanner({ filename: j.resolvedFilename || j.filename });
            recentSaved = [{ filename: j.resolvedFilename || j.filename, timestamp: Date.now() }, ...recentSaved.filter((r) => r.filename !== j.filename)].slice(0, 5);
            renderRecentSaved();
          }
        }
        renderActiveJobs();
      }, 300);
    }
  }

  // Event Listeners
  el.btnToggleLocation.addEventListener('click', () => {
    locationDrawerOpen = !locationDrawerOpen;
    updateSaveLocationUi();
  });

  el.btnModeDefault.addEventListener('click', async () => {
    await persistSaveSettings({ saveMode: 'default', subfolder: '' });
    el.subfolderInput.value = '';
    locationDrawerOpen = false;
    updateSaveLocationUi();
    renderVideosDiagnostics();
  });

  el.btnModeAsk.addEventListener('click', async () => {
    await persistSaveSettings({ saveMode: 'ask', subfolder: saveSettings.subfolder || '' });
    locationDrawerOpen = false;
    updateSaveLocationUi();
    renderVideosDiagnostics();
  });

  const applySubfolder = async () => {
    const clean = sanitizeSubfolder(el.subfolderInput.value);
    if (!clean) {
      el.subfolderInput.focus();
      return;
    }
    el.subfolderInput.value = clean;
    await persistSaveSettings({ saveMode: 'subfolder', subfolder: clean });
    locationDrawerOpen = false;
    updateSaveLocationUi();
    renderVideosDiagnostics();
  };

  el.btnSetSubfolder.addEventListener('click', applySubfolder);
  el.subfolderInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applySubfolder();
    }
  });

  el.btnChangeDrive.addEventListener('click', () => {
    if (hasChromeExtensionApi()) {
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    }
  });

  el.tabSelector.addEventListener('change', () => {
    const nextTabId = parseInt(el.tabSelector.value, 10);
    if (Number.isFinite(nextTabId) && nextTabId >= 0) {
      currentTabId = nextTabId;
      selectedStreamId = null;
      selectedQualityValue = null;
      userEditedCaption = false;
      if (hasChromeExtensionApi()) {
        chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTabId }, (res) => {
          if (res && res.ok && res.media) {
            mediaState = res.media;
            renderAll();
          }
        });
      }
    }
  });

  el.btnRefresh.addEventListener('click', () => {
    if (hasChromeExtensionApi()) {
      chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_INIT', tabId: currentTabId }, (res) => {
        if (res && res.ok) {
          currentTabId = typeof res.tabId === 'number' ? res.tabId : currentTabId;
          mediaTabs = Array.isArray(res.mediaTabs) ? res.mediaTabs : mediaTabs;
          mediaState = res.media || mediaState;
          jobsList = Array.isArray(res.jobs) ? res.jobs : jobsList;
          renderAll();
        }
      });
    } else {
      renderAll();
    }
  });

  el.btnClear.addEventListener('click', () => {
    selectedStreamId = null;
    selectedQualityValue = null;
    userEditedCaption = false;
    activeCaptionValue = '';
    setPasteStatus('');
    if (hasChromeExtensionApi() && currentTabId >= 0) {
      chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA', tabId: currentTabId }, (res) => {
        if (res && res.ok && res.media) {
          mediaState = res.media;
          renderAll();
        }
      });
    } else {
      mediaState.detectedVideos = [];
      mediaState.hqImages = [];
      renderAll();
    }
  });

  el.btnPasteLink.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        el.pasteLinkInput.value = text.trim();
        inspectPastedUrl(text.trim());
      } else {
        setPasteStatus('Clipboard is empty. Paste a stream URL manually.', 'error');
        el.pasteLinkInput.focus();
      }
    } catch (_) {
      setPasteStatus('Clipboard access denied — paste URL manually and click Load Link.', 'error');
      el.pasteLinkInput.focus();
    }
  });

  el.btnLoadLink.addEventListener('click', () => inspectPastedUrl(el.pasteLinkInput.value));
  el.pasteLinkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inspectPastedUrl(el.pasteLinkInput.value);
    }
  });

  el.btnSwitchVideos.addEventListener('click', () => switchView('videos'));
  el.btnSwitchPictures.addEventListener('click', () => switchView('pictures'));

  el.btnPauseAll.addEventListener('click', () => {
    if (hasChromeExtensionApi()) {
      chrome.runtime.sendMessage({ type: 'PAUSE_ALL_DOWNLOADS' }, (res) => {
        if (res && Array.isArray(res.jobs)) {
          jobsList = res.jobs;
          renderActiveJobs();
        }
      });
    } else {
      jobsList.forEach((j) => { if (j.status === 'downloading') { j.status = 'paused'; j.isPaused = true; } });
      renderActiveJobs();
    }
  });

  el.btnResumeAll.addEventListener('click', () => {
    if (hasChromeExtensionApi()) {
      chrome.runtime.sendMessage({ type: 'RESUME_ALL_DOWNLOADS' }, (res) => {
        if (res && Array.isArray(res.jobs)) {
          jobsList = res.jobs;
          renderActiveJobs();
        }
      });
    } else {
      jobsList.forEach((j) => { if (j.status === 'paused') { j.status = 'downloading'; j.isPaused = false; } });
      renderActiveJobs();
    }
  });

  el.btnClearDone.addEventListener('click', () => {
    jobsList = jobsList.filter((j) => j.status === 'downloading' || j.status === 'paused' || j.status === 'saving');
    renderActiveJobs();
    if (hasChromeExtensionApi()) {
      chrome.runtime.sendMessage({ type: 'CLEAR_DONE_DOWNLOADS' });
    }
  });

  el.dismissSavedBanner.addEventListener('click', () => {
    el.savedBanner.classList.add('hidden');
    if (hasChromeExtensionApi()) {
      chrome.storage.local.remove('ums_saved_banner');
    }
  });

  el.dismissErrorBanner.addEventListener('click', () => renderErrorBanner(''));

  window.addEventListener('online', updateOfflineUi);
  window.addEventListener('offline', updateOfflineUi);

  function init() {
    updateOfflineUi();
    const params = new URLSearchParams(window.location.search);
    const paramTabId = parseInt(params.get('tabId') || '-1', 10);
    const paramStreamId = params.get('streamId') || '';
    if (paramStreamId) selectedStreamId = paramStreamId;

    if (!hasChromeExtensionApi()) {
      seedStandalonePreviewData();
      renderAll();
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'GET_DASHBOARD_INIT', tabId: Number.isFinite(paramTabId) ? paramTabId : -1 },
      (res) => {
        if (res && res.ok) {
          currentTabId = typeof res.tabId === 'number' ? res.tabId : -1;
          mediaTabs = Array.isArray(res.mediaTabs) ? res.mediaTabs : [];
          mediaState = res.media || mediaState;
          if (res.saveSettings) {
            saveSettings = {
              saveMode: res.saveSettings.saveMode || 'default',
              subfolder: res.saveSettings.subfolder || ''
            };
          } else {
            saveSettings = { saveMode: res.askLocation ? 'ask' : 'default', subfolder: '' };
          }
          jobsList = Array.isArray(res.jobs) ? res.jobs : [];
          recentSaved = Array.isArray(res.recentSaved) ? res.recentSaved : [];
          renderSavedBanner(res.savedBanner);
          renderAll();
        }
      }
    );

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;

      if ((msg.type === 'MEDIA_UPDATED' || msg.type === 'TAB_MEDIA_UPDATED') && msg.tabId === currentTabId) {
        mediaState = msg.payload || mediaState;
        if (!userEditedCaption) {
          const streams = getDetectedVideos();
          const cur = streams.find((s) => s.id === selectedStreamId) || streams[0];
          activeCaptionValue = resolveStreamCaption(cur, mediaState.pageTitle);
        }
        renderVideosDiagnostics();
        renderPictures();
      } else if (msg.type === 'PAGE_CAPTION_UPDATED' && msg.tabId === currentTabId) {
        mediaState.pageTitle = msg.caption || '';
        if (!userEditedCaption) {
          const streams = getDetectedVideos();
          const cur = streams.find((s) => s.id === selectedStreamId) || streams[0];
          activeCaptionValue = resolveStreamCaption(cur, mediaState.pageTitle);
          renderVideosDiagnostics();
        }
      } else if (msg.type === 'DOWNLOAD_PROGRESS') {
        if (Array.isArray(msg.jobs)) {
          jobsList = msg.jobs;
        } else if (msg.job) {
          upsertJobInList(msg.job);
        }
        renderActiveJobs();
        if (msg.job && msg.job.status === 'completed') {
          renderErrorBanner('');
          chrome.storage.local.get(['ums_saved_banner', 'ums_recent_saved'], (data) => {
            renderSavedBanner(data.ums_saved_banner);
            recentSaved = Array.isArray(data.ums_recent_saved) ? data.ums_recent_saved : [];
            renderRecentSaved();
          });
        } else if (msg.job && msg.job.status === 'error' && msg.job.error) {
          renderErrorBanner(msg.job.error);
        }
      }
    });
  }

  init();
})();
