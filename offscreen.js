'use strict';

/**
 * Private Course & Stream Saver — CodeByAzim
 * Offscreen Concurrent 32-Worker CORS-Safe Engine & Dual-Track Remuxer (offscreen.js)
 */

const GLOBAL_MAX_WORKERS = 32;
const MAX_RETRIES = 8;
const UI_THROTTLE_MS = 250;
const HEARTBEAT_MS = 20000;
const RANGE_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB parallel range chunks
const DIRECT_RANGE_ACCEL_MIN_BYTES = 4 * 1024 * 1024; // Accelerate > 4 MB direct files supporting Accept-Ranges
const MIN_VALID_BLOB_BYTES = 10240; // 10 KB minimum valid media file guard

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
];

/** @type {Map<string, any>} */
const jobStates = new Map();
/** @type {Set<string>} */
const activeBlobUrls = new Set();
/** @type {Map<string, string>} */
const blobUrlToJobId = new Map();

let globalActiveWorkers = 0;
/** @type {Array<() => void>} */
const workerWaiters = [];
let heartbeatTimer = null;

function notifyWorkerWaiters() {
  while (workerWaiters.length > 0) {
    const resolve = workerWaiters.shift();
    if (typeof resolve === 'function') resolve();
  }
}

function waitForWorkerSignal(timeoutMs = 120) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    workerWaiters.push(() => {
      clearTimeout(timer);
      done();
    });
  });
}

function getActiveFetchingJobCount() {
  let count = 0;
  for (const st of jobStates.values()) {
    if (!st.cancelled && st.status === 'downloading' && !st.isPaused) {
      count++;
    }
  }
  return count;
}

function computePerJobCap(state) {
  const activeCount = Math.max(1, getActiveFetchingJobCount());
  const fairShare = Math.max(4, Math.floor(GLOBAL_MAX_WORKERS / activeCount));
  return Math.min(state.maxActiveLimit || GLOBAL_MAX_WORKERS, fairShare);
}

function hasRunningOrPausedJobs() {
  for (const st of jobStates.values()) {
    if (!st.cancelled && (st.status === 'downloading' || st.status === 'paused' || st.status === 'saving')) {
      return true;
    }
  }
  return false;
}

function startHeartbeatIfNeeded() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_HEARTBEAT' }).catch(() => {});
  }, HEARTBEAT_MS);
}

function stopHeartbeatIfIdle() {
  if (hasRunningOrPausedJobs()) return;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDownloadUrl(rawUrl) {
  return rawUrl;
}

async function corsSafeFetch(url, signal, responseType = 'arraybuffer', byteRange = null) {
  const safeUrl = normalizeDownloadUrl(url);
  const buildOpts = (credentials) => {
    const opts = { credentials, signal };
    if (byteRange) {
      opts.headers = { Range: `bytes=${byteRange}` };
    }
    return opts;
  };

  let res = await fetch(safeUrl, buildOpts('omit'));
  if (res.status === 401 || res.status === 403) {
    res = await fetch(safeUrl, buildOpts('include'));
  }
  if (res.status === 429 || res.status === 503) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : 1500;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (responseType === 'text') return res.text();
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function resolveUrl(baseUrl, relUrl) {
  try {
    return new URL(relUrl, baseUrl).href;
  } catch (_) {
    return relUrl;
  }
}

function parseAttributes(attrStr) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let mediaSequence = 0;
  let mapUri = null;
  let currentKey = null;
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        mapUri = resolveUrl(baseUrl, attrs.URI);
      }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128' && attrs.URI) {
        currentKey = {
          method: 'AES-128',
          uri: resolveUrl(baseUrl, attrs.URI),
          ivHex: attrs.IV || null
        };
      }
    } else if (!line.startsWith('#')) {
      const segUrl = resolveUrl(baseUrl, line);
      const seqNum = mediaSequence + segments.length;
      segments.push({
        index: segments.length,
        seqNum,
        url: segUrl,
        range: null,
        key: currentKey ? { ...currentKey } : null
      });
    }
  }

  return { mapUri, segments, mediaSequence };
}

function parseHexIv(ivHex, seqNum) {
  const iv = new Uint8Array(16);
  if (ivHex) {
    const clean = ivHex.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) {
      iv[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return iv;
  }
  const view = new DataView(iv.buffer);
  view.setUint32(12, seqNum >>> 0, false);
  return iv;
}

// =========================================================================
// ISO BMFF (fMP4) Dual-Track Merger & Track ID Patcher
// =========================================================================

function readBoxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({
      type,
      start: offset,
      end: offset + size,
      headerSize,
      data: bytes.subarray(offset, offset + size)
    });
    offset += size;
  }
  return boxes;
}

