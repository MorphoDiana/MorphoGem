# MorphoGem Desktop (`MorphoGem.exe`) — Windows Installer & Auto-Updater

`desktop/` packages **MorphoGem Studio + Embedded Silent Tripo Workspace + Local HTTP Server + `tripo_mcp` Daemon** into a standalone Windows desktop application (`MorphoGem-Setup-<version>.exe`) with GitHub Releases update support.

> **Important Repository Rule**: Never commit `.exe` or `.blockmap` binaries into Git. Installers are built via GitHub Actions (`.github/workflows/release.yml`) or locally into `desktop/dist/` (gitignored) and published strictly to **GitHub Releases**.

---

## Installation Directory Layout (`<InstallDir>`)

When installed via `MorphoGem-Setup-*.exe`, user data folders live cleanly inside `<InstallDir>` and are **automatically preserved across upgrades and uninstallations** (`desktop/build/installer.nsh`):

```text
<InstallDir>/
├── MorphoGem.exe               # Desktop Studio shell
├── Uninstall MorphoGem.exe     # Safe uninstaller (removes app binaries only)
├── resources/app-core/         # Clean-room web studio, skills, scripts & tripo_mcp
├── Projects/                   # User .mgem character projects & exports (Preserved)
├── Exports/                    # Merged FBX / GLB / Blend packages (Preserved)
├── Mods/                       # Community .mgmod extensions (Preserved)
└── userdata/                   # Persistent Tripo login cookies & Blender path config (Preserved)
```

---

## Local Development & Packaging Commands

```powershell
# 1. Launch desktop window in dev mode
npm run desktop

# 2. Headless Electron smoke test
npm run desktop:smoke

# 3. Build unpacked Windows directory (desktop/dist/win-unpacked)
npm run desktop:pack

# 4. Build Windows NSIS Setup Installer (desktop/dist/MorphoGem-Setup-2.1.0.exe)
npm run desktop:installer
```
