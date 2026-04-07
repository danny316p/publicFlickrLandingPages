const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// ---------- CONFIG ----------
var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const USER_ID = config_consts.USER_ID;

const API = "https://www.flickr.com/services/rest/";
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

// ---------- Flickr ----------
async function flickrCall(method, params= {}) {
    const url = new URL(API);
    url.searchParams.set("method", method);
    url.searchParams.set("api_key", API_KEY);
    url.searchParams.set("format","json");
    url.searchParams.set("nojsoncallback","1");
    Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
    return (await fetch(url)).json();
}

// ---------- Data ----------
async function getCollections() {
    const c = readCache("collections");
    if (c) return c;
    const d = await flickrCall("flickr.collections.getTree", {user_id:USER_ID});
    writeCache("collections", d.collections.collection);
    return d.collections.collection;
}

function countCollections(collections) {
    let count = 0;

    function walk(col) {
        count++;
        if (col.collection) {
            col.collection.forEach(walk);
        }
    }

    collections.forEach(walk);
    return count;
}

async function getAllPhotosets() {
    const c = readCache("photosets_list");
    if (c) return c;
    let page=1,pages=1,all=[];
    while(page<=pages) {
        const d = await flickrCall("flickr.photosets.getList", {user_id:USER_ID,page,per_page:500});
        pages=d.photosets.pages;
        all.push(...d.photosets.photoset);
        page++;
    }
    writeCache("photosets_list", all);
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
    const c = readCache("total_photos");
    if (c) return c;
    const d = await flickrCall("flickr.people.getPhotos", {user_id:USER_ID,per_page:1});
    const total=parseInt(d.photos.total||0);
    writeCache("total_photos",total);
    return total;
}

// ---------- Helpers ----------
const realId = id => id.split("-").pop();
const baseUser = u => u.pathAlias || u.nsid;

const collectionUrl = (id,u)=>
                      `https://www.flickr.com/photos/${baseUser(u)}/collections/${realId(id)}`;

                          const albumUrl = id =>
                                           `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;

                                           const avatarUrl = u =>
                                                   u.iconserver>0
                                                   ? `https://farm${u.iconfarm}.staticflickr.com/${u.iconserver}/buddyicons/${u.nsid}.jpg`
                                                   : "https://www.flickr.com/images/buddyicon.gif";

const thumbUrl = ps =>
                 ps.primary && ps.secret && ps.server && ps.farm
                 ? `https://farm${ps.farm}.staticflickr.com/${ps.server}/${ps.primary}_${ps.secret}_q.jpg`
                 : null;

// ---------- Map ----------
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

// ---------- Enrich ----------
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
                thumbUrl(m)
            };
        }).filter(Boolean);
    }

    if (col.collection) {
        col.collection = col.collection.map(c=>enrich(c,map));
    }

    return col;
}