function makeBox(type, childrenOrPayload) {
  const chunks = Array.isArray(childrenOrPayload) ? childrenOrPayload : [childrenOrPayload];
  let totalPayload = 0;
  for (const c of chunks) totalPayload += c.byteLength;
  const out = new Uint8Array(8 + totalPayload);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  let pos = 8;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function patchTrackIdInTrak(trakBytes, newTrackId) {
  const copy = new Uint8Array(trakBytes);
  const children = readBoxes(copy, 8, copy.length);
  for (const child of children) {
    if (child.type === 'tkhd') {
      const version = copy[child.start + 8];
      const trackIdOffset = child.start + (version === 1 ? 28 : 20);
      if (trackIdOffset + 4 <= child.end) {
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        view.setUint32(trackIdOffset, newTrackId, false);
      }
    }
  }
  return copy;
}

function patchTrackIdInTrex(trexBytes, newTrackId) {
  const copy = new Uint8Array(trexBytes);
  if (copy.length >= 16) {
    const view = new DataView(copy.buffer);
    view.setUint32(12, newTrackId, false);
  }
  return copy;
}

function patchMvhdNextTrackId(mvhdBytes, nextTrackId) {
  const copy = new Uint8Array(mvhdBytes);
  const version = copy[8];
  const offset = version === 1 ? 108 : 96;
  if (offset + 4 <= copy.length) {
    const view = new DataView(copy.buffer);
    view.setUint32(offset, nextTrackId, false);
  }
  return copy;
}

function mergeFmp4Inits(videoInit, audioInit) {
  if (!videoInit || videoInit.length === 0) return audioInit;
  if (!audioInit || audioInit.length === 0) return videoInit;

  const vTop = readBoxes(videoInit);
  const aTop = readBoxes(audioInit);
  const vMoov = vTop.find((b) => b.type === 'moov');
  const aMoov = aTop.find((b) => b.type === 'moov');
  if (!vMoov || !aMoov) {
    return videoInit;
  }

  const aMoovChildren = readBoxes(aMoov.data, aMoov.headerSize, aMoov.data.length);
  const aTraks = aMoovChildren
    .filter((b) => b.type === 'trak')
    .map((b) => patchTrackIdInTrak(b.data, 2));
  if (aTraks.length === 0) return videoInit;

  const aMvex = aMoovChildren.find((b) => b.type === 'mvex');
  let aTrexList = [];
  if (aMvex) {
    aTrexList = readBoxes(aMvex.data, aMvex.headerSize, aMvex.data.length)
      .filter((b) => b.type === 'trex')
      .map((b) => patchTrackIdInTrex(b.data, 2));
  }

  const vMoovChildren = readBoxes(vMoov.data, vMoov.headerSize, vMoov.data.length);
  const newMoovChildren = [];
  for (const child of vMoovChildren) {
    if (child.type === 'mvhd') {
      newMoovChildren.push(patchMvhdNextTrackId(child.data, 3));
    } else if (child.type === 'mvex' && aTrexList.length > 0) {
      const vMvexChildren = readBoxes(child.data, child.headerSize, child.data.length).map((b) => b.data);
      newMoovChildren.push(makeBox('mvex', [...vMvexChildren, ...aTrexList]));
    } else {
      newMoovChildren.push(child.data);
    }
  }
  for (const aTrak of aTraks) {
    newMoovChildren.push(aTrak);
  }
  const mergedMoov = makeBox('moov', newMoovChildren);

  const outTop = [];
  for (const box of vTop) {
    if (box.type === 'moov') {
      outTop.push(mergedMoov);
    } else {
      outTop.push(box.data);
    }
  }
  return concatUint8Arrays(outTop);
}

function patchTfhdBox(tfhdBytes, targetTrackId) {
  const tfFlags = (tfhdBytes[9] << 16) | (tfhdBytes[10] << 8) | tfhdBytes[11];
  const hasBaseDataOffset = (tfFlags & 0x000001) !== 0;
  const newFlags = (tfFlags & ~0x000001) | 0x020000;

  let out;
  if (hasBaseDataOffset) {
    out = new Uint8Array(tfhdBytes.length - 8);
    out.set(tfhdBytes.subarray(0, 16), 0);
    out.set(tfhdBytes.subarray(24), 16);
  } else {
    out = new Uint8Array(tfhdBytes);
  }

  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  out[9] = (newFlags >>> 16) & 0xff;
  out[10] = (newFlags >>> 8) & 0xff;
  out[11] = newFlags & 0xff;
  view.setUint32(12, targetTrackId, false);
  return { bytes: out, deltaBytes: hasBaseDataOffset ? -8 : 0 };
}

function patchTrunDataOffset(trunBytes, deltaBytes) {
  if (!deltaBytes) return trunBytes;
  const trunFlags = (trunBytes[9] << 16) | (trunBytes[10] << 8) | trunBytes[11];
  if ((trunFlags & 0x000001) === 0 || trunBytes.length < 20) return trunBytes;
  const copy = new Uint8Array(trunBytes);
  const view = new DataView(copy.buffer);
  const currentOffset = view.getInt32(16, false);
  view.setInt32(16, currentOffset + deltaBytes, false);
  return copy;
}

function patchAudioFragment(fragmentBytes) {
  const topBoxes = readBoxes(fragmentBytes);
  if (topBoxes.length === 0) return fragmentBytes;

  const outTop = [];
  for (const top of topBoxes) {
    if (top.type !== 'moof') {
      outTop.push(top.data);
      continue;
    }

    const moofChildren = readBoxes(top.data, top.headerSize, top.data.length);
    const newMoofChildren = [];

    for (const mc of moofChildren) {
      if (mc.type !== 'traf') {
        newMoofChildren.push(mc.data);
        continue;
      }
      const trafChildren = readBoxes(mc.data, mc.headerSize, mc.data.length);
      let trafDelta = 0;
      const patchedFirstPass = [];
      for (const tc of trafChildren) {
        if (tc.type === 'tfhd') {
          const res = patchTfhdBox(tc.data, 2);
          trafDelta += res.deltaBytes;
          patchedFirstPass.push({ type: tc.type, data: res.bytes });
        } else {
          patchedFirstPass.push({ type: tc.type, data: tc.data });
        }
      }
      const finalTrafChildren = patchedFirstPass.map((tc) =>
        tc.type === 'trun' ? patchTrunDataOffset(tc.data, trafDelta) : tc.data
      );
      newMoofChildren.push(makeBox('traf', finalTrafChildren));
    }

    outTop.push(makeBox('moof', newMoofChildren));
  }

  return concatUint8Arrays(outTop);
}

// =========================================================================
// ADTS (.aac) -> MPEG-TS PES Packetizer
// =========================================================================

function createTsPacket(pid, payloadUnitStart, continuityCounter, payload) {
  const packet = new Uint8Array(188);
  packet.fill(0xff);
  packet[0] = 0x47;
  packet[1] = (payloadUnitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;

  const maxPayload = 184;
  if (payload.length >= maxPayload) {
    packet[3] = 0x10 | (continuityCounter & 0x0f);
    packet.set(payload.subarray(0, maxPayload), 4);
    return { packet, consumed: maxPayload };
  }

  const stuffing = maxPayload - payload.length;
  if (stuffing === 1) {
    packet[3] = 0x30 | (continuityCounter & 0x0f);
    packet[4] = 0x00;
    packet.set(payload, 5);
  } else {
    packet[3] = 0x30 | (continuityCounter & 0x0f);
    packet[4] = stuffing - 1;
    packet[5] = 0x00;
    packet.set(payload, 4 + stuffing);
  }
  return { packet, consumed: payload.length };
}

function encodePts33(pts) {
  const out = new Uint8Array(5);
  const p = Math.floor(pts);
  out[0] = 0x21 | (((p / 536870912) & 0x07) << 1);
  out[1] = (p >>> 22) & 0xff;
  out[2] = 0x01 | (((p >>> 15) & 0x7f) << 1);
  out[3] = (p >>> 7) & 0xff;
  out[4] = 0x01 | ((p & 0x7f) << 1);
  return out;
}

function packetizeAdtsToTs(aacBytes, tsState) {
  if (!tsState.patSent) {
    const patPayload = new Uint8Array([
      0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0x00, 0x01, 0xf0, 0x00,
      0x2a, 0xb1, 0x04, 0xb2
    ]);
    const pmtPayload = new Uint8Array([
      0x00, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe1, 0x01, 0xf0, 0x00,
      0x0f, 0xe1, 0x01, 0xf0, 0x00,
      0x2f, 0x44, 0xb9, 0x9b
    ]);
    tsState.packets.push(createTsPacket(0x0000, true, tsState.patCc++ & 0x0f, patPayload).packet);
    tsState.packets.push(createTsPacket(0x1000, true, tsState.pmtCc++ & 0x0f, pmtPayload).packet);
    tsState.patSent = true;
  }

  let offset = 0;
  const frames = [];
  while (offset + 7 <= aacBytes.length) {
    if (aacBytes[offset] === 0xff && (aacBytes[offset + 1] & 0xf0) === 0xf0) {
      const srIdx = (aacBytes[offset + 2] >> 2) & 0x0f;
      const sampleRate = ADTS_SAMPLE_RATES[srIdx] || 44100;
      const frameLen =
        ((aacBytes[offset + 3] & 0x03) << 11) |
        (aacBytes[offset + 4] << 3) |
        ((aacBytes[offset + 5] & 0xe0) >> 5);
      if (frameLen >= 7 && offset + frameLen <= aacBytes.length) {
        frames.push({
          data: aacBytes.subarray(offset, offset + frameLen),
          ticks: (1024 * 90000) / sampleRate
        });
        offset += frameLen;
        continue;
      }
    }
    offset++;
  }

  for (const frame of frames) {
    const ptsBytes = encodePts33(tsState.pts);
    const pesLen = frame.data.length + 8;
    const pesHeader = new Uint8Array(14);
    pesHeader[0] = 0x00;
    pesHeader[1] = 0x00;
    pesHeader[2] = 0x01;
    pesHeader[3] = 0xc0;
    pesHeader[4] = pesLen <= 65535 ? (pesLen >> 8) & 0xff : 0;
    pesHeader[5] = pesLen <= 65535 ? pesLen & 0xff : 0;
    pesHeader[6] = 0x80;
    pesHeader[7] = 0x80;
    pesHeader[8] = 0x05;
    pesHeader.set(ptsBytes, 9);

    const pes = concatUint8Arrays([pesHeader, frame.data]);
    let pos = 0;
    let first = true;
    while (pos < pes.length) {
      const { packet, consumed } = createTsPacket(
        0x0101,
        first,
        tsState.audioCc++ & 0x0f,
        pes.subarray(pos)
      );
      tsState.packets.push(packet);
      pos += consumed;
      first = false;
    }
    tsState.pts += frame.ticks;
  }
}

// =========================================================================
// MPEG-TS Transmuxer Wrapper (mux.js)
// =========================================================================

function transmuxTsChunks(tsChunks, isAudioOnly = false) {
  if (!self.muxjs || !self.muxjs.mp4 || typeof self.muxjs.mp4.Transmuxer !== 'function') {
    throw new Error('mux.min.js failed to load');
  }
  const transmuxer = new self.muxjs.mp4.Transmuxer({
    keepOriginalTimestamps: true
  });

  let videoInit = null;
  let audioInit = null;
  const videoParts = [];
  const audioParts = [];
  const combinedParts = [];

  transmuxer.on('data', (segment) => {
    if (segment.type === 'video') {
      if (segment.initSegment && !videoInit) videoInit = new Uint8Array(segment.initSegment);
      if (segment.data && segment.data.byteLength > 0) videoParts.push(new Uint8Array(segment.data));
    } else if (segment.type === 'audio') {
      if (segment.initSegment && !audioInit) audioInit = new Uint8Array(segment.initSegment);
      if (segment.data && segment.data.byteLength > 0) audioParts.push(new Uint8Array(segment.data));
    } else {
      if (segment.initSegment && !videoInit) videoInit = new Uint8Array(segment.initSegment);
      if (segment.data && segment.data.byteLength > 0) combinedParts.push(new Uint8Array(segment.data));
    }
  });

  for (const chunk of tsChunks) {
    if (chunk && chunk.byteLength > 0) {
      transmuxer.push(chunk);
    }
  }
  transmuxer.flush();

  if (isAudioOnly) {
    const parts = audioParts.length > 0 ? audioParts : combinedParts;
    const init = audioInit || videoInit;
    return {
      initSegment: init,
      fragments: parts
    };
  }

  if (videoInit && audioInit) {
    const mergedInit = mergeFmp4Inits(videoInit, audioInit);
    const patchedAudio = audioParts.map((p) => patchAudioFragment(p));
    return {
      initSegment: mergedInit,
      fragments: [...videoParts, ...patchedAudio]
    };
  }

  return {
    initSegment: videoInit || audioInit,
    fragments: [...combinedParts, ...videoParts, ...audioParts]
  };
}

function isFmp4Segment(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return type === 'styp' || type === 'moof' || type === 'ftyp' || type === 'sidx' || type === 'emsg';
}

function isAdtsSegment(bytes) {
  return bytes && bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
}

function interleaveFragments(vFrags, aFrags) {
  const out = [];
  const maxLen = Math.max(vFrags.length, aFrags.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < vFrags.length) out.push(vFrags[i]);
    if (i < aFrags.length) out.push(aFrags[i]);
  }
  return out;
}

// =========================================================================
// Shared Global 32-Worker Pool Across Concurrent Jobs
// =========================================================================

async function runSegmentWorkerPool(state, tasks) {
  state.totalSegments = tasks.length;
  const keyCache = new Map();
  let nextTaskIdx = 0;
  let throttleUntil = 0;

  async function getAesKey(keyInfo) {
    if (!keyInfo || keyInfo.method !== 'AES-128') return null;
    if (keyCache.has(keyInfo.uri)) return keyCache.get(keyInfo.uri);
    const rawKey = await corsSafeFetch(keyInfo.uri, state.abortController.signal, 'arraybuffer');
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    keyCache.set(keyInfo.uri, cryptoKey);
    return cryptoKey;
  }

  async function waitIfPaused() {
    while (state.isPaused && !state.cancelled) {
      await waitForWorkerSignal(150);
    }
    if (state.cancelled) throw new Error('CANCELLED');
  }

  async function acquireSlot() {
    while (!state.cancelled) {
      await waitIfPaused();
      const cap = computePerJobCap(state);
      if (state.activeWorkers < cap && globalActiveWorkers < GLOBAL_MAX_WORKERS) {
        state.activeWorkers++;
        globalActiveWorkers++;
        return;
      }
      await waitForWorkerSignal(100);
    }
    throw new Error('CANCELLED');
  }

  function releaseSlot() {
    if (state.activeWorkers > 0) state.activeWorkers--;
    if (globalActiveWorkers > 0) globalActiveWorkers--;
    notifyWorkerWaiters();
  }

  async function workerLoop() {
    while (!state.cancelled) {
      await waitIfPaused();

      const now = Date.now();
      if (throttleUntil > now) {
        await sleep(throttleUntil - now);
        continue;
      }

      const taskIdx = nextTaskIdx++;
      if (taskIdx >= tasks.length) return;
      const task = tasks[taskIdx];

      await acquireSlot();
      try {
        let bytes = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          await waitIfPaused();
          try {
            bytes = await corsSafeFetch(
              task.seg.url,
              state.abortController.signal,
              'arraybuffer',
              task.seg.range || null
            );
            if (task.seg.key && task.seg.key.method === 'AES-128') {
              const cryptoKey = await getAesKey(task.seg.key);
              const iv = parseHexIv(task.seg.key.ivHex, task.seg.seqNum);
              const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-CBC', iv },
                cryptoKey,
                bytes
              );
              bytes = new Uint8Array(decrypted);
            }
            if (state.maxActiveLimit < GLOBAL_MAX_WORKERS) {
              state.maxActiveLimit = Math.min(GLOBAL_MAX_WORKERS, state.maxActiveLimit + 1);
            }
            break;
          } catch (err) {
            if (state.cancelled || (err && err.name === 'AbortError')) throw new Error('CANCELLED');
            if (attempt >= MAX_RETRIES) throw err;

            if (err && (err.status === 429 || err.status === 503)) {
              state.maxActiveLimit = Math.max(4, Math.floor(state.maxActiveLimit / 2));
              const backoff = err.retryAfterMs || Math.min(15000, 400 * Math.pow(2, attempt));
              throttleUntil = Math.max(throttleUntil, Date.now() + backoff);
            } else {
              const backoff = Math.min(12000, 300 * Math.pow(2, attempt));
              await sleep(backoff);
            }
          }
        }

        state.slotMap.set(`${task.track}:${task.seg.index}`, bytes);
        state.completedSegments++;
        state.downloadedBytes += bytes.byteLength;
        emitProgress(state, false);
      } finally {
        releaseSlot();
      }
    }
  }

  const workerCount = Math.min(GLOBAL_MAX_WORKERS, tasks.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(workerLoop());
  }
  await Promise.all(workers);
}

