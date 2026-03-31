const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const API_KEY = "YOUR_FLICKR_API_KEY";
const USER_ID = "YOUR_FLICKR_USER_ID";

const API = "https://www.flickr.com/services/rest/";
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_TTL = 1000 * 60 * 60 * 24;

const FORCE_REFRESH = process.argv.includes("--refresh");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

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

// ---------- Collections ----------

async function getCollections() {
  const cached = readCache("collections");
  if (cached) {
    console.log("📦 collections cache");
    return cached;
  }

  console.log("🌐 fetching collections");
  const data = await flickrCall("flickr.collections.getTree", {
    user_id: USER_ID
  });

  writeCache("collections", data.collections.collection);
  return data.collections.collection;
}

// ---------- Photosets ----------

async function getAllPhotosets() {
  const cached = readCache("photosets_list");
  if (cached) {
    console.log("📦 photosets list cache");
    return cached;
  }

  console.log("🌐 fetching all photosets");

  let page = 1;
  let pages = 1;
  let all = [];

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

// ---------- Map ----------

function buildPhotosetMap(list) {
  const map = {};

  list.forEach(ps => {
    map[ps.id] = {
      id: ps.id,
      title: ps.title._content,
      photos: parseInt(ps.count_photos || 0),
      videos: parseInt(ps.count_videos || 0)
    };
  });

  return map;
}

// ---------- Helpers ----------

function albumUrl(id) {
  return `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;
}

// ---------- Enrichment ----------

function enrichCollection(collection, map) {
  if (collection.set) {
    collection.set = collection.set
      .map(set => {
        const meta = map[set.id];
        if (!meta) return null;

        return {
          id: set.id,
          title: meta.title,
          photos: meta.photos,
          videos: meta.videos,
          url: albumUrl(set.id)
        };
      })
      .filter(Boolean);
  }

  if (collection.collection) {
    collection.collection = collection.collection.map(sub =>
      enrichCollection(sub, map)
    );
  }

  return collection;
}

// ---------- HTML ----------

function formatMeta(set) {
  return set.videos > 0
    ? `${set.photos} photos • ${set.videos} videos`
    : `${set.photos} photos`;
}

function renderCollection(collection) {
  return `
  <div class="collection">
    <div class="collection-header" onclick="toggle(this)">
      <span>${collection.title}</span>
      <span class="toggle">[+]</span>
    </div>

    <div class="children">

      ${(collection.set || []).map(set => `
        <div class="album"
             data-title="${set.title.toLowerCase()}"
             data-photos="${set.photos}"
             data-videos="${set.videos}">
          <a href="${set.url}" target="_blank">${set.title}</a>
          <div class="meta">${formatMeta(set)}</div>
        </div>
      `).join("")}

      ${(collection.collection || []).map(renderCollection).join("")}

    </div>
  </div>
  `;
}

function buildHTML(collections) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flickr Sitemap</title>

<style>
body { font-family: Arial; background:#f5f5f5; padding:1rem; }
#app { max-width:1000px; margin:auto; }

.controls {
  background:white; padding:10px; border-radius:8px;
  margin-bottom:10px; display:flex; flex-wrap:wrap; gap:10px;
}

.collection, .album {
  background:white; margin:6px 0; border-radius:8px; padding:10px;
}

.collection-header {
  cursor:pointer; font-weight:bold;
  display:flex; justify-content:space-between;
}

.children { display:none; margin-left:20px; }
.collection.open > .children { display:block; }

.album {
  display:flex; justify-content:space-between; flex-wrap:wrap;
}

.meta { font-size:0.9em; color:#555; }
.hidden { display:none !important; }

mark { background:yellow; padding:0 2px; }

@media (max-width:600px) {
  .album { flex-direction:column; }
}
</style>
</head>

<body>

<h1>Flickr Sitemap</h1>

<div class="controls">
  <input type="text" id="search" placeholder="Search albums...">
  <input type="number" id="minPhotos" placeholder="Min photos">
  <label><input type="checkbox" id="hasVideos"> Has videos</label>
  <button onclick="expandAll()">Expand all</button>
  <button onclick="collapseAll()">Collapse all</button>
</div>

<div id="app">
${collections.map(renderCollection).join("")}
</div>

<script>
function toggle(el) {
  const parent = el.parentElement;
  parent.classList.toggle("open");
  updateToggle(parent);
}

function updateToggle(collection) {
  const t = collection.querySelector(".toggle");
  if (t) t.textContent = collection.classList.contains("open") ? "[-]" : "[+]";
}

function debounce(fn, delay=200){
  let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),delay); };
}

function escapeRegex(str){
  return str.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');
}

function highlight(text, term){
  if(!term) return text;
  const r=new RegExp("("+escapeRegex(term)+")","gi");
  return text.replace(r,"<mark>$1</mark>");
}

const searchInput=document.getElementById("search");
const minPhotosInput=document.getElementById("minPhotos");
const hasVideosInput=document.getElementById("hasVideos");

function updateURL(){
  const p=new URLSearchParams();
  if(searchInput.value)p.set("q",searchInput.value);
  if(minPhotosInput.value)p.set("min",minPhotosInput.value);
  if(hasVideosInput.checked)p.set("vid","1");
  history.replaceState(null,"","?"+p.toString());
}

function loadFromURL(){
  const p=new URLSearchParams(location.search);
  if(p.get("q"))searchInput.value=p.get("q");
  if(p.get("min"))minPhotosInput.value=p.get("min");
  if(p.get("vid")==="1")hasVideosInput.checked=true;
}

function applyFilters(){
  const term=searchInput.value.toLowerCase();
  const min=parseInt(minPhotosInput.value)||0;
  const vid=hasVideosInput.checked;

  document.querySelectorAll(".album").forEach(el=>{
    const title=el.dataset.title;
    const photos=+el.dataset.photos;
    const videos=+el.dataset.videos;

    const link=el.querySelector("a");
    const original=link.dataset.original||link.textContent;
    link.dataset.original=original;

    let show=title.includes(term)&&photos>=min&&(!vid||videos>0);

    el.classList.toggle("hidden",!show);

    if(show&&term){
      link.innerHTML=highlight(original,term);
    }else{
      link.textContent=original;
    }
  });

  document.querySelectorAll(".collection").forEach(col=>{
    const visible=col.querySelectorAll(".album:not(.hidden)").length>0;
    col.classList.toggle("open",visible);
    updateToggle(col);
  });

  updateURL();
}

const debounced=debounce(applyFilters,200);

function expandAll(){
  document.querySelectorAll(".collection").forEach(c=>{
    c.classList.add("open"); updateToggle(c);
  });
}

function collapseAll(){
  document.querySelectorAll(".collection").forEach(c=>{
    c.classList.remove("open"); updateToggle(c);
  });
}

searchInput.oninput=debounced;
minPhotosInput.oninput=debounced;
hasVideosInput.onchange=applyFilters;

loadFromURL();
applyFilters();
</script>

</body>
</html>
`;
}

// ---------- Main ----------

(async () => {
  const [collections, photosets] = await Promise.all([
    getCollections(),
    getAllPhotosets()
  ]);

  const map = buildPhotosetMap(photosets);

  const enriched = collections.map(c =>
    enrichCollection(c, map)
  );

  fs.writeFileSync("index.html", buildHTML(enriched));

  console.log("✅ done (zero getInfo mode, fully working)");
})();
