const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const API_KEY = "YOUR_FLICKR_API_KEY";
const USER_ID = "YOUR_FLICKR_USER_ID";

const API = "https://www.flickr.com/services/rest/";
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_TTL = 1000 * 60 * 60 * 24;

const FORCE_REFRESH = process.argv.includes("--refresh");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ---------- Cache ----------

function cachePath(key) {
  return path.join(CACHE_DIR, key + ".json");
}

function readCache(key) {
  const file = cachePath(key);
  if (!fs.existsSync(file)) return null;

  if (!FORCE_REFRESH) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CACHE_TTL) {
      return JSON.parse(fs.readFileSync(file));
    }
  }

  return null;
}

function writeCache(key, data) {
  fs.writeFileSync(cachePath(key), JSON.stringify(data, null, 2));
}

// ---------- Flickr ----------

async function flickrCall(method, params = {}) {
  const url = new URL(API);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("format", "json");
  url.searchParams.set("nojsoncallback", "1");

  Object.entries(params).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );

  const res = await fetch(url);
  return res.json();
}

// ---------- Data ----------

async function getCollections() {
  const cached = readCache("collections");
  if (cached) return cached;

  const data = await flickrCall("flickr.collections.getTree", {
    user_id: USER_ID
  });

  writeCache("collections", data.collections.collection);
  return data.collections.collection;
}

async function getAllPhotosets() {
  const cached = readCache("photosets_list");
  if (cached) return cached;

  let page = 1, pages = 1, all = [];

  while (page <= pages) {
    const data = await flickrCall("flickr.photosets.getList", {
      user_id: USER_ID,
      page,
      per_page: 500
    });

    pages = data.photosets.pages;
    all.push(...data.photosets.photoset);
    page++;
  }

  writeCache("photosets_list", all);
  return all;
}

async function getUserInfo() {
  const cached = readCache("user_info");
  if (cached) return cached;

  const data = await flickrCall("flickr.people.getInfo", {
    user_id: USER_ID
  });

  const p = data.person;

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
  const cached = readCache("total_photos");
  if (cached) return cached;

  const data = await flickrCall("flickr.people.getPhotos", {
    user_id: USER_ID,
    per_page: 1
  });

  const total = parseInt(data.photos.total || 0);
  writeCache("total_photos", total);
  return total;
}

// ---------- Helpers ----------

function getRealCollectionId(id) {
  return id.split("-").pop();
}

function collectionUrl(id, user) {
  const base = user.pathAlias || user.nsid;
  return `https://www.flickr.com/photos/${base}/collections/${getRealCollectionId(id)}`;
}

function albumUrl(id) {
  return `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;
}

function getAvatarUrl(user) {
  return user.iconserver > 0
    ? `https://farm${user.iconfarm}.staticflickr.com/${user.iconserver}/buddyicons/${user.nsid}.jpg`
    : "https://www.flickr.com/images/buddyicon.gif";
}

function getThumbnailUrl(ps) {
  if (!ps.primary || !ps.secret || !ps.server || !ps.farm) return null;
  return `https://farm${ps.farm}.staticflickr.com/${ps.server}/${ps.primary}_${ps.secret}_q.jpg`;
}

// ---------- Map ----------

function buildPhotosetMap(list) {
  const map = {};
  list.forEach(ps => {
    map[ps.id] = {
      title: ps.title._content,
      photos: +ps.count_photos,
      videos: +ps.count_videos,
      primary: ps.primary,
      farm: ps.farm,
      server: ps.server,
      secret: ps.secret
    };
  });
  return map;
}

// ---------- Enrich ----------

function enrichCollection(col, map) {
  col.id = getRealCollectionId(col.id);

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
        thumb: getThumbnailUrl(m)
      };
    }).filter(Boolean);
  }

  if (col.collection) {
    col.collection = col.collection.map(c => enrichCollection(c, map));
  }

  return col;
}

// ---------- Stats ----------

function computeStats(col) {
  let stats = { collections: 0, albums: 0, photos: 0, videos: 0 };

  if (col.set) {
    stats.albums += col.set.length;
    col.set.forEach(s => {
      stats.photos += s.photos;
      stats.videos += s.videos;
    });
  }

  if (col.collection) {
    stats.collections += col.collection.length;
    col.collection.forEach(sub => {
      const subStats = computeStats(sub);
      stats.collections += subStats.collections;
      stats.albums += subStats.albums;
      stats.photos += subStats.photos;
      stats.videos += subStats.videos;
    });
  }

  col._stats = stats;
  return stats;
}

function countCollections(cols) {
  let c = 0;
  (function walk(arr){
    arr.forEach(x=>{
      c++;
      if(x.collection) walk(x.collection);
    });
  })(cols);
  return c;
}

// ---------- HTML ----------

function buildHTML(collections, user, totals) {
  const name = user.realname || user.username;
  const avatar = getAvatarUrl(user);
  const profile = `https://www.flickr.com/photos/${user.pathAlias || user.nsid}`;

  function renderCollection(col) {
    return `
<div class="collection">
  <div class="collection-header" onclick="toggle(this)">
    <span>
      <a href="${collectionUrl(col.id, user)}" target="_blank">${col.title}</a>
      <div class="meta">
        ${col._stats.collections} collections •
        ${col._stats.albums} albums •
        ${col._stats.photos} photos
        ${col._stats.videos ? `• ${col._stats.videos} videos` : ""}
      </div>
    </span>
    <span class="toggle">[+]</span>
  </div>

  <div class="children">

    <div class="album-grid">
      ${(col.set || []).map(s => `
        <a class="album-card"
           href="${s.url}" target="_blank"
           data-title="${s.title.toLowerCase()}"
           data-photos="${s.photos}"
           data-videos="${s.videos}">

          ${s.thumb ? `<img src="${s.thumb}" loading="lazy" alt="${s.title}">` : ""}

          <div class="album-info">
            <div class="album-title">${s.title}</div>
            <div class="meta">
              ${s.photos} photos ${s.videos ? `• ${s.videos} videos` : ""}
            </div>
          </div>

        </a>
      `).join("")}
    </div>

    ${(col.collection || []).map(renderCollection).join("")}

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

.header{
  position:sticky;top:0;background:#fff;
  display:flex;gap:10px;align-items:center;
  padding:10px;border-bottom:1px solid #ddd;
  z-index:1000;
}

.header img{width:48px;height:48px;border-radius:50%}

.controls{
  display:flex;gap:10px;flex-wrap:wrap;
  padding:10px;background:#fff;margin:10px;border-radius:8px;
}

.collection{margin:10px}

.collection-header{
  background:#fff;padding:10px;border-radius:8px;
  cursor:pointer;display:flex;justify-content:space-between;
}

.children{display:none;margin-left:10px}
.collection.open>.children{display:block}

.album-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:10px;
  margin-top:10px;
}

.album-card{
  background:#fff;border-radius:8px;
  overflow:hidden;text-decoration:none;color:black;
  display:flex;flex-direction:column;
}

.album-card img{
  width:100%;height:140px;object-fit:cover;
}

.album-info{padding:8px}
.album-title{font-weight:bold}
.meta{font-size:.8em;color:#555}

.hidden{display:none!important}
</style>
</head>

<body>

<div class="header">
  <img src="${avatar}">
  <div>
    <a href="${profile}" target="_blank">${name}</a>
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
  <button onclick="expandAll()">Expand all</button>
  <button onclick="collapseAll()">Collapse all</button>
</div>

${collections.map(renderCollection).join("")}

<script>
function toggle(el){el.parentElement.classList.toggle("open")}
function expandAll(){document.querySelectorAll(".collection").forEach(c=>c.classList.add("open"))}
function collapseAll(){document.querySelectorAll(".collection").forEach(c=>c.classList.remove("open"))}

function filter(){
  const q=document.getElementById("search").value.toLowerCase();
  const min=+document.getElementById("minPhotos").value||0;
  const vid=document.getElementById("hasVideos").checked;

  document.querySelectorAll(".album-card").forEach(el=>{
    const t=el.dataset.title;
    const p=+el.dataset.photos;
    const v=+el.dataset.videos;

    const show=t.includes(q)&&p>=min&&(!vid||v>0);
    el.classList.toggle("hidden",!show);
  });
}

document.getElementById("search").oninput=filter;
document.getElementById("minPhotos").oninput=filter;
document.getElementById("hasVideos").onchange=filter;
</script>

</body>
</html>`;
}

// ---------- Main ----------

(async () => {
  const [collections, photosets, user, totalPhotos] = await Promise.all([
    getCollections(),
    getAllPhotosets(),
    getUserInfo(),
    getTotalPhotoCount()
  ]);

  const map = buildPhotosetMap(photosets);
  const enriched = collections.map(c => enrichCollection(c, map));
  enriched.forEach(computeStats);

  const totals = {
    albums: photosets.length,
    collections: countCollections(enriched),
    photos: totalPhotos
  };

  fs.writeFileSync("index.html", buildHTML(enriched, user, totals));

  console.log("✅ done (grid layout version)");
})();