async function runHlsJob(state) {
  const { job } = state;
  const isAudioOnly = job.outputFormat === 'mp3';

  const fetchTasks = [];
  if (!isAudioOnly && job.videoPlaylistUrl) {
    fetchTasks.push(
      corsSafeFetch(job.videoPlaylistUrl, state.abortController.signal, 'text').then((txt) => ({
        kind: 'videoPlaylist',
        data: parseMediaPlaylist(txt, job.videoPlaylistUrl)
      }))
    );
  }
  if (job.audioPlaylistUrl) {
    fetchTasks.push(
      corsSafeFetch(job.audioPlaylistUrl, state.abortController.signal, 'text').then((txt) => ({
        kind: 'audioPlaylist',
        data: parseMediaPlaylist(txt, job.audioPlaylistUrl)
      }))
    );
  }

  const results = await Promise.all(fetchTasks);
  const videoPl = results.find((r) => r.kind === 'videoPlaylist')?.data || null;
  const audioPl = results.find((r) => r.kind === 'audioPlaylist')?.data || null;

  const initTasks = [];
  if (videoPl && videoPl.mapUri) {
    initTasks.push(
      corsSafeFetch(videoPl.mapUri, state.abortController.signal, 'arraybuffer').then((bytes) => ({
        kind: 'videoInit',
        bytes
      }))
    );
  }
  if (audioPl && audioPl.mapUri) {
    initTasks.push(
      corsSafeFetch(audioPl.mapUri, state.abortController.signal, 'arraybuffer').then((bytes) => ({
        kind: 'audioInit',
        bytes
      }))
    );
  }

  const initResults = await Promise.all(initTasks);
  const videoInit = initResults.find((r) => r.kind === 'videoInit')?.bytes || null;
  const audioInit = initResults.find((r) => r.kind === 'audioInit')?.bytes || null;

  const tasks = [];
  if (videoPl) {
    for (const seg of videoPl.segments) {
      tasks.push({ track: 'video', seg });
    }
  }
  if (audioPl) {
    for (const seg of audioPl.segments) {
      tasks.push({ track: 'audio', seg });
    }
  }

  if (tasks.length === 0) {
    throw new Error('No downloadable segments found in playlist.');
  }

  await runSegmentWorkerPool(state, tasks);
  if (state.cancelled) return null;

  const videoSegCount = videoPl ? videoPl.segments.length : 0;
  const audioSegCount = audioPl ? audioPl.segments.length : 0;
  const videoSegs = [];
  const audioSegs = [];

  for (let i = 0; i < videoSegCount; i++) {
    const b = state.slotMap.get(`video:${i}`);
    if (b) videoSegs.push(b);
  }
  for (let i = 0; i < audioSegCount; i++) {
    const b = state.slotMap.get(`audio:${i}`);
    if (b) audioSegs.push(b);
  }

  if (isAudioOnly) {
    const targetSegs = audioSegs.length > 0 ? audioSegs : videoSegs;
    const targetInit = audioInit || videoInit;

    if (targetSegs.length > 0 && isAdtsSegment(targetSegs[0])) {
      const tsState = { patSent: false, patCc: 0, pmtCc: 0, audioCc: 0, pts: 0, packets: [] };
      for (const seg of targetSegs) packetizeAdtsToTs(seg, tsState);
      const transmuxed = transmuxTsChunks(tsState.packets, true);
      const parts = transmuxed.initSegment ? [transmuxed.initSegment, ...transmuxed.fragments] : transmuxed.fragments;
      return new Blob(parts, { type: 'audio/mpeg' });
    }
    if (targetInit || (targetSegs.length > 0 && isFmp4Segment(targetSegs[0]))) {
      const parts = targetInit ? [targetInit, ...targetSegs] : targetSegs;
      return new Blob(parts, { type: 'audio/mpeg' });
    }
    const transmuxed = transmuxTsChunks(targetSegs, true);
    const parts = transmuxed.initSegment ? [transmuxed.initSegment, ...transmuxed.fragments] : transmuxed.fragments;
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  const videoIsFmp4 = Boolean(videoInit) || (videoSegs.length > 0 && isFmp4Segment(videoSegs[0]));
  const audioIsFmp4 = Boolean(audioInit) || (audioSegs.length > 0 && isFmp4Segment(audioSegs[0]));

  if (videoIsFmp4) {
    if (audioSegs.length > 0 && audioIsFmp4) {
      const mergedInit = mergeFmp4Inits(videoInit, audioInit);
      const patchedAudio = audioSegs.map((frag) => patchAudioFragment(frag));
      return new Blob([mergedInit, ...interleaveFragments(videoSegs, patchedAudio)], { type: 'video/mp4' });
    }
    if (audioSegs.length > 0 && isAdtsSegment(audioSegs[0])) {
      const tsState = { patSent: false, patCc: 0, pmtCc: 0, audioCc: 0, pts: 0, packets: [] };
      for (const seg of audioSegs) packetizeAdtsToTs(seg, tsState);
      const transmuxedAudio = transmuxTsChunks(tsState.packets, true);
      const mergedInit = mergeFmp4Inits(videoInit, transmuxedAudio.initSegment);
      const patchedAudio = transmuxedAudio.fragments.map((frag) => patchAudioFragment(frag));
      return new Blob([mergedInit, ...interleaveFragments(videoSegs, patchedAudio)], { type: 'video/mp4' });
    }
    const parts = videoInit ? [videoInit, ...videoSegs] : videoSegs;
    return new Blob(parts, { type: 'video/mp4' });
  }

  const videoTransmuxed = transmuxTsChunks(videoSegs, false);
  if (audioSegs.length > 0) {
    let audioTransmuxed;
    if (isAdtsSegment(audioSegs[0])) {
      const tsState = { patSent: false, patCc: 0, pmtCc: 0, audioCc: 0, pts: 0, packets: [] };
      for (const seg of audioSegs) packetizeAdtsToTs(seg, tsState);
      audioTransmuxed = transmuxTsChunks(tsState.packets, true);
    } else if (audioIsFmp4) {
      audioTransmuxed = { initSegment: audioInit, fragments: audioSegs };
    } else {
      audioTransmuxed = transmuxTsChunks(audioSegs, true);
    }
    const mergedInit = mergeFmp4Inits(videoTransmuxed.initSegment, audioTransmuxed.initSegment);
    const patchedAudio = audioTransmuxed.fragments.map((frag) => patchAudioFragment(frag));
    return new Blob([mergedInit, ...interleaveFragments(videoTransmuxed.fragments, patchedAudio)], { type: 'video/mp4' });
  }

  const finalParts = videoTransmuxed.initSegment
    ? [videoTransmuxed.initSegment, ...videoTransmuxed.fragments]
    : videoTransmuxed.fragments;
  return new Blob(finalParts, { type: 'video/mp4' });
}

async function runDashJob(state) {
  const { job } = state;
  const isAudioOnly = job.outputFormat === 'mp3';
  const dash = job.dashData || {};

  const vInitInfo = !isAudioOnly ? dash.videoInit : null;
  const aInitInfo = dash.audioInit || null;
  const vSegList = !isAudioOnly && Array.isArray(dash.videoSegments) ? dash.videoSegments : [];
  const aSegList = Array.isArray(dash.audioSegments) ? dash.audioSegments : [];

  if (vSegList.length === 0 && aSegList.length === 0 && job.directUrl) {
    return runProgressiveJob(state);
  }

  const initTasks = [];
  if (vInitInfo && vInitInfo.url) {
    initTasks.push(
      corsSafeFetch(vInitInfo.url, state.abortController.signal, 'arraybuffer', vInitInfo.range || null).then((bytes) => ({
        kind: 'videoInit',
        bytes
      }))
    );
  }
  if (aInitInfo && aInitInfo.url) {
    initTasks.push(
      corsSafeFetch(aInitInfo.url, state.abortController.signal, 'arraybuffer', aInitInfo.range || null).then((bytes) => ({
        kind: 'audioInit',
        bytes
      }))
    );
  }

  const initResults = await Promise.all(initTasks);
  const videoInit = initResults.find((r) => r.kind === 'videoInit')?.bytes || null;
  const audioInit = initResults.find((r) => r.kind === 'audioInit')?.bytes || null;

  const tasks = [];
  vSegList.forEach((s, idx) => {
    tasks.push({
      track: 'video',
      seg: { index: idx, seqNum: idx, url: typeof s === 'string' ? s : s.url, range: s.range || null, key: null }
    });
  });
  aSegList.forEach((s, idx) => {
    tasks.push({
      track: 'audio',
      seg: { index: idx, seqNum: idx, url: typeof s === 'string' ? s : s.url, range: s.range || null, key: null }
    });
  });

  if (tasks.length === 0) {
    throw new Error('No downloadable DASH segments found in MPD manifest.');
  }

  await runSegmentWorkerPool(state, tasks);
  if (state.cancelled) return null;

  const videoSegs = [];
  const audioSegs = [];
  for (let i = 0; i < vSegList.length; i++) {
    const b = state.slotMap.get(`video:${i}`);
    if (b) videoSegs.push(b);
  }
  for (let i = 0; i < aSegList.length; i++) {
    const b = state.slotMap.get(`audio:${i}`);
    if (b) audioSegs.push(b);
  }

  if (isAudioOnly) {
    const targetSegs = audioSegs.length > 0 ? audioSegs : videoSegs;
    const targetInit = audioInit || videoInit;
    const parts = targetInit ? [targetInit, ...targetSegs] : targetSegs;
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  if (videoInit && audioInit && audioSegs.length > 0) {
    const mergedInit = mergeFmp4Inits(videoInit, audioInit);
    const patchedAudio = audioSegs.map((frag) => patchAudioFragment(frag));
    return new Blob([mergedInit, ...interleaveFragments(videoSegs, patchedAudio)], { type: 'video/mp4' });
  }

  if (audioSegs.length > 0 && videoSegs.length > 0) {
    const patchedAudio = audioSegs.map((frag) => patchAudioFragment(frag));
    const prefix = videoInit ? [videoInit] : [];
    return new Blob([...prefix, ...interleaveFragments(videoSegs, patchedAudio)], { type: 'video/mp4' });
  }

  const parts = videoInit ? [videoInit, ...videoSegs] : videoSegs;
  return new Blob(parts, { type: 'video/mp4' });
}

function getMimeForFormat(outputFormat) {
  switch ((outputFormat || 'mp4').toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'ts':
      return 'video/mp2t';
    default:
      return 'video/mp4';
  }
}

function splitIsoBmffInitAndFragments(bytes) {
  const boxes = readBoxes(bytes);
  if (boxes.length === 0) return null;

  const initBoxes = [];
  const fragments = [];
  let sawMoov = false;
  let curFrag = null;

  for (const box of boxes) {
    if (box.type === 'moov') sawMoov = true;
    if (box.type === 'moof') {
      if (curFrag && curFrag.length > 0) {
        fragments.push(concatUint8Arrays(curFrag));
      }
      curFrag = [box.data];
    } else if (curFrag) {
      curFrag.push(box.data);
    } else if (box.type !== 'sidx') {
      initBoxes.push(box.data);
    }
  }
  if (curFrag && curFrag.length > 0) {
    fragments.push(concatUint8Arrays(curFrag));
  }

  if (!sawMoov || initBoxes.length === 0 || fragments.length === 0) {
    return null;
  }
  return {
    initBytes: concatUint8Arrays(initBoxes),
    fragments
  };
}

async function probeRangeSupport(rawUrl, signal) {
  const safeUrl = normalizeDownloadUrl(rawUrl);
  let totalLen = 0;
  let supportsRanges = false;

  try {
    let res = await fetch(safeUrl, { method: 'HEAD', credentials: 'omit', signal });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(safeUrl, { method: 'HEAD', credentials: 'include', signal });
    }
    if (res.ok) {
      const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      const ar = res.headers.get('accept-ranges') || '';
      if (len > 0) totalLen = len;
      if (/bytes/i.test(ar)) supportsRanges = true;
      if (totalLen > 0 && supportsRanges) {
        return { totalLen, supportsRanges: true };
      }
    }
  } catch (_) {}

  // Fallback probe via 2-byte Range request (handles servers disallowing HEAD)
  try {
    let res = await fetch(safeUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-1' },
      credentials: 'omit',
      signal
    });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(safeUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-1' },
        credentials: 'include',
        signal
      });
    }
    if (res.status === 206) {
      supportsRanges = true;
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) {
        totalLen = parseInt(m[1], 10) || totalLen;
      }
    } else if (res.ok) {
      const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      const ar = res.headers.get('accept-ranges') || '';
      if (len > 2) totalLen = len;
      if (/bytes/i.test(ar)) supportsRanges = true;
      if (res.body && typeof res.body.cancel === 'function') {
        res.body.cancel().catch(() => {});
      }
    }
  } catch (_) {}

  return { totalLen, supportsRanges };
}

