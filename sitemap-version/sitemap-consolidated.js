const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

// ---------- CONFIG ----------
var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const API_SECRET = config_consts.API_SECRET;
const USER_ID = config_consts.USER_ID;
const OAUTH_TOKEN = config_consts.OAUTH_TOKEN;
const OAUTH_TOKEN_SECRET = config_consts.OAUTH_TOKEN_SECRET;

// Determine mode from filename or environment
const mode = process.env.FLICKR_MODE || 
             (process.argv.includes("--private") ? "private" : "public");
const suffix = mode;

// ---------- SEPARATE CACHE DIRS PER MODE ----------
const BASE_CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_DIR = path.join(BASE_CACHE_DIR, mode);
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
const FORCE_REFRESH = process.argv.includes("--refresh");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- CACHE ----------
function cachePath(key) {
    return path.join(CACHE_DIR, key + ".json");
}

function readCache(key) {
    const f = cachePath(key);
    if (!fs.existsSync(f)) return null;
    if (!FORCE_REFRESH) {
        const age = Date.now() - fs.statSync(f).mtimeMs;
        if (age < CACHE_TTL) return JSON.parse(fs.readFileSync(f));
    }
    return null;
}

function writeCache(key, data) {
    fs.writeFileSync(cachePath(key), JSON.stringify(data, null, 2));
}

// ---------- OAUTH (for private mode) ----------
let oauth = null;
let token = null;

function setupOAuth() {
    if (!oauth && mode === "private") {
        oauth = OAuth({
            consumer: { key: API_KEY, secret: API_SECRET },
            signature_method: "HMAC-SHA1",
            hash_function(base, key) {
                return crypto.createHmac("sha1", key).update(base).digest("base64");
            }
        });
        token = { key: OAUTH_TOKEN, secret: OAUTH_TOKEN_SECRET };
    }
}

// ---------- API ----------
async function flickrCall(method, params = {}) {
    const url = "https://www.flickr.com/services/rest/";
    const full = new URL(url);
    full.searchParams.set("method", method);
    full.searchParams.set("api_key", API_KEY);
    full.searchParams.set("format", "json");
    full.searchParams.set("nojsoncallback", "1");
    
    Object.entries(params).forEach(([k, v]) => full.searchParams.set(k, v));

    let headers = {};

    if (mode === "private") {
        setupOAuth();
        const req = { 
            url, 
            method: "GET", 
            data: { 
                method, 
                format: "json", 
                nojsoncallback: "1", 
                ...params 
            } 
        };
        const authHeaders = oauth.toHeader(oauth.authorize(req, token));
        headers = authHeaders;
    }

    return (await fetch(full, { headers })).json();
}

// ---------- FETCH ----------
async function getCollections() {
    const c = readCache("collections");
    if (c) return c;
    const d = await flickrCall("flickr.collections.getTree", { user_id: USER_ID });
    const result = d.collections ? d.collections.collection : [];
    writeCache("collections", result);
    return result;
}

async function getPhotosets() {
    const c = readCache("photosets");
    if (c) return c;
    let page = 1, pages = 1, all = [];
    while (page <= pages) {
        const d = await flickrCall("flickr.photosets.getList", { user_id: USER_ID, page, per_page: 500 });
        if (d.photosets) {
            pages = d.photosets.pages || 1;
            all.push(...(d.photosets.photoset || []));
        } else {
            break;
        }
        page++;
    }
    writeCache("photosets", all);
    return all;
}

async function getUserInfo() {
    const c = readCache("user_info");
    if (c) return c;
    const d = await flickrCall("flickr.people.getInfo", { user_id: USER_ID });
    if (!d.person) {
        throw new Error("Failed to get user info");
    }
    const p = d.person;
    const user = {
        username: p.username._content,
        realname: p.realname._content,
        nsid: p.nsid,
        pathAlias: p.path_alias,
        iconfarm: p.iconfarm,
        iconserver: p.iconserver
    };
    writeCache("user_info", user);
    return user;
}

async function getTotalPhotoCount() {
    const c = readCache("total_photos");
    if (c) return c;
    const d = await flickrCall("flickr.people.getPhotos", { user_id: USER_ID, per_page: 1 });
    const total = parseInt(d.photos?.total || 0);
    writeCache("total_photos", total);
    return total;
}

