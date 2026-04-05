const fetch = require("node-fetch");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const readline = require("readline");

const API_KEY = "YOUR_API_KEY";
const API_SECRET = "YOUR_API_SECRET";

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

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function getRequestToken() {
  const requestData = {
    url: REQUEST_TOKEN_URL,
    method: "POST",
    data: { oauth_callback: "oob" }
  };

  const headers = oauth.toHeader(oauth.authorize(requestData));

  const res = await fetch(REQUEST_TOKEN_URL, {
    method: "POST",
    headers
  });

  const text = await res.text();
  const params = new URLSearchParams(text);

  return {
    key: params.get("oauth_token"),
    secret: params.get("oauth_token_secret")
  };
}

async function getAccessToken(requestToken, verifier) {
  const requestData = {
    url: ACCESS_TOKEN_URL,
    method: "POST",
    data: { oauth_verifier: verifier }
  };

  const headers = oauth.toHeader(
    oauth.authorize(requestData, requestToken)
  );

  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers
  });

  const text = await res.text();
  const params = new URLSearchParams(text);

  return {
    oauth_token: params.get("oauth_token"),
    oauth_token_secret: params.get("oauth_token_secret"),
    user_nsid: params.get("user_nsid"),
    username: params.get("username")
  };
}

(async () => {
  console.log("🔐 Getting request token...");

  const requestToken = await getRequestToken();

  const authUrl = `${AUTHORIZE_URL}?oauth_token=${requestToken.key}&perms=read`;

  console.log("\n👉 Open this URL in your browser:\n");
  console.log(authUrl);

  const verifier = await ask("\nEnter the verification code: ");

  console.log("\n🔐 Getting access token...");

  const access = await getAccessToken(requestToken, verifier);

  console.log("\n✅ DONE — Save these credentials:\n");

  console.log(`OAUTH_TOKEN=${access.oauth_token}`);
  console.log(`OAUTH_TOKEN_SECRET=${access.oauth_token_secret}`);
  console.log(`USER_ID=${access.user_nsid}`);
  console.log(`USERNAME=${access.username}`);
})();
