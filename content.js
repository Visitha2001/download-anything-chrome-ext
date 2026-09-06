// ─── Utilities ────────────────────────────────────────────────────────────────

function isExtensionValid() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
}

const PAGE_URL_RE = /^https?:\/\/(www\.|web\.|m\.)?(facebook\.com\/(reel|watch|video)|youtube\.com|youtu\.be|instagram\.com\/(p|reel)|twitter\.com|x\.com|tiktok\.com|reddit\.com)/i;

function isPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return PAGE_URL_RE.test(url) || /\.html?(\?|$)/i.test(url);
}

// ─── Floating FAB ────────────────────────────────────────────────────────────
function injectDownloadButton(show) {
  if (!show) return;
  if (document.getElementById('media-downloader-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'media-downloader-btn';
  btn.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`;

  Object.assign(btn.style, {
    position: 'fixed', top: '50%', right: '18px',
    transform: 'translateY(-50%)',
    width: '50px', height: '50px',
    background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
    color: 'white', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 16px rgba(99,102,241,.45)',
    cursor: 'pointer', zIndex: '2147483647',
    transition: 'transform .2s, box-shadow .2s',
  });

  btn.onmouseover = () => {
    btn.style.transform = 'translateY(-50%) scale(1.1)';
    btn.style.boxShadow = '0 6px 24px rgba(99,102,241,.6)';
  };
  btn.onmouseout = () => {
    btn.style.transform = 'translateY(-50%)';
    btn.style.boxShadow = '0 4px 16px rgba(99,102,241,.45)';
  };
  btn.onclick = () => {
    if (!isExtensionValid()) { btn.remove(); return; }
    try {
      chrome.runtime.sendMessage({ action: 'openPopup' }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch { btn.remove(); }
  };

  document.body.appendChild(btn);

  const hc = setInterval(() => {
    if (!isExtensionValid()) { clearInterval(hc); btn.remove(); }
  }, 3000);
}

// ─── Platform Metadata Helpers ───────────────────────────────────────────────

function getPlatform(host) {
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'YouTube';
  if (host.includes('facebook.com') || host.includes('fb.com'))  return 'Facebook';
  if (host.includes('instagram.com'))                            return 'Instagram';
  if (host.includes('twitter.com') || host.includes('x.com'))   return 'Twitter/X';
  if (host.includes('tiktok.com'))                               return 'TikTok';
  if (host.includes('twitch.tv'))                                return 'Twitch';
  if (host.includes('reddit.com') || host.includes('redd.it'))  return 'Reddit';
  if (host.includes('vimeo.com'))                                return 'Vimeo';
  if (host.includes('dailymotion.com'))                          return 'Dailymotion';
  return '';
}

function getPageMetadata() {
  const host     = location.hostname;
  const platform = getPlatform(host);

  let title = document.querySelector('meta[property="og:title"]')?.content
           || document.querySelector('meta[name="twitter:title"]')?.content
           || document.title
           || 'Media File';

  let poster = document.querySelector('meta[property="og:image"]')?.content
            || document.querySelector('meta[name="twitter:image"]')?.content
            || document.querySelector('link[rel="image_src"]')?.href
            || '';

  if (poster?.startsWith('/')) poster = location.origin + poster;

  // Platform-specific poster fallbacks
  if (!poster) {
    if (platform === 'YouTube') {
      const vid = new URLSearchParams(location.search).get('v');
      if (vid) poster = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    } else if (platform === 'Twitter/X') {
      poster = document.querySelector('article img[src*="media"]')?.src || '';
    } else if (platform === 'Instagram') {
      poster = document.querySelector('article img')?.src || '';
    } else if (platform === 'Reddit') {
      poster = document.querySelector('shreddit-post img, .Post img')?.src || '';
    }
  }

  return { title, poster, platform };
}

function getBestVideoSrc(v) {
  if (v.src && !v.src.startsWith('blob:') && !isPageUrl(v.src)) return v.src;
  if (v.currentSrc && !v.currentSrc.startsWith('blob:') && !isPageUrl(v.currentSrc)) return v.currentSrc;

  // <source> children — pick highest resolution
  const sources = Array.from(v.querySelectorAll('source'));
  const ranked = sources
    .map(s => ({
      src:  s.src || s.getAttribute('src') || '',
      res:  parseInt(s.getAttribute('res') || s.getAttribute('size') || '0', 10),
      type: s.type || '',
    }))
    .filter(s => s.src && !s.src.startsWith('blob:') && !isPageUrl(s.src));

  ranked.sort((a, b) => b.res - a.res);
  if (ranked.length) return ranked[0].src;

  // Lazy-load data attributes
  for (const attr of ['data-src', 'data-video-src', 'data-lazy-src', 'data-original']) {
    const val = v.getAttribute(attr);
    if (val && val.startsWith('http') && !isPageUrl(val)) return val;
  }

function getPageVideoElements() {
  const vids = Array.from(document.querySelectorAll('video'));
  try {
    // Check elements with shadow roots shallowly without recursive explosions
    const withShadow = document.querySelectorAll('*');
    for (let i = 0; i < withShadow.length; i++) {
      const sr = withShadow[i].shadowRoot;
      if (sr) {
        const sv = sr.querySelectorAll('video');
        if (sv.length) vids.push(...sv);
      }
    }
  } catch {}
  return vids;
}

// ─── Media Scanner ───────────────────────────────────────────────────────────
function findMediaElements() {
  const meta   = getPageMetadata();
  const videos = [];
  const images = [];
  const docs   = [];

  // 1. <video> elements
  getPageVideoElements().forEach(v => {
    const src = getBestVideoSrc(v);
    const poster = v.getAttribute('poster') || meta.poster || '';
    if (src && !isPageUrl(src)) {
      videos.push({ url: src, poster, title: meta.title, quality: '' });
    }
  });

  // 2. OpenGraph / Meta video URLs
  const ogVid = document.querySelector('meta[property="og:video"]')?.content ||
                document.querySelector('meta[property="og:video:secure_url"]')?.content ||
                document.querySelector('meta[name="twitter:player:stream"]')?.content;
  if (ogVid && ogVid.startsWith('http') && !isPageUrl(ogVid)) {
    videos.push({ url: ogVid, poster: meta.poster, title: meta.title, quality: 'Original' });
  }

  // 3. <img> elements — content images (≥ 250×250)
  document.querySelectorAll('img').forEach(img => {
    const w = img.naturalWidth  || img.width  || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w >= 250 && h >= 250 && img.src && img.src.startsWith('http') && !img.src.includes('data:')) {
      images.push({ url: img.src, title: meta.title });
    }
  });

  // 4. Document / PDF links (<a href="...pdf">)
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.href;
    if (href && /\.pdf(\?|$)/i.test(href) && href.startsWith('http')) {
      docs.push({ url: href, title: a.textContent.trim() || meta.title });
    }
  });

  // 5. JSON-LD VideoObject
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const data = JSON.parse(s.textContent);
      const entries = Array.isArray(data) ? data : [data];
      entries.forEach(d => {
        const contentUrl = d?.contentUrl || d?.video?.contentUrl;
        if (contentUrl && contentUrl.startsWith('http') && !isPageUrl(contentUrl)) {
          videos.push({
            url: contentUrl,
            title: d.name || meta.title,
            poster: d.thumbnailUrl || meta.poster,
            quality: 'HD',
          });
        }
      });
    } catch {}
  });

  if (videos.length || images.length || docs.length) {
    injectDownloadButton(true);
  }

  if (!isExtensionValid()) return;
  try {
    chrome.runtime.sendMessage({
      action: 'domMediaDetected',
      videos, images, docs, streams: [],
      metadata: meta,
    }, () => { if (chrome.runtime.lastError) {} });
  } catch {}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
findMediaElements();

// Debounced MutationObserver
let scanTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(findMediaElements, 1500);
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// Re-scan listener
chrome.runtime.onMessage.addListener((req) => {
  if (req.action === 'rescanMedia') {
    setTimeout(findMediaElements, 50);
  }
});
