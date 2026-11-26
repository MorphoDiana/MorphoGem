const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * electron-builder afterPack hook:
 * Stamps custom chibi MorphoGem icon.ico & PE metadata onto MorphoGem.exe
 * BEFORE NSIS packages MorphoGem-Setup-x.y.z.exe.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  const rcedit = path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (!fs.existsSync(exePath) || !fs.existsSync(icoPath) || !fs.existsSync(rcedit)) {
    console.warn('[after-pack] Skipping rcedit stamp (missing binary or icon)');
    return;
  }

  execFileSync(rcedit, [
    exePath,
    '--set-icon', icoPath,
    '--set-version-string', 'ProductName', 'MorphoGem',
    '--set-version-string', 'FileDescription', 'MorphoGem — 节点式 2D 转 3D 角色工坊',
    '--set-version-string', 'CompanyName', 'MorphoDiana × Gemini',
    '--set-version-string', 'InternalName', 'MorphoGem',
    '--set-version-string', 'OriginalFilename', 'MorphoGem.exe',
  ], { stdio: 'inherit' });
  console.log('[after-pack] Stamped custom chibi MorphoGem icon & PE metadata onto', exePath);
};
