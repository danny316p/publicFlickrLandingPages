// Flickr Privacy Audit Script
// Outputs privacy report for collections, albums, and photos

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

// ---------- CONFIG ----------
const API_KEY = "YOUR_API_KEY";
const API_SECRET = "YOUR_API_SECRET";
const USER_ID = "YOUR_USER_ID";
const OAUTH_TOKEN = "YOUR_OAUTH_TOKEN";
const OAUTH_TOKEN_SECRET = "YOUR_OAUTH_TOKEN_SECRET";

// Enable/disable deep photo scan (slower!)
const INCLUDE_PHOTOS = false;

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
async function flickrCall(method, params={}){
  const url = "https://www.flickr.com/services/rest/";
  const req = { url, method:"GET", data:{ method, format:"json", nojsoncallback:"1", ...params } };
  const headers = oauth.toHeader(oauth.authorize(req, token));
  const full = new URL(url);
  Object.entries(req.data).forEach(([k,v])=>full.searchParams.set(k,v));
  const res = await fetch(full,{headers});
  return res.json();
}

// ---------- FETCH ----------
async function getCollections(){
  const c = readCache("collections");
  if (c) return c;
  const d = await flickrCall("flickr.collections.getTree",{user_id:USER_ID});
  writeCache("collections", d.collections.collection);
  return d.collections.collection;
}

async function getPhotosets(){
  const c = readCache("photosets");
  if (c) return c;

  let page=1,pages=1,all=[];
  while(page<=pages){
    const d = await flickrCall("flickr.photosets.getList",{user_id:USER_ID,page,per_page:500});
    pages=d.photosets.pages;
    all.push(...d.photosets.photoset);
    page++;
  }

  writeCache("photosets", all);
  return all;
}

// ---------- OPTIONAL: PHOTO-LEVEL ----------
async function getPhotosInSet(setId){
  const key = "photos_" + setId;
  const c = readCache(key);
  if (c) return c;

  let page=1,pages=1,all=[];
  while(page<=pages){
    const d = await flickrCall("flickr.photosets.getPhotos",{
      photoset_id:setId,
      page,
      per_page:500,
      extras:"privacy"
    });
    pages=d.photoset.pages;
    all.push(...d.photoset.photo);
    page++;
  }

  writeCache(key, all);
  return all;
}

// ---------- HELPERS ----------
function privacyLabel(p){
  switch(parseInt(p)){
    case 1: return "public";
    case 2: return "friends";
    case 3: return "family";
    case 4: return "friends+family";
    case 5: return "private";
    default: return "unknown";
  }
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
      id: ps.id,
      title: ps.title._content,
      privacy: parseInt(ps.privacy),
      privacyLabel: privacyLabel(ps.privacy),
      count_photos: parseInt(ps.count_photos),
      count_videos: parseInt(ps.count_videos)
    };
  });

  async function processCollection(col){
    const result = {
      id: col.id,
      title: col.title,
      albums: [],
      collections: []
    };

    if (col.set){
      for (const s of col.set){
        const album = setMap[s.id];
        if (!album) continue;

        const entry = { ...album };

        if (INCLUDE_PHOTOS){
          const photos = await getPhotosInSet(s.id);

          entry.photoBreakdown = {
            public: 0,
            private: 0,
            mixed: false
          };

          photos.forEach(p=>{
            if (parseInt(p.ispublic) === 1) entry.photoBreakdown.public++;
            else entry.photoBreakdown.private++;
          });

          entry.photoBreakdown.mixed =
            entry.photoBreakdown.public > 0 &&
            entry.photoBreakdown.private > 0;
        }

        result.albums.push(entry);
      }
    }

    if (col.collection){
      for (const c of col.collection){
        result.collections.push(await processCollection(c));
      }
    }

    return result;
  }

  const report = [];
  for (const c of collections){
    report.push(await processCollection(c));
  }

  fs.writeFileSync("privacy_report.json", JSON.stringify(report,null,2));

  console.log("✅ Privacy report written to privacy_report.json");
})();
