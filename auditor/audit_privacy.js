// Flickr Privacy Audit – Single Collection Mode (Stable)

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

const CACHE_DIR = path.join(__dirname, ".cache_privacy");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ---------- CSV ----------
function esc(v){
  if (!v) return "";
  const s = String(v);
  return s.includes(",") ? `"${s}"` : s;
}
function toCSV(rows){
  return rows.map(r=>r.map(esc).join(",")).join("\n");
}

const csvRows = [["collection","album","photo_id","photo_url","privacy"]];
const albumRows = [["collection","album","total","public","friends","family","friends_family","private","mixed"]];

// ---------- CACHE ----------
function cacheFile(k){ return path.join(CACHE_DIR, k+".json"); }
function readCache(k){
  if (fs.existsSync(cacheFile(k))) return JSON.parse(fs.readFileSync(cacheFile(k)));
  return null;
}
function writeCache(k,d){
  fs.writeFileSync(cacheFile(k), JSON.stringify(d,null,2));
}

// ---------- NETWORK ----------
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function safeFetch(url, options={}, retries=5){
  for (let i=0;i<retries;i++){
    try {
      const res = await fetch(url, options);

      if (res.status === 429){
        console.warn("⏳ 429 hit, backing off...");
        await sleep(1000 * (i+1));
        continue;
      }

      return res;

    } catch (err){
      if (["ECONNRESET","ETIMEDOUT","EAI_AGAIN"].includes(err.code)){
        console.warn("🔁 retry", err.code);
        await sleep(500 * (i+1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed fetch");
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

  const res = await safeFetch(full,{headers});
  const text = await res.text();

  if (text.startsWith("<!DOCTYPE")) {
    console.warn("⚠️ HTML response, retrying...");
    await sleep(1000);
    return flickrCall(method, params);
  }

  return JSON.parse(text);
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

async function getPhotoIds(setId){
  const key="ids_"+setId;
  const c=readCache(key);
  if(c) return c;

  let page=1,pages=1,all=[];
  while(page<=pages){
    const d=await flickrCall("flickr.photosets.getPhotos",{photoset_id:setId,page,per_page:500});
    if(!d.photoset) return [];
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

// ---------- PROCESS ----------
(async()=>{
  const collections = await getCollections();
  const sets = await getPhotosets();

  const map={};
  sets.forEach(s=>map[s.id]={title:s.title._content});

  const report=[];

  for (const col of collections){

    console.log(`\n📁 Processing collection: ${col.title}`);

    const colResult={title:col.title,albums:[]};

    if (!col.set) continue;

    for (const s of col.set){

      const albumName = map[s.id]?.title || s.id;
      console.log(`  📷 Album: ${albumName}`);

      const ids = await getPhotoIds(s.id);

      const counts={
        public:0,friends:0,family:0,friends_family:0,private:0
      };

      let i=0;
      for (const id of ids){
        i++;

        const v = await getVisibility(id);
        if(!v) continue;

        const p = label(v);
        counts[p]++;

        const url=`https://www.flickr.com/photos/${USER_ID}/${id}`;

        csvRows.push([col.title,albumName,id,url,p]);

        if (i % 50 === 0){
          console.log(`    ...${i}/${ids.length}`);
        }
      }

      const total = Object.values(counts).reduce((a,b)=>a+b,0);
      const mixed = counts.public>0 && counts.private>0;

      albumRows.push([
        col.title,
        albumName,
        total,
        counts.public,
        counts.friends,
        counts.family,
        counts.friends_family,
        counts.private,
        mixed
      ]);

      colResult.albums.push({title:albumName,counts});
    }

    report.push(colResult);

    console.log("✅ Collection complete");

    // pause between collections (VERY important)
    await sleep(2000);
  }

  fs.writeFileSync("privacy_report.json", JSON.stringify(report,null,2));
  fs.writeFileSync("privacy_report.csv", toCSV(csvRows));
  fs.writeFileSync("album_summary.csv", toCSV(albumRows));

  console.log("\n🎉 DONE");
})();