async function runDualProgressiveJob(state, preProbedVideo = null) {
  const { job } = state;
  const isAudioOnly = job.outputFormat === 'mp3';
  const videoUrl = !isAudioOnly && job.directUrl ? normalizeDownloadUrl(job.directUrl) : null;
  const audioUrl = job.audioDirectUrl ? normalizeDownloadUrl(job.audioDirectUrl) : null;

  const buildRangeTasks = async (url, track, preProbe = null) => {
    if (!url) return null;
    const probe = preProbe || await probeRangeSupport(url, state.abortController.signal);
    const totalLen = probe.totalLen || 0;
    const canChunk = probe.supportsRanges && totalLen > RANGE_CHUNK_BYTES;

    if (canChunk) {
      const chunks = [];
      let index = 0;
      for (let start = 0; start < totalLen; start += RANGE_CHUNK_BYTES) {
        const end = Math.min(totalLen - 1, start + RANGE_CHUNK_BYTES - 1);
        chunks.push({
          track,
          seg: { index: index++, seqNum: index, url, range: `${start}-${end}`, key: null }
        });
      }
      return { totalLen, chunks };
    }

    return {
      totalLen,
      chunks: [{ track, seg: { index: 0, seqNum: 0, url, range: null, key: null } }]
    };
  };

  const [vPlan, aPlan] = await Promise.all([
    videoUrl ? buildRangeTasks(videoUrl, 'video', preProbedVideo) : Promise.resolve(null),
    audioUrl ? buildRangeTasks(audioUrl, 'audio', null) : Promise.resolve(null)
  ]);

  const plannedTotal = (vPlan ? vPlan.totalLen : 0) + (aPlan ? aPlan.totalLen : 0);
  if (plannedTotal > 0) {
    state.knownTotalBytes = plannedTotal;
    state.totalBytes = plannedTotal;
  }

  const tasks = [
    ...(vPlan ? vPlan.chunks : []),
    ...(aPlan ? aPlan.chunks : [])
  ];
  if (tasks.length === 0) {
    throw new Error('No downloadable media tracks found.');
  }

  await runSegmentWorkerPool(state, tasks);
  if (state.cancelled) return null;

  const assembleTrack = (plan, track) => {
    if (!plan) return null;
    const parts = [];
    for (let i = 0; i < plan.chunks.length; i++) {
      const b = state.slotMap.get(`${track}:${i}`);
      if (b) parts.push(b);
    }
    return parts.length > 0 ? concatUint8Arrays(parts) : null;
  };

  const audioBytes = assembleTrack(aPlan, 'audio');
  if (isAudioOnly) {
    if (!audioBytes) throw new Error('Audio stream returned 0 bytes.');
    return new Blob([audioBytes], { type: 'audio/mpeg' });
  }

  const videoBytes = assembleTrack(vPlan, 'video');
  if (!videoBytes) throw new Error('Video stream returned 0 bytes.');
  if (!audioBytes) {
    return new Blob([videoBytes], { type: getMimeForFormat(job.outputFormat) });
  }

  const vSplit = splitIsoBmffInitAndFragments(videoBytes);
  const aSplit = splitIsoBmffInitAndFragments(audioBytes);
  if (vSplit && aSplit) {
    const mergedInit = mergeFmp4Inits(vSplit.initBytes, aSplit.initBytes);
    const patchedAudio = aSplit.fragments.map((frag) => patchAudioFragment(frag));
    return new Blob([mergedInit, ...interleaveFragments(vSplit.fragments, patchedAudio)], {
      type: 'video/mp4'
    });
  }

  return new Blob([videoBytes], { type: getMimeForFormat(job.outputFormat) });
}

