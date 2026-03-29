const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const USER_ID = config_consts.USER_ID;

const API = "https://www.flickr.com/services/rest/";
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

// ---------- Cache Helpers ----------

function getCachePath(key) {
  return path.join(CACHE_DIR, key + ".json");
}

function isCacheValid(file) {
  if (!fs.existsSync(file)) return false;
  const stats = fs.statSync(file);
  return (Date.now() - stats.mtimeMs) < CACHE_TTL;
}

function readCache(key) {
  const file = getCachePath(key);
  if (isCacheValid(file)) {
    return JSON.parse(fs.readFileSync(file));
  }
  return null;
}

function writeCache(key, data) {
  const file = getCachePath(key);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- Flickr API ----------

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

// ---------- Data Fetching ----------

async function getCollections() {
  const cacheKey = "collections";

  const cached = readCache(cacheKey);
  if (cached) {
    console.log("📦 Using cached collections");
    return cached;
  }

  console.log("🌐 Fetching collections...");
  const data = await flickrCall("flickr.collections.getTree", {
    user_id: USER_ID
  });

  writeCache(cacheKey, data.collections.collection);
  return data.collections.collection;
}

async function getPhotosetInfo(id) {
  const cacheKey = `photoset_${id}`;

  const cached = readCache(cacheKey);
  if (cached) {
    console.log(`📦 Cached album ${id}`);
    return cached;
  }

  console.log(`🌐 Fetching album ${id}`);
  const data = await flickrCall("flickr.photosets.getInfo", {
    photoset_id: id
  });

  writeCache(cacheKey, data.photoset);
  return data.photoset;
}

// ---------- Helpers ----------

function getAlbumUrl(photosetId) {
  return `https://www.flickr.com/photos/${USER_ID}/albums/${photosetId}`;
}

// ---------- Recursive Enrichment ----------

async function enrichCollection(collection) {
  if (collection.set) {
    const enrichedSets = [];

    for (const set of collection.set) {
      const info = await getPhotosetInfo(set.id);

      enrichedSets.push({
        id: set.id,
        title: info.title._content,
        photos: info.photos,
        videos: info.videos || 0,
        url: getAlbumUrl(set.id)
      });
    }

    collection.set = enrichedSets;
  }

  if (collection.collection) {
    const subs = [];
    for (const sub of collection.collection) {
      subs.push(await enrichCollection(sub));
    }
    collection.collection = subs;
  }

  return collection;
}

// ---------- HTML Rendering ----------

function renderCollection(collection) {
  return `
  <div class="collection">
    <div class="collection-header" onclick="toggle(this)">
      <span>${collection.title}</span>
      <span class="toggle">[+]</span>
    </div>

    <div class="children">

      ${(collection.set || []).map(set => `
        <div class="album">
          <a href="${set.url}" target="_blank">${set.title}</a>
          <div class="meta">
            ${set.photos} photos • ${set.videos} videos
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

a {
  text-decoration: none;
  color: #0063dc;
}

a:hover {
  text-decoration: underline;
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
</script>

</body>
</html>
`;
}

// ---------- Main ----------

(async () => {
  const collections = await getCollections();

  console.log("🔄 Enriching collections...");
  const enriched = [];

  for (const col of collections) {
    enriched.push(await enrichCollection(col));
  }

  const html = buildHTML(enriched);

  fs.writeFileSync("index.html", html);

  console.log("✅ Done! Cached + generated index.html");
})();
