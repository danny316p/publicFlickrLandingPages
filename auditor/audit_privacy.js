// Flickr Privacy Audit – BULLETPROOF VERSION

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

// ---------- CONFIG ----------
var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const API_SECRET = config_consts.API_SECRET;
const USER_ID = config_consts.USER_ID;
const OAUTH_TOKEN = config_consts.OAUTH_TOKEN;
const OAUTH_TOKEN_SECRET = config_consts.OAUTH_TOKEN_SECRET;

const TARGET_COLLECTION_NAME = "BrickFair VA 2025";

// slow + safe settings
const PER_PHOTO_DELAY = 200;   // increase if needed
const COLLECTION_DELAY = 3000;

// ---------- PATHS ----------
const CACHE_DIR = path.join(__dirname, ".cache_privacy");
const PROGRESS_FILE = path.join(__dirname, "progress.json");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ---------- CACHE ----------
function cacheFile(k){ return path.join(CACHE_DIR, k + ".json"); }

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

const csvRows = [["collection","album","photo_id","photo_url","privacy"]];
const albumRows = [["collection","album","total","public","friends","family","friends_family","private","mixed"]];

// ---------- UTILS ----------
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ---------- GLOBAL COOLDOWN ----------
let cooldownUntil = 0;

async function waitCooldown(){
  const now = Date.now();
  if (now < cooldownUntil){
    const wait = cooldownUntil - now;
    console.warn(`🛑 Cooling down ${Math.ceil(wait/1000)}s`);
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
        console.warn(`⏳ 429 → waiting ${backoff}ms`);
        cooldownUntil = Date.now() + backoff;
        await sleep(backoff);
        continue;
      }

      return res;

    } catch (err){
      console.warn("🔁 network issue:", err.code);

      const delay = Math.min(30000, 1000 * attempt);
      await sleep(delay);
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
      console.warn("⚠️ HTML response → retrying");
      await sleep(2000);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      console.warn("⚠️ JSON parse error → retrying");
      await sleep(2000);
    }
  }
}

// ---------- FETCH ----------
async function getCollections(){
  const d = await flickrCall("flickr.collections.getTree",{user_id:USER_ID});
  return d.collections.collection || [];
}

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

// ---------- FIND COLLECTION ----------
function findCollection(list){
  for (const c of list){
    if (c.title === TARGET_COLLECTION_NAME) return c;
    if (c.collection){
      const found = findCollection(c.collection);
      if (found) return found;
    }
  }
  return null;
}

// ---------- MAIN ----------
(async()=>{

  const collections = await getCollections();
  const sets = await getPhotosets();

  const target = findCollection(collections);

  if (!target){
    console.log("❌ Collection not found");
    return;
  }

  console.log(`🎯 Auditing: ${target.title}`);

  const map={};
  sets.forEach(s=>map[s.id]=s.title._content);

  for (const s of (target.set || [])){

    const albumName = map[s.id] || s.id;
    console.log(`\n📷 ${albumName}`);

    const ids = await getPhotoIds(s.id);

    const counts={public:0,friends:0,family:0,friends_family:0,private:0};

    let i=0;
    for (const id of ids){

      if (progress.donePhotos[id]) continue;

      const v = await getVisibility(id);
      if(!v) continue;

      const p = label(v);
      counts[p]++;

      const url=`https://www.flickr.com/photos/${USER_ID}/${id}`;
      csvRows.push([target.title,albumName,id,url,p]);

      progress.donePhotos[id] = true;

      i++;
      if (i % 25 === 0){
        console.log(`  ...${i}/${ids.length}`);
        saveProgress(progress);
      }

      await sleep(PER_PHOTO_DELAY);
    }

    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    const mixed = counts.public>0 && counts.private>0;

    albumRows.push([
      target.title,albumName,total,
      counts.public,counts.friends,counts.family,
      counts.friends_family,counts.private,mixed
    ]);

    await sleep(COLLECTION_DELAY);
  }

  saveProgress(progress);

  fs.writeFileSync("privacy_report.csv", toCSV(csvRows));
  fs.writeFileSync("album_summary.csv", toCSV(albumRows));

  console.log("\n🎉 COMPLETE (no crashes)");
})();
