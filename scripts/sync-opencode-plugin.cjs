#!/usr/bin/env node
/**
 * Copy dist/opencode-plugin/index.js → OpenCode plugins directory as claude-mem.js.
 * OpenCode loads a file copy, not the live repo — this must run after each build/sync.
 *
 * Destination matches OpenCodeInstaller: respects OPENCODE_CONFIG_DIR, else ~/.config/opencode/plugins.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function getOpenCodePluginsDirectory() {
  const base =
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), '.config', 'opencode');
  return path.join(base, 'plugins');
}

/**
 * @param {string} repoRoot Absolute path to claude-mem repository root
 * @returns {boolean} true if the bundle was copied
 */
function syncOpenCodePlugin(repoRoot) {
  const src = path.join(repoRoot, 'dist', 'opencode-plugin', 'index.js');
  const dstDir = getOpenCodePluginsDirectory();
  const dst = path.join(dstDir, 'claude-mem.js');

  if (!fs.existsSync(src)) {
    console.log(
      '\x1b[33m%s\x1b[0m',
      `ℹ OpenCode plugin: no build at ${src} (run npm run build)`
    );
    return false;
  }

  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`✓ OpenCode plugin synced to ${dst}`);
    return true;
  } catch (e) {
    console.log(`ℹ Could not sync OpenCode plugin: ${e.message}`);
    return false;
  }
}

const repoRoot = path.join(__dirname, '..');
if (require.main === module) {
  syncOpenCodePlugin(repoRoot);
}

module.exports = { syncOpenCodePlugin, getOpenCodePluginsDirectory };
