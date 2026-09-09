const fs = require('node:fs');
const path = require('node:path');

const cachePath = path.join(__dirname, '..', 'node_modules', '@omss', 'framework', 'dist', 'core', 'cache.js');

if (!fs.existsSync(cachePath)) {
  console.warn('[patch-omss-framework] cache.js not found, skipping');
  process.exit(0);
}

let source = fs.readFileSync(cachePath, 'utf8');
const original = `    constructor() {
        // Cleanup expired entries every minute
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }`;
const patched = `    constructor() {
        // Cloudflare Workers do not allow timers during Worker startup.
        if (typeof navigator === 'undefined' || navigator.userAgent !== 'Cloudflare-Workers') {
            this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
        }
    }`;

if (source.includes(patched)) {
  console.log('[patch-omss-framework] cache timer patch already applied');
  process.exit(0);
}

if (!source.includes(original)) {
  console.warn('[patch-omss-framework] expected cache constructor not found, skipping');
  process.exit(0);
}

source = source.replace(original, patched);
fs.writeFileSync(cachePath, source);
console.log('[patch-omss-framework] patched Worker startup cache timer');