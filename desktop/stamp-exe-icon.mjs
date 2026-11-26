#!/usr/bin/env node
/**
 * Stamps build/icon.ico and MorphoGem PE version strings onto dist/win-unpacked/MorphoGem.exe
 * using bundled rcedit.exe so no external network download (winCodeSign) is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exePath = path.join(__dirname, 'dist', 'win-unpacked', 'MorphoGem.exe');
const icoPath = path.join(__dirname, 'build', 'icon.ico');
const rceditCandidates = [
  path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
];

const rcedit = rceditCandidates.find(p => fs.existsSync(p));
if (!fs.existsSync(exePath)) {
  console.warn('[stamp-exe-icon] MorphoGem.exe not found at:', exePath);
  process.exit(0);
}
if (rcedit && fs.existsSync(icoPath)) {
  execFileSync(rcedit, [
    exePath,
    '--set-icon', icoPath,
    '--set-version-string', 'ProductName', 'MorphoGem',
    '--set-version-string', 'FileDescription', 'MorphoGem — 节点式 2D 转 3D 角色工坊',
    '--set-version-string', 'CompanyName', 'MorphoDiana × Gemini',
    '--set-version-string', 'InternalName', 'MorphoGem',
    '--set-version-string', 'OriginalFilename', 'MorphoGem.exe',
  ], { stdio: 'inherit' });
  console.log('[stamp-exe-icon] Stamped custom chibi MorphoGem icon & PE metadata onto MorphoGem.exe');
} else {
  console.warn('[stamp-exe-icon] Skipped PE stamp (rcedit or icon.ico missing)');
}
