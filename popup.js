// ─── Instant Startup & Tab Switcher ──────────────────────────────────────────
let activeTabId = null;
let scanTimeout = null;

document.addEventListener('DOMContentLoaded', () => {
    // 1. Setup UI tabs instantly
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

    // 2. Load cached media immediately from background memory / storage (instant 0ms render)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabsList) => {
        if (!tabsList?.length) return;
        activeTabId = tabsList[0].id;

        // Show immediate scanning indicator if no cached media is rendered yet
        showScanningState();

        // 2a. Query background RAM for instant sub-millisecond response
        chrome.runtime.sendMessage({ action: 'getMedia', tabId: activeTabId }, (resp) => {
            if (resp && Array.isArray(resp.media) && resp.media.length > 0) {
                renderMedia(resp.media);
            } else {
                chrome.storage.local.get('media_' + activeTabId, result => {
                    renderMedia(result['media_' + activeTabId] || []);
                });
            }

            // 3. Trigger immediate rescan on the active page
            chrome.tabs.sendMessage(activeTabId, { action: 'rescanMedia' }, () => {
                if (chrome.runtime.lastError) { /* ignore tab error */ }
            });
        });
    });

    // 4. Listen for live updates from background / content scripts
    chrome.storage.onChanged.addListener((changes) => {
        if (!activeTabId) return;
        const key = 'media_' + activeTabId;
        if (changes[key]) {
            renderMedia(changes[key].newValue || []);
        }
    });

    // 5. Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.classList.add('spinning');
            setTimeout(() => refreshBtn.classList.remove('spinning'), 600);

            if (!activeTabId) return;
            showScanningState();
            chrome.runtime.sendMessage({ action: 'getMedia', tabId: activeTabId }, (resp) => {
                if (resp && Array.isArray(resp.media)) {
                    renderMedia(resp.media);
                } else {
                    chrome.storage.local.get('media_' + activeTabId, result => {
                        renderMedia(result['media_' + activeTabId] || []);
                    });
                }
            });
            chrome.tabs.sendMessage(activeTabId, { action: 'rescanMedia' }, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
            });
        });
    }

    // ── Clear All button
    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (!activeTabId) return;
            clearBtn.classList.add('cleared');
            setTimeout(() => clearBtn.classList.remove('cleared'), 500);
            chrome.runtime.sendMessage({ action: 'clearMedia', tabId: activeTabId }, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
            });
            chrome.storage.local.set({ ['media_' + activeTabId]: [] });
            renderMedia([]);
        });
    }

    // 6. Manual link input
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
            manualBtn.innerHTML = '<span class="btn-spinner"></span> Scanning…';

            chrome.tabs.query({ active: true, currentWindow: true }, (tabsList) => {
                if (!tabsList?.length) {
                    manualBtn.disabled = false;
                    manualBtn.textContent = 'Detect';
                    return;
                }
                const tabId = tabsList[0].id;

                chrome.runtime.sendMessage({
                    action: 'processManualLink',
                    url,
                    targetTabId: tabId,
                }, (response) => {
                    manualBtn.disabled = false;
                    if (response && response.count > 0) {
                        manualBtn.textContent = `Found ${response.count}!`;
                        const vidTabBtn = document.querySelector('.tab-btn[data-tab="videos"]');
                        if (vidTabBtn) vidTabBtn.click();
                    } else {
                        manualBtn.textContent = 'Done';
                    }

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
    // Preserve signed URL parameters to prevent HMAC signature invalidation
    return url;
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

function showScanningState() {
    const videoList = document.getElementById('video-list');
    if (videoList && (!videoList.children.length || videoList.querySelector('.empty-state'))) {
        videoList.innerHTML = `<li class="scanning-state"><div class="spinner-ring"></div> Scanning for media on page…</li>`;
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
            const sc = videoList.querySelector('.scanning-state');
            if (sc) {
                videoList.innerHTML = `<li class="empty-state">No videos detected yet. Play a video to detect it.</li>`;
            }
        }, 1200);
    }
}

// ─── High-Performance Batch Render ────────────────────────────────────────────
function renderMedia(mediaArray) {
    clearTimeout(scanTimeout);

    const videos = mediaArray.filter(m =>
        m.type === 'video' && !(m.size > 0 && m.size < 1048576 && !m.isStream)
    );
    const images = mediaArray.filter(m =>
        m.type === 'image' &&
        !(m.size > 0 && m.size < 2048) &&
        !((m.mime || '').includes('keyframes')) &&
        !((m.url || '').includes('keyframes'))
    );
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

    // Use DocumentFragment for 1-pass fast rendering
    const fragment = document.createDocumentFragment();

    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'media-item';
        if (item.isManual) {
            li.classList.add('manual-item');
        }

        // ── Thumbnail / preview
        const preview = document.createElement('div');
        preview.className = 'media-preview';

        if (item.type === 'pdf') {
            preview.textContent = '📄';
        } else if (item.type === 'image') {
            const spinner = document.createElement('div');
            spinner.className = 'preview-spinner';
            preview.appendChild(spinner);

            const img = document.createElement('img');
            img.className = 'preview-img loading';
            img.src       = item.url;
            img.onload = () => {
                spinner.remove();
                img.classList.remove('loading');
                img.classList.add('loaded');
            };
            img.onerror = () => {
                spinner.remove();
                img.remove();
                preview.textContent = '🖼️';
            };
            preview.appendChild(img);
        } else {
            // Video preview
            if (item.poster) {
                const spinner = document.createElement('div');
                spinner.className = 'preview-spinner';
                preview.appendChild(spinner);

                const img = document.createElement('img');
                img.className = 'preview-img loading';
                img.src       = item.poster;
                img.onload = () => {
                    spinner.remove();
                    img.classList.remove('loading');
                    img.classList.add('loaded');
                };
                img.onerror = () => {
                    spinner.remove();
                    img.remove();
                    preview.textContent = '🎥';
                };
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
        if (item.isManual) {
            parts.push('<span class="manual-badge">⚡ Manual</span>');
        }
        if (item.mime && item.mime !== 'unknown') parts.push(item.mime);
        if (item.quality) parts.push(item.quality);
        if (item.size)    parts.push(formatBytes(item.size));
        metaEl.innerHTML = parts.length ? parts.join(' • ') : 'Ready to download';

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

        const copyBtn = document.createElement('button');
        copyBtn.className   = 'copy-btn';
        copyBtn.title       = 'Copy URL';
        copyBtn.textContent = '📋';
        // For manual social items, copy the original page URL (CDN URLs are auth-gated and useless)
        const copyUrl = (item.isManual && item.pageUrl) ? item.pageUrl : item.url;
        copyBtn.onclick = () => {
            copyToClipboard(copyUrl);
            copyBtn.textContent = '✅';
            setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
        };

        // Manual items from social platforms have CDN URLs that require auth cookies
        // the extension doesn't have — direct downloads always fail (saves .txt garbage)
        const AUTH_PLATFORMS = new Set(['YouTube', 'Facebook', 'Instagram', 'TikTok', 'Twitter/X', 'Twitch']);
        const needsYtdlp = item.quality !== 'API Direct' && (
            item.isStream
            || item.url.includes('.m3u8')
            || item.url.includes('bytestart=')
            || item.platform === 'YouTube'
            || item.url.includes('youtube.com')
            || isWebPageUrl(item.url)
            || (item.isManual && AUTH_PLATFORMS.has(item.platform))
        );
        const canDownload = !needsYtdlp;

        if (canDownload) {
            const dlBtn = document.createElement('button');
            dlBtn.className   = 'download-btn';
            dlBtn.textContent = '⬇ Download';
            dlBtn.onclick = () => {
                const cleanUrl  = getCleanDownloadUrl(item.url);
                const safeTitle = getCleanFilename(item);
                chrome.downloads.download({
                    url: cleanUrl,
                    filename: safeTitle,
                    saveAs: false,
                }, () => {
                    if (chrome.runtime.lastError) {
                        chrome.downloads.download({ url: cleanUrl });
                    }
                });
            };
            actions.appendChild(copyBtn);
            actions.appendChild(dlBtn);
        } else {
            // New logic: Use third party API directly for video downloading
            const apiBtn = document.createElement('button');
            apiBtn.className = 'download-btn';
            apiBtn.textContent = '⬇ API Download';
            apiBtn.onclick = async () => {
                const targetUrl = item.pageUrl || item.url;
                const originalText = apiBtn.textContent;
                apiBtn.textContent = '⏳ Fetching...';
                apiBtn.disabled = true;
                const instances = [
                    'https://cobalt.cst.im/api/json',
                    'https://cobalt-api.pepegapi.cc/api/json',
                    'https://co.wuk.sh/api/json',
                    'https://api.vkrdownloader.com/server?vkr=' // fallback to VKR
                ];

                let finalUrl = null;
                for (let api of instances) {
                    try {
                        let data;
                        if (api.includes('vkr')) {
                            const res = await fetch(api + encodeURIComponent(targetUrl));
                            data = await res.json();
                            if (data && data.url) { finalUrl = data.url; break; }
                        } else {
                            const res = await fetch(api, {
                                method: 'POST',
                                headers: {
                                    'Accept': 'application/json',
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ url: targetUrl, videoQuality: '1080' })
                            });
                            data = await res.json();
                            if (data && data.url) { finalUrl = data.url; break; }
                        }
                    } catch (e) {
                        // silently try next
                    }
                }

                if (finalUrl) {
                    chrome.downloads.download({ url: finalUrl, saveAs: false });
                    apiBtn.textContent = '✅ Started';
                } else {
                    apiBtn.textContent = '❌ Failed';
                    // Open web downloader fallback
                    if (item.platform === 'YouTube' || targetUrl.includes('youtube.com')) {
                        window.open(`https://ssyoutube.com/en713/?url=${encodeURIComponent(targetUrl)}`, '_blank');
                    } else if (item.platform === 'Facebook' || targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch')) {
                        window.open(`https://snapsave.app/?url=${encodeURIComponent(targetUrl)}`, '_blank');
                    } else {
                        alert('All free API endpoints failed. Please use the small "yt-dlp" fallback button instead.');
                    }
                }
                setTimeout(() => { 
                    apiBtn.textContent = originalText;
                    apiBtn.disabled = false;
                }, 3000);
            };

            const ytBtn = document.createElement('button');
            ytBtn.className   = 'copy-btn';
            ytBtn.title       = 'Copy yt-dlp command as fallback';
            ytBtn.textContent = 'yt-dlp';
            ytBtn.style.marginLeft = '5px';
            ytBtn.onclick = () => {
                const targetUrl = item.pageUrl || item.url;
                copyToClipboard(`yt-dlp "${targetUrl}"`);
                ytBtn.textContent = '✅';
                setTimeout(() => { ytBtn.textContent = 'yt-dlp'; }, 1800);
            };

            actions.appendChild(copyBtn);
            actions.appendChild(apiBtn);
            actions.appendChild(ytBtn);
        }

        wrapper.appendChild(info);
        wrapper.appendChild(actions);

        li.appendChild(preview);
        li.appendChild(wrapper);
        fragment.appendChild(li);
    });

    ul.appendChild(fragment);
}