async function runProgressiveJob(state) {
  const { job } = state;
  const safeUrl = normalizeDownloadUrl(job.directUrl);
  let res = await fetch(safeUrl, { credentials: 'omit', signal: state.abortController.signal });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(safeUrl, { credentials: 'include', signal: state.abortController.signal });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const headerLen = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  state.totalBytes = headerLen || state.knownTotalBytes || 0;
  if (headerLen > 0) {
    state.knownTotalBytes = headerLen;
  }

  const mime = getMimeForFormat(job.outputFormat);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    state.downloadedBytes = buf.byteLength;
    emitProgress(state, true);
    return new Blob([buf], { type: mime });
  }

  const reader = res.body.getReader();
  const chunks = [];
  while (true) {
    while (state.isPaused && !state.cancelled) {
      await sleep(150);
    }
    if (state.cancelled) {
      reader.cancel().catch(() => {});
      return null;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(value);
      state.downloadedBytes += value.byteLength;
      emitProgress(state, false);
    }
  }

  return new Blob(chunks, { type: mime });
}

function updateStableTotalBytes(state) {
  if (state.knownTotalBytes > 0) {
    state.prevEstimatedTotal = Math.max(state.knownTotalBytes, state.downloadedBytes);
    state.lockedEstimatedTotal = state.knownTotalBytes;
    return state.prevEstimatedTotal;
  }
  if (state.lockedEstimatedTotal > 0) {
    return Math.max(state.lockedEstimatedTotal, state.downloadedBytes);
  }
  if (state.totalSegments > 0 && state.completedSegments > 0) {
    const rawEst = Math.round((state.downloadedBytes / state.completedSegments) * state.totalSegments);
    const damped = state.prevEstimatedTotal > 0
      ? Math.round(state.prevEstimatedTotal * 0.9 + rawEst * 0.1)
      : rawEst;
    state.prevEstimatedTotal = damped;
    if (state.completedSegments >= 12) {
      state.lockedEstimatedTotal = damped;
    }
    return Math.max(damped, state.downloadedBytes);
  }
  return state.totalBytes || 0;
}

