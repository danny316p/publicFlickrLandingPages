#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
// Presets and deploy settings come from ../secrets/
const PRESETS = require("../secrets/sitemap-presets.js");
const DEPLOY_CONFIG = require("../secrets/sitemap-deploy.js");

// Resolve deploy directory: CLI arg > env var > secrets config
const DEPLOY_DIR = process.argv[2]
    || process.env.DEPLOY_DIR
    || DEPLOY_CONFIG.deployDir;

// Resolve modes: env var > secrets config
const MODES = (process.env.DEPLOY_MODES
        ? process.env.DEPLOY_MODES.split(",")
        : DEPLOY_CONFIG.modes
    )
    .map(s => s.trim())
    .filter(Boolean);

// Resolve source directory: secrets config > this script's directory
const SOURCE_DIR = DEPLOY_CONFIG.sourceDir || __dirname;

// ---------- FILENAME TRANSFORMS ----------
// Source filename for a given mode + preset (matches generator output).
function sourceFilename(mode, preset) {
    return preset.name === "all"
        ? `sitemap-${mode}.html`
        : `sitemap-${mode}-${preset.name}.html`;
}

// Destination filename applied during deploy.
//   - Prepend "flickr-"
//   - Remove "-public" if present
function destFilename(mode, preset) {
    let name = sourceFilename(mode, preset);
    name = name.replace("-public", "");
    name = "flickr-" + name;
    return name;
}

// ---------- HELPERS ----------
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyFile(src, dest) {
    fs.copyFileSync(src, dest);
    return fs.statSync(dest).size;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------- VALIDATION ----------
function validateConfig() {
    if (!DEPLOY_DIR) {
        console.error("❌ No deploy directory configured.");
        console.error("   Set deployDir in ../secrets/sitemap-deploy.js,");
        console.error("   or pass a path as an argument, or set DEPLOY_DIR.");
        process.exit(1);
    }
    if (!Array.isArray(MODES) || MODES.length === 0) {
        console.error("❌ No modes configured.");
        console.error("   Set modes in ../secrets/sitemap-deploy.js (e.g. [\"public\",\"private\"]),");
        console.error("   or set DEPLOY_MODES=public,private.");
        process.exit(1);
    }
    if (!fs.existsSync(SOURCE_DIR)) {
        console.error(`❌ Source directory does not exist: ${SOURCE_DIR}`);
        process.exit(1);
    }
}

// ---------- MAIN ----------
function main() {
    validateConfig();

    console.log(`📦 Deploying sitemaps`);
    console.log(`   Source:  ${SOURCE_DIR}`);
    console.log(`   Dest:    ${DEPLOY_DIR}`);
    console.log(`   Modes:   ${MODES.join(", ")}`);
    console.log(`   Presets: ${PRESETS.map(p => p.name).join(", ")}`);
    console.log("");

    // Verify destination exists or create it
    try {
        ensureDir(DEPLOY_DIR);
    } catch (err) {
        console.error(`❌ Could not create deploy directory: ${err.message}`);
        process.exit(1);
    }

    // Check that the destination is writable by attempting a probe file
    const probe = path.join(DEPLOY_DIR, ".deploy-probe");
    try {
        fs.writeFileSync(probe, "");
        fs.unlinkSync(probe);
    } catch (err) {
        console.error(`❌ Deploy directory not writable: ${err.message}`);
        process.exit(1);
    }

    let copied = 0;
    let missing = 0;
    let totalBytes = 0;
    const failures = [];

    for (const mode of MODES) {
        for (const preset of PRESETS) {
            const srcName = sourceFilename(mode, preset);
            const destName = destFilename(mode, preset);
            const src = path.join(SOURCE_DIR, srcName);
            const dest = path.join(DEPLOY_DIR, destName);

            if (!fs.existsSync(src)) {
                console.warn(`⚠️  Missing: ${srcName} (skipped)`);
                missing++;
                continue;
            }

            try {
                const size = copyFile(src, dest);
                totalBytes += size;
                copied++;
                console.log(`✅ ${srcName} → ${destName} (${formatBytes(size)})`);
            } catch (err) {
                console.error(`❌ Failed to copy ${srcName}: ${err.message}`);
                failures.push({ filename: srcName, error: err.message });
            }
        }
    }

    console.log("");
    console.log(`📊 Summary`);
    console.log(`   Copied:  ${copied}`);
    console.log(`   Missing: ${missing}`);
    console.log(`   Failed:  ${failures.length}`);
    console.log(`   Total:   ${formatBytes(totalBytes)}`);

    if (failures.length > 0) {
        console.error("\n❌ Deployment completed with errors:");
        failures.forEach(f => console.error(`   - ${f.filename}: ${f.error}`));
        process.exit(1);
    }

    if (copied === 0) {
        console.warn("\n⚠️  No files were copied. Did you run the generator first?");
        process.exit(1);
    }

    console.log("\n🎉 Deployment complete.");
}

main();