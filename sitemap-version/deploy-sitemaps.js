#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

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

// Path to the generator script (relative to this script's directory)
const GENERATOR_SCRIPT = path.join(__dirname, "sitemap-consolidated.js");

// Commit message used by the git commit step
const COMMIT_MESSAGE = "Update Flickr sitemaps";

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

// Run a command synchronously and return its exit status.
// Inherits stdio so the subprocess output is visible in the terminal.
function runCommand(cmd, args, cwd) {
    console.log(`\n$ ${cmd} ${args.join(" ")}`);
    const result = spawnSync(cmd, args, {
        cwd: cwd || process.cwd(),
        stdio: "inherit",
        env: process.env
    });
    return result.status === 0;
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
    if (!fs.existsSync(GENERATOR_SCRIPT)) {
        console.error(`❌ Generator script not found: ${GENERATOR_SCRIPT}`);
        process.exit(1);
    }
}

// ---------- STEPS ----------
function generateSitemaps() {
    console.log(`\n🔨 Generating sitemaps (with --refresh)`);
    for (const mode of MODES) {
        const args = [GENERATOR_SCRIPT, "--refresh"];
        if (mode === "private") args.push("--private");

        const ok = runCommand("node", args, SOURCE_DIR);
        if (!ok) {
            console.error(`❌ Generation failed for mode: ${mode}`);
            process.exit(1);
        }
    }
}

function deployFiles() {
    console.log(`\n📦 Deploying sitemaps`);
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
        console.error("\n❌ No files were copied. Aborting.");
        process.exit(1);
    }
}

function commitChanges() {
    console.log(`\n📝 Committing changes in ${DEPLOY_DIR}`);

    // Verify DEPLOY_DIR is inside a git repo
    const checkRepo = spawnSync(
        "git", ["rev-parse", "--is-inside-work-tree"],
        { cwd: DEPLOY_DIR, encoding: "utf8" }
    );
    if (checkRepo.status !== 0 || checkRepo.stdout.trim() !== "true") {
        console.error(`❌ ${DEPLOY_DIR} is not inside a git repository.`);
        process.exit(1);
    }

    const ok = runCommand(
        "git",
        ["commit", "-am", COMMIT_MESSAGE],
        DEPLOY_DIR
    );

    if (!ok) {
        // git commit exits 1 when there's nothing to commit, which is
        // not necessarily an error from our perspective.
        console.warn("⚠️  git commit returned non-zero (nothing to commit?)");
    } else {
        console.log(`✅ Committed: "${COMMIT_MESSAGE}"`);
    }
}

// ---------- MAIN ----------
function main() {
    validateConfig();

    generateSitemaps();
    deployFiles();
    commitChanges();

    console.log("\n🎉 Deployment complete.");
}

main();