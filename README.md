# publicFlickrLandingPages
For handling public landing and navigation pages for my Flickr albums

## Generate Flickr sitemaps

Run the consolidated generator to create sitemap HTML for every configured preset in public mode:

```sh
node sitemap-version/sitemap-consolidated.js
```

Add `--private` to generate private-mode sitemaps, `--refresh` to refresh cached Flickr data, or `--show-unprocessed-videos` to include unprocessed video counts after normal video counts in album and collection metadata. Unprocessed video labels are hidden by default. The display flag applies to every preset generated in that run.

When using the deployment script, pass `--show-unprocessed-videos` after the optional deploy-directory argument to enable the labels in all generated modes and presets:

```sh
node sitemap-version/deploy-sitemaps.js <deploy-directory> --show-unprocessed-videos
```

## Convert a sitemap to Discord Markdown

Convert a generated sitemap HTML file from `sitemap-version/sitemap-consolidated.js` into nested Discord-friendly Markdown:

```sh
node convert-sitemap-to-discord.js sitemap.html
node convert-sitemap-to-discord.js sitemap.html --collection "vacation" --max-albums 10 --output discord.md
```

The positional HTML file is required. `--collection` selects collections whose titles contain the supplied substring (including their parent hierarchy), `--max-albums` limits the number of albums listed directly under each collection, and `--output` writes the result to a file instead of stdout.
