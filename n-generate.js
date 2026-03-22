const fs = require("fs");
const fetch = require("node-fetch");

// ================= CONFIG =================
const API_KEY = "YOUR_FLICKR_API_KEY";
const USER_ID = "YOUR_USER_ID"; // e.g. 12345678@N00
const COLLECTION_ID = "YOUR_COLLECTION_ID"; // e.g. 721577...

// ================= FETCH =================
async function fetchCollectionTree() {
  const url = `https://www.flickr.com/services/rest/?method=flickr.collections.getTree&api_key=${API_KEY}&collection_id=${COLLECTION_ID}&user_id=${USER_ID}&format=json&nojsoncallback=1`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data?.collections?.collection?.length) {
    throw new Error("No collections found. Check IDs/API key.");
  }

  return data.collections.collection[0];
}

// ================= RECURSIVE EXTRACTION =================
function extractAllSets(node) {
  let results = [];

  // Add albums (sets) at this level
  if (Array.isArray(node.set)) {
    results.push(...node.set);
  }

  // Recurse into sub-collections
  if (Array.isArray(node.collection)) {
    node.collection.forEach((child) => {
      results.push(...extractAllSets(child));
    });
  }

  return results;
}

// ================= HELPERS =================
function safeText(field, fallback = "") {
  return field && typeof field === "object"
    ? field._content || fallback
    : fallback;
}

function buildAlbumLink(userId, albumId) {
  return `https://www.flickr.com/photos/${userId}/albums/${albumId}`;
}

function buildThumbnail(album) {
  if (album.primary && album.server && album.secret) {
    return `https://live.staticflickr.com/${album.server}/${album.primary}_${album.secret}_q.jpg`;
  }
  return null;
}

// ================= HTML GENERATOR =================
function generateHTML(albums) {
  const cards = albums
    .map((album) => {
      const title = safeText(album.title, "Untitled album");
      const desc = safeText(album.description, "");
      const link = buildAlbumLink(USER_ID, album.id);
      const img = buildThumbnail(album);

      return `
        <a href="${link}" class="card" target="_blank" rel="noreferrer">
          ${
            img
              ? `<img src="${img}" alt="${title}" loading="lazy" />`
              : `<div class="no-image">No image</div>`
          }
          <div class="card-content">
            <h2>${title}</h2>
            ${desc ? `<p>${desc}</p>` : ""}
          </div>
        </a>
      `;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Flickr Collection</title>

<style>
  body {
    margin: 0;
    font-family: Arial, sans-serif;
    background: #f4f4f4;
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
    max-width: 1200px;
    margin: auto;
  }

  .card {
    display: block;
    background: white;
    border-radius: 10px;
    overflow: hidden;
    text-decoration: none;
    color: #333;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 5px 20px rgba(0,0,0,0.15);
  }

  .card img {
    width: 100%;
    height: 180px;
    object-fit: cover;
    display: block;
  }

  .no-image {
    height: 180px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ddd;
    color: #666;
    font-size: 0.9rem;
  }

  .card-content {
    padding: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  p {
    font-size: 0.85rem;
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
</html>`;
}

// ================= MAIN =================
(async () => {
  try {
    const root = await fetchCollectionTree();

    // DEBUG (optional)
    // console.log(JSON.stringify(root, null, 2));

    const albums = extractAllSets(root);

    console.log(`Found ${albums.length} albums`);

    const html = generateHTML(albums);

    fs.writeFileSync("index.html", html);

    console.log("✅ index.html generated successfully!");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
})();
