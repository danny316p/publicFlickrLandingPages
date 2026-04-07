// Flickr Private Sitemap Generator (FULL FINAL)

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

const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
const FORCE_REFRESH = process.argv.includes("--refresh");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

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
function writeCache(key,data) {
    fs.writeFileSync(cachePath(key), JSON.stringify(data,null,2));
}

// ---------- OAUTH ----------
const oauth = OAuth({
consumer: { key: API_KEY, secret: API_SECRET },
signature_method: "HMAC-SHA1",
    hash_function(base, key) {
        return crypto.createHmac("sha1", key).update(base).digest("base64");
    }
});
const token = { key: OAUTH_TOKEN, secret: OAUTH_TOKEN_SECRET };

// ---------- API ----------
async function flickrCall(method, params= {}) {
    const url = "https://www.flickr.com/services/rest/";
    const req = { url, method:"GET", data:{ method, format:"json", nojsoncallback:"1", ...params } };
    const headers = oauth.toHeader(oauth.authorize(req, token));
    const full = new URL(url);
    Object.entries(req.data).forEach(([k,v])=>full.searchParams.set(k,v));
    return (await fetch(full, {headers})).json();
}

// ---------- FETCH ----------
async function getCollections() {
    const c = readCache("collections");
    if (c) return c;
    const d = await flickrCall("flickr.collections.getTree", {user_id:USER_ID});
    writeCache("collections", d.collections.collection);
    return d.collections.collection;
}

async function getPhotosets() {
    const c = readCache("photosets");
    if(c) return c;
    let page=1,pages=1,all=[];
    while(page<=pages) {
        const d = await flickrCall("flickr.photosets.getList", {user_id:USER_ID,page,per_page:500});
        pages=d.photosets.pages;
        all.push(...d.photosets.photoset);
        page++;
    }
    writeCache("photosets", all);
    return all;
}

async function getUserInfo() {
    const c = readCache("user_info");
    if (c) return c;
    const d = await flickrCall("flickr.people.getInfo", {user_id:USER_ID});
    const p=d.person;
    const user= {
username:
        p.username._content,
realname:
        p.realname._content,
nsid:
        p.nsid,
pathAlias:
        p.path_alias,
iconfarm:
        p.iconfarm,
iconserver:
        p.iconserver
    };
    writeCache("user_info",user);
    return user;
}

async function getTotalPhotoCount() {
    const c = readCache("total");
    if (c) return c;
    const d = await flickrCall("flickr.people.getPhotos", {user_id:USER_ID,per_page:1});
    const total=parseInt(d.photos.total||0);
    writeCache("total",total);
    return total;
}

// ---------- HELPERS ----------
const realId = id => id.split("-").pop();
const baseUser = u => u.pathAlias || u.nsid;
const albumUrl = id => `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;
const collectionUrl = (id,u)=> `https://www.flickr.com/photos/${baseUser(u)}/collections/${realId(id)}`;

function avatarUrl(user) {
    if(!user.iconserver || parseInt(user.iconserver)===0)
        return "https://www.flickr.com/images/buddyicon.gif";
return `https://farm${user.iconfarm}.staticflickr.com/${user.iconserver}/buddyicons/${user.nsid}.jpg`;
}

function thumb(ps) {
    return ps.primary && ps.secret
           ? `https://farm${ps.farm}.staticflickr.com/${ps.server}/${ps.primary}_${ps.secret}_q.jpg`
           : null;
}

// ---------- MAP ----------
function buildMap(list) {
    const m= {};
    list.forEach(ps=> {
        m[ps.id]= {
title:
            ps.title._content,
photos:
            +ps.count_photos,
    videos:
                +ps.count_videos,
    primary:
                ps.primary,
    farm:
                ps.farm,
    server:
                ps.server,
    secret:
                ps.secret
            };
    });
    return m;
}

// ---------- ENRICH ----------
function enrich(col,map) {
    col.id = realId(col.id);

    if (col.set) {
        col.set = col.set.map(s=> {
            const m=map[s.id];
            if (!m) return null;
            return {
id:
                s.id,
title:
                m.title,
photos:
                m.photos,
videos:
                m.videos,
url:
                albumUrl(s.id),
thumb:
                thumb(m)
            };
        }).filter(Boolean);
    }

    if (col.collection) {
        col.collection = col.collection.map(c=>enrich(c,map)).filter(Boolean);
    }

    return col;
}

// ---------- PRUNE ----------
function prune(col) {
    if(col.collection) {
        col.collection = col.collection.map(prune).filter(Boolean);
    }
    const hasAlbums = col.set && col.set.length;
    const hasChildren = col.collection && col.collection.length;
    return (hasAlbums||hasChildren)?col:null;
}

// ---------- STATS ----------
function stats(col) {
    let s= {collections:0,albums:0,photos:0,videos:0};

    if(col.set) {
        col.set.forEach(x=> {
            s.albums++;
            s.photos+=x.photos;
            s.videos+=x.videos;
        });
    }

    if(col.collection) {
        col.collection.forEach(c=> {
            s.collections++;
            const sub=stats(c);
            s.collections+=sub.collections;
            s.albums+=sub.albums;
            s.photos+=sub.photos;
            s.videos+=sub.videos;
        });
    }

    col._stats=s;
    return s;
}

function countCols(cols) {
    let n=0;
    (function walk(a) {
        a.forEach(c=> {
            n++;
            if(c.collection) walk(c.collection);
        });
    })(cols);
    return n;
}

// ---------- HTML ----------
function buildHTML(collections,user,totals) {
    const name=user.realname||user.username;

    function render(col) {
        return `
               <div class="collection">
                              <div class="collection-header" onclick="toggle(this)">
                                             <span>
                                             <a href="${collectionUrl(col.id,user)}" target="_blank">${col.title}</a>
        <div class="meta">
                       ${col._stats.collections?`${col._stats.collections.toLocaleString()} collections •`:""}
        ${col._stats.albums?` ${col._stats.albums.toLocaleString()} albums `:""}
        ${col._stats.photos?`• ${col._stats.photos.toLocaleString()} photos `:""}
        ${col._stats.videos?`• ${col._stats.videos.toLocaleString()} videos`:""}
        </div>
        </span>
        <span>[+]</span>
        </div>

        <div class="children">
                       <div class="albums">
                                      ${(col.set||[]).map(s=>`
                                              <a class="album-card" href="${s.url}" target="_blank"
                                                       data-title="${s.title.toLowerCase()}"
                                                               data-photos="${s.photos}"
                                                                       data-videos="${s.videos}">
                                                                               ${s.thumb?`<img src="${s.thumb}" loading="lazy" onerror="this.style.display='none'">`:""}
                                                                               <div class="album-info">
                                                                                       <div class="album-title">${s.title}</div>
                                                                                               <div class="meta">
                                                                                                       ${s.photos} photos ${s.videos?`• ${s.videos} videos`:""}
                                                                                                       </div>
                                                                                                       </div>
                                                                                                       </a>
                                                                                                       `).join("")
            }
        </div>
        ${(col.collection||[]).map(render).join("")}
        </div>
        </div>`;
    }

    return `<!DOCTYPE html>
           <html>
           <head>
           <meta name="viewport" content="width=device-width,initial-scale=1">
                                         <title>${name} – Flickr Sitemap</title>

                                         <style>
                                         body{font-family:Arial; background:#f5f5f5; margin:0}
                                         .header{position:sticky; top:0; background:#fff; padding:10px; display:flex; gap:10px; align-items:center; border-bottom:1px solid #ddd}
                                         .header img{width:48px; height:48px; border-radius:50%}

                                         .controls{display:flex; gap:10px; flex-wrap:wrap; padding:10px; background:#fff; margin:10px; border-radius:8px}

                                         .collection{margin:10px}
                                         .collection-header{background:#fff; padding:10px; border-radius:8px; cursor:pointer; display:flex; justify-content:space-between}
                                         .children{display:none; margin-left:10px}
                                         .collection.open>.children{display:block}

                                         /* GRID */
                                         body.grid .albums{display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px}

                                         /* LIST */
                                         body.list .albums{display:flex; flex-direction:column; gap:6px}
                                         body.list .album-card{display:flex}
                                         body.list .album-card img{width:80px; height:80px; margin-right:10px}

                                         /* CARD */
                                         .album-card{background:#fff; border-radius:8px; overflow:hidden; text-decoration:none; color:black}
                                         .album-card img{width:100%; height:140px; object-fit:cover}
                                         .album-info{padding:8px}
                                         .meta{font-size:.8em; color:#555}

                                         .hidden{display:none!important}
                                         </style>
    </head>

    <body class="grid">

                    <div class="header">
                                   <img src="${avatarUrl(user)}">
                                            <div>
                                            <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank">${name}</a>
    <div class="meta">
                   ${totals.collections.toLocaleString()} collections •
    ${totals.albums.toLocaleString()} albums •
    ${totals.photos.toLocaleString()} photos
    </div>
    </div>
    </div>

    <div class="controls">
                   <input id="search" placeholder="Search">
                             <input id="minPhotos" type="number" placeholder="Min photos">
                                       <label><input type="checkbox" id="hasVideos"> videos</label>
                                               <button onclick="setView('grid')">Grid</button>
                                                       <button onclick="setView('list')">List</button>
                                                               <button onclick="expandAll()">Expand all</button>
                                                                       <button onclick="collapseAll()">Collapse all</button>
                                                                               </div>

                                                                               ${collections.map(render).join("")}

    <script>
    function toggle(header) {
        const col = header.parentElement;
        col.classList.toggle("open");
        const indicator = header.querySelector("span:last-child");
        if(indicator) indicator.textContent = col.classList.contains("open") ? "[-]" : "[+]";
    }

    function expandAll() {
        document.querySelectorAll(".collection").forEach(c=> {
            c.classList.add("open");
            const i=c.querySelector(".collection-header span:last-child");
            if(i) i.textContent="[-]";
        });
    }

    function collapseAll() {
        document.querySelectorAll(".collection").forEach(c=> {
            c.classList.remove("open");
            const i=c.querySelector(".collection-header span:last-child");
            if(i) i.textContent="[+]";
        });
    }

// ---------- View toggle ----------
    function setView(v) {
        document.body.classList.remove("grid","list");
        document.body.classList.add(v);
        localStorage.setItem("view",v);

        const p=new URLSearchParams(window.location.search);
        p.set("view",v);
        history.replaceState({}, '', location.pathname+'?'+p);
    }

// ---------- Filter ----------
    function filter() {
        const q=document.getElementById("search").value.toLowerCase();
        const min=+document.getElementById("minPhotos").value||0;
        const vid=document.getElementById("hasVideos").checked;

        const p=new URLSearchParams(window.location.search);
        p.set("q",q);
        p.set("minPhotos",min);
        vid?p.set("hasVideos","1"):p.delete("hasVideos");
        history.replaceState({}, '', location.pathname+'?'+p);

        // --- Filter albums ---
        document.querySelectorAll(".album-card").forEach(el=> {
            const show = el.dataset.title.includes(q)
                         && (+el.dataset.photos)>=min
                         && (!vid || +el.dataset.videos>0);
            el.classList.toggle("hidden", !show);
        });

        document.querySelectorAll(".collection").forEach(col=> {
            const visible = col.querySelectorAll(".album-card:not(.hidden)");
            col.classList.toggle("open", visible.length>0);
            const i=col.querySelector(".collection-header span:last-child");
            if(i) i.textContent = col.classList.contains("open")?"[-]":"[+]";
        });
    }

    document.getElementById("search").oninput=filter;
    document.getElementById("minPhotos").oninput=filter;
    document.getElementById("hasVideos").onchange=filter;

    (function() {
        const p=new URLSearchParams(window.location.search);
        setView(p.get("view")||localStorage.getItem("view")||"grid");
        document.getElementById("search").value=p.get("q")||"";
        document.getElementById("minPhotos").value=p.get("minPhotos")||"";
        document.getElementById("hasVideos").checked=p.get("hasVideos")==="1";
        filter();
    })();
    </script>

    </body>
    </html>`;
}

// ---------- MAIN ----------
(async()=> {
    const [collections,photosets,user,total] = await Promise.all([
                getCollections(),
                getPhotosets(),
                getUserInfo(),
                getTotalPhotoCount()
            ]);

    const map=buildMap(photosets);

    const tree=collections
               .map(c=>enrich(JSON.parse(JSON.stringify(c)),map))
               .map(prune)
               .filter(Boolean);

    tree.forEach(stats);

    const totals= {
albums:
        photosets.length,
collections:
        countCols(tree),
photos:
        total
    };

    fs.writeFileSync("sitemap.html", buildHTML(tree,user,totals));
    console.log("✅ DONE: sitemap.html generated");
})();
