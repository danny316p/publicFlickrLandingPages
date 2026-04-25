// Flickr Privacy Audit Script (FULL VERSION WITH CSV SUMMARIES)

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

const MAX_CONCURRENT = 5;      // safe level
const REQUEST_DELAY = 200;     // ms between batches

let active = 0;
const queue = [];

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

async function enqueue(task){
  if (active >= MAX_CONCURRENT){
    await new Promise(resolve => queue.push(resolve));
  }

  active++;

  try {
    const result = await task();
    return result;
  } finally {
    active--;
    if (queue.length) queue.shift()();
    await sleep(REQUEST_DELAY);
  }
}

// ---------- CONFIG ----------
var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const API_SECRET = config_consts.API_SECRET;
const USER_ID = config_consts.USER_ID;
const OAUTH_TOKEN = config_consts.OAUTH_TOKEN;
const OAUTH_TOKEN_SECRET = config_consts.OAUTH_TOKEN_SECRET;

const INCLUDE_PHOTOS = true;

// ---------- CACHE ----------
const CACHE_DIR = path.join(__dirname, ".cache_privacy");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function cacheFile(k){ return path.join(CACHE_DIR, k+".json"); }
function readCache(k){
  if (fs.existsSync(cacheFile(k))) {
    return JSON.parse(fs.readFileSync(cacheFile(k)));
  }
  return null;
}
function writeCache(k,d){
  fs.writeFileSync(cacheFile(k), JSON.stringify(d,null,2));
}

// ---------- CSV ----------
function escapeCSV(value){
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
function toCSV(rows){
  return rows.map(r => r.map(escapeCSV).join(",")).join("\n");
}

// ---------- GLOBAL CSV STORAGE ----------
const csvRows = [
  ["collection", "album", "photo_id", "photo_url", "privacy"]
];

const albumSummaryRows = [
  ["collection_path","album","album_privacy","total_photos","public","friends","family","friends_family","private","is_mixed"]
];

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
async function flickrCall(method, params={}, retries=3){
  return enqueue(async () => {

    const url = "https://www.flickr.com/services/rest/";
    const req = { url, method:"GET", data:{ method, format:"json", nojsoncallback:"1", ...params } };
    const headers = oauth.toHeader(oauth.authorize(req, token));
    const full = new URL(url);
    Object.entries(req.data).forEach(([k,v])=>full.searchParams.set(k,v));

    const res = await fetch(full, { headers });

    // 🚨 Handle rate limit
    if (res.status === 429){
      if (retries > 0){
        console.warn(`⏳ 429 hit, retrying ${method}...`);
        await sleep(1000 * (4 - retries)); // exponential backoff
        return flickrCall(method, params, retries - 1);
      }
      throw new Error("Rate limit exceeded repeatedly");
    }

    const text = await res.text();

    // 🚨 Flickr sometimes returns HTML on failure
    if (text.startsWith("<!DOCTYPE")){
      console.warn("⚠️ HTML response (likely rate limit)");
      if (retries > 0){
        await sleep(1500);
        return flickrCall(method, params, retries - 1);
      }
      return {};
    }

    const data = JSON.parse(text);

    if (data.stat !== "ok"){
      console.warn(`⚠️ Flickr API error (${method}):`, data.message);
    }

    return data;
  });
}

// ---------- FETCH ----------
async function getCollections(){
  const d = await flickrCall("flickr.collections.getTree",{user_id:USER_ID});
  return d.collections.collection;
}

async function getPhotosets(){
  let page=1,pages=1,all=[];
  while(page<=pages){
    const d = await flickrCall("flickr.photosets.getList",{user_id:USER_ID,page,per_page:500});
    pages=d.photosets.pages;
    all.push(...d.photosets.photoset);
    page++;
  }
  return all;
}

// ---------- PHOTO HELPERS ----------
async function getPhotoIdsInSet(setId){
  let page=1,pages=1,all=[];
  while(page<=pages){
    const d = await flickrCall("flickr.photosets.getPhotos",{
      photoset_id:setId,
      page,
      per_page:500
    });

    if (!d.photoset) return [];

    pages=d.photoset.pages;
    all.push(...d.photoset.photo.map(p=>p.id));
    page++;
  }
  return all;
}

async function getPhotoVisibility(photoId){
  const d = await flickrCall("flickr.photos.getInfo",{photo_id:photoId});
  if (!d.photo) return null;
  return d.photo.visibility;
}

// ---------- PRIVACY LABEL ----------
function getPrivacyLabel(vis){
  if (vis.ispublic) return "public";
  if (vis.isfriend && vis.isfamily) return "friends+family";
  if (vis.isfriend) return "friends";
  if (vis.isfamily) return "family";
  return "private";
}

// ---------- MAIN ----------
(async()=>{
  const [collections, photosets] = await Promise.all([
    getCollections(),
    getPhotosets()
  ]);

  const setMap = {};
  photosets.forEach(ps=>{
    setMap[ps.id] = {
      title: ps.title._content,
      privacy: ps.privacy
    };
  });

  async function processCollection(col, path=[]){
    const currentPath = [...path, col.title];

    const result = {
      title: col.title,
      albums: [],
      collections: []
    };

    if (col.set){
      for (const s of col.set){
        const albumMeta = setMap[s.id];
        if (!albumMeta) continue;

        const entry = {
          title: albumMeta.title,
          privacy: albumMeta.privacy
        };

        if (INCLUDE_PHOTOS){
          const ids = await getPhotoIdsInSet(s.id);

          const breakdown = {
            public: {count:0},
            friends: {count:0},
            family: {count:0},
            friends_family: {count:0},
            private: {count:0}
          };

          for (const id of ids){
            const vis = await getPhotoVisibility(id);
            if (!vis) continue;

            const label = getPrivacyLabel(vis);
            const url = `https://www.flickr.com/photos/${USER_ID}/${id}`;

            breakdown[label.replace("+","_")].count++;

            csvRows.push([
              currentPath.join(" > "),
              entry.title,
              id,
              url,
              label
            ]);
          }

          const total =
            breakdown.public.count +
            breakdown.friends.count +
            breakdown.family.count +
            breakdown.friends_family.count +
            breakdown.private.count;

          const isMixed =
            breakdown.public.count > 0 &&
            breakdown.private.count > 0;

          albumSummaryRows.push([
            currentPath.join(" > "),
            entry.title,
            entry.privacy,
            total,
            breakdown.public.count,
            breakdown.friends.count,
            breakdown.family.count,
            breakdown.friends_family.count,
            breakdown.private.count,
            isMixed
          ]);

          entry.photoBreakdown = breakdown;
        }

        result.albums.push(entry);
      }
    }

    if (col.collection){
      for (const c of col.collection){
        result.collections.push(await processCollection(c, currentPath));
      }
    }

    return result;
  }

  const report = [];
  for (const c of collections){
    report.push(await processCollection(c));
  }

  fs.writeFileSync("privacy_report.json", JSON.stringify(report,null,2));
  fs.writeFileSync("privacy_report.csv", toCSV(csvRows));
  fs.writeFileSync("album_summary.csv", toCSV(albumSummaryRows));

  console.log("✅ DONE:");
  console.log(" - privacy_report.json");
  console.log(" - privacy_report.csv");
  console.log(" - album_summary.csv");
})();