// ---------- HELPERS ----------
const realId = id => id.split("-").pop();
const baseUser = u => u.pathAlias || u.nsid;
const albumUrl = id => `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;
const collectionUrl = (id, u) => `https://www.flickr.com/photos/${baseUser(u)}/collections/${realId(id)}`;

function avatarUrl(user) {
    if (!user.iconserver || parseInt(user.iconserver) === 0)
        return "https://www.flickr.com/images/buddyicon.gif";
    return `https://farm${user.iconfarm}.staticflickr.com/${user.iconserver}/buddyicons/${user.nsid}.jpg`;
}

const thumbUrl = ps =>
    ps.primary && ps.secret && ps.server && ps.farm
        ? `https://farm${ps.farm}.staticflickr.com/${ps.server}/${ps.primary}_${ps.secret}_q.jpg`
        : null;

// ---------- MAP ----------
function buildMap(list) {
    const m = {};
    list.forEach(ps => {
        m[ps.id] = {
            title: ps.title._content,
            photos: +ps.count_photos,
            videos: +ps.count_videos,
            primary: ps.primary,
            farm: ps.farm,
            server: ps.server,
            secret: ps.secret
        };
    });
    return m;
}

// ---------- ENRICH ----------
function enrich(col, map) {
    col.id = realId(col.id);

    if (col.set) {
        col.set = col.set.map(s => {
            const m = map[s.id];
            if (!m) return null;
            return {
                id: s.id,
                title: m.title,
                photos: m.photos,
                videos: m.videos,
                url: albumUrl(s.id),
                thumb: thumbUrl(m)
            };
        }).filter(Boolean);
    }

    if (col.collection) {
        col.collection = col.collection.map(c => enrich(c, map)).filter(Boolean);
    }

    return col;
}

// ---------- PRUNE (for private mode) ----------
function prune(col) {
    if (col.collection) {
        col.collection = col.collection.map(prune).filter(Boolean);
    }
    const hasAlbums = col.set && col.set.length;
    const hasChildren = col.collection && col.collection.length;
    return (hasAlbums || hasChildren) ? col : null;
}

// ---------- STATS ----------
function stats(col) {
    let s = { collections: 0, albums: 0, photos: 0, videos: 0 };

    if (col.set) {
        col.set.forEach(x => {
            s.albums++;
            s.photos += x.photos;
            s.videos += x.videos;
        });
    }

    if (col.collection) {
        col.collection.forEach(c => {
            s.collections++;
            const sub = stats(c);
            s.collections += sub.collections;
            s.albums += sub.albums;
            s.photos += sub.photos;
            s.videos += sub.videos;
        });
    }

    col._stats = s;
    return s;
}

function countCols(cols) {
    let n = 0;
    (function walk(a) {
        a.forEach(c => {
            n++;
            if (c.collection) walk(c.collection);
        });
    })(cols);
    return n;
}

