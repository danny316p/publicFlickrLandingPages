#!/usr/bin/env node

const fs = require("fs");

function usage() {
    return [
        "Usage: node convert-sitemap-to-discord.js <sitemap.html> [options]",
        "",
        "Options:",
        "  --collection <text>  Include collections whose title contains text",
        "  --max-albums <n>     Limit direct albums listed per collection",
        "  --output <file>      Write Markdown to a file instead of stdout",
        "  --help               Show this help"
    ].join("\n");
}

function parseArgs(args) {
    const options = { input: null, collection: null, maxAlbums: null, output: null };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--help" || arg === "-h") {
            console.log(usage());
            process.exit(0);
        }
        if (arg === "--collection" || arg === "--max-albums" || arg === "--output") {
            if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
            const value = args[++i];
            if (arg === "--collection") options.collection = value.toLowerCase();
            if (arg === "--output") options.output = value;
            if (arg === "--max-albums") {
                options.maxAlbums = Number(value);
                if (!Number.isInteger(options.maxAlbums) || options.maxAlbums < 0) {
                    throw new Error("--max-albums must be a non-negative integer");
                }
            }
            continue;
        }
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (options.input) throw new Error("Only one input HTML file may be supplied");
        options.input = arg;
    }
    if (!options.input) throw new Error("An input HTML file is required");
    return options;
}

function decodeHtml(value) {
    const named = {
        amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\""
    };
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === "#") {
            const code = entity[1].toLowerCase() === "x"
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return named[entity.toLowerCase()] || match;
    });
}

function parseAttributes(source) {
    const attrs = {};
    const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = pattern.exec(source))) {
        attrs[match[1].toLowerCase()] = decodeHtml(match[2] || match[3] || match[4] || "");
    }
    return attrs;
}

function parseHtml(html) {
    const root = { tag: "#root", attrs: {}, children: [], text: "" };
    const stack = [root];
    const tokens = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
    let position = 0;
    let match;
    while ((match = tokens.exec(html))) {
        const text = html.slice(position, match.index);
        if (text) stack[stack.length - 1].text += decodeHtml(text);
        const token = match[0];
        position = tokens.lastIndex;
        if (token.startsWith("<!--")) continue;
        if (token.startsWith("</")) {
            const tag = token.slice(2, -1).trim().toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].tag === tag) {
                    stack.length = i;
                    break;
                }
            }
            continue;
        }
        const inner = token.slice(1, -1).trim();
        const selfClosing = inner.endsWith("/");
        const parts = inner.replace(/\/$/, "").trim().match(/^([a-z][\w:-]*)\s*([\s\S]*)$/i);
        if (!parts) continue;
        const node = {
            tag: parts[1].toLowerCase(),
            attrs: parseAttributes(parts[2]),
            children: [],
            text: ""
        };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing && !["area", "base", "br", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"].includes(node.tag)) {
            stack.push(node);
        }
    }
    if (position < html.length) stack[stack.length - 1].text += decodeHtml(html.slice(position));
    return root;
}

function hasClass(node, className) {
    return (node.attrs.class || "").split(/\s+/).includes(className);
}

function directChild(node, predicate) {
    return node.children.find(predicate);
}

function textContent(node) {
    return node.text + node.children.map(textContent).join("");
}

function escapeMarkdown(value) {
    return value.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1").replace(/\s+/g, " ").trim();
}

function parseCollections(root) {
    function parseCollection(node) {
        const header = directChild(node, child => hasClass(child, "collection-header"));
        const titleLink = header && directChild(header, child => child.tag === "a");
        const children = directChild(node, child => hasClass(child, "children"));
        const albumsContainer = children && directChild(children, child => hasClass(child, "albums"));
        const albums = albumsContainer
            ? albumsContainer.children.filter(child => child.tag === "a" && hasClass(child, "album-card")).map(card => {
                const titleNode = directChild(card, child => hasClass(child, "album-title"));
                return {
                    title: textContent(titleNode || card).trim(),
                    url: card.attrs.href || "#",
                    photos: Number(card.attrs["data-photos"] || 0),
                    videos: Number(card.attrs["data-videos"] || 0)
                };
            })
            : [];
        const childCollections = children
            ? children.children.filter(child => child.tag === "div" && hasClass(child, "collection")).map(parseCollection)
            : [];
        return {
            title: textContent(titleLink || header || node).trim(),
            url: titleLink ? titleLink.attrs.href : null,
            albums,
            children: childCollections
        };
    }

    const topLevelCollections = [];
    function collectTopLevelCollections(node) {
        if (node.tag === "div" && hasClass(node, "collection")) {
            topLevelCollections.push(node);
            return;
        }
        node.children.forEach(collectTopLevelCollections);
    }
    root.children.forEach(collectTopLevelCollections);
    return topLevelCollections.map(parseCollection);
}

function selectCollections(collections, query) {
    if (!query) return collections;
    function select(collection) {
        const children = collection.children.map(select).filter(Boolean);
        if (collection.title.toLowerCase().includes(query) || children.length) {
            return { ...collection, children };
        }
        return null;
    }
    return collections.map(select).filter(Boolean);
}

function formatCount(value, singular) {
    return `${value.toLocaleString()} ${value === 1 ? singular : `${singular}s`}`;
}

function renderMarkdown(collections, options) {
    const lines = ["# Flickr Sitemap", ""];
    function render(collection, depth) {
        const heading = "#".repeat(Math.min(depth + 2, 6));
        const title = escapeMarkdown(collection.title);
        lines.push(`${heading} ${collection.url ? `[${title}](${collection.url})` : title}`);
        const albums = options.maxAlbums === null
            ? collection.albums
            : collection.albums.slice(0, options.maxAlbums);
        albums.forEach(album => {
            const counts = [formatCount(album.photos, "photo")];
            if (album.videos > 0) counts.push(formatCount(album.videos, "video"));
            lines.push(`- [${escapeMarkdown(album.title)}](${album.url}) — ${counts.join(", ")}`);
        });
        if (albums.length < collection.albums.length) {
            lines.push(`- _...and ${collection.albums.length - albums.length} more album(s)_`);
        }
        if (albums.length || collection.children.length) lines.push("");
        collection.children.forEach(child => render(child, depth + 1));
    }
    collections.forEach(collection => render(collection, 0));
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const html = fs.readFileSync(options.input, "utf8");
        const collections = selectCollections(parseCollections(parseHtml(html)), options.collection);
        const markdown = renderMarkdown(collections, options);
        if (options.output) fs.writeFileSync(options.output, markdown);
        else process.stdout.write(markdown);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        console.error(usage());
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = { parseHtml, parseCollections, renderMarkdown, selectCollections };
