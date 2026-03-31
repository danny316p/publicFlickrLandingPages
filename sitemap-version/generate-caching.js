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
  return JSON.parse(fs.readFileSync(file));
}

function writeCache(key, data) {
  fs.writeFileSync(cachePath(key), JSON.stringify(data, null, 2));
}

function isCacheFresh(file) {
  if (!fs.existsSync(file)) return false;
  if (FORCE_REFRESH) return false;
  const age = Date.now() - fs.statSync(file).mtimeMs;
  return age < CACHE_TTL;
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
  const file = cachePath("collections");

  if (isCacheFresh(file)) {
    console.log("📦 collections cache");
    return readCache("collections");
  }

  console.log("🌐 fetching collections");
  const data = await flickrCall("flickr.collections.getTree", {
    user_id: USER_ID
  });

  writeCache("collections", data.collections.collection);
  return data.collections.collection;
}

// Smart diffing version
async function getPhotosetInfoSmart(set) {
  const key = `photoset_${set.id}`;
  const file = cachePath(key);
  const cached = readCache(key);

  // If cached and not forced refresh:
  if (cached && !FORCE_REFRESH) {
    // Compare last update timestamps
    const cachedUpdated = cached.date_update;
    const currentUpdated = set.date_update;

    if (cachedUpdated && currentUpdated && cachedUpdated === currentUpdated) {
      console.log(`📦 unchanged album ${set.id}`);
      return cached;
    }
  }

  console.log(`🌐 updating album ${set.id}`);
  const data = await flickrCall("flickr.photosets.getInfo", {
    photoset_id: set.id
  });

  writeCache(key, data.photoset);
  return data.photoset;
}

// ---------- Helpers ----------

function albumUrl(id) {
  return `https://www.flickr.com/photos/${USER_ID}/albums/${id}`;
}

// ---------- Enrichment ----------

async function enrichCollection(collection) {
  if (collection.set) {
    collection.set = await Promise.all(
      collection.set.map(async (set) => {
        const info = await getPhotosetInfoSmart(set);

        return {
          id: set.id,
          title: info.title._content,
          photos: info.photos,
          videos: info.videos || 0,
          url: albumUrl(set.id)
        };
      })
    );
  }

  if (collection.collection) {
    collection.collection = await Promise.all(
      collection.collection.map(enrichCollection)
    );
  }

  return collection;
}

// ---------- HTML ----------

function formatMeta(set) {
  if (set.videos > 0) {
    return `${set.photos} photos • ${set.videos} videos`;
  }
  return `${set.photos} photos`;
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
          <div class="meta">
            ${formatMeta(set)}
          </div>
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
body {
  font-family: Arial;
  background: #f5f5f5;
  padding: 1rem;
}

#app {
  max-width: 1000px;
  margin: auto;
}

.controls {
  background: white;
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

input {
  padding: 6px;
}

.collection, .album {
  background: white;
  margin: 6px 0;
  border-radius: 8px;
  padding: 10px;
}

.collection-header {
  cursor: pointer;
  font-weight: bold;
  display: flex;
  justify-content: space-between;
}

.children {
  display: none;
  margin-left: 20px;
}

.collection.open > .children {
  display: block;
}

.album {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
}

.meta {
  font-size: 0.9em;
  color: #555;
}

.hidden {
  display: none !important;
}

@media (max-width: 600px) {
  .album {
    flex-direction: column;
  }
}
</style>
</head>

<body>

<h1>Flickr Sitemap</h1>

<div class="controls">
  <input type="text" id="search" placeholder="Search albums...">
  <input type="number" id="minPhotos" placeholder="Min photos">
  <label>
    <input type="checkbox" id="hasVideos"> Has videos
  </label>
</div>

<div id="app">
${collections.map(renderCollection).join("")}
</div>

<script>
function toggle(el) {
  const parent = el.parentElement;
  parent.classList.toggle("open");
  el.querySelector(".toggle").textContent =
    parent.classList.contains("open") ? "[-]" : "[+]";
}

// Filtering
const searchInput = document.getElementById("search");
const minPhotosInput = document.getElementById("minPhotos");
const hasVideosInput = document.getElementById("hasVideos");

function applyFilters() {
  const term = searchInput.value.toLowerCase();
  const minPhotos = parseInt(minPhotosInput.value) || 0;
  const hasVideos = hasVideosInput.checked;

  document.querySelectorAll(".album").forEach(el => {
    const title = el.dataset.title;
    const photos = parseInt(el.dataset.photos);
    const videos = parseInt(el.dataset.videos);

    let visible =
      title.includes(term) &&
      photos >= minPhotos &&
      (!hasVideos || videos > 0);

    el.classList.toggle("hidden", !visible);
  });
}

searchInput.oninput = applyFilters;
minPhotosInput.oninput = applyFilters;
hasVideosInput.onchange = applyFilters;
</script>

</body>
</html>
`;
}

// ---------- Main ----------

(async () => {
  const collections = await getCollections();

  console.log("🔄 smart incremental enrichment...");
  const enriched = await Promise.all(
    collections.map(enrichCollection)
  );

  fs.writeFileSync("index.html", buildHTML(enriched));

  console.log("✅ done (smart diffing + clean UI)");
})();