function emitProgress(state, force) {
  const now = Date.now();
  if (!force && now - state.lastUiEmit < UI_THROTTLE_MS) return;
  state.lastUiEmit = now;

  const elapsedSec = Math.max(0.1, (now - state.startedAt) / 1000);
  const speedBps = state.downloadedBytes / elapsedSec;
  const speedMBps = speedBps / (1024 * 1024);

  const estimatedTotal = updateStableTotalBytes(state);
  let progress = 0;
  if (state.status === 'completed') {
    progress = 100;
  } else if (state.totalSegments > 0) {
    progress = Math.min(99, Math.round((state.completedSegments / state.totalSegments) * 100));
  } else if (estimatedTotal > 0) {
    progress = Math.min(99, Math.round((state.downloadedBytes / estimatedTotal) * 100));
  }

  let etaSeconds = 0;
  if (speedBps > 0 && estimatedTotal > state.downloadedBytes) {
    etaSeconds = Math.ceil((estimatedTotal - state.downloadedBytes) / speedBps);
  }

  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_PROGRESS',
    job: {
      jobId: state.job.jobId,
      status: state.status,
      filename: state.job.filename,
      resolvedFilename: state.job.resolvedFilename || state.job.filename,
      videoUrl: state.job.videoUrl || state.job.directUrl || state.job.videoPlaylistUrl || state.job.streamUrl || '',
      streamUrl: state.job.streamUrl || state.job.directUrl || state.job.videoPlaylistUrl || '',
      qualityKey: state.job.qualityKey || '',
      streamSignature: state.job.streamSignature || '',
      progress,
      speedMBps: Number(speedMBps.toFixed(2)),
      downloadedBytes: state.downloadedBytes,
      totalBytes: estimatedTotal,
      completedSegments: state.completedSegments || 0,
      totalSegments: state.totalSegments || 0,
      workerCount: computePerJobCap(state),
      globalPoolSize: GLOBAL_MAX_WORKERS,
      etaSeconds,
      isPaused: state.isPaused,
      offlinePaused: state.offlinePaused,
      error: state.error
    }
  }).catch(() => {});
}

