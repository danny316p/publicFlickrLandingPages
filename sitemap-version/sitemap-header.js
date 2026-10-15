const DEFAULT_HEADER = Object.freeze({
    about: "",
    links: [],
    socials: []
});

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function safeUrl(value) {
    if (typeof value !== "string") return null;

    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
}

function normalizeItems(items, includeIcon) {
    if (!Array.isArray(items)) return [];

    return items
        .map(item => {
            if (!item || typeof item !== "object") return null;

            const url = safeUrl(item.url);
            const label = typeof item.label === "string" ? item.label.trim() : "";
            if (!url || !label) return null;

            return {
                label,
                url,
                ...(includeIcon && typeof item.icon === "string" && item.icon.trim()
                    ? { icon: item.icon.trim() }
                    : {}),
                ...(includeIcon && safeUrl(item.iconUrl)
                    ? { iconUrl: safeUrl(item.iconUrl) }
                    : {})
            };
        })
        .filter(Boolean);
}

function normalizeHeaderConfig(config) {
    const source = config && typeof config === "object" ? config : {};

    return {
        about: typeof source.about === "string" ? source.about.trim() : DEFAULT_HEADER.about,
        links: normalizeItems(source.links, false),
        socials: normalizeItems(source.socials, true)
    };
}

function renderHeaderExtras(config) {
    const header = normalizeHeaderConfig(config);
    const about = header.about
        ? `<p class="header-about">${escapeHtml(header.about)}</p>`
        : "";
    const links = header.links.length
        ? `<nav class="header-links" aria-label="Website links">${header.links.map(link =>
            `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`
        ).join("")}</nav>`
        : "";
    const socials = header.socials.length
        ? `<nav class="header-socials" aria-label="Social links">${header.socials.map(link =>
            `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.label)}">${link.iconUrl ? `<img class="social-icon" src="${escapeHtml(link.iconUrl)}" alt="${escapeHtml(link.label)}" title="${escapeHtml(link.label)}" loading="lazy">` : `${link.icon ? `<span aria-hidden="true">${escapeHtml(link.icon)}</span>` : ""}${escapeHtml(link.label)}`}</a>`
        ).join("")}</nav>`
        : "";

    return about || links || socials
        ? `<div class="header-extras">${about}${links}${socials}</div>`
        : "";
}

module.exports = {
    normalizeHeaderConfig,
    renderHeaderExtras
};