// ---------- HTML ----------
function buildHTML(collections, user, totals) {
    const name = user.realname || user.username;

    function render(col, depth = 0) {
        const levelClass = `collection-level-${Math.min(depth, 3)}`;
        
        return `
            <div class="collection ${levelClass}" data-collection-title="${col.title.toLowerCase()}">
                <div class="collection-header" onclick="toggle(this)">
                    <span>
                        <a href="${collectionUrl(col.id, user)}" target="_blank">${col.title}</a>
                        <div class="meta">
                            ${col._stats.collections ? `${col._stats.collections.toLocaleString()} collections •` : ""}
                            ${col._stats.albums ? ` ${col._stats.albums.toLocaleString()} albums ` : ""}
                            ${col._stats.photos ? `• ${col._stats.photos.toLocaleString()} photos ` : ""}
                            ${col._stats.videos ? `• ${col._stats.videos.toLocaleString()} videos` : ""}
                        </div>
                    </span>
                    <span class="toggle">[+]</span>
                </div>

                <div class="children">
                    <div class="albums">
                        ${(col.set || []).map(s => `
                            <div class="album-card-wrapper" data-album-title="${s.title.toLowerCase()}" data-photos="${s.photos}" data-videos="${s.videos}">
                                <a class="album-card" href="${s.url}" target="_blank">
                                    ${s.thumb ? `<img src="${s.thumb}" loading="lazy" onerror="this.style.display='none'">` : `<div class="album-placeholder">📷</div>`}
                                    <div class="album-info">
                                        <div class="album-title">${s.title}</div>
                                        <div class="meta">
                                            ${s.photos ? `${s.photos.toLocaleString()} photos ` : ""} ${s.videos ? `• ${s.videos.toLocaleString()} videos` : ""}
                                        </div>
                                    </div>
                                    <div class="album-actions">
                                        <button onclick="event.preventDefault();event.stopPropagation();copyLink('${s.url}')" title="Copy link">🔗</button>
                                    </div>
                                </a>
                            </div>
                        `).join("")}
                    </div>
                    ${(col.collection || []).map(c => render(c, depth + 1)).join("")}
                </div>
            </div>`;
    }

    return `<!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>${name} – Flickr Sitemap</title>

            <style>
                * {
                    box-sizing: border-box;
                }
                
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    background: #f5f5f5;
                    margin: 0;
                    padding: 0;
                    color: #333;
                    transition: background 0.3s, color 0.3s;
                }
                
                .header {
                    position: sticky;
                    top: 0;
                    background: #fff;
                    padding: 12px 20px;
                    display: flex;
                    gap: 12px;
                    align-items: center;
                    border-bottom: 1px solid #ddd;
                    z-index: 1000;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                    transition: background 0.3s, border-color 0.3s;
                }
                
                .header img {
                    width: 48px;
                    height: 48px;
                    border-radius: 50%;
                    border: 2px solid #e0e0e0;
                }
                
                .header h1 {
                    font-size: 18px;
                    margin: 0;
                    font-weight: 600;
                }
                
                .header .subtitle {
                    font-size: 13px;
                    color: #666;
                }
                
                .header a {
                    color: #1a73e8;
                    text-decoration: none;
                }
                
                .header a:hover {
                    text-decoration: underline;
                }

                /* Stats Bar */
                .stats-bar {
                    display: flex;
                    gap: 24px;
                    padding: 12px 20px;
                    background: #f8f9fa;
                    border-radius: 8px;
                    margin: 10px;
                    flex-wrap: wrap;
                    border: 1px solid #e9ecef;
                    align-items: center;
                    transition: background 0.3s, border-color 0.3s;
                }
                
                .stat-item {
                    display: flex;
                    align-items: baseline;
                    gap: 6px;
                    font-size: 14px;
                }
                
                .stat-number {
                    font-weight: bold;
                    color: #1a73e8;
                    font-size: 18px;
                }
                
                .stat-label {
                    color: #666;
                    font-size: 13px;
                }
                
                .stat-divider {
                    color: #ddd;
                }
                
                .filter-results {
                    font-size: 13px;
                    color: #666;
                    padding: 4px 12px;
                    background: #e9ecef;
                    border-radius: 4px;
                    display: inline-block;
                }
                
                .controls {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                    padding: 12px 16px;
                    background: #fff;
                    margin: 10px;
                    border-radius: 8px;
                    align-items: center;
                    border: 1px solid #e9ecef;
                    transition: background 0.3s, border-color 0.3s;
                }
                
                .controls input[type="text"],
                .controls input[type="number"] {
                    padding: 8px 12px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    font-size: 14px;
                    transition: border-color 0.2s;
                }
                
                .controls input[type="text"]:focus,
                .controls input[type="number"]:focus {
                    outline: none;
                    border-color: #1a73e8;
                    box-shadow: 0 0 0 3px rgba(26,115,232,0.1);
                }
                
                .controls label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 14px;
                    cursor: pointer;
                }
                
                .controls button {
                    padding: 8px 16px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    background: #f8f9fa;
                    cursor: pointer;
                    font-size: 14px;
                    transition: all 0.2s;
                    color: #333;
                }
                
                .controls button:hover {
                    background: #e9ecef;
                    border-color: #ccc;
                }
                
                .controls button.primary {
                    background: #1a73e8;
                    color: white;
                    border-color: #1a73e8;
                }
                
                .controls button.primary:hover {
                    background: #1557b0;
                    border-color: #1557b0;
                }
                
                .collection {
                    margin: 10px;
                }
                
                .collection-header {
                    background: #fff;
                    padding: 12px 16px;
                    border-radius: 8px;
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border: 1px solid #e9ecef;
                    transition: all 0.2s;
                    user-select: none;
                }
                
                .collection-header:hover {
                    background: #f8f9fa;
                    border-color: #dee2e6;
                }
                
                .collection-header a {
                    color: #1a73e8;
                    text-decoration: none;
                    font-weight: 500;
                }
                
                .collection-header a:hover {
                    text-decoration: underline;
                }
                
                .collection-header .meta {
                    font-weight: normal;
                }
                
                .collection-header .toggle {
                    font-weight: bold;
                    color: #666;
                    font-size: 18px;
                }
                
                .children {
                    display: none;
                    margin-left: 20px;
                    padding-top: 10px;
                }
                
                .collection.open > .children {
                    display: block;
                    animation: fadeSlide 0.25s ease-out;
                }
                
                @keyframes fadeSlide {
                    from {
                        opacity: 0;
                        transform: translateY(-8px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                
                /* Collection level indicators */
                .collection-level-0 > .collection-header {
                    border-left: 4px solid #1a73e8;
                }
                .collection-level-1 > .collection-header {
                    border-left: 4px solid #34a853;
                }
                .collection-level-2 > .collection-header {
                    border-left: 4px solid #fbbc04;
                }
                .collection-level-3 > .collection-header {
                    border-left: 4px solid #ea4335;
                }
                
                /* Album grid */
                body.grid .albums {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                    gap: 12px;
                    padding: 4px 0;
                }
                
                /* Album list */
                body.list .albums {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 4px 0;
                }
                
                body.list .album-card-wrapper {
                    width: 100%;
                }
                
                body.list .album-card {
                    display: flex;
                    align-items: center;
                    padding: 8px 12px;
                    height: auto;
                    min-height: 80px;
                }
                
                body.list .album-card img,
                body.list .album-card .album-placeholder {
                    width: 80px;
                    height: 80px;
                    flex-shrink: 0;
                    margin-right: 12px;
                    border-radius: 6px;
                }
                
                body.list .album-card .album-info {
                    flex: 1;
                }
                
                body.list .album-card .album-actions {
                    position: static;
                    margin-left: auto;
                }
                
                body.list .album-card:hover .album-actions {
                    display: flex;
                }
                
                /* Album card */
                .album-card-wrapper {
                    position: relative;
                }
                
                .album-card {
                    display: block;
                    background: #fff;
                    border-radius: 10px;
                    overflow: hidden;
                    text-decoration: none;
                    color: #333;
                    transition: transform 0.2s, box-shadow 0.2s;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.06);
                    border: 1px solid #e9ecef;
                    height: 100%;
                    position: relative;
                }
                
                .album-card:hover {
                    transform: translateY(-3px);
                    box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                    border-color: #d0d0d0;
                }
                
                .album-card img {
                    width: 100%;
                    height: 160px;
                    object-fit: cover;
                    display: block;
                    background: #f0f0f0;
                    transition: transform 0.3s;
                }
                
                .album-card:hover img {
                    transform: scale(1.02);
                }
                
                .album-placeholder {
                    width: 100%;
                    height: 160px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #f0f0f0;
                    font-size: 48px;
                    color: #ccc;
                }
                
                .album-info {
                    padding: 10px 12px 12px;
                }
                
                .album-title {
                    font-weight: 600;
                    font-size: 14px;
                    margin-bottom: 4px;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    line-height: 1.3;
                }
                
                .album-actions {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    display: none;
                    gap: 4px;
                    z-index: 10;
                }
                
                .album-card:hover .album-actions {
                    display: flex;
                }
                
                .album-actions button {
                    background: rgba(255,255,255,0.95);
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    padding: 4px 8px;
                    cursor: pointer;
                    font-size: 14px;
                    transition: all 0.2s;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                
                .album-actions button:hover {
                    background: #fff;
                    border-color: #1a73e8;
                    transform: scale(1.05);
                }
                
                .meta {
                    font-size: 12px;
                    color: #888;
                }
                
                .hidden {
                    display: none !important;
                }
                
                .toggle-switch {
                    position: relative;
                    display: inline-block;
                    width: 50px;
                    height: 28px;
                    flex-shrink: 0;
                }
                
                .toggle-switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                
                .toggle-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #ccc;
                    transition: .3s;
                    border-radius: 28px;
                }
                
                .toggle-slider:before {
                    position: absolute;
                    content: "";
                    height: 20px;
                    width: 20px;
                    left: 4px;
                    bottom: 4px;
                    background-color: white;
                    transition: .3s;
                    border-radius: 50%;
                }
                
                input:checked + .toggle-slider {
                    background-color: #1a73e8;
                }
                
                input:focus + .toggle-slider {
                    box-shadow: 0 0 0 3px rgba(26,115,232,0.2);
                }
                
                input:checked + .toggle-slider:before {
                    transform: translateX(22px);
                }
                
                .toggle-label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 14px;
                    color: #555;
                }
                
                .toggle-label .grid-icon,
                .toggle-label .list-icon {
                    font-size: 18px;
                }
                
                .view-label {
                    font-weight: 600;
                    color: #333;
                    min-width: 36px;
                }
                
                #clearFilters,
                #clearFiltersBtn {
                    display: none;
                }
                
                /* Notification toast */
                .toast {
                    position: fixed;
                    bottom: 30px;
                    right: 30px;
                    background: #333;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    z-index: 9999;
                    animation: slideIn 0.3s ease-out;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                    font-size: 14px;
                }
                
                @keyframes slideIn {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                
                /* Dark mode */
                @media (prefers-color-scheme: dark) {
                    body {
                        background: #1a1a1a;
                        color: #e0e0e0;
                    }
                    
                    .header,
                    .controls,
                    .collection-header,
                    .album-card,
                    .stats-bar {
                        background: #2d2d2d;
                        border-color: #444;
                    }
                    
                    .header {
                        border-bottom-color: #444;
                    }
                    
                    .collection-header:hover {
                        background: #383838;
                    }
                    
                    .album-card:hover {
                        border-color: #555;
                    }
                    
                    .album-card,
                    .collection-header a {
                        color: #e0e0e0;
                    }
                    
                    .meta,
                    .stat-label,
                    .filter-results,
                    .collection-header .meta {
                        color: #aaa;
                    }
                    
                    .stat-number {
                        color: #4fc3f7;
                    }
                    
                    .controls input[type="text"],
                    .controls input[type="number"] {
                        background: #3d3d3d;
                        border-color: #555;
                        color: #e0e0e0;
                    }
                    
                    .controls input[type="text"]:focus,
                    .controls input[type="number"]:focus {
                        border-color: #4fc3f7;
                        box-shadow: 0 0 0 3px rgba(79,195,247,0.1);
                    }
                    
                    .controls button {
                        background: #3d3d3d;
                        border-color: #555;
                        color: #e0e0e0;
                    }
                    
                    .controls button:hover {
                        background: #4d4d4d;
                        border-color: #666;
                    }
                    
                    .controls button.primary {
                        background: #1a73e8;
                        color: white;
                        border-color: #1a73e8;
                    }
                    
                    .album-actions button {
                        background: rgba(45,45,45,0.95);
                        border-color: #555;
                        color: #e0e0e0;
                    }
                    
                    .album-actions button:hover {
                        background: #4d4d4d;
                        border-color: #4fc3f7;
                    }
                    
                    .album-placeholder {
                        background: #3d3d3d;
                    }
                    
                    .filter-results {
                        background: #3d3d3d;
                    }
                    
                    .stats-bar {
                        border-color: #444;
                    }
                    
                    .stat-divider {
                        color: #555;
                    }
                    
                    .collection-level-0 > .collection-header {
                        border-left-color: #4fc3f7;
                    }
                    .collection-level-1 > .collection-header {
                        border-left-color: #81c784;
                    }
                    .collection-level-2 > .collection-header {
                        border-left-color: #ffd54f;
                    }
                    .collection-level-3 > .collection-header {
                        border-left-color: #ef5350;
                    }
                }
                
                /* Responsive */
                @media (max-width: 768px) {
                    .header {
                        flex-wrap: wrap;
                        padding: 10px 12px;
                    }
                    
                    .header h1 {
                        font-size: 16px;
                    }
                    
                    .stats-bar {
                        gap: 12px;
                        padding: 10px 12px;
                        margin: 8px;
                        font-size: 12px;
                    }
                    
                    .stat-number {
                        font-size: 16px;
                    }
                    
                    .controls {
                        padding: 10px 12px;
                        margin: 8px;
                        gap: 8px;
                    }
                    
                    .controls input[type="text"] {
                        width: 120px;
                    }
                    
                    .controls input[type="number"] {
                        width: 80px;
                    }
                    
                    body.grid .albums {
                        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                        gap: 8px;
                    }
                    
                    .album-card img,
                    .album-placeholder {
                        height: 120px;
                    }
                    
                    .collection {
                        margin: 8px;
                    }
                    
                    .collection-header {
                        padding: 10px 12px;
                        font-size: 14px;
                    }
                    
                    .children {
                        margin-left: 12px;
                    }
                    
                    .toggle-label .grid-icon,
                    .toggle-label .list-icon {
                        font-size: 16px;
                    }
                }
                
                @media (max-width: 480px) {
                    .header img {
                        width: 36px;
                        height: 36px;
                    }
                    
                    body.grid .albums {
                        grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
                    }
                    
                    .album-card img,
                    .album-placeholder {
                        height: 100px;
                    }
                    
                    .album-title {
                        font-size: 12px;
                    }
                    
                    .meta {
                        font-size: 11px;
                    }
                }
            </style>
        </head>

        <body class="grid">
            <div class="header">
                <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank">
                    <img src="${avatarUrl(user)}" alt="avatar">
                </a>
                <div>
                    <h1>
                        <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank">${name}</a>'s 
                        <a href="https://www.flickr.com/">Flickr</a> Sitemap
                    </h1>
                    <div class="subtitle">Browse and filter all collections and albums</div>
                </div>
            </div>

            <div class="stats-bar">
                <div class="stat-item">
                    <span class="stat-number">${totals.collections.toLocaleString()}</span>
                    <span class="stat-label">Collections</span>
                </div>
                <span class="stat-divider">•</span>
                <div class="stat-item">
                    <span class="stat-number">${totals.albums.toLocaleString()}</span>
                    <span class="stat-label">Albums</span>
                </div>
                <span class="stat-divider">•</span>
                <div class="stat-item">
                    <span class="stat-number">${totals.photos.toLocaleString()}</span>
                    <span class="stat-label">Photos</span>
                </div>
                <div style="margin-left:auto; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <span class="filter-results" id="filterResults">All albums</span>
                    <button onclick="resetFilters()" id="clearFilters" style="display:none;" class="primary">✕ Clear filters</button>
                </div>
            </div>

            <div class="controls">
                <input id="search" placeholder="Search albums..." style="flex:1; min-width:120px;">
                <input id="minPhotos" type="number" placeholder="Min photos" style="width:100px;">
                <label><input type="checkbox" id="hasVideos"> Has videos</label>
                
                <div class="toggle-label">
                    <span class="grid-icon">▦</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="viewToggle">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="list-icon">☰</span>
                    <span class="view-label" id="viewLabel">Grid</span>
                </div>
                
                <button onclick="expandAll()">▼ Expand all</button>
                <button onclick="collapseAll()">▶ Collapse all</button>
                <button onclick="resetFilters()" id="clearFiltersBtn" style="display:none;" class="primary">✕ Clear</button>
                <button onclick="exportData()">📤 Export</button>
            </div>

            ${collections.map(c => render(c, 0)).join("")}

            <script>
                // ---------- Toggle ----------
                function toggle(header) {
                    const col = header.parentElement;
                    col.classList.toggle("open");
                    const indicator = header.querySelector(".toggle");
                    if(indicator) indicator.textContent = col.classList.contains("open") ? "[-]" : "[+]";
                }

                function expandAll() {
                    document.querySelectorAll(".collection").forEach(c => {
                        c.classList.add("open");
                        const i = c.querySelector(".collection-header .toggle");
                        if(i) i.textContent = "[-]";
                    });
                }

                function collapseAll() {
                    document.querySelectorAll(".collection").forEach(c => {
                        c.classList.remove("open");
                        const i = c.querySelector(".collection-header .toggle");
                        if(i) i.textContent = "[+]";
                    });
                }

                // ---------- View toggle ----------
                function setView(v) {
                    document.body.classList.remove("grid","list");
                    document.body.classList.add(v);
                    localStorage.setItem("view", v);
                    
                    const toggle = document.getElementById("viewToggle");
                    toggle.checked = (v === "list");
                    document.getElementById("viewLabel").textContent = v === "grid" ? "Grid" : "List";
                    
                    const p = new URLSearchParams(window.location.search);
                    p.set("view", v);
                    history.replaceState(null, "", "?" + p.toString());
                }

                document.getElementById("viewToggle").addEventListener("change", function() {
                    const view = this.checked ? "list" : "grid";
                    setView(view);
                });

                // ---------- Filter ----------
                function filter() {
                    const q = document.getElementById("search").value.toLowerCase().trim();
                    const min = parseInt(document.getElementById("minPhotos").value) || 0;
                    const vid = document.getElementById("hasVideos").checked;

                    // Update URL params
                    const p = new URLSearchParams(window.location.search);
                    if (q) p.set("q", q);
                    else p.delete("q");
                    if (min > 0) p.set("minPhotos", min);
                    else p.delete("minPhotos");
                    if (vid) p.set("hasVideos", "1");
                    else p.delete("hasVideos");
                    history.replaceState({}, '', location.pathname + '?' + p);

                    let visibleCount = 0;
                    let totalCount = 0;

                    // Filter album wrappers
                    document.querySelectorAll(".album-card-wrapper").forEach(wrapper => {
                        const title = wrapper.dataset.albumTitle || "";
                        const photos = parseInt(wrapper.dataset.photos) || 0;
                        const videos = parseInt(wrapper.dataset.videos) || 0;
                        
                        const matchesSearch = !q || title.includes(q);
                        const matchesMinPhotos = photos >= min;
                        const matchesVideos = !vid || videos > 0;
                        
                        const show = matchesSearch && matchesMinPhotos && matchesVideos;
                        wrapper.classList.toggle("hidden", !show);
                        
                        totalCount++;
                        if (show) visibleCount++;
                    });

                    // Show/hide collections based on visible albums
                    document.querySelectorAll(".collection").forEach(col => {
                        const visibleAlbums = col.querySelectorAll(".album-card-wrapper:not(.hidden)");
                        const hasVisible = visibleAlbums.length > 0;
                        
                        // Only auto-expand if there are visible albums
                        if (hasVisible) {
                            col.classList.add("open");
                            const i = col.querySelector(".collection-header .toggle");
                            if(i) i.textContent = "[-]";
                        } else {
                            col.classList.remove("open");
                            const i = col.querySelector(".collection-header .toggle");
                            if(i) i.textContent = "[+]";
                        }
                    });

                    // Update filter results
                    const resultsEl = document.getElementById("filterResults");
                    const clearBtn = document.getElementById("clearFilters");
                    const clearBtn2 = document.getElementById("clearFiltersBtn");
                    
                    if (q || min > 0 || vid) {
                        resultsEl.textContent = \`Showing \${visibleCount} of \${totalCount} albums\`;
                        clearBtn.style.display = "inline-block";
                        clearBtn2.style.display = "inline-block";
                    } else {
                        resultsEl.textContent = "All albums";
                        clearBtn.style.display = "none";
                        clearBtn2.style.display = "none";
                    }
                }

                function resetFilters() {
                    document.getElementById("search").value = "";
                    document.getElementById("minPhotos").value = "";
                    document.getElementById("hasVideos").checked = false;
                    filter();
                    document.getElementById("search").focus();
                }

                // ---------- Copy link ----------
                function copyLink(url) {
                    event.preventDefault();
                    event.stopPropagation();
                    
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(url).then(() => {
                            showToast("✅ Link copied!");
                        }).catch(() => {
                            fallbackCopy(url);
                        });
                    } else {
                        fallbackCopy(url);
                    }
                }

                function fallbackCopy(text) {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    try {
                        document.execCommand('copy');
                        showToast("✅ Link copied!");
                    } catch (err) {
                        showToast("❌ Failed to copy link");
                    }
                    document.body.removeChild(textarea);
                }

                function showToast(message) {
                    const existing = document.querySelector('.toast');
                    if (existing) existing.remove();
                    
                    const toast = document.createElement('div');
                    toast.className = 'toast';
                    toast.textContent = message;
                    document.body.appendChild(toast);
                    setTimeout(() => toast.remove(), 2000);
                }

                // ---------- Export ----------
                function collectData() {
                    const data = [];
                    document.querySelectorAll(".collection").forEach(col => {
                        const title = col.querySelector(".collection-header a")?.textContent || "Untitled";
                        const albums = [];
                        col.querySelectorAll(".album-card-wrapper:not(.hidden)").forEach(wrapper => {
                            const card = wrapper.querySelector(".album-card");
                            if (card) {
                                albums.push({
                                    title: card.querySelector(".album-title")?.textContent || "Untitled",
                                    photos: parseInt(wrapper.dataset.photos) || 0,
                                    videos: parseInt(wrapper.dataset.videos) || 0,
                                    url: card.href
                                });
                            }
                        });
                        if (albums.length > 0) {
                            data.push({ title, albums });
                        }
                    });
                    return data;
                }

                function exportData() {
                    const data = {
                        generated: new Date().toISOString(),
                        user: "${name}",
                        totalCollections: ${totals.collections},
                        totalAlbums: ${totals.albums},
                        totalPhotos: ${totals.photos},
                        collections: collectData()
                    };
                    
                    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = \`flickr-sitemap-\${new Date().toISOString().split('T')[0]}.json\`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showToast("📤 Export complete!");
                }

                // ---------- Keyboard shortcuts ----------
                document.addEventListener('keydown', function(e) {
                    // Ctrl+F or / to focus search (but not in input fields)
                    const tag = e.target.tagName;
                    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
                        if ((e.ctrlKey && e.key === 'f') || e.key === '/') {
                            e.preventDefault();
                            document.getElementById('search').focus();
                            document.getElementById('search').select();
                        }
                    }
                    
                    // Escape to clear search
                    if (e.key === 'Escape') {
                        const search = document.getElementById('search');
                        if (document.activeElement === search) {
                            resetFilters();
                            search.blur();
                        } else {
                            resetFilters();
                        }
                    }
                });

                // ---------- Init ----------
                (function() {
                    const p = new URLSearchParams(window.location.search);
                    const view = p.get("view") || localStorage.getItem("view") || "grid";
                    setView(view);
                    document.getElementById("search").value = p.get("q") || "";
                    document.getElementById("minPhotos").value = p.get("minPhotos") || "";
                    document.getElementById("hasVideos").checked = p.get("hasVideos") === "1";
                    filter();
                })();
            </script>
        </body>
        </html>`;
}

