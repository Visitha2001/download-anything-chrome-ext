// ─── State ────────────────────────────────────────────────────────────────────
let detectedMedia = {};   // tabId → [mediaItem]
let tabMetadata   = {};   // tabId → { title, poster, platform }
let manualScans   = {};   // backgroundTabId → targetTabId
let hlsManifests  = {};   // tabId → Set of seen m3u8 base URLs
let seenUrls      = {};   // tabId → Set of normalized URLs

// ─── MIME & Regex Classifiers ────────────────────────────────────────────────
const VIDEO_MIME = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/x-matroska', 'video/avi',
  'video/quicktime', 'video/x-flv', 'video/x-ms-wmv', 'video/x-msvideo',
  'video/3gpp', 'video/3gpp2', 'video/mp2t', 'video/mpeg', 'video/iso.segment',
  'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml', 'application/octet-stream',
]);

const IMAGE_MIME_PREFIX = 'image/';
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

// URLs that are clearly web pages and must NEVER be treated as downloadable video files
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
  try {
    const u = new URL(url);
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    return u.toString();
  } catch {
    return url;
  }
}

function matchesVideoUrl(url) {
  return VIDEO_URL_PATTERNS.some(re => re.test(url));
}

function classifyUrl(url, contentType) {
  if (isWebPageUrl(url)) return null;
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (ct && VIDEO_MIME.has(ct)) return 'video';
  if (ct && ct.startsWith(IMAGE_MIME_PREFIX)) return 'image';
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

function getQualityTag(url, contentType) {
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
  if (url.includes('fbcdn.net')) return 'HD Video';
  return '';
}

function ensureTabState(tabId) {
  if (!detectedMedia[tabId]) detectedMedia[tabId] = [];
  if (!seenUrls[tabId])      seenUrls[tabId]      = new Set();
  if (!hlsManifests[tabId])  hlsManifests[tabId]  = new Set();
}

function storeItem(tabId, item) {
  if (!item || !item.url) return;
  // STRICT GUARD: Never store web page URLs as video or image items
  if (isWebPageUrl(item.url) || item.quality === 'page-link') return;

  ensureTabState(tabId);
  const key = normalizeUrl(item.url);
  if (seenUrls[tabId].has(key)) return;
  seenUrls[tabId].add(key);

  detectedMedia[tabId].push(item);
  chrome.storage.local.set({ ['media_' + tabId]: detectedMedia[tabId] });

  // Mirror to manual-scan origin tab if this came from a background scan
  const targetTabId = manualScans[tabId];
  if (targetTabId) {
    ensureTabState(targetTabId);
    const mirrorKey = normalizeUrl(item.url);
    if (!seenUrls[targetTabId].has(mirrorKey)) {
      seenUrls[targetTabId].add(mirrorKey);
      const copy = { ...item, title: (item.title ? '[Detected] ' + item.title : 'Detected Video') };
      detectedMedia[targetTabId].push(copy);
      chrome.storage.local.set({ ['media_' + targetTabId]: detectedMedia[targetTabId] });
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

    // Skip tiny images/icons (< 15KB)
    if (mediaType === 'image' && totalSize > 0 && totalSize < 15000) return;

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
    const quality = getQualityTag(details.url, contentType);

    storeItem(tabId, {
      url:       finalUrl,
      type:      mediaType,
      mime:      contentType,
      size:      totalSize,
      title:     meta.title || extractPlatform(details.url) || 'Video File',
      poster:    meta.poster || '',
      quality:   quality,
      platform:  extractPlatform(details.url),
      isStream:  details.url.includes('googlevideo.com') || details.url.includes('.m3u8'),
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
        storeItem(targetTabId, {
          url:       url,
          type:      'video',
          mime:      ct || 'video/mp4',
          size:      cl,
          title:     title,
          poster:    '',
          quality:   getQualityTag(url, ct) || 'Direct',
          platform:  extractPlatform(url),
          isStream:  url.includes('.m3u8'),
          timestamp: Date.now(),
        });
        return { success: true, count: 1 };
      }
    } catch {
      // If HEAD fails, proceed to HTML fetch
    }
  }

  // 2. Fetch page HTML in background (bypasses CORS via <all_urls>)
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,video/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });

    const contentType = res.headers.get('content-type') || '';

    // If server responded with a direct video stream
    if (contentType.startsWith('video/') || contentType.includes('mpegurl')) {
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      storeItem(targetTabId, {
        url:       url,
        type:      'video',
        mime:      contentType,
        size:      cl,
        title:     'Video Stream',
        poster:    '',
        quality:   'Stream',
        platform:  extractPlatform(url),
        isStream:  url.includes('.m3u8'),
        timestamp: Date.now(),
      });
      return { success: true, count: 1 };
    }

    const html = await res.text();
    let foundCount = 0;

    // Helper to unescape JSON strings
    const unescapeJson = str => {
      try {
        return decodeURIComponent(JSON.parse(`"${str}"`));
      } catch {
        return str.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
      }
    };

    // Extract title & poster from HTML
    let pageTitle = '';
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) pageTitle = titleMatch[1].trim();

    let posterUrl = '';
    const posterMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
    if (posterMatch) posterUrl = posterMatch[1].replace(/&amp;/g, '&');

    // ── Facebook Reel / Video extraction
    if (url.includes('facebook.com') || url.includes('fb.watch')) {
      const fbVideoRegexes = [
        /"browser_native_hd_url"\s*:\s*"([^"]+)"/,
        /"browser_native_sd_url"\s*:\s*"([^"]+)"/,
        /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
        /"playable_url"\s*:\s*"([^"]+)"/,
        /"video_url"\s*:\s*"([^"]+)"/,
      ];

      for (const rx of fbVideoRegexes) {
        const m = html.match(rx);
        if (m && m[1]) {
          const rawMediaUrl = unescapeJson(m[1]);
          if (rawMediaUrl.startsWith('http') && !isWebPageUrl(rawMediaUrl)) {
            const cleanUrl = cleanFacebookVideoUrl(rawMediaUrl);
            const quality = rx.source.includes('hd') ? '1080p / HD' : 'SD';
            storeItem(targetTabId, {
              url:       cleanUrl,
              type:      'video',
              mime:      'video/mp4',
              size:      0,
              title:     pageTitle || 'Facebook Video',
              poster:    posterUrl,
              quality:   quality,
              platform:  'Facebook',
              isStream:  false,
              timestamp: Date.now(),
            });
            foundCount++;
            break;
          }
        }
      }
    }

    // ── Reddit extraction
    if (url.includes('reddit.com/r/')) {
      try {
        const jsonUrl = url.split('?')[0].replace(/\/+$/, '') + '.json';
        const rRes = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const rData = await rRes.json();
        const post = rData?.[0]?.data?.children?.[0]?.data;
        if (post) {
          const vidObj = post.secure_media?.reddit_video || post.media?.reddit_video;
          if (vidObj?.fallback_url) {
            storeItem(targetTabId, {
              url:       vidObj.fallback_url,
              type:      'video',
              mime:      'video/mp4',
              size:      0,
              title:     post.title || pageTitle || 'Reddit Video',
              poster:    post.thumbnail || posterUrl,
              quality:   vidObj.height ? `${vidObj.height}p` : 'HD',
              platform:  'Reddit',
              isStream:  false,
              timestamp: Date.now(),
            });
            foundCount++;
          }
        }
      } catch {}
    }

    // ── TikTok extraction
    if (url.includes('tiktok.com')) {
      const ttMatches = html.match(/"playAddr"\s*:\s*"([^"]+)"/) ||
                        html.match(/"downloadAddr"\s*:\s*"([^"]+)"/);
      if (ttMatches && ttMatches[1]) {
        const ttUrl = unescapeJson(ttMatches[1]);
        if (ttUrl.startsWith('http')) {
          storeItem(targetTabId, {
            url:       ttUrl,
            type:      'video',
            mime:      'video/mp4',
            size:      0,
            title:     pageTitle || 'TikTok Video',
            poster:    posterUrl,
            quality:   'HD',
            platform:  'TikTok',
            isStream:  false,
            timestamp: Date.now(),
          });
          foundCount++;
        }
      }
    }

    // ── OpenGraph & Twitter Video meta tags
    const ogVideoMatch = html.match(/<meta\s+property=["']og:video(?::secure_url|:url)?["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+(?:name|property)=["']twitter:player:stream["']\s+content=["']([^"']+)["']/i);
    if (ogVideoMatch && ogVideoMatch[1]) {
      const ogVidUrl = ogVideoMatch[1].replace(/&amp;/g, '&');
      if (ogVidUrl.startsWith('http') && !isWebPageUrl(ogVidUrl)) {
        storeItem(targetTabId, {
          url:       ogVidUrl,
          type:      'video',
          mime:      'video/mp4',
          size:      0,
          title:     pageTitle || 'Video File',
          poster:    posterUrl,
          quality:   'Original',
          platform:  extractPlatform(ogVidUrl) || extractPlatform(url),
          isStream:  ogVidUrl.includes('.m3u8'),
          timestamp: Date.now(),
        });
        foundCount++;
      }
    }

    // ── HTML5 <video> and <source> tag extraction
    const srcRegex = /<(?:video|source)[^>]+src=["']([^"']+\.(?:mp4|webm|mkv|mov|m3u8|mpd)[^"']*)["']/gi;
    let sMatch;
    while ((sMatch = srcRegex.exec(html)) !== null) {
      let vSrc = sMatch[1];
      if (vSrc.startsWith('//')) vSrc = 'https:' + vSrc;
      else if (vSrc.startsWith('/')) {
        try { vSrc = new URL(url).origin + vSrc; } catch {}
      }
      if (vSrc.startsWith('http') && !isWebPageUrl(vSrc)) {
        storeItem(targetTabId, {
          url:       vSrc,
          type:      'video',
          mime:      'video/mp4',
          size:      0,
          title:     pageTitle || 'Video Stream',
          poster:    posterUrl,
          quality:   getQualityTag(vSrc, '') || '',
          platform:  extractPlatform(vSrc) || extractPlatform(url),
          isStream:  vSrc.includes('.m3u8'),
          timestamp: Date.now(),
        });
        foundCount++;
      }
    }

    // ── Generic fallback regex for media CDN URLs inside scripts/JSON
    if (foundCount === 0) {
      const cdnRegex = /https?:\\\/\\\/[^"'\s<>]+\.(?:mp4|webm|m3u8)(?:\\\/[^"'\s<>]*)?/gi;
      const cdnMatches = html.match(cdnRegex);
      if (cdnMatches) {
        for (const rawCdn of cdnMatches.slice(0, 3)) {
          const decUrl = unescapeJson(rawCdn);
          if (decUrl.startsWith('http') && !isWebPageUrl(decUrl)) {
            storeItem(targetTabId, {
              url:       decUrl,
              type:      'video',
              mime:      'video/mp4',
              size:      0,
              title:     pageTitle || 'Detected Video',
              poster:    posterUrl,
              quality:   '',
              platform:  extractPlatform(decUrl) || extractPlatform(url),
              isStream:  decUrl.includes('.m3u8'),
              timestamp: Date.now(),
            });
            foundCount++;
          }
        }
      }
    }

    // If YouTube link
    if (foundCount === 0 && (url.includes('youtube.com') || url.includes('youtu.be'))) {
      let vidId = '';
      try {
        const u = new URL(url);
        vidId = u.searchParams.get('v') || u.pathname.split('/').pop();
      } catch {}
      if (vidId) {
        posterUrl = `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
        // We add an informative item with yt-dlp copy capability
        storeItem(targetTabId, {
          url:       `https://www.youtube.com/watch?v=${vidId}`,
          type:      'video',
          mime:      'video/mp4',
          size:      0,
          title:     pageTitle || `YouTube Video (${vidId})`,
          poster:    posterUrl,
          quality:   'YouTube Stream',
          platform:  'YouTube',
          isStream:  true,
          timestamp: Date.now(),
        });
        foundCount++;
      }
    }

    return { success: foundCount > 0, count: foundCount };
  } catch (err) {
    console.error('Error fetching pasted URL:', err);
    return { success: false, count: 0 };
  }
}

// ─── Tab / Navigation Lifecycle ───────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(function(tabId) {
  delete detectedMedia[tabId];
  delete tabMetadata[tabId];
  delete manualScans[tabId];
  delete seenUrls[tabId];
  delete hlsManifests[tabId];
  chrome.storage.local.remove('media_' + tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
  if (details.frameId === 0) {
    const tabId = details.tabId;
    detectedMedia[tabId] = [];
    seenUrls[tabId]      = new Set();
    hlsManifests[tabId]  = new Set();
    delete tabMetadata[tabId];
    chrome.storage.local.set({ ['media_' + tabId]: [] });
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
          isStream:  urlStr.includes('.m3u8') || urlStr.includes('.mpd') || urlStr.includes('googlevideo.com'),
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

  // ── Open popup
  else if (request.action === 'openPopup') {
    if (chrome.action?.openPopup) chrome.action.openPopup().catch(() => {});
  }

  // ── Clear all media for current tab
  else if (request.action === 'clearMedia' && sender.tab) {
    const tabId = sender.tab.id;
    detectedMedia[tabId] = [];
    seenUrls[tabId]      = new Set();
    hlsManifests[tabId]  = new Set();
    chrome.storage.local.set({ ['media_' + tabId]: [] });
  }
});
