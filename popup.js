// ─── Tab Switcher ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const tabs     = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t     => t.classList.remove('active'));
            contents.forEach(c => c.classList.add('hidden'));
            tab.classList.add('active');
            const targetContent = document.getElementById(`${tab.dataset.tab}-tab`);
            if (targetContent) targetContent.classList.remove('hidden');
        });
    });

    // ── Initial load
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs?.length) return;
        const tabId = tabs[0].id;
        chrome.storage.local.get('media_' + tabId, result => {
            renderMedia(result['media_' + tabId] || []);
        });
    });

    // ── Live updates from background
    chrome.storage.onChanged.addListener((changes) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs?.length) return;
            const key = 'media_' + tabs[0].id;
            if (changes[key]) renderMedia(changes[key].newValue || []);
        });
    });

    // ── Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.classList.add('spinning');
            setTimeout(() => refreshBtn.classList.remove('spinning'), 800);

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs?.length) return;
                const tabId = tabs[0].id;
                chrome.storage.local.get('media_' + tabId, result => {
                    renderMedia(result['media_' + tabId] || []);
                });
                chrome.tabs.sendMessage(tabId, { action: 'rescanMedia' }, () => {
                    if (chrome.runtime.lastError) { /* ignore */ }
                });
            });
        });
    }

    // ── Manual link input
    const manualBtn   = document.getElementById('manual-add-btn');
    const manualInput = document.getElementById('manual-link-input');
    if (manualBtn && manualInput) {
        const doDetect = () => {
            let url = manualInput.value.trim();
            if (!url) return;
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }

            manualBtn.disabled = true;
            manualBtn.textContent = 'Scanning…';

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs?.length) {
                    manualBtn.disabled = false;
                    manualBtn.textContent = 'Detect';
                    return;
                }
                const tabId = tabs[0].id;

                chrome.runtime.sendMessage({
                    action: 'processManualLink',
                    url,
                    targetTabId: tabId,
                }, (response) => {
                    manualBtn.disabled = false;
                    if (response && response.count > 0) {
                        manualBtn.textContent = `Found ${response.count}!`;
                        // Switch to Videos tab
                        const vidTabBtn = document.querySelector('.tab-btn[data-tab="videos"]');
                        if (vidTabBtn) vidTabBtn.click();
                    } else {
                        manualBtn.textContent = 'Done';
                    }

                    // Reload storage
                    chrome.storage.local.get('media_' + tabId, result => {
                        renderMedia(result['media_' + tabId] || []);
                    });

                    setTimeout(() => {
                        manualInput.value = '';
                        manualBtn.textContent = 'Detect';
                    }, 2000);
                });
            });
        };

        manualBtn.addEventListener('click', doDetect);
        manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') doDetect(); });
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
    if (!+bytes) return '';
    const k  = 1024;
    const sz = ['B','KB','MB','GB'];
    const i  = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sz[i]}`;
}

function isWebPageUrl(url) {
    if (!url) return false;
    return /facebook\.com\/(reel|watch|video)|youtube\.com|youtu\.be|instagram\.com\/(reel|p)|twitter\.com|x\.com|tiktok\.com|reddit\.com|\.html?(\?|$)/i.test(url);
}

function isStreamUrl(url) {
    return /googlevideo\.com\/videoplayback/.test(url) ||
           /\.m3u8(\?|$)/i.test(url) ||
           /\.mpd(\?|$)/i.test(url)  ||
           /\.ts(\?|$)/i.test(url);
}

function getCleanDownloadUrl(url) {
    try {
        const u = new URL(url);
        // Clean Facebook range limits so entire video is downloaded
        u.searchParams.delete('bytestart');
        u.searchParams.delete('byteend');
        return u.toString();
    } catch {
        return url;
    }
}

function getCleanFilename(item) {
    let ext = '.mp4';
    if (item.type === 'image') ext = '.jpg';
    else if (item.type === 'pdf') ext = '.pdf';
    else if (item.url.includes('.webm')) ext = '.webm';
    else if (item.url.includes('.m3u8')) ext = '.m3u8';

    let rawTitle = (item.title || 'media_file')
        .replace(/\[Detected\]/g, '')
        .replace(/\[Pasted Link\]/g, '')
        .trim();

    let safeName = rawTitle
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 45);

    if (!safeName) safeName = 'video_download';
    if (!safeName.toLowerCase().endsWith(ext)) {
        safeName += ext;
    }
    return safeName;
}

function getPlatformIcon(platform) {
    const p = (platform || '').toLowerCase();
    const icons = {
        youtube:    '▶️', facebook: '👤', instagram: '📷',
        'twitter/x':'🐦', twitter:   '🐦', tiktok:   '🎵',
        twitch:     '🟣', reddit:    '🟠', vimeo:    '🔵',
        dailymotion:'🎬',
    };
    return icons[p] || '';
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderMedia(mediaArray) {
    // Only filter out confirmed non-stream videos with known size < 1MB
    const videos = mediaArray.filter(m =>
        m.type === 'video' && !(m.size > 0 && m.size < 1048576 && !m.isStream)
    );
    const images = mediaArray.filter(m => m.type === 'image');
    const docs   = mediaArray.filter(m => m.type === 'pdf');

    setCount('video-count', videos.length);
    setCount('image-count', images.length);
    setCount('doc-count',   docs.length);

    renderList('video-list', videos, 'videos');
    renderList('image-list', images, 'images');
    renderList('doc-list',   docs,   'documents');
}

function setCount(id, n) {
    const el = document.getElementById(id);
    if (el) el.textContent = n;
}

function renderList(listId, items, label) {
    const ul = document.getElementById(listId);
    if (!ul) return;
    if (!items.length) {
        ul.innerHTML = `<li class="empty-state">No ${label} detected yet.</li>`;
        return;
    }

    ul.innerHTML = '';
    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'media-item';

        // ── Thumbnail / preview
        const preview = document.createElement('div');
        preview.className = 'media-preview';

        if (item.type === 'pdf') {
            preview.textContent = '📄';
        } else if (item.type === 'image') {
            const img = document.createElement('img');
            img.src     = item.url;
            img.onerror = () => { preview.textContent = '🖼️'; };
            preview.appendChild(img);
        } else {
            // Video preview
            if (item.poster) {
                const img = document.createElement('img');
                img.src     = item.poster;
                img.onerror = () => { preview.textContent = '🎥'; };
                preview.appendChild(img);
            } else {
                preview.textContent = '🎥';
            }
        }

        // ── Info block
        const wrapper = document.createElement('div');
        wrapper.className = 'media-content-wrapper';

        const info = document.createElement('div');
        info.className = 'media-info';

        // Title
        const titleEl = document.createElement('div');
        titleEl.className = 'media-url';
        let displayTitle = item.title || 'Video File';
        const platformIcon = getPlatformIcon(item.platform);
        titleEl.textContent = (platformIcon ? platformIcon + ' ' : '') + displayTitle;
        titleEl.title = item.url;

        // Meta row
        const metaEl = document.createElement('div');
        metaEl.className = 'media-meta';
        const parts = [];
        if (item.mime && item.mime !== 'unknown') parts.push(item.mime);
        if (item.quality) parts.push(item.quality);
        if (item.size)    parts.push(formatBytes(item.size));
        metaEl.textContent = parts.length ? parts.join(' • ') : 'Ready to download';

        info.appendChild(titleEl);
        info.appendChild(metaEl);

        // Stream / chunk warning for adaptive streams
        if (item.isStream || isStreamUrl(item.url)) {
            const warn = document.createElement('div');
            warn.className = 'stream-warning';
            warn.title     = 'Stream or manifest. Use yt-dlp for complete audio+video merging.';
            warn.textContent = '⚠️ Live stream / DASH — use yt-dlp for best results';
            info.appendChild(warn);
        }

        // ── Action buttons
        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const dlBtn = document.createElement('button');
        dlBtn.className   = 'download-btn';
        dlBtn.textContent = '⬇ Download';
        dlBtn.onclick = () => {
            if (isWebPageUrl(item.url)) {
                alert('This is a web page link, not a direct video stream. Play the video on the page to capture the direct stream.');
                return;
            }
            const cleanUrl  = getCleanDownloadUrl(item.url);
            const safeTitle = getCleanFilename(item);
            chrome.downloads.download({
                url: cleanUrl,
                filename: safeTitle,
                saveAs: false,
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    // Fallback to simple download if filename conflict occurs
                    chrome.downloads.download({ url: cleanUrl });
                }
            });
        };

        const copyBtn = document.createElement('button');
        copyBtn.className   = 'copy-btn';
        copyBtn.title       = 'Copy URL';
        copyBtn.textContent = '📋';
        copyBtn.onclick = () => {
            copyToClipboard(item.url);
            copyBtn.textContent = '✅';
            setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
        };

        // yt-dlp button for streams / YouTube
        if (item.isStream || isStreamUrl(item.url) || item.platform === 'YouTube') {
            const ytBtn = document.createElement('button');
            ytBtn.className   = 'ytdlp-btn';
            ytBtn.title       = 'Copy yt-dlp command to clipboard';
            ytBtn.textContent = 'yt-dlp';
            ytBtn.onclick = () => {
                const targetUrl = item.url.includes('googlevideo.com')
                    ? location.href
                    : item.url;
                copyToClipboard(`yt-dlp "${targetUrl}"`);
                ytBtn.textContent = 'Copied!';
                setTimeout(() => { ytBtn.textContent = 'yt-dlp'; }, 1800);
            };
            actions.appendChild(ytBtn);
        }

        actions.appendChild(copyBtn);
        actions.appendChild(dlBtn);

        wrapper.appendChild(info);
        wrapper.appendChild(actions);

        li.appendChild(preview);
        li.appendChild(wrapper);
        ul.appendChild(li);
    });
}
