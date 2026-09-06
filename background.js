// ─── State ────────────────────────────────────────────────────────────────────
let detectedMedia = {};   // tabId → [mediaItem]
let tabMetadata   = {};   // tabId → { title, poster, platform }
let manualScans   = {};   // backgroundTabId → targetTabId
let hlsManifests  = {};   // tabId → Set of seen m3u8 base URLs
let seenUrls      = {};   // tabId → Set of normalized URLs
let tabCurrentUrls= {};   // tabId → last known URL
let currentSessionId = '';
let storageSaveTimers = {};

// ─── Session Management ───────────────────────────────────────────────────────
// Strictly isolate media to the current browser/page session
function initSession() {
  chrome.storage.session.get('sessionId', (data) => {
    if (!data || !data.sessionId) {
      currentSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      chrome.storage.session.set({ sessionId: currentSessionId });
      // Fresh browser run: clear old persisted media from previous sessions
      chrome.storage.local.clear();
      detectedMedia = {};
      seenUrls = {};
      hlsManifests = {};
      tabMetadata = {};
      tabCurrentUrls = {};
    } else {
      currentSessionId = data.sessionId;
    }
  });
}
initSession();

chrome.runtime.onStartup.addListener(() => {
  currentSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  chrome.storage.session.set({ sessionId: currentSessionId });
  chrome.storage.local.clear();
  detectedMedia = {};
  seenUrls = {};
  hlsManifests = {};
  tabMetadata = {};
  tabCurrentUrls = {};
});

chrome.runtime.onInstalled.addListener(() => {
  currentSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  chrome.storage.session.set({ sessionId: currentSessionId });
  chrome.storage.local.clear();
  detectedMedia = {};
  seenUrls = {};
  hlsManifests = {};
  tabMetadata = {};
  tabCurrentUrls = {};
});

// ─── MIME & Regex Classifiers ────────────────────────────────────────────────
const VIDEO_MIME = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/x-matroska', 'video/avi',
  'video/quicktime', 'video/x-flv', 'video/x-ms-wmv', 'video/x-msvideo',
  'video/3gpp', 'video/3gpp2', 'video/mp2t', 'video/mpeg', 'video/iso.segment',
  'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml',
]);

const VALID_IMAGE_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'
]);
const PDF_MIME          = 'application/pdf';

const VIDEO_URL_PATTERNS = [
  /googlevideo\.com\/videoplayback/,
  /\.(mp4|webm|mkv|avi|mov|m3u8|mpd|ts|flv|m4v|3gp)(\?|$)/i,
  /fbcdn\.net.*\/v\/t/,
  /fbcdn\.net.*\.mp4/,
  /cdninstagram\.com.*\.mp4/,
  /video\.twimg\.com\/ext_tw_video/,
  /video\.twimg\.com\/tweet_video/,
  /vod-progressive\.akamaized\.net/,
  /v\.redd\.it/,
  /tiktokcdn\.com/,
  /byteoversea\.com/,
  /cloudfront\.net.*\.mp4/,
  /cdn\.jwplayer\.com/,
  /storage\.googleapis\.com.*\.mp4/,
];

// URLs that are clearly web pages or API endpoints and must NEVER be treated as media files
const PAGE_URL_PATTERNS = [
  /^https?:\/\/(www\.|web\.|m\.)?facebook\.com\/(reel|watch|video|videos|story)/i,
  /^https?:\/\/(www\.)?youtube\.com\/(watch|shorts|channel|user)/i,
  /^https?:\/\/youtu\.be\//i,
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\//i,
  /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\/[^/]+\/status\//i,
  /^https?:\/\/(www\.)?tiktok\.com\/@[^/]+\/video\//i,
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\//i,
  /\.html?(\?|$)/i,
  /\.php(\?|$)/i,
  /\/ajax\//i,
  /\/api\/graphql/i,
  /\/bz\?/i,
  /facebook\.com\/tr\//i,
];

function isWebPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return PAGE_URL_PATTERNS.some(re => re.test(url));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    ['bytestart', 'byteend', 'range', 't', 'start', 'end', '_'].forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