// ---------- MAIN ----------
(async () => {
    try {
        console.log(`🔧 Running in ${mode.toUpperCase()} mode`);
        console.log(`📁 Cache directory: ${CACHE_DIR}`);
        
        const [collections, photosets, user, totalPhotos] = await Promise.all([
            getCollections(),
            getPhotosets(),
            getUserInfo(),
            getTotalPhotoCount()
        ]);

        const map = buildMap(photosets);
        
        let tree = collections.map(c => enrich(JSON.parse(JSON.stringify(c)), map));
        
        // If private mode, prune empty collections
        if (mode === "private") {
            tree = tree.map(prune).filter(Boolean);
        }
        
        tree.forEach(stats);

        const totals = {
            albums: photosets.length,
            collections: countCols(tree),
            photos: totalPhotos
        };

        const outputFile = `sitemap-${suffix}.html`;
        fs.writeFileSync(outputFile, buildHTML(tree, user, totals));
        console.log(`✅ Generated ${outputFile}`);
        console.log(`   ${totals.collections.toLocaleString()} collections, ${totals.albums.toLocaleString()} albums, ${totals.photos.toLocaleString()} photos`);
        console.log(`   Cache TTL: ${CACHE_TTL / (1000 * 60 * 60 * 24)} days`);
    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    }
})();