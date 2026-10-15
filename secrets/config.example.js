module.exports = {
    // Flickr API credentials: https://www.flickr.com/services/apps/create/
    API_KEY: "YOUR_API_KEY",
    API_SECRET: "YOUR_API_SECRET",
    USER_ID: "YOUR_FLICKR_USER_ID",

    // OAuth access token values used by private sitemap generation.
    OAUTH_TOKEN: "YOUR_OAUTH_TOKEN",
    OAUTH_TOKEN_SECRET: "YOUR_OAUTH_TOKEN_SECRET",

    // Used by n-generate.js and cgpt-generate.js.
    COLLECTION_ID: "YOUR_COLLECTION_ID",

    // Optional content rendered below the sitemap title.
    // Omit this object or leave its fields empty to use the default header.
    sitemapHeader: {
        about: "A short introduction about yourself.",
        links: [
            { label: "Website", url: "https://example.com" }
        ],
        socials: [
            { label: "Linktree", url: "https://linktr.ee/example", iconUrl: "https://cdn.simpleicons.org/linktree" },
            { label: "Patreon", url: "https://www.patreon.com/example", iconUrl: "https://cdn.simpleicons.org/patreon" }
        ]
    }
};
