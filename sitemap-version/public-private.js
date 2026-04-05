const fs = require("fs");
const fetch = require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const API_SECRET = config_consts.API_SECRET;

const USER_ID = config_consts.USER_ID;

const OAUTH_TOKEN = config_consts.OAUTH_TOKEN;
const OAUTH_TOKEN_SECRET = config_consts.OAUTH_TOKEN_SECRET;

const oauth = OAuth({
  consumer: { key: API_KEY, secret: API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(base, key) {
    return crypto.createHmac("sha1", key).update(base).digest("base64");
  }
});

const token = { key: OAUTH_TOKEN, secret: OAUTH_TOKEN_SECRET };

// ---------- Flickr Call ----------
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

// ---------- Fetch ----------
async function getPhotosets(privacy_filter) {
  let page = 1, pages = 1, all = [];

  while (page <= pages) {
    const d = await flickrCall("flickr.photosets.getList", {
      user_id: USER_ID,
      page,
      per_page: 500,
      privacy_filter
    });

    pages = d.photosets.pages;
    all.push(...d.photosets.photoset);
    page++;
  }

  return all;
}

// ---------- Build ----------
function buildHTML(title, albums) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:Arial;background:#f5f5f5;margin:0;padding:10px}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:10px;
}
.card{
  background:#fff;border-radius:8px;overflow:hidden;
  text-decoration:none;color:black;
}
.card img{width:100%;height:140px;object-fit:cover}
.info{padding:8px}
.meta{font-size:.8em;color:#555}
</style>
</head>
<body>

<h1>${title}</h1>

<div class="grid">
${albums.map(a=>`
  <a class="card" href="https://www.flickr.com/photos/${USER_ID}/albums/${a.id}" target="_blank">
    <img src="${thumb(a)}" loading="lazy" onerror="this.style.display='none'">
    <div class="info">
      <div>${a.title._content}</div>
      <div class="meta">
        ${a.count_photos} photos ${a.count_videos>0?`• ${a.count_videos} videos`:""}
      </div>
    </div>
  </a>
`).join("")}
</div>

</body>
</html>`;
}

// ---------- Thumbnail ----------
function thumb(ps) {
  if (!ps.primary || !ps.secret) return "";
  return `https://farm${ps.farm}.staticflickr.com/${ps.server}/${ps.primary}_${ps.secret}_q.jpg`;
}

// ---------- Main ----------
(async () => {
  console.log("📸 Fetching public albums...");
  const publicSets = await getPhotosets(1);

  console.log("🔒 Fetching all albums...");
  const allSets = await getPhotosets(5);

  fs.writeFileSync("public.html", buildHTML("Public Albums", publicSets));
  fs.writeFileSync("private.html", buildHTML("All Albums (Private Included)", allSets));

  console.log("✅ Done:");
  console.log(" - public.html");
  console.log(" - private.html");
})();
