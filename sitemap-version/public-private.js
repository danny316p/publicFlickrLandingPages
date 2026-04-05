// FULL FLICKR SITEMAP GENERATOR (PUBLIC + PRIVATE + UI)

const fs = require("fs");
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

// ---------- OAUTH ----------
const oauth = OAuth({
  consumer: { key: API_KEY, secret: API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(base, key) {
    return crypto.createHmac("sha1", key).update(base).digest("base64");
  }
});

const token = {
  key: OAUTH_TOKEN,
  secret: OAUTH_TOKEN_SECRET
};

// ---------- API ----------
async function flickrCall(method, params = {}) {
  const url = "https://www.flickr.com/services/rest/";

  const requestData = {
    url,
    method: "GET",
    data: {
      method,
      format: "json",
      nojsoncallback: "1",
      ...params
    }
  };

  const headers = oauth.toHeader(
    oauth.authorize(requestData, token)
  );

  const full = new URL(url);
  Object.entries(requestData.data).forEach(([k, v]) =>
    full.searchParams.set(k, v)
  );

  const res = await fetch(full, { headers });
  return res.json();
}

// ---------- FETCH ----------
async function getCollections() {
  const d = await flickrCall("flickr.collections.getTree", {
    user_id: USER_ID
  });
  return d.collections.collection;
}

async function getPhotosets() {
  let page = 1, pages = 1, all = [];

  while (page <= pages) {
    const d = await flickrCall("flickr.photosets.getList", {
      user_id: USER_ID,
      page,
      per_page: 500
    });

    pages = d.photosets.pages;
    all.push(...d.photosets.photoset);
    page++;
  }

  return all;
}

async function getUserInfo() {
  const d = await flickrCall("flickr.people.getInfo", {
    user_id: USER_ID
  });

  const p = d.person;

  return {
    username: p.username._content,
    realname: p.realname._content,
    nsid: p.nsid,
    pathAlias: p.path_alias,
    iconfarm: p.iconfarm,
    iconserver: p.iconserver
  };
}

async function getTotalPhotos() {
  const d = await flickrCall("flickr.people.getPhotos", {
    user_id: USER_ID,
    per_page: 1
  });

  return parseInt(d.photos.total || 0);
}

// ---------- HELPERS ----------
const realId = id => id.split("-").pop();
const baseUser = u => u.pathAlias || u.nsid;

const collectionUrl = (id, u) =>
  `https://www.flickr.com/photos/${baseUser(u)}/collections/${realId(id)}`;

const albumUrl = id =>
  `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;

const avatarUrl = u =>
  u.iconserver > 0
    ? `https://farm${u.iconfarm}.staticflickr.com/${u.iconserver}/buddyicons/${u.nsid}.jpg`
    : "https://www.flickr.com/images/buddyicon.gif";

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
      secret: ps.secret,
      isPublic: ps.visibility_is_public === 1
    };
  });
  return m;
}