function cleanFacebookVideoUrl(url) {
  // Never tamper with signed query strings (oh, oe, bytestart, efg) to avoid 403 Forbidden
  return url;
}

function matchesVideoUrl(url) {
  return VIDEO_URL_PATTERNS.some(re => re.test(url));
}

function classifyUrl(url, contentType) {
  if (isWebPageUrl(url)) return null;
  if (url.includes('keyframes') || (contentType && contentType.includes('keyframes'))) return null;
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (ct && VIDEO_MIME.has(ct)) return 'video';
  if (ct && VALID_IMAGE_MIME.has(ct)) return 'image';
  if (ct === PDF_MIME) return 'pdf';
  if (matchesVideoUrl(url)) return 'video';
  return null;
}

function isHlsManifest(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  return ct.includes('mpegurl') || url.includes('.m3u8');
}

function isDashManifest(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  return ct.includes('dash+xml') || url.includes('.mpd');
}

function isChunkUrl(url) {
  return /\.ts(\?|$)/i.test(url) ||
         /\/seg[0-9]+/i.test(url) ||
         /\/chunk[-_]/i.test(url) ||
         /\/fragment\//i.test(url);
}

function extractPlatform(url) {
  if (url.includes('googlevideo.com') || url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('fbcdn.net') || url.includes('facebook.com') || url.includes('fb.watch')) return 'Facebook';
  if (url.includes('cdninstagram.com') || url.includes('instagram.com')) return 'Instagram';
  if (url.includes('twimg.com') || url.includes('twitter.com') || url.includes('x.com')) return 'Twitter/X';
  if (url.includes('akamaized.net') || url.includes('vimeo.com')) return 'Vimeo';
  if (url.includes('dailymotion.com')) return 'Dailymotion';
  if (url.includes('tiktok.com') || url.includes('tiktokcdn.com') || url.includes('byteoversea.com')) return 'TikTok';
  if (url.includes('twitch.tv') || url.includes('twitchsvc.net')) return 'Twitch';
  if (url.includes('reddit.com') || url.includes('redd.it')) return 'Reddit';
  return '';
}

function getQualityTag(url, contentType, mediaType) {
  if (mediaType !== 'video') return '';
  try {
    const u = new URL(url);
    const itag = u.searchParams.get('itag');
    if (itag) {
      const itagMap = {
        '37': '1080p', '137': '1080p', '248': '1080p WebM',
        '22': '720p',  '136': '720p',  '247': '720p WebM',
        '135': '480p', '244': '480p WebM',
        '134': '360p', '243': '360p WebM',
        '133': '240p', '242': '240p WebM',
        '160': '144p', '278': '144p WebM',
      };
      return itagMap[itag] || `itag:${itag}`;
    }
  } catch {}
  if (/1080[p_]/i.test(url)) return '1080p HD';
  if (/720[p_]/i.test(url))  return '720p HD';
  if (/480[p_]/i.test(url))  return '480p';
  if (/360[p_]/i.test(url))  return '360p';
  if (/240[p_]/i.test(url))  return '240p';
  if (url.includes('fbcdn.net') && (url.includes('.mp4') || (contentType && contentType.includes('video')))) return 'HD Video';
  return '';
}

function ensureTabState(tabId) {
  if (!detectedMedia[tabId]) detectedMedia[tabId] = [];
  if (!seenUrls[tabId])      seenUrls[tabId]      = new Set();
  if (!hlsManifests[tabId])  hlsManifests[tabId]  = new Set();
}

function scheduleStorageSave(tabId) {
  if (storageSaveTimers[tabId]) return;
  storageSaveTimers[tabId] = setTimeout(() => {
    delete storageSaveTimers[tabId];
    if (detectedMedia[tabId]) {
      chrome.storage.local.set({ ['media_' + tabId]: detectedMedia[tabId] });
    }
  }, 25);
}