async function runSmartProgressiveJob(state) {
  const targetUrl = normalizeDownloadUrl(state.job.directUrl || '');
  const probe = await probeRangeSupport(targetUrl, state.abortController.signal);
  if (probe.supportsRanges && probe.totalLen > DIRECT_RANGE_ACCEL_MIN_BYTES) {
    return runDualProgressiveJob(state, probe);
  }
  return runProgressiveJob(state);
}

async function executeJob(state) {
  startHeartbeatIfNeeded();
  try {
    state.status = 'downloading';
    state.startedAt = Date.now();
    emitProgress(state, true);

    let finalBlob;
    if (state.job.isDash) {
      finalBlob = await runDashJob(state);
    } else if (state.job.isProgressive && state.job.audioDirectUrl) {
      finalBlob = await runDualProgressiveJob(state);
    } else if (state.job.isProgressive) {
      finalBlob = await runSmartProgressiveJob(state);
    } else {
      finalBlob = await runHlsJob(state);
    }

    if (state.cancelled || !finalBlob) return;
    if (finalBlob.size < MIN_VALID_BLOB_BYTES) {
      throw new Error('Error: Stream blocked or empty (< 10 KB) — refresh the page and try again.');
    }

    state.knownTotalBytes = finalBlob.size;
    state.downloadedBytes = finalBlob.size;
    state.status = 'saving';
    emitProgress(state, true);

    const blobUrl = URL.createObjectURL(finalBlob);
    activeBlobUrls.add(blobUrl);
    blobUrlToJobId.set(blobUrl, state.job.jobId);

    await chrome.runtime.sendMessage({
      type: 'SAVE_BLOB_URL',
      blobUrl,
      filename: state.job.filename,
      jobId: state.job.jobId,
      sizeBytes: finalBlob.size
    });
  } catch (err) {
    if (state.cancelled || (err && err.message === 'CANCELLED')) return;
    state.status = 'error';
    state.error = err && err.message ? err.message : 'Download failed';
    emitProgress(state, true);
  } finally {
    notifyWorkerWaiters();
    stopHeartbeatIfIdle();
  }
}