// ---------- ENRICH ----------
function enrich(col, map, mode = "all") {
  col.id = realId(col.id);

  if (col.set) {
    col.set = col.set.map(s => {
      const m = map[s.id];
      if (!m) return null;

      if (mode === "public" && !m.isPublic) return null;

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
    col.collection = col.collection
      .map(c => enrich(c, map, mode))
      .filter(Boolean);
  }

  return col;
}

// ---------- PRUNE ----------
function prune(col) {
  if (col.collection) {
    col.collection = col.collection.map(prune).filter(Boolean);
  }

  const hasAlbums = col.set && col.set.length;
  const hasChildren = col.collection && col.collection.length;

  if (!hasAlbums && !hasChildren) return null;
  return col;
}

// ---------- STATS ----------
function stats(col) {
  let s = { collections: 0, albums: 0, photos: 0, videos: 0 };

  if (col.set) {
    s.albums += col.set.length;
    col.set.forEach(x => {
      s.photos += x.photos;
      s.videos += x.videos;
    });
  }

  if (col.collection) {
    s.collections += col.collection.length;
    col.collection.forEach(c => {
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
  (function walk(a){
    a.forEach(c=>{
      n++;
      if(c.collection) walk(c.collection);
    });
  })(cols);
  return n;
}

// ---------- HTML ----------
function buildHTML(collections, user, totals, label) {
const name = user.realname || user.username;

function render(col){
return `
<div class="collection">
  <div class="collection-header" onclick="toggle(this)">
    <span>
      <a href="${collectionUrl(col.id,user)}" target="_blank">${col.title}</a>
      <div class="meta">
        ${col._stats.collections} collections •
        ${col._stats.albums} albums •
        ${col._stats.photos} photos
        ${col._stats.videos?`• ${col._stats.videos} videos`:""}
      </div>
    </span>
    <span>[+]</span>
  </div>

  <div class="children">
    <div class="albums">
      ${(col.set||[]).map(s=>`
        <a class="album-card"
           href="${s.url}" target="_blank"
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
      `).join("")}
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
body{font-family:Arial;background:#f5f5f5;margin:0}
.header{position:sticky;top:0;background:#fff;padding:10px;display:flex;gap:10px;align-items:center;border-bottom:1px solid #ddd;z-index:1000}
.header img{width:48px;height:48px;border-radius:50%}
.banner{background:#222;color:#fff;padding:6px;text-align:center}

.controls{display:flex;gap:10px;flex-wrap:wrap;padding:10px;background:#fff;margin:10px;border-radius:8px}

.collection{margin:10px}
.collection-header{background:#fff;padding:10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between}
.children{display:none;margin-left:10px}
.collection.open>.children{display:block}

/* GRID */
body.grid .albums{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}

/* LIST */
body.list .albums{display:flex;flex-direction:column;gap:6px}
body.list .album-card{display:flex;align-items:center}
body.list .album-card img{width:80px;height:80px;margin-right:10px}

/* CARD */
.album-card{background:#fff;border-radius:8px;overflow:hidden;text-decoration:none;color:black}
.album-card img{width:100%;height:140px;object-fit:cover}
.album-info{padding:8px}
.meta{font-size:.8em;color:#555}

.hidden{display:none!important}
</style>
</head>

<body class="grid">

<div class="banner">${label}</div>

<div class="header">
  <img src="${avatarUrl(user)}">
  <div>
    <a href="https://www.flickr.com/photos/${baseUser(user)}" target="_blank">${name}</a>
    <div class="meta">
      ${totals.collections} collections •
      ${totals.albums} albums •
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
  <button onclick="expandAll()">Expand</button>
  <button onclick="collapseAll()">Collapse</button>
</div>

${collections.map(render).join("")}

<script>
function toggle(el){el.parentElement.classList.toggle("open")}
function expandAll(){document.querySelectorAll(".collection").forEach(c=>c.classList.add("open"))}
function collapseAll(){document.querySelectorAll(".collection").forEach(c=>c.classList.remove("open"))}

function setView(v){
  document.body.classList.remove("grid","list");
  document.body.classList.add(v);
  localStorage.setItem("view",v);
}

function loadView(){
  const v=localStorage.getItem("view")||"grid";
  setView(v);
}

function filter(){
  const q=document.getElementById("search").value.toLowerCase();
  const min=+document.getElementById("minPhotos").value||0;
  const vid=document.getElementById("hasVideos").checked;

  document.querySelectorAll(".album-card").forEach(el=>{
    const show=el.dataset.title.includes(q)
      && (+el.dataset.photos)>=min
      && (!vid || +el.dataset.videos>0);
    el.classList.toggle("hidden",!show);
  });

  document.querySelectorAll(".collection").forEach(col=>{
    const visible=col.querySelectorAll(".album-card:not(.hidden)");
    col.classList.toggle("open",visible.length>0);
  });
}

document.getElementById("search").oninput=filter;
document.getElementById("minPhotos").oninput=filter;
document.getElementById("hasVideos").onchange=filter;

loadView();
</script>

</body>
</html>`;
}

// ---------- MAIN ----------
(async () => {
  const [collections, photosets, user, totalPhotos] = await Promise.all([
    getCollections(),
    getPhotosets(),
    getUserInfo(),
    getTotalPhotos()
  ]);

  const map = buildMap(photosets);

  const allTree = collections.map(c => enrich(JSON.parse(JSON.stringify(c)), map, "all")).map(prune).filter(Boolean);
  const publicTree = collections.map(c => enrich(JSON.parse(JSON.stringify(c)), map, "public")).map(prune).filter(Boolean);

  allTree.forEach(stats);
  publicTree.forEach(stats);

  const totals = {
    albums: photosets.length,
    collections: countCols(allTree),
    photos: totalPhotos
  };

  fs.writeFileSync("private.html", buildHTML(allTree, user, totals, "Private (All Content)"));
  fs.writeFileSync("public.html", buildHTML(publicTree, user, totals, "Public Only"));

  console.log("✅ Done: public.html + private.html");
})();
