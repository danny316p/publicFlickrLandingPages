// Flickr Privacy Audit – Single Album (Bulletproof)

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

// ---------- CONFIG ----------
const API_KEY = "YOUR_API_KEY";
const API_SECRET = "YOUR_API_SECRET";
const USER_ID = "YOUR_USER_ID";
const OAUTH_TOKEN = "YOUR_OAUTH_TOKEN";
const OAUTH_TOKEN_SECRET = "YOUR_OAUTH_TOKEN_SECRET";

// 🎯 TARGET
const TARGET_ALBUM_ID = "YOUR_PHOTOSET_ID";
// const TARGET_ALBUM_NAME = "Album Name";

// tuning
const PER_PHOTO_DELAY = 200;

// ---------- PATHS ----------
const CACHE_DIR = path.join(__dirname, ".cache_privacy");
const PROGRESS_FILE = path.join(__dirname, "album_progress.json");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ---------- CACHE ----------
function cacheFile(k){ return path.join(CACHE_DIR, k+".json"); }

function readCache(k){
  try {
    if (fs.existsSync(cacheFile(k))){
      return JSON.parse(fs.readFileSync(cacheFile(k)));
    }
  } catch {}
  return null;
}

function writeCache(k,d){
  try {
    fs.writeFileSync(cacheFile(k), JSON.stringify(d,null,2));
  } catch {}
}

// ---------- PROGRESS ----------
function loadProgress(){
  try {
    if (fs.existsSync(PROGRESS_FILE)){
      return JSON.parse(fs.readFileSync(PROGRESS_FILE));
    }
  } catch {}
  return { donePhotos:{} };
}

function saveProgress(p){
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p,null,2));
}

const progress = loadProgress();

// ---------- CSV ----------
function esc(v){
  if (!v) return "";
  const s = String(v);
  return s.includes(",") ? `"${s.replace(/"/g,'""')}"` : s;
}

function toCSV(rows){
  return rows.map(r=>r.map(esc).join(",")).join("\n");
}

const csvRows = [["album","photo_id","photo_url","privacy"]];
const summaryRows = [["album","total","public","friends","family","friends_family","private","mixed"]];

// ---------- UTILS ----------
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ---------- COOLDOWN ----------
let cooldownUntil = 0;

async function waitCooldown(){
  const now = Date.now();
  if (now < cooldownUntil){
    const wait = cooldownUntil - now;
    console.warn(`🛑 Cooling ${Math.ceil(wait/1000)}s`);
    await sleep(wait);
  }
}

// ---------- SAFE FETCH ----------
async function safeFetch(url, options={}){
  let attempt = 0;

  while (true){
    attempt++;

    await waitCooldown();

    try {
      const res = await fetch(url, options);

      if (res.status === 429){
        const backoff = Math.min(60000, 2000 * attempt);
        console.warn(`⏳ 429 → wait ${backoff}ms`);
        cooldownUntil = Date.now() + backoff;
        await sleep(backoff);
        continue;
      }

      return res;

    } catch (err){
      console.warn("🔁 network:", err.code);
      await sleep(Math.min(30000, 1000 * attempt));
    }
  }
}

// ---------- OAUTH ----------
const oauth = OAuth({
  consumer:{key:API_KEY,secret:API_SECRET},
  signature_method:"HMAC-SHA1",
  hash_function(base,key){
    return crypto.createHmac("sha1",key).update(base).digest("base64");
  }
});

const token={key:OAUTH_TOKEN,secret:OAUTH_TOKEN_SECRET};

// ---------- API ----------
async function flickrCall(method, params={}){
  const url="https://www.flickr.com/services/rest/";
  const req={url,method:"GET",data:{method,format:"json",nojsoncallback:"1",...params}};
  const headers=oauth.toHeader(oauth.authorize(req,token));

  const full=new URL(url);
  Object.entries(req.data).forEach(([k,v])=>full.searchParams.set(k,v));

  while (true){
    const res = await safeFetch(full,{headers});
    const text = await res.text();

    if (text.startsWith("<!DOCTYPE")){
      console.warn("⚠️ HTML → retry");
      await sleep(2000);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      console.warn("⚠️ parse error → retry");
      await sleep(2000);
    }
  }
}

// ---------- FETCH ----------
async function getPhotosets(){
  let page=1,pages=1,all=[];
  while(page<=pages){
    const d = await flickrCall("flickr.photosets.getList",{user_id:USER_ID,page,per_page:500});
    pages=d.photosets?.pages || 1;
    all.push(...(d.photosets?.photoset || []));
    page++;
  }
  return all;
}

async function findAlbum(){
  if (TARGET_ALBUM_ID) return TARGET_ALBUM_ID;

  const sets = await getPhotosets();
  const match = sets.find(s => s.title._content === TARGET_ALBUM_NAME);

  return match?.id;
}

async function getPhotoIds(setId){
  const key="ids_"+setId;
  const c=readCache(key);
  if(c) return c;

  let page=1,pages=1,all=[];
  while(page<=pages){
    const d=await flickrCall("flickr.photosets.getPhotos",{photoset_id:setId,page,per_page:500});
    if(!d.photoset) break;
    pages=d.photoset.pages;
    all.push(...d.photoset.photo.map(p=>p.id));
    page++;
  }

  writeCache(key,all);
  return all;
}

async function getVisibility(id){
  const key="vis_"+id;
  const c=readCache(key);
  if(c) return c;

  const d=await flickrCall("flickr.photos.getInfo",{photo_id:id});
  if(!d.photo) return null;

  const v=d.photo.visibility;
  writeCache(key,v);
  return v;
}

function label(v){
  if(v.ispublic) return "public";
  if(v.isfriend && v.isfamily) return "friends_family";
  if(v.isfriend) return "friends";
  if(v.isfamily) return "family";
  return "private";
}

// ---------- MAIN ----------
(async()=>{

  const albumId = await findAlbum();

  if (!albumId){
    console.log("❌ Album not found");
    return;
  }

  console.log(`🎯 Auditing album: ${albumId}`);

  const ids = await getPhotoIds(albumId);

  const counts={
    public:0,friends:0,family:0,friends_family:0,private:0
  };

  let i=0;
  for (const id of ids){

    if (progress.donePhotos[id]) continue;

    const v = await getVisibility(id);
    if(!v) continue;

    const p = label(v);
    counts[p]++;

    const url=`https://www.flickr.com/photos/${USER_ID}/${id}`;
    csvRows.push([albumId,id,url,p]);

    progress.donePhotos[id] = true;

    i++;
    if (i % 25 === 0){
      console.log(`...${i}/${ids.length}`);
      saveProgress(progress);
    }

    await sleep(PER_PHOTO_DELAY);
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  const mixed = counts.public>0 && counts.private>0;

  summaryRows.push([
    albumId,total,
    counts.public,counts.friends,counts.family,
    counts.friends_family,counts.private,mixed
  ]);

  saveProgress(progress);

  fs.writeFileSync("album_privacy.csv", toCSV(csvRows));
  fs.writeFileSync("album_summary.csv", toCSV(summaryRows));

  console.log("\n🎉 Album audit complete");
})();