function createJobState(job) {
  return {
    job,
    status: 'downloading',
    writeCursor: 0,
    completedSegments: 0,
    totalSegments: 0,
    downloadedBytes: 0,
    totalBytes: Number(job.knownTotalBytes || 0),
    knownTotalBytes: Number(job.knownTotalBytes || 0),
    prevEstimatedTotal: Number(job.knownTotalBytes || 0),
    lockedEstimatedTotal: Number(job.knownTotalBytes || 0),
    activeWorkers: 0,
    maxActiveLimit: GLOBAL_MAX_WORKERS,
    initWritten: false,
    slotMap: new Map(),
    isPaused: false,
    offlinePaused: false,
    cancelled: false,
    error: null,
    startedAt: Date.now(),
    lastUiEmit: 0,
    abortController: new AbortController()
  };
}

function resetErroredJobState(state) {
  state.writeCursor = 0;
  state.completedSegments = 0;
  state.downloadedBytes = 0;
  state.prevEstimatedTotal = Number(state.knownTotalBytes || 0);
  state.lockedEstimatedTotal = Number(state.knownTotalBytes || 0);
  state.activeWorkers = 0;
  state.maxActiveLimit = GLOBAL_MAX_WORKERS;
  state.initWritten = false;
  state.slotMap.clear();
  state.error = null;
  state.isPaused = false;
  state.offlinePaused = false;
  state.abortController = new AbortController();
}

// Automatic Offline / Online handling across ALL concurrent jobs
window.addEventListener('offline', () => {
  for (const st of jobStates.values()) {
    if (!st.cancelled && st.status === 'downloading') {
      st.isPaused = true;
      st.offlinePaused = true;
      st.status = 'paused';
      emitProgress(st, true);
    }
  }
  notifyWorkerWaiters();
});

window.addEventListener('online', () => {
  for (const st of jobStates.values()) {
    if (!st.cancelled && st.offlinePaused) {
      st.isPaused = false;
      st.offlinePaused = false;
      st.status = 'downloading';
      emitProgress(st, true);
    }
  }
  notifyWorkerWaiters();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'OFFSCREEN_START_JOB') {
    if (!msg.job || !msg.job.jobId) return;
    const state = createJobState(msg.job);
    jobStates.set(msg.job.jobId, state);
    notifyWorkerWaiters();
    executeJob(state);
  } else if (msg.type === 'OFFSCREEN_PAUSE_DOWNLOAD') {
    const st = msg.jobId ? jobStates.get(msg.jobId) : null;
    if (st && st.status === 'downloading') {
      st.isPaused = true;
      st.status = 'paused';
      emitProgress(st, true);
      notifyWorkerWaiters();
    }
  } else if (msg.type === 'OFFSCREEN_RESUME_DOWNLOAD') {
    const st = msg.jobId ? jobStates.get(msg.jobId) : null;
    if (!st && msg.job) {
      const recreated = createJobState(msg.job);
      jobStates.set(msg.job.jobId, recreated);
      notifyWorkerWaiters();
      executeJob(recreated);
      return;
    }
    if (!st) return;
    if (st.status === 'error') {
      resetErroredJobState(st);
      notifyWorkerWaiters();
      executeJob(st);
    } else if (st.status === 'paused') {
      st.isPaused = false;
      st.offlinePaused = false;
      st.status = 'downloading';
      emitProgress(st, true);
      notifyWorkerWaiters();
    }
  } else if (msg.type === 'OFFSCREEN_CANCEL_DOWNLOAD') {
    const st = msg.jobId ? jobStates.get(msg.jobId) : null;
    if (st) {
      st.cancelled = true;
      st.status = 'cancelled';
      st.abortController.abort();
      jobStates.delete(msg.jobId);
      notifyWorkerWaiters();
      stopHeartbeatIfIdle();
    }
  } else if (msg.type === 'OFFSCREEN_PAUSE_ALL') {
    for (const st of jobStates.values()) {
      if (!st.cancelled && st.status === 'downloading') {
        st.isPaused = true;
        st.status = 'paused';
        emitProgress(st, true);
      }
    }
    notifyWorkerWaiters();
  } else if (msg.type === 'OFFSCREEN_RESUME_ALL') {
    const payloadList = Array.isArray(msg.jobs) ? msg.jobs : [];
    for (const st of jobStates.values()) {
      if (!st.cancelled && st.status === 'error') {
        resetErroredJobState(st);
        executeJob(st);
      } else if (!st.cancelled && st.status === 'paused') {
        st.isPaused = false;
        st.offlinePaused = false;
        st.status = 'downloading';
        emitProgress(st, true);
      }
    }
    for (const p of payloadList) {
      if (p && p.jobId && !jobStates.has(p.jobId)) {
        const recreated = createJobState(p);
        jobStates.set(p.jobId, recreated);
        executeJob(recreated);
      }
    }
    notifyWorkerWaiters();
  } else if (msg.type === 'OFFSCREEN_JOB_DONE') {
    if (msg.jobId) {
      jobStates.delete(msg.jobId);
      stopHeartbeatIfIdle();
    }
  } else if (msg.type === 'REVOKE_BLOB_URL') {
    if (msg.blobUrl && activeBlobUrls.has(msg.blobUrl)) {
      URL.revokeObjectURL(msg.blobUrl);
      activeBlobUrls.delete(msg.blobUrl);
      const jobId = blobUrlToJobId.get(msg.blobUrl);
      blobUrlToJobId.delete(msg.blobUrl);
      if (jobId) {
        jobStates.delete(jobId);
      }
      stopHeartbeatIfIdle();
    }
  }
});
