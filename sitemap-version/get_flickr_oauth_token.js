const fetch = require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const readline = require("readline");

var config_consts = require("../secrets/config.js");
const API_KEY = config_consts.API_KEY;
const API_SECRET = config_consts.API_SECRET;


const REQUEST_TOKEN_URL = "https://www.flickr.com/services/oauth/request_token";
const AUTHORIZE_URL = "https://www.flickr.com/services/oauth/authorize";
const ACCESS_TOKEN_URL = "https://www.flickr.com/services/oauth/access_token";

const oauth = OAuth({
  consumer: { key: API_KEY, secret: API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(base, key) {
    return crypto.createHmac("sha1", key).update(base).digest("base64");
  }
});

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => {
    rl.close();
    res(ans.trim());
  }));
}

// ---------- STEP 1 ----------
async function getRequestToken() {
  const requestData = {
    url: REQUEST_TOKEN_URL,
    method: "POST",
    data: {
      oauth_callback: "oob"
    }
  };

  const oauthData = oauth.authorize(requestData);

  const headers = {
    ...oauth.toHeader(oauthData),
    "Content-Type": "application/x-www-form-urlencoded"
  };

  const body = new URLSearchParams({
    oauth_callback: "oob"
  }).toString();

  const res = await fetch(REQUEST_TOKEN_URL, {
    method: "POST",
    headers,
    body
  });

  const text = await res.text();
  console.log("\n🔍 Request token response:\n", text);

  const params = new URLSearchParams(text);

  if (!params.get("oauth_token")) {
    throw new Error("❌ Failed to obtain request token");
  }

  return {
    key: params.get("oauth_token"),
    secret: params.get("oauth_token_secret")
  };
}

// ---------- STEP 2 ----------
async function getAccessToken(requestToken, verifier) {
  const requestData = {
    url: ACCESS_TOKEN_URL,
    method: "POST",
    data: {
      oauth_verifier: verifier
    }
  };

  const oauthData = oauth.authorize(requestData, requestToken);

  const headers = {
    ...oauth.toHeader(oauthData),
    "Content-Type": "application/x-www-form-urlencoded"
  };

  const body = new URLSearchParams({
    oauth_verifier: verifier
  }).toString();

  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers,
    body
  });

  const text = await res.text();
  console.log("\n🔍 Access token response:\n", text);

  const params = new URLSearchParams(text);

  return {
    oauth_token: params.get("oauth_token"),
    oauth_token_secret: params.get("oauth_token_secret"),
    user_nsid: params.get("user_nsid"),
    username: params.get("username")
  };
}

// ---------- MAIN ----------
(async () => {
  try {
    console.log("🔐 Requesting token...");

    const requestToken = await getRequestToken();

    const authUrl = `${AUTHORIZE_URL}?oauth_token=${requestToken.key}&perms=read`;

    console.log("\n👉 Open this URL:\n");
    console.log(authUrl);

    const verifier = await ask("\nEnter verifier code: ");

    console.log("\n🔐 Getting access token...");

    const access = await getAccessToken(requestToken, verifier);

    console.log("\n✅ SUCCESS\n");

    console.log(`OAUTH_TOKEN=${access.oauth_token}`);
    console.log(`OAUTH_TOKEN_SECRET=${access.oauth_token_secret}`);
    console.log(`USER_ID=${access.user_nsid}`);
    console.log(`USERNAME=${access.username}`);

  } catch (err) {
    console.error("\n❌ ERROR:", err.message);
  }
})();
