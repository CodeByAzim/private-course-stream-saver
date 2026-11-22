'use strict';

/**
 * Private Course & Stream Saver — CodeByAzimDev
 * Inline Popup Controller (popup.js)
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
  let activeTabName = 'videos';
  let saveLocationOpen = false;
  let saveSettings = { saveMode: 'default', subfolder: '' };
  let mediaState = { pageTitle: '', pageUrl: '', detectedVideos: [], hqImages: [], streams: [], images: [] };
  let jobsList = [];
  let recentSaved = [];
  let recentExpanded = false;

  // Live SPA auto-switch tracking
  let selectedStreamUrl = null;
  let expandedStreamId = null;
  let activeCaptionValue = '';
  let userManuallyEditedCurrentStream = false;

  const el = {
    toggleSaveLocationBar: document.getElementById('toggleSaveLocationBar'),
    saveLocationBar: document.getElementById('saveLocationBar'),
    locationModeSummary: document.getElementById('locationModeSummary'),
    btnModeDefault: document.getElementById('btnModeDefault'),
    btnModeAsk: document.getElementById('btnModeAsk'),
    subfolderInput: document.getElementById('subfolderInput'),
    btnSetSubfolder: document.getElementById('btnSetSubfolder'),
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
    tabVideos: document.getElementById('tabVideos'),
    tabPictures: document.getElementById('tabPictures'),
    btnDownloadAllHq: document.getElementById('btnDownloadAllHq'),
    btnOpenDashboard: document.getElementById('btnOpenDashboard'),
    downloadsSection: document.getElementById('downloadsSection'),
    downloadsHeading: document.getElementById('downloadsHeading'),
    downloadsBulk: document.getElementById('downloadsBulk'),
    btnPauseAll: document.getElementById('btnPauseAll'),
    btnResumeAll: document.getElementById('btnResumeAll'),
    btnClearDone: document.getElementById('btnClearDone'),
    downloadsList: document.getElementById('downloadsList'),
    videosPanel: document.getElementById('videosPanel'),
    pasteLinkInput: document.getElementById('pasteLinkInput'),
    btnPasteLink: document.getElementById('btnPasteLink'),
    btnLoadLink: document.getElementById('btnLoadLink'),
    pasteLinkStatus: document.getElementById('pasteLinkStatus'),
    streamsContainer: document.getElementById('streamsContainer'),
    picturesPanel: document.getElementById('picturesPanel'),
    recentSection: document.getElementById('recentSection'),
    btnToggleRecent: document.getElementById('btnToggleRecent'),
    recentChevron: document.getElementById('recentChevron'),
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
    return `~${Math.round(mb)} MB`;
  }

  function formatEta(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatQualityBaseLabel(height) {
    if (height >= 4320) return '8K UHD (4320p)';
    if (height >= 2160) return '4K UHD (2160p)';
    if (height >= 1440) return '2K QHD (1440p)';
    if (height >= 1080) return '1080p Full HD';
    if (height >= 720) return '720p HD';
    if (height >= 540) return '540p qHD';
    if (height >= 480) return '480p SD';
    if (height >= 360) return '360p';
    if (height > 0) return `${height}p`;
    return 'Original Quality';
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

  function updateSaveLocationUi() {
    const { saveMode, subfolder } = saveSettings;
    if (saveMode === 'ask') {
      el.toggleSaveLocationBar.textContent = '📂 Ask Location';
      el.toggleSaveLocationBar.classList.add('active-mode');
      el.locationModeSummary.textContent = 'Save As Dialog';
    } else if (saveMode === 'subfolder' && subfolder) {
      const shortName = subfolder.length > 16 ? `${subfolder.slice(0, 15)}…` : subfolder;
      el.toggleSaveLocationBar.textContent = `📁 ${shortName}`;
      el.toggleSaveLocationBar.classList.add('active-mode');
      el.locationModeSummary.textContent = `Downloads/${subfolder}/`;
    } else {
      el.toggleSaveLocationBar.textContent = '📁 Default Folder';
      el.toggleSaveLocationBar.classList.remove('active-mode');
      el.locationModeSummary.textContent = 'Downloads/';
    }

    el.btnModeDefault.setAttribute('aria-pressed', saveMode === 'default' ? 'true' : 'false');
    el.btnModeAsk.setAttribute('aria-pressed', saveMode === 'ask' ? 'true' : 'false');
    if (subfolder && document.activeElement !== el.subfolderInput) {
      el.subfolderInput.value = subfolder;
    }

    el.toggleSaveLocationBar.setAttribute('aria-expanded', saveLocationOpen ? 'true' : 'false');
    el.saveLocationBar.classList.toggle('hidden', !saveLocationOpen);
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
    el.btnToggleRecent.querySelector('span').textContent = `Recent Saved (${recentSaved.length})`;
    el.btnToggleRecent.setAttribute('aria-expanded', recentExpanded ? 'true' : 'false');
    el.recentChevron.textContent = recentExpanded ? '▾' : '▸';
    el.recentList.classList.toggle('hidden', !recentExpanded);
    el.recentList.innerHTML = '';
    for (const item of recentSaved.slice(0, 5)) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.textContent = `✓ ${item.filename}`;
      li.title = item.filename;
      el.recentList.appendChild(li);
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
    const visibleJobs = jobsList.filter((j) => j && j.status !== 'cancelled');
    if (visibleJobs.length === 0) {
      el.downloadsSection.classList.add('hidden');
      return;
    }

    el.downloadsSection.classList.remove('hidden');
    const activeCount = visibleJobs.filter(
      (j) => j.status === 'downloading' || j.status === 'paused' || j.status === 'saving'
    ).length;
    el.downloadsHeading.textContent = `Active & Queued Downloads (${activeCount || visibleJobs.length})`;

    const hasDoneOrError = visibleJobs.some((j) => j.status === 'completed' || j.status === 'error');
    const showBulk = visibleJobs.length >= 2 || hasDoneOrError;
    el.downloadsBulk.classList.toggle('hidden', !showBulk);
    el.btnClearDone.classList.toggle('hidden', !hasDoneOrError);

    el.downloadsList.innerHTML = '';

    for (const job of visibleJobs) {
      const card = document.createElement('div');
      card.className = 'job-card';

      const topRow = document.createElement('div');
      topRow.className = 'job-top';

      const nameEl = document.createElement('div');
      nameEl.className = 'job-filename';
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
      badge.className = `job-status-badge ${stateClass}`;
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
      controls.className = 'progress-controls';

      if (job.status !== 'completed') {
        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'btn-ctrl';
        const shouldResume = Boolean(job.isPaused) || job.status === 'paused' || job.status === 'error';
        pauseBtn.textContent = shouldResume ? 'Resume' : 'Pause';
        pauseBtn.addEventListener('click', () => {
          if (!hasChromeExtensionApi()) return;
          chrome.runtime.sendMessage({
            type: shouldResume ? 'RESUME_DOWNLOAD' : 'PAUSE_DOWNLOAD',
            jobId: job.jobId
          }, (res) => {
            if (res && Array.isArray(res.jobs)) {
              jobsList = res.jobs;
              renderActiveJobs();
            }
          });
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

  function setPasteStatus(text, kind = '') {
    if (!text) {
      el.pasteLinkStatus.textContent = '';
      el.pasteLinkStatus.className = 'paste-status hidden';
      return;
    }
    el.pasteLinkStatus.textContent = text;
    el.pasteLinkStatus.className = `paste-status ${kind}`.trim();
  }

  async function inspectPastedUrl(rawUrl) {
    const cleanUrl = String(rawUrl || '').trim();
    if (!cleanUrl) {
      setPasteStatus('Paste a .m3u8, .mpd, .mp4, or stream link first.', 'error');
      el.pasteLinkInput.focus();
      return;
    }
    el.btnLoadLink.disabled = true;
    el.btnPasteLink.disabled = true;
    setPasteStatus('Inspecting stream link...');

    if (!hasChromeExtensionApi()) {
      el.btnLoadLink.disabled = false;
      el.btnPasteLink.disabled = false;
      setPasteStatus('Load Link is active when running inside Chrome Extension.', 'error');
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'INSPECT_LINK_URL', url: cleanUrl, tabId: currentTabId },
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
        const stream = res.stream;
        setPasteStatus(`Loaded ${stream.kind.toUpperCase()} stream at #1`, 'ok');
        el.pasteLinkInput.value = '';
        selectedStreamUrl = stream.url;
        expandedStreamId = stream.id;
        userManuallyEditedCurrentStream = false;
        activeCaptionValue = resolveStreamCaption(stream, mediaState.pageTitle);

        chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTabId }, (tabRes) => {
          if (tabRes && tabRes.ok && tabRes.media) {
            mediaState = tabRes.media;
            renderVideos();
          }
        });
      }
    );
  }

  function syncTopStreamSelection(detectedVideos) {
    if (!detectedVideos || detectedVideos.length === 0) {
      selectedStreamUrl = null;
      expandedStreamId = null;
      return;
    }
    const top = detectedVideos[0];
    if (top.url !== selectedStreamUrl) {
      selectedStreamUrl = top.url;
      expandedStreamId = top.id;
      userManuallyEditedCurrentStream = false;
      activeCaptionValue = resolveStreamCaption(top, mediaState.pageTitle);
    } else if (!expandedStreamId || !detectedVideos.some((s) => s.id === expandedStreamId)) {
      expandedStreamId = top.id;
    }
  }

  /**
   * Builds Quality & Format options for any HLS / DASH / Progressive stream:
   * - Keeps BOTH highest-bitrate "(★ Best)" AND same-resolution "(Data Saver)"
   *   when lower bitrate is at least 15% smaller (<= 85% of highest bitrate).
   * - Includes pre-download ~MB estimate in every option label when available.
   */
  function buildQualityOptionsForStream(stream) {
    const outExt = resolveStreamOutputExt(stream);
    const duration = normalizeDurationSeconds(stream.totalDuration) || normalizeDurationSeconds(mediaState.pageDuration);
    const audioTracks = Array.isArray(stream.audioTracks) ? stream.audioTracks : [];
    const audioBw = audioTracks.length > 0 ? (stream.primaryAudioBandwidth || 128000) : 0;

    const rawVariants = Array.isArray(stream.variants) && stream.variants.length > 0
      ? [...stream.variants]
      : [{
          url: stream.url,
          width: 0,
          height: stream.height || 0,
          bandwidth: 0,
          averageBandwidth: 0,
          codecs: '',
          audioGroup: '',
          subtitleGroup: '',
          estimatedBytes: stream.sizeBytes || 0,
          isBest: true,
          label: stream.qualityBadge || formatQualityBaseLabel(stream.height || 0)
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
      const baseLabel = formatQualityBaseLabel(h);
      const bestSuffix = isBest ? ' (★ Best)' : '';
      const sizeText = formatApproxMb(highEst);

      options.push({
        value: String(options.length),
        label: sizeText ? `${baseLabel}${bestSuffix} · ${sizeText}` : `${baseLabel}${bestSuffix}`,
        url: highest.url,
        height: h,
        bandwidth: highBw,
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
        const lowSizeText = formatApproxMb(lowEst);
        options.push({
          value: String(options.length),
          label: lowSizeText ? `${baseLabel} (Data Saver) · ${lowSizeText}` : `${baseLabel} (Data Saver)`,
          url: lowest.url,
          height: h,
          bandwidth: lowBw,
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
    const audioSizeText = formatApproxMb(audioEst);

    options.push({
      value: 'mp3',
      label: audioSizeText
        ? `MP3 Audio Only (Original Quality) · ${audioSizeText}`
        : 'MP3 Audio Only (Original Quality)',
      url: options[0] ? options[0].url : stream.url,
      height: 0,
      bandwidth: stream.primaryAudioBandwidth || 128000,
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

  function renderVideos() {
    const streams = getDetectedVideos();
    el.tabVideos.textContent = `Videos (${streams.length})`;
    el.streamsContainer.innerHTML = '';

    if (streams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <div class="empty-title">No streams detected on this page yet</div>
        <div>Play a video, click Refresh, or paste any stream link above.</div>
      `;
      el.streamsContainer.appendChild(empty);
      return;
    }

    syncTopStreamSelection(streams);

    streams.forEach((stream, index) => {
      const isExpanded = stream.id === expandedStreamId;
      const card = document.createElement('div');
      card.className = 'stream-card';

      let hostLabel = 'Stream';
      try {
        hostLabel = new URL(stream.url).hostname;
      } catch (_) {}

      const durationSecs = normalizeDurationSeconds(stream.totalDuration) || normalizeDurationSeconds(mediaState.pageDuration);
      const durationText = formatDurationDisplay(durationSecs);
      const kindLabel = stream.kind.toUpperCase();

      const streamResolvedCap = isExpanded && userManuallyEditedCurrentStream
        ? (activeCaptionValue || CAPTION_PLACEHOLDER)
        : resolveStreamCaption(stream, mediaState.pageTitle);

      const summaryBtn = document.createElement('button');
      summaryBtn.type = 'button';
      summaryBtn.className = 'stream-summary';
      summaryBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      const kickerBadge = stream.isPasted
        ? '★ Pasted Link'
        : (index === 0 ? '★ #1 Best Stream' : `Stream #${index + 1}`);
      summaryBtn.innerHTML = `
        <div class="stream-summary-left">
          <div class="stream-kicker-row">
            <div class="stream-kicker">${kickerBadge} · ${kindLabel}</div>
            ${durationText ? `<span class="duration-badge">${durationText}</span>` : ''}
          </div>
          <div class="stream-caption-title ${streamResolvedCap === CAPTION_PLACEHOLDER ? 'is-placeholder' : ''}" data-stream-summary-caption="${isExpanded ? '1' : '0'}"></div>
          <div class="stream-host">${hostLabel}</div>
        </div>
        <span style="font-size:12px;color:#475569;">${isExpanded ? '▾' : '▸'}</span>
      `;
      const summaryCapEl = summaryBtn.querySelector('.stream-caption-title');
      if (summaryCapEl) summaryCapEl.textContent = streamResolvedCap;
      summaryBtn.addEventListener('click', () => {
        if (isExpanded) {
          expandedStreamId = null;
        } else {
          expandedStreamId = stream.id;
          selectedStreamUrl = stream.url;
          userManuallyEditedCurrentStream = false;
          activeCaptionValue = resolveStreamCaption(stream, mediaState.pageTitle);
        }
        renderVideos();
      });
      card.appendChild(summaryBtn);

      if (isExpanded) {
        const body = document.createElement('div');
        body.className = 'stream-body';

        const qualityOptions = buildQualityOptionsForStream(stream);
        const topHeight = qualityOptions.reduce((maxH, opt) => Math.max(maxH, opt.height || 0), stream.height || 0);
        const detailsBar = document.createElement('div');
        detailsBar.className = 'stream-details-bar';
        const formatSpan = document.createElement('span');
        formatSpan.textContent = `${kindLabel}${topHeight > 0 ? ` · Up to ${topHeight}p` : ''}`;
        detailsBar.appendChild(formatSpan);
        if (durationText) {
          const durSpan = document.createElement('span');
          durSpan.className = 'duration-badge';
          durSpan.textContent = durationText;
          detailsBar.appendChild(durSpan);
        }
        body.appendChild(detailsBar);

        const captionGroup = document.createElement('div');
        const captionLabel = document.createElement('label');
        captionLabel.className = 'field-label';
        captionLabel.textContent = 'Video Caption';
        const captionRow = document.createElement('div');
        captionRow.className = 'caption-row';
        const captionInput = document.createElement('input');
        captionInput.type = 'text';
        captionInput.className = 'input';
        captionInput.setAttribute('data-active-caption', '1');
        captionInput.value = userManuallyEditedCurrentStream
          ? activeCaptionValue
          : (activeCaptionValue || resolveStreamCaption(stream, mediaState.pageTitle));
        if (captionInput.value.trim() === CAPTION_PLACEHOLDER) {
          captionInput.classList.add('caption-placeholder');
        }
        captionInput.placeholder = CAPTION_PLACEHOLDER;

        const btnPasteCaption = document.createElement('button');
        btnPasteCaption.type = 'button';
        btnPasteCaption.className = 'btn-caption-paste';
        btnPasteCaption.textContent = 'Paste';
        btnPasteCaption.title = 'Paste video caption from clipboard';

        const captionGuardMsg = document.createElement('div');
        captionGuardMsg.className = 'caption-guard-msg hidden';

        captionRow.appendChild(captionInput);
        captionRow.appendChild(btnPasteCaption);
        captionGroup.appendChild(captionLabel);
        captionGroup.appendChild(captionRow);
        captionGroup.appendChild(captionGuardMsg);
        body.appendChild(captionGroup);

        const previewGroup = document.createElement('div');
        const previewLabel = document.createElement('div');
        previewLabel.className = 'field-label';
        previewLabel.textContent = 'Output Filename Preview';
        const previewBox = document.createElement('div');
        previewBox.className = 'filename-preview';
        previewBox.setAttribute('data-active-preview', '1');
        previewGroup.appendChild(previewLabel);
        previewGroup.appendChild(previewBox);
        body.appendChild(previewGroup);

        let defaultOptIdx = qualityOptions.findIndex((o) => o.isBest);
        if (defaultOptIdx === -1) defaultOptIdx = 0;

        const qualityGroup = document.createElement('div');
        const qualityLabel = document.createElement('label');
        qualityLabel.className = 'field-label';
        qualityLabel.textContent = 'Quality & Format';
        const qualitySelect = document.createElement('select');
        qualitySelect.className = 'select';
        qualitySelect.setAttribute('data-active-quality', '1');

        qualityOptions.forEach((optItem, idx) => {
          const opt = document.createElement('option');
          opt.value = optItem.value;
          opt.textContent = optItem.label;
          if (idx === defaultOptIdx) opt.selected = true;
          qualitySelect.appendChild(opt);
        });

        qualityGroup.appendChild(qualityLabel);
        qualityGroup.appendChild(qualitySelect);
        body.appendChild(qualityGroup);

        const audioTracks = Array.isArray(stream.audioTracks) ? stream.audioTracks : [];
        const subtitleTracks = Array.isArray(stream.subtitleTracks) ? stream.subtitleTracks : [];
        let audioSelect = null;
        let subSelect = null;

        if (audioTracks.length > 0 || subtitleTracks.length > 0) {
          const tracksRow = document.createElement('div');
          tracksRow.className = audioTracks.length > 0 && subtitleTracks.length > 0 ? 'row-2' : '';

          if (audioTracks.length > 0) {
            const aWrap = document.createElement('div');
            const aLbl = document.createElement('label');
            aLbl.className = 'field-label';
            aLbl.textContent = 'Audio Track';
            audioSelect = document.createElement('select');
            audioSelect.className = 'select';
            let defaultAudioIdx = audioTracks.findIndex((t) => t.isDefault);
            if (defaultAudioIdx === -1) defaultAudioIdx = 0;
            audioTracks.forEach((t, idx) => {
              const opt = document.createElement('option');
              opt.value = t.uri;
              opt.textContent = t.name || t.language || `Audio ${idx + 1}`;
              if (idx === defaultAudioIdx) opt.selected = true;
              audioSelect.appendChild(opt);
            });
            aWrap.appendChild(aLbl);
            aWrap.appendChild(audioSelect);
            tracksRow.appendChild(aWrap);
          }

          if (subtitleTracks.length > 0) {
            const sWrap = document.createElement('div');
            const sLbl = document.createElement('label');
            sLbl.className = 'field-label';
            sLbl.textContent = 'Subtitle Track';
            subSelect = document.createElement('select');
            subSelect.className = 'select';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = 'None';
            subSelect.appendChild(noneOpt);
            subtitleTracks.forEach((t, idx) => {
              const opt = document.createElement('option');
              opt.value = t.uri;
              opt.textContent = t.name || t.language || `Subtitle ${idx + 1}`;
              subSelect.appendChild(opt);
            });
            sWrap.appendChild(sLbl);
            sWrap.appendChild(subSelect);
            tracksRow.appendChild(sWrap);
          }

          body.appendChild(tracksRow);
        }

        const updatePreview = () => {
          const isMp3 = qualitySelect.value === 'mp3';
          const outExt = isMp3 ? 'mp3' : resolveStreamOutputExt(stream);
          const prefix = saveSettings.saveMode === 'subfolder' && saveSettings.subfolder
            ? `${saveSettings.subfolder}/`
            : '';
          previewBox.textContent = `${prefix}${formatOutputFilename(captionInput.value, outExt)}`;
          if (summaryCapEl) {
            const trimmedVal = captionInput.value.trim();
            summaryCapEl.textContent = trimmedVal || CAPTION_PLACEHOLDER;
            summaryCapEl.classList.toggle('is-placeholder', !trimmedVal || trimmedVal === CAPTION_PLACEHOLDER);
          }
          captionInput.classList.toggle('caption-placeholder', captionInput.value.trim() === CAPTION_PLACEHOLDER);
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
          userManuallyEditedCurrentStream = true;
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
            userManuallyEditedCurrentStream = true;
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

        const dupNotice = document.createElement('div');
        dupNotice.className = 'dup-notice hidden';
        qualitySelect.addEventListener('change', () => {
          dupNotice.classList.add('hidden');
          updatePreview();
        });

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'btn-download';
        dlBtn.textContent = 'Download Now';
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

          const chosenOpt = qualityOptions.find((o) => o.value === qualitySelect.value) || qualityOptions[0];
          const isMp3 = chosenOpt.outputFormat === 'mp3';
          const outExt = chosenOpt.outputFormat;
          const filename = formatOutputFilename(rawCaption, outExt);

          const selectedAudioUri = audioSelect ? audioSelect.value : (audioTracks[0] ? audioTracks[0].uri : '');
          const chosenAudioTrack = audioTracks.find((t) => t.uri === selectedAudioUri) || audioTracks[0] || null;
          const isDash = stream.kind === 'dash';
          const isHls = stream.kind === 'hls';
          const isProgressive = !isDash && !isHls;
          const exactVideoUrl = chosenOpt.url || stream.url;
          const qualityKey = `${chosenOpt.height || 0}:${chosenOpt.bandwidth || 0}:${outExt}:${chosenOpt.isDataSaver ? 'ds' : 'std'}`;
          const streamSignature = `${exactVideoUrl}::${filename}`;

          const existingDup = findClientDuplicateJob(exactVideoUrl, filename);
          if (existingDup) {
            dupNotice.textContent = 'Already downloading this stream';
            dupNotice.classList.remove('hidden');
            return;
          }
          dupNotice.classList.add('hidden');

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
            streamUrl: stream.url,
            qualityKey,
            streamSignature,
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
            subtitleUrl: subSelect && subSelect.value ? subSelect.value : null,
            referer: stream.referer || mediaState.pageUrl || ''
          };

          if (hasChromeExtensionApi()) {
            chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', job }, (res) => {
              if (res && res.duplicate) {
                dupNotice.textContent = res.error || 'Already downloading this stream';
                dupNotice.classList.remove('hidden');
              } else if (res && res.ok) {
                if (Array.isArray(res.jobs)) {
                  jobsList = res.jobs;
                } else if (res.job) {
                  upsertJobInList(res.job);
                }
                renderActiveJobs();
              }
            });
          }
        });

        body.appendChild(dupNotice);
        body.appendChild(dlBtn);
        card.appendChild(body);
      }

      el.streamsContainer.appendChild(card);
    });
  }

  function updateOpenCaptionDomInPlace(newCaption) {
    const resolved = cleanCaptionCandidate(newCaption) || CAPTION_PLACEHOLDER;
    const input = el.streamsContainer.querySelector('input[data-active-caption="1"]');
    const preview = el.streamsContainer.querySelector('[data-active-preview="1"]');
    const qualitySelect = el.streamsContainer.querySelector('select[data-active-quality="1"]');
    const summaryCap = el.streamsContainer.querySelector('[data-stream-summary-caption="1"]');
    if (summaryCap) {
      summaryCap.textContent = resolved;
      summaryCap.classList.toggle('is-placeholder', resolved === CAPTION_PLACEHOLDER);
    }
    if (!input || !preview) return;
    input.value = resolved;
    input.classList.toggle('caption-placeholder', resolved === CAPTION_PLACEHOLDER);
    const isMp3 = qualitySelect && qualitySelect.value === 'mp3';
    const top = getDetectedVideos()[0];
    const outExt = isMp3 ? 'mp3' : resolveStreamOutputExt(top);
    const prefix = saveSettings.saveMode === 'subfolder' && saveSettings.subfolder
      ? `${saveSettings.subfolder}/`
      : '';
    preview.textContent = `${prefix}${formatOutputFilename(resolved, outExt)}`;
  }

  function guessImgExt(url) {
    const m = url.match(/\.(png|webp|jpeg|jpg|avif|gif)(\?|#|$)/i);
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    return 'jpg';
  }

  function renderPictures() {
    const images = getDetectedImages();
    el.tabPictures.textContent = `HQ Pictures (${images.length})`;
    el.btnDownloadAllHq.classList.toggle('hidden', activeTabName !== 'pictures' || images.length === 0);
    el.picturesPanel.innerHTML = '';

    if (images.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <div class="empty-title">No HQ pictures (&ge; 250&times;250px) detected</div>
        <div>Scroll down on the page or click Refresh to scan newly loaded images.</div>
      `;
      el.picturesPanel.appendChild(empty);
      return;
    }

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
      card.appendChild(thumb);

      const footer = document.createElement('div');
      footer.className = 'pic-footer';

      const dims = document.createElement('span');
      dims.className = 'pic-dims';
      dims.textContent = `${img.width}×${img.height}`;

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'pic-dl-btn';
      dlBtn.textContent = 'Download HQ';
      dlBtn.addEventListener('click', () => {
        const ext = guessImgExt(img.url);
        const filename = `${sanitizeCaption(img.alt || `HQ_Image_${idx + 1}`)} [CodeByAzimDev].${ext}`;
        if (hasChromeExtensionApi()) {
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_DIRECT_MEDIA',
            url: img.url,
            filename,
            isBatch: false
          });
        }
      });

      footer.appendChild(dims);
      footer.appendChild(dlBtn);
      card.appendChild(footer);
      grid.appendChild(card);
    });

    el.picturesPanel.appendChild(grid);
  }

  function switchTab(tabName) {
    activeTabName = tabName;
    el.tabVideos.setAttribute('aria-selected', tabName === 'videos' ? 'true' : 'false');
    el.tabPictures.setAttribute('aria-selected', tabName === 'pictures' ? 'true' : 'false');
    el.videosPanel.classList.toggle('hidden', tabName !== 'videos');
    el.picturesPanel.classList.toggle('hidden', tabName !== 'pictures');
    const images = getDetectedImages();
    el.btnDownloadAllHq.classList.toggle(
      'hidden',
      tabName !== 'pictures' || images.length === 0
    );
  }

  function renderAll() {
    updateSaveLocationUi();
    renderVideos();
    renderPictures();
    renderActiveJobs();
    renderRecentSaved();
  }

  // Save Location Bar Handlers
  el.toggleSaveLocationBar.addEventListener('click', () => {
    saveLocationOpen = !saveLocationOpen;
    updateSaveLocationUi();
  });

  el.btnModeDefault.addEventListener('click', async () => {
    await persistSaveSettings({ saveMode: 'default', subfolder: '' });
    el.subfolderInput.value = '';
    saveLocationOpen = false;
    updateSaveLocationUi();
    renderVideos();
  });

  el.btnModeAsk.addEventListener('click', async () => {
    await persistSaveSettings({ saveMode: 'ask', subfolder: saveSettings.subfolder || '' });
    saveLocationOpen = false;
    updateSaveLocationUi();
    renderVideos();
  });

  const applyCustomSubfolder = async () => {
    const clean = sanitizeSubfolder(el.subfolderInput.value);
    if (!clean) {
      el.subfolderInput.focus();
      return;
    }
    el.subfolderInput.value = clean;
    await persistSaveSettings({ saveMode: 'subfolder', subfolder: clean });
    saveLocationOpen = false;
    updateSaveLocationUi();
    renderVideos();
  };

  el.btnSetSubfolder.addEventListener('click', applyCustomSubfolder);
  el.subfolderInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCustomSubfolder();
    }
  });

  el.btnChangeDrive.addEventListener('click', () => {
    if (hasChromeExtensionApi()) {
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    }
  });

  // Paste Any Video Link Handlers
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

  el.btnLoadLink.addEventListener('click', () => {
    inspectPastedUrl(el.pasteLinkInput.value);
  });

  el.pasteLinkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inspectPastedUrl(el.pasteLinkInput.value);
    }
  });

  // Bulk Multi-Download Handlers
  el.btnPauseAll.addEventListener('click', () => {
    if (!hasChromeExtensionApi()) return;
    chrome.runtime.sendMessage({ type: 'PAUSE_ALL_DOWNLOADS' }, (res) => {
      if (res && Array.isArray(res.jobs)) {
        jobsList = res.jobs;
        renderActiveJobs();
      }
    });
  });

  el.btnResumeAll.addEventListener('click', () => {
    if (!hasChromeExtensionApi()) return;
    chrome.runtime.sendMessage({ type: 'RESUME_ALL_DOWNLOADS' }, (res) => {
      if (res && Array.isArray(res.jobs)) {
        jobsList = res.jobs;
        renderActiveJobs();
      }
    });
  });

  el.btnClearDone.addEventListener('click', () => {
    jobsList = jobsList.filter((j) => j.status === 'downloading' || j.status === 'paused' || j.status === 'saving');
    renderActiveJobs();
    if (hasChromeExtensionApi()) {
      chrome.runtime.sendMessage({ type: 'CLEAR_DONE_DOWNLOADS' });
    }
  });

  el.btnRefresh.addEventListener('click', () => {
    if (hasChromeExtensionApi() && currentTabId >= 0) {
      chrome.runtime.sendMessage({ type: 'REFRESH_TAB_SCAN', tabId: currentTabId }, (res) => {
        if (res && res.ok && res.media) {
          mediaState = res.media;
          renderAll();
        }
      });
    }
  });

  el.btnClear.addEventListener('click', () => {
    selectedStreamUrl = null;
    expandedStreamId = null;
    activeCaptionValue = '';
    userManuallyEditedCurrentStream = false;
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
      mediaState.streams = [];
      mediaState.images = [];
      renderAll();
    }
  });

  el.dismissSavedBanner.addEventListener('click', () => {
    el.savedBanner.classList.add('hidden');
    if (hasChromeExtensionApi()) {
      chrome.storage.local.remove('ums_saved_banner');
    }
  });

  if (el.dismissErrorBanner) {
    el.dismissErrorBanner.addEventListener('click', () => {
      renderErrorBanner('');
    });
  }

  el.tabVideos.addEventListener('click', () => switchTab('videos'));
  el.tabPictures.addEventListener('click', () => switchTab('pictures'));

  if (el.btnOpenDashboard) {
    el.btnOpenDashboard.addEventListener('click', () => {
      const qs = new URLSearchParams();
      if (currentTabId >= 0) qs.set('tabId', String(currentTabId));
      if (expandedStreamId) qs.set('streamId', expandedStreamId);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      if (hasChromeExtensionApi()) {
        const dashUrl = chrome.runtime.getURL(`download.html${suffix}`);
        chrome.tabs.create({ url: dashUrl });
      } else {
        window.location.href = `download.html${suffix}`;
      }
    });
  }

  el.btnDownloadAllHq.addEventListener('click', () => {
    if (!hasChromeExtensionApi()) return;
    const images = getDetectedImages();
    images.forEach((img, idx) => {
      const ext = guessImgExt(img.url);
      const filename = `${sanitizeCaption(img.alt || `HQ_Image_${idx + 1}`)} [CodeByAzimDev].${ext}`;
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_DIRECT_MEDIA',
        url: img.url,
        filename,
        isBatch: true
      });
    });
  });

  el.btnToggleRecent.addEventListener('click', () => {
    recentExpanded = !recentExpanded;
    renderRecentSaved();
  });

  window.addEventListener('online', updateOfflineUi);
  window.addEventListener('offline', updateOfflineUi);

  async function init() {
    updateOfflineUi();
    if (!hasChromeExtensionApi()) {
      renderAll();
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tabs && tabs[0] ? tabs[0].id : -1;

    if (currentTabId >= 0) {
      chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTabId }, (res) => {
        if (res && res.ok) {
          mediaState = res.media || mediaState;
          if (res.saveSettings) {
            saveSettings = {
              saveMode: res.saveSettings.saveMode || 'default',
              subfolder: res.saveSettings.subfolder || ''
            };
          } else {
            saveSettings = { saveMode: res.askLocation ? 'ask' : 'default', subfolder: '' };
          }
          jobsList = Array.isArray(res.jobs) ? res.jobs : (res.activeJob ? [res.activeJob] : []);
          recentSaved = Array.isArray(res.recentSaved) ? res.recentSaved : [];
          renderSavedBanner(res.savedBanner);
          renderAll();
        }
      });
    }

    let lastVideoSig = '';
    const computeVideoSig = (videos) =>
      `${Math.round(mediaState.pageDuration || 0)}::` +
      (videos || [])
        .map((v) => `${v.id}|${v.url}|${v.isMaster ? 1 : 0}|${(v.variants || []).length}|${Math.round(v.totalDuration || 0)}`)
        .join(';');

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;

      if ((msg.type === 'MEDIA_UPDATED' || msg.type === 'TAB_MEDIA_UPDATED') && msg.tabId === currentTabId) {
        mediaState = msg.payload || mediaState;
        const videos = getDetectedVideos();
        const nextVideoSig = computeVideoSig(videos);
        const top = videos[0];

        if (top && top.url !== selectedStreamUrl) {
          selectedStreamUrl = top.url;
          expandedStreamId = top.id;
          userManuallyEditedCurrentStream = false;
          activeCaptionValue = resolveStreamCaption(top, mediaState.pageTitle);
          lastVideoSig = nextVideoSig;
          renderVideos();
        } else if (nextVideoSig !== lastVideoSig) {
          lastVideoSig = nextVideoSig;
          if (!userManuallyEditedCurrentStream) {
            activeCaptionValue = resolveStreamCaption(top, mediaState.pageTitle);
          }
          renderVideos();
        } else if (!userManuallyEditedCurrentStream) {
          const nextCap = resolveStreamCaption(top, mediaState.pageTitle);
          if (nextCap !== activeCaptionValue) {
            activeCaptionValue = nextCap;
            updateOpenCaptionDomInPlace(nextCap);
          }
        }
        renderPictures();
      } else if (msg.type === 'PAGE_CAPTION_UPDATED' && msg.tabId === currentTabId) {
        mediaState.pageTitle = msg.caption || '';
        if (!userManuallyEditedCurrentStream) {
          const top = getDetectedVideos()[0];
          activeCaptionValue = resolveStreamCaption(top, mediaState.pageTitle);
          updateOpenCaptionDomInPlace(activeCaptionValue);
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
