#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental rsync overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 *
 * OpenCode always receives the local build output: we sync ~/.config/opencode/plugins/claude-mem.js
 * whenever dist/opencode-plugin/index.js exists, even when marketplace rsync is skipped.
 *
 * Cursor + Claude Code: sync-built-plugin.cjs copies plugin/ to the marketplace plugin dir and to the
 * versioned plugin cache so hooks keep using the latest build when full rsync is skipped.
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { syncOpenCodePlugin } = require('./sync-opencode-plugin.cjs');
const { syncBuiltPlugin } = require('./sync-built-plugin.cjs');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return '';

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

// Get version from plugin.json
function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

function triggerWorkerRestart() {
  console.log('\n🔄 Triggering worker restart...');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '✓ Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out');
  });
  req.end();
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');
const skipRsync = branch && branch !== 'main' && !isForce;

const rootDir = path.join(__dirname, '..');

if (skipRsync) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Skipping marketplace rsync (would overwrite beta code).');
  console.log('');
  console.log('OpenCode plugin and Cursor/Claude plugin/ trees will still update from this repo\'s build.');
  console.log('');
  console.log('To sync marketplace from this checkout:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
}

if (!skipRsync) {
  console.log('Syncing to marketplace...');
  try {
    const gitignoreExcludes = getGitignoreExcludes(rootDir);

    execSync(
      `rsync -av --delete --exclude=.git --exclude=bun.lock --exclude=package-lock.json ${gitignoreExcludes} ./ ~/.claude/plugins/marketplaces/thedotmack/`,
      { stdio: 'inherit', cwd: rootDir }
    );

    console.log('Running bun install in marketplace...');
    execSync(
      'cd ~/.claude/plugins/marketplaces/thedotmack/ && bun install',
      { stdio: 'inherit' }
    );

    // Sync to cache folder with version
    const version = getPluginVersion();
    const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

    const pluginDir = path.join(rootDir, 'plugin');
    const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);

    console.log(`Syncing to cache folder (version ${version})...`);
    execSync(
      `rsync -av --delete --exclude=.git ${pluginGitignoreExcludes} plugin/ "${CACHE_VERSION_PATH}/"`,
      { stdio: 'inherit', cwd: rootDir }
    );

    console.log(`Running bun install in cache folder (version ${version})...`);
    execSync(`bun install`, { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

    console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
    process.exit(1);
  }
} else {
  console.log('Skipping marketplace root rsync and versioned cache sync.\n');
}

// OpenCode: separate install path; always refresh from local dist build
syncOpenCodePlugin(rootDir);
// Cursor (marketplace plugin/) + Claude Code (versioned cache): refresh plugin/ when full rsync skipped
if (skipRsync) {
  syncBuiltPlugin(rootDir);
}

triggerWorkerRestart();
