#!/usr/bin/env node
/**
 * Copy repo plugin/ → Claude Code marketplace + versioned plugin cache.
 *
 * Cursor resolves worker/MCP from ~/.claude/.../marketplaces/thedotmack/plugin/.
 * Claude Code hooks prefer ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/ (see plugin/hooks/hooks.json).
 * When sync-marketplace skips full rsync (beta branch), those trees were never updated — same class of bug as OpenCode.
 *
 * Respects CLAUDE_CONFIG_DIR for the marketplace path (matches src/shared/paths.ts).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return '';

  const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

function getPluginVersion(repoRoot) {
  const pluginJsonPath = path.join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');
  const raw = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  return raw.version;
}

/**
 * @param {string} repoRoot Absolute path to claude-mem repository root
 * @returns {boolean} true if at least one destination was synced
 */
function syncBuiltPlugin(repoRoot) {
  const pluginSrc = path.join(repoRoot, 'plugin');
  if (!fs.existsSync(pluginSrc)) {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ sync-built-plugin: no plugin/ directory');
    return false;
  }

  let version;
  try {
    version = getPluginVersion(repoRoot);
  } catch (e) {
    console.log('\x1b[33m%s\x1b[0m', `ℹ sync-built-plugin: could not read plugin version (${e.message})`);
    return false;
  }

  const claudeConfig = getClaudeConfigDir();
  const marketplaceRoot = path.join(claudeConfig, 'plugins', 'marketplaces', 'thedotmack');
  const marketplacePlugin = path.join(marketplaceRoot, 'plugin');
  const cacheBase = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  const cacheVersion = path.join(cacheBase, version);

  const hasInstall =
    fs.existsSync(marketplaceRoot) || fs.existsSync(cacheBase);
  if (!hasInstall) {
    console.log(
      '\x1b[33m%s\x1b[0m',
      'ℹ sync-built-plugin: no Claude marketplace or plugin cache — skip'
    );
    return false;
  }

  const gitignoreExcludes = getGitignoreExcludes(pluginSrc);
  // Never rsync node_modules — huge and bun install at destination refreshes deps (matches sync intent).
  const staticExcludes = ['node_modules', '.bun']
    .map((p) => `--exclude=${JSON.stringify(p)}`)
    .join(' ');
  const excludes = [staticExcludes, gitignoreExcludes].filter(Boolean).join(' ');
  const rsyncTo = (label, destDir) => {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      execSync(
        `rsync -av --delete --exclude=.git ${excludes} "${pluginSrc}/" "${destDir}/"`,
        { stdio: 'inherit' }
      );
      console.log(`✓ ${label} → ${destDir}`);
      return true;
    } catch (e) {
      console.log(`ℹ Could not rsync ${label}: ${e.message}`);
      return false;
    }
  };

  let any = false;
  // Claude Code: hooks resolve latest cache dir first
  if (rsyncTo('Claude plugin cache', cacheVersion)) any = true;
  // Cursor + marketplace fallback
  if (fs.existsSync(marketplaceRoot)) {
    if (rsyncTo('Marketplace plugin', marketplacePlugin)) any = true;
    try {
      console.log('Running bun install in marketplace...');
      execSync('bun install', { cwd: marketplaceRoot, stdio: 'inherit' });
    } catch (e) {
      console.log(`ℹ bun install (marketplace): ${e.message}`);
    }
  }

  try {
    console.log('Running bun install in plugin cache...');
    execSync('bun install', { cwd: cacheVersion, stdio: 'inherit' });
  } catch (e) {
    console.log(`ℹ bun install (cache): ${e.message}`);
  }

  return any;
}

const repoRoot = path.join(__dirname, '..');
if (require.main === module) {
  syncBuiltPlugin(repoRoot);
}

module.exports = { syncBuiltPlugin };