// ---------- STATS ----------
function stats(col) {
    let s= {collections:0,albums:0,photos:0,videos:0};

    if(col.set) {
        s.albums+=col.set.length;
        col.set.forEach(x=> {
            s.photos+=x.photos;
            s.videos+=x.videos;
        });
    }

    if(col.collection) {
        s.collections+=col.collection.length;
        col.collection.forEach(c=> {
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
                                             <a href="${collectionUrl(col.id,user)}" target="_blank">$ {col.title}</a>
        <div class="meta">
                       $ {col._stats.collections?`${col._stats.collections.toLocaleString()} collections •`:""}
        $ {col._stats.albums?` ${col._stats.albums.toLocaleString()} albums `:""}
        $ {col._stats.photos?`• ${col._stats.photos.toLocaleString()} photos `:""}
        $ {col._stats.videos?`• ${col._stats.videos.toLocaleString()} videos`:""}
        </div>
        </span>
        <span class="toggle">[+]</span>
                        </div>

                        <div class="children">

                                       <div class="albums">
                                                      $ {(col.set||[]).map(s=>`
                                                              <a class="album-card"
                                                                      href="${s.url}" target="_blank"
                                                                              data-title="${s.title.toLowerCase()}"
                                                                                      data-photos="${s.photos}"
                                                                                              data-videos="${s.videos}">

                                                                                                      ${s.thumb?`<img src="${s.thumb}" loading="lazy">`:""}

                                                                                                      <div class="album-info">
                                                                                                              <div class="album-title">${s.title}</div>
                                                                                                                      <div class="meta">
                                                                                                                              ${s.photos?`${s.photos.toLocaleString()} photos `:""}
                                                                                                                              ${s.videos?`• ${s.videos.toLocaleString()} videos`:""}
                                                                                                                              </div>
                                                                                                                              </div>
                                                                                                                              </a>
                                                                                                                              `).join("")
                }
        </div>

        $ {(col.collection||[]).map(render).join("")}

        </div>
        </div>`;
    }

    return `<!DOCTYPE html>
           <html>
           <head>
           <meta name="viewport" content="width=device-width,initial-scale=1">
                                         <title>$ {name} – Flickr Sitemap</title>

                                         <style>
                                         body{font-family:Arial; background:#f5f5f5; margin:0}

    .header{
position:
        sticky;
        top:0;
background:
#fff;
display:
        flex;
        gap:10px;
align-items:
        center;
        padding:10px;
        border-bottom:1px solid #ddd;
        z-index:1000;
    }
    .header img{width:48px; height:48px; border-radius:50%}

    .controls{
display:
        flex;
        gap:10px;
flex-wrap:
        wrap;
        padding:10px;
background:
#fff; 
        margin:10px;
        border-radius:8px;
    }

    .collection{margin:10px}
    .collection-header{
background:
#fff; 
        padding:10px;
        border-radius:8px;
cursor:
        pointer;
display:
        flex;
justify-content:
        space-between;
    }
    .children{display:none; margin-left:10px}
    .collection.open>.children{display:block}

    /* GRID VIEW */
    body.grid .albums{
display:
        grid;
grid-template-columns:
        repeat(auto-fill,minmax(180px,1fr));
        gap:10px;
    }

    /* LIST VIEW */
    body.list .albums{
display:
        flex;
flex-direction:
        column;
        gap:6px;
    }
    body.list .album-card{
display:
        flex;
align-items:
        center;
    }
    body.list .album-card img{
        width:80px;
        height:80px;
object-fit:
        cover;
        margin-right:10px;
    }

    /* SHARED */
    .album-card{
background:
#fff; 
        border-radius:8px;
overflow:
        hidden;
text-decoration:
        none;
color:
        black;
    }
    .album-card img{
        width:100%;
        height:140px;
object-fit:
        cover;
    }
    .album-info{padding:8px}
    .album-title{font-weight:bold}
    .meta{font-size:.8em; color:#555}

    .hidden{display:none!important}
    </style>
    </head>

    <body class="grid">

                    <div class="header">
                                   <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank"><img src="${avatarUrl(user)}" alt="avatar"></a>
                                           <div>
                                           <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank">$ {name}</a>'s <a href="https://www.flickr.com/">Flickr</a> sitemap
    <div class="meta">
                   $ {totals.collections} collections •
    $ {totals.albums} albums •
    $ {totals.photos.toLocaleString()} photos
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

                                                                               $ {collections.map(render).join("")}

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

        const p=new URLSearchParams(location.search);
        p.set("view",v);
        history.replaceState(null,"","?"+p.toString());
    }

// ---------- Filter ----------
    function filter() {
        const q = document.getElementById("search").value.toLowerCase();
        const min = +document.getElementById("minPhotos").value || 0;
        const vid = document.getElementById("hasVideos").checked;

        // --- Filter albums ---
        document.querySelectorAll(".album-card").forEach(el=> {
            const t = el.dataset.title;
            const p = +el.dataset.photos;
            const v = +el.dataset.videos;

            const show = t.includes(q) && p >= min && (!vid || v > 0);
            el.classList.toggle("hidden", !show);
        });

        // --- Expand/collapse collections based on visibility ---
        document.querySelectorAll(".collection").forEach(col => {
            const visibleAlbums = col.querySelectorAll(".album-card:not(.hidden)");

            if (visibleAlbums.length > 0) {
                col.classList.add("open");
            } else {
                col.classList.remove("open");
            }
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
    const [collections,photosets,user,totalPhotos]=await Promise.all([
                getCollections(),
                getAllPhotosets(),
                getUserInfo(),
                getTotalPhotoCount()
            ]);

    const map=buildMap(photosets);
    const enriched=collections.map(c=>enrich(c,map));
    enriched.forEach(stats);

    const totals= {
albums:
        photosets.length,
collections:
        countCols(enriched),
photos:
        totalPhotos
    };

    fs.writeFileSync("index.html", buildHTML(enriched,user,totals));
    console.log("✅ done (grid/list toggle)");
})();