function storeItem(tabId, item) {
  if (!item || !item.url) return;
  // STRICT GUARD: Block keyframes animation data and web page URLs
  if (item.url.includes('keyframes') || (item.mime && item.mime.includes('keyframes'))) return;
  if (isWebPageUrl(item.url) || item.quality === 'page-link') return;

  ensureTabState(tabId);
  const key = normalizeUrl(item.url);
  if (seenUrls[tabId].has(key)) return;
  seenUrls[tabId].add(key);

  item.sessionId = currentSessionId;
  detectedMedia[tabId].push(item);
  scheduleStorageSave(tabId);

  // Mirror to manual-scan origin tab if this came from a background scan
  const targetTabId = manualScans[tabId];
  if (targetTabId) {
    ensureTabState(targetTabId);
    const mirrorKey = normalizeUrl(item.url);
    if (!seenUrls[targetTabId].has(mirrorKey)) {
      seenUrls[targetTabId].add(mirrorKey);
      const copy = { ...item, title: (item.title ? '[Detected] ' + item.title : 'Detected Video'), isManual: true, sessionId: currentSessionId };
      detectedMedia[targetTabId].push(copy);
      scheduleStorageSave(targetTabId);
    }
  }
}

// ─── Network Interceptor ─────────────────────────────────────────────────────
chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    const tabId = details.tabId;
    if (tabId === -1) return;

    let contentType        = '';
    let contentLength      = 0;
    let contentRange       = '';

    for (const h of (details.responseHeaders || [])) {
      const name = h.name.toLowerCase();
      if (name === 'content-type')   contentType   = h.value;
      if (name === 'content-length') contentLength = parseInt(h.value, 10) || 0;
      if (name === 'content-range')  contentRange  = h.value;
    }

    // Skip web pages immediately
    if (contentType.toLowerCase().includes('text/html') || isWebPageUrl(details.url)) {
      return;
    }

    const mediaType = classifyUrl(details.url, contentType);
    if (!mediaType) return;

    // Calculate true total size using Content-Range if present (e.g. bytes 0-524287/18492048)
    let totalSize = contentLength;
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match && match[1]) {
        totalSize = parseInt(match[1], 10) || contentLength;
      }
    }

    // Skip tiny images under 2KB (2,048 bytes) to avoid tracking pixels, but keep thumbnails
    if (mediaType === 'image' && totalSize > 0 && totalSize < 2048) return;

    // Filter rule: Only ignore videos if TOTAL size is confirmed < 1 MB
    // If it's a stream, or totalSize is 0/unknown, KEEP it!
    if (mediaType === 'video' && totalSize > 0 && totalSize < 1048576 && !details.url.includes('.m3u8')) {
      return;
    }

    ensureTabState(tabId);

    // HLS/DASH Manifest handling
    if (mediaType === 'video' && (isHlsManifest(details.url, contentType) || isDashManifest(details.url, contentType))) {
      const baseKey = details.url.split('?')[0];
      if (!hlsManifests[tabId].has(baseKey)) {
        hlsManifests[tabId].add(baseKey);
        const meta = tabMetadata[tabId] || {};
        storeItem(tabId, {
          url:       details.url,
          type:      'video',
          mime:      contentType || 'application/x-mpegurl',
          size:      totalSize,
          title:     meta.title || extractPlatform(details.url) + ' Stream',
          poster:    meta.poster || '',
          quality:   'HLS/DASH Playlist',
          platform:  extractPlatform(details.url),
          isStream:  true,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Skip individual .ts or DASH chunk segments (the master manifest or clean stream is preferred)
    if (mediaType === 'video' && isChunkUrl(details.url)) return;

    let finalUrl = details.url;
    if (details.url.includes('fbcdn.net')) {
      finalUrl = cleanFacebookVideoUrl(details.url);
    }

    const meta    = tabMetadata[tabId] || {};
    const quality = getQualityTag(details.url, contentType, mediaType);

    storeItem(tabId, {
      url:       finalUrl,
      type:      mediaType,
      mime:      contentType,
      size:      totalSize,
      title:     meta.title || extractPlatform(details.url) || 'Video File',
      poster:    meta.poster || '',
      quality:   quality,
      platform:  extractPlatform(details.url),
      isStream:  details.url.includes('googlevideo.com') || details.url.includes('.m3u8') || details.url.includes('bytestart='),
      pageUrl:   tabCurrentUrls[tabId] || '',
      timestamp: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ─── Advanced Deep Link Extractor (for pasted URLs) ──────────────────────────
async function extractMediaFromPastedUrl(targetTabId, rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  ensureTabState(targetTabId);

  // Wrapper: every manual item gets the original pasted URL for yt-dlp
  const storeManualItem = (tabId, item) => storeItem(tabId, { ...item, pageUrl: url });

  // 1. Direct Video Link Check (e.g. .mp4, .webm, .m3u8)
  if (/\.(mp4|webm|mkv|mov|m3u8|mpd)(\?|$)/i.test(url)) {
    try {
      const headRes = await fetch(url, { method: 'HEAD' });
      const ct = headRes.headers.get('content-type') || '';
      const cl = parseInt(headRes.headers.get('content-length') || '0', 10);
      const isVid = ct.startsWith('video/') || ct.includes('mpegurl') || matchesVideoUrl(url);
      if (isVid) {
        let title = 'Direct Video';
        try {
          const u = new URL(url);
          title = decodeURIComponent(u.pathname.split('/').pop() || 'Video');
        } catch {}
        storeManualItem(targetTabId, {
          url:       url,
          type:      'video',
          mime:      ct || 'video/mp4',
          size:      cl,
          title:     title,
          poster:    '',
          quality:   getQualityTag(url, ct, 'video') || 'Direct',
          platform:  extractPlatform(url),
          isStream:  url.includes('.m3u8'),
          isManual:  true,
          timestamp: Date.now(),
        });
        return { success: true, count: 1 };
      }
    } catch {
      // If HEAD fails, proceed to HTML fetch
    }
  }

  // 2. Fetch via Third-Party Free API (No Keys)
  // Replaces all custom HTML parsing for YouTube, Facebook, TikTok, Reddit, etc.
  try {
    const instances = [
      'https://cobalt.cst.im/api/json',
      'https://cobalt-api.pepegapi.cc/api/json',
      'https://co.wuk.sh/api/json',
      'https://api.vkrdownloader.com/server?vkr=' // fallback to VKR GET api
    ];

    let finalData = null;
    for (let api of instances) {
      try {
        if (api.includes('vkr')) {
            const res = await fetch(api + encodeURIComponent(url));
            const data = await res.json();
            if (data && data.url) { finalData = data; break; }
        } else {
            const res = await fetch(api, {
              method: 'POST',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url: url })
            });
            const data = await res.json();
            if (data && data.url) { finalData = data; break; }
        }
      } catch (e) {
        // silently try next instance
      }
    }
    
    if (finalData && finalData.url) {
      storeManualItem(targetTabId, {
        url:       finalData.url,
        type:      'video',
        mime:      'video/mp4',
        size:      0,
        title:     'Detected Video (API)',
        poster:    '',
        quality:   'API Direct',
        platform:  extractPlatform(url),
        isStream:  data.url.includes('.m3u8'),
        isManual:  true,
        timestamp: Date.now(),
      });
      return { success: true, count: 1 };
    }
  } catch (err) {
    console.error('Third-party API extraction failed:', err);
  }

  return { success: false, count: 0 };
}

// ─── Tab / Navigation Lifecycle (Current Session Scoping) ─────────────────────
function isDifferentMediaPage(oldUrl, newUrl) {
  if (!oldUrl || !newUrl || oldUrl === newUrl) return false;
  try {
    const u1 = new URL(oldUrl);
    const u2 = new URL(newUrl);
    if (u1.origin !== u2.origin) return true;
    if (u1.pathname !== u2.pathname) return true;
    if (u1.searchParams.get('v') !== u2.searchParams.get('v')) return true;
    if (u1.searchParams.get('video_id') !== u2.searchParams.get('video_id')) return true;
    return false;
  } catch {
    return oldUrl !== newUrl;
  }
}

function resetTabMedia(tabId) {
  detectedMedia[tabId] = [];
  seenUrls[tabId]      = new Set();
  hlsManifests[tabId]  = new Set();
  delete tabMetadata[tabId];
  if (storageSaveTimers[tabId]) {
    clearTimeout(storageSaveTimers[tabId]);
    delete storageSaveTimers[tabId];
  }
  chrome.storage.local.set({ ['media_' + tabId]: [] });
}

chrome.tabs.onRemoved.addListener(function(tabId) {
  delete detectedMedia[tabId];
  delete tabMetadata[tabId];
  delete manualScans[tabId];
  delete seenUrls[tabId];
  delete hlsManifests[tabId];
  delete tabCurrentUrls[tabId];
  if (storageSaveTimers[tabId]) {
    clearTimeout(storageSaveTimers[tabId]);
    delete storageSaveTimers[tabId];
  }
  chrome.storage.local.remove('media_' + tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
  if (details.frameId === 0) {
    resetTabMedia(details.tabId);
    tabCurrentUrls[details.tabId] = details.url;
  }
});

// Reset media on Single-Page-App URL transitions (e.g. YouTube next video, Facebook Reels scroll)
chrome.webNavigation.onHistoryStateUpdated.addListener(function(details) {
  if (details.frameId === 0) {
    const tabId = details.tabId;
    const lastUrl = tabCurrentUrls[tabId];
    if (lastUrl && isDifferentMediaPage(lastUrl, details.url)) {
      resetTabMedia(tabId);
    }
    tabCurrentUrls[tabId] = details.url;
  }
});

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.url) {
    const lastUrl = tabCurrentUrls[tabId];
    if (lastUrl && isDifferentMediaPage(lastUrl, changeInfo.url)) {
      resetTabMedia(tabId);
    }
    tabCurrentUrls[tabId] = changeInfo.url;
  }
});

// ─── Message Hub ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── DOM-detected media from content script
  if (request.action === 'domMediaDetected' && sender.tab) {
    const tabId = sender.tab.id;
    ensureTabState(tabId);
    if (request.metadata) tabMetadata[tabId] = request.metadata;

    const addItems = (items, type) => {
      (items || []).forEach(item => {
        const urlStr    = typeof item === 'string' ? item : item.url;
        const posterStr = (typeof item === 'object' && item.poster)  || '';
        const titleStr  = (typeof item === 'object' && item.title)   || '';
        const qual      = (typeof item === 'object' && item.quality) || '';
        if (!urlStr || !urlStr.startsWith('http')) return;
        if (isWebPageUrl(urlStr) || qual === 'page-link') return; // NEVER store page links

        storeItem(tabId, {
          url:       urlStr,
          type:      type,
          mime:      'unknown',
          size:      0,
          poster:    posterStr,
          title:     titleStr,
          quality:   qual,
          platform:  extractPlatform(urlStr),
          isStream:  urlStr.includes('.m3u8') || urlStr.includes('.mpd') || urlStr.includes('googlevideo.com') || urlStr.includes('bytestart='),
          pageUrl:   request.pageUrl || tabCurrentUrls[tabId] || '',
          timestamp: Date.now(),
        });
      });
    };

    addItems(request.images,  'image');
    addItems(request.videos,  'video');
    addItems(request.docs,    'pdf');
    addItems(request.streams, 'video');
  }

  // ── Manual link scan: Deep extract without triggering HTML downloads
  else if (request.action === 'processManualLink') {
    const targetTabId = request.targetTabId;
    extractMediaFromPastedUrl(targetTabId, request.url).then(result => {
      sendResponse(result);
    });
    return true; // async sendResponse
  }

  // ── Immediate in-memory media fetch for instant popup rendering
  else if (request.action === 'getMedia') {
    const tabId = request.tabId;
    const items = (detectedMedia[tabId] || []).filter(m => !currentSessionId || m.sessionId === currentSessionId || !m.sessionId);
    sendResponse({ media: items, sessionId: currentSessionId });
    return false;
  }

  // ── Open popup
  else if (request.action === 'openPopup') {
    if (chrome.action?.openPopup) chrome.action.openPopup().catch(() => {});
  }

  // ── Clear all media for current tab
  else if (request.action === 'clearMedia') {
    const tabId = request.tabId || (sender.tab ? sender.tab.id : null);
    if (tabId) {
      resetTabMedia(tabId);
    }
  }
});
