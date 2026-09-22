# DOCX Skill — Environment Setup Guide

This document contains full platform-specific instructions for setting up the DOCX skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

DOCX_SKILL_DIR="<skill_directory>"
export DOCX_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:DOCX_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$DOCX_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:DOCX_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| Runtime | Node.js + npm | DOCX generation (docx-js) |
| npm pkg | docx | Word document creation library |
| Runtime | Python 3 + pip | Post-processing scripts |
| Python pkg | defusedxml | Safe XML parsing for validation |
| Font | CJK fonts (from CDN) | Chinese text in documents |

### Manual Install by Platform

#### macOS

```bash
brew install node python3
npm install -g docx
python3 -m pip install defusedxml
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install nodejs npm python3 python3-pip
npm install -g docx
python3 -m pip install defusedxml
```

#### Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
npm install -g docx
python -m pip install defusedxml
```

Alternative Windows package managers:
- `choco install nodejs-lts python3`
- `scoop install nodejs-lts python`

---

## Step 3: Font Installation

Fonts are downloaded individually from CDN on first setup.

- **CDN base**: `https://z-cdn.chatglm.cn/office-skill/fonts/`
- **Font list**: `env_setup/font_list.txt` (78 fonts, one relative path per line)
- **Marker file**: `.office-skill-fonts-installed` in the user font directory prevents re-download
- Special characters in filenames (e.g., `[`, `]`) are URL-encoded automatically by the setup script

The setup scripts read `font_list.txt`, check which fonts are already installed, and download only the missing ones. Each font is saved flat (filename only) to the user font directory.

### CDN Directory Structure (78 fonts)

| Directory | Count | Description |
|-----------|-------|-------------|
| `truetype/lxgw-wenkai/` | 6 | LXGW WenKai — Chinese handwriting style |
| `truetype/noto-serif-sc/` | 9 | Noto Serif SC — Chinese serif (variable + 8 static weights) |
| `chinese/` | 14 | Noto Sans SC, Sarasa Mono SC, Liberation fallbacks |
| `dejavu/` | 8 | DejaVu Sans/Serif/Mono — Latin/symbol fallback |
| `emoji/` | 1 | Noto Color Emoji |
| `english/` | 12 | Tinos, Carlito, Calibri |
| `freefont/` | 12 | FreeSans/FreeSerif/FreeMono — open-source fallback |
| `liberation/` | 12 | Liberation Sans/Serif/Mono — MS-metric-compatible |
| `libreoffice/` | 1 | OpenSymbol |
| `noto/` | 1 | Noto Color Emoji (duplicate) |
| `wqy/` | 1 | WenQuanYi Zen Hei — CJK fallback |
| *(root)* | 1 | Japanese Gothic |

### Install Targets by Platform

| Platform | User Font Directory |
|----------|-------------------|
| macOS | `~/Library/Fonts/` |
| Linux | `~/.local/share/fonts/` (then run `fc-cache -f`) |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (per-user, no admin) |

### Manual Font Installation

If CDN is unreachable, download fonts manually. Example:

```bash
# Download a single font
curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/chinese/NotoSansSC%5Bwght%5D.ttf"
# Copy to user font dir
cp "NotoSansSC[wght].ttf" ~/Library/Fonts/   # macOS
```

Or download all fonts listed in `font_list.txt`:

```bash
while read f; do
    encoded=$(echo "$f" | sed 's/\[/%5B/g; s/\]/%5D/g')
    curl -fSLO "https://z-cdn.chatglm.cn/office-skill/fonts/$encoded"
done < env_setup/font_list.txt
```

### Post-Install Variable

After font installation, `FONT_DIR` points to the user font directory:

| Platform | FONT_DIR |
|----------|----------------|
| macOS | `~/Library/Fonts` |
| Linux | `~/.local/share/fonts` |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### npm (npmmirror)

```bash
npm install -g docx --registry https://registry.npmmirror.com
```

### pip (Tsinghua mirror)

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  defusedxml
```

### Windows (PowerShell) China mirrors

```powershell
npm install -g docx --registry https://registry.npmmirror.com
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn defusedxml
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Node.js | https://npmmirror.com/mirrors/node/ |
| Python | https://npmmirror.com/mirrors/python/ |
