const fs = require("fs");
const fetch = require("node-fetch");

// CONFIG
var config_consts = require("./secrets/config.js");
const API_KEY = config_consts.API_KEY;
const COLLECTION_ID = config_consts.COLLECTION_ID;
const USER_ID = config_consts.USER_ID;

// Fetch collections (includes sets/albums)
async function fetchCollection() {
  const url = `https://www.flickr.com/services/rest/?method=flickr.collections.getTree&api_key=${API_KEY}&collection_id=${COLLECTION_ID}&user_id=${USER_ID}&format=json&nojsoncallback=1`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.collections) {
    throw new Error("Failed to fetch collection");
  }

  return data.collections.collection[0].set || [];
}

// Generate HTML page
function generateHTML(albums) {
  const cards = albums.map(album => {
    const link = `https://www.flickr.com/photos/${USER_ID}/albums/${album.id}`;
    return `
      <a href="${link}" class="card" target="_blank">
        <div class="card-content">
          <h2>${album.title._content}</h2>
          <p>${album.description._content || ""}</p>
        </div>
      </a>
    `;
  }).join("\n");

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flickr Collection</title>

<style>
  body {
    margin: 0;
    font-family: Arial, sans-serif;
    background: #f5f5f5;
  }

  header {
    text-align: center;
    padding: 2rem;
    background: #222;
    color: white;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
    padding: 1rem;
  }

  .card {
    display: block;
    text-decoration: none;
    background: white;
    border-radius: 10px;
    padding: 1.5rem;
    color: #333;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 5px 20px rgba(0,0,0,0.15);
  }

  h2 {
    margin-top: 0;
    font-size: 1.2rem;
  }

  p {
    font-size: 0.9rem;
    color: #666;
  }
</style>
</head>

<body>

<header>
  <h1>My Flickr Collection</h1>
</header>

<div class="grid">
  ${cards}
</div>

</body>
</html>
`;
}

// Main
(async () => {
console.log();
  try {
    const albums = await fetchCollection();
    const html = generateHTML(albums);
    fs.writeFileSync("index.html", html);
    console.log("✅ index.html generated!");
  } catch (err) {
    console.error(err);
  }
})();
