# publicFlickrLandingPages
For handling public landing and navigation pages for my Flickr albums

## Convert a sitemap to Discord Markdown

Convert a generated sitemap HTML file from `sitemap-version/sitemap-consolidated.js` into nested Discord-friendly Markdown:

```sh
node convert-sitemap-to-discord.js sitemap.html
node convert-sitemap-to-discord.js sitemap.html --collection "vacation" --max-albums 10 --output discord.md
```

The positional HTML file is required. `--collection` selects collections whose titles contain the supplied substring (including their parent hierarchy), `--max-albums` limits the number of albums listed directly under each collection, and `--output` writes the result to a file instead of stdout.
