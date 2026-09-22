# XLSX Skill — Environment Setup Guide

This document contains full platform-specific instructions for setting up the XLSX skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

XLSX_SKILL_DIR="<skill_directory>"
export XLSX_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:XLSX_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$XLSX_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:XLSX_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| Runtime | Python 3 + pip | Spreadsheet generation and processing |
| Python pkg | openpyxl | Read/write .xlsx files |
| Python pkg | XlsxWriter | High-performance .xlsx creation |
| Optional | LibreOffice | .xlsx-to-PDF and .csv-to-.xlsx conversion |
| Font | CJK fonts (pre-installed in /usr/share/fonts) | Chinese text in spreadsheets |

### Manual Install by Platform

#### macOS

```bash
brew install python3
python3 -m pip install openpyxl XlsxWriter
brew install --cask libreoffice   # optional
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install python3 python3-pip
python3 -m pip install openpyxl XlsxWriter
sudo apt install libreoffice-core   # optional
```

#### Windows (PowerShell)

```powershell
winget install Python.Python.3.11
python -m pip install openpyxl XlsxWriter
winget install TheDocumentFoundation.LibreOffice   # optional
```

Alternative Windows package managers:
- `choco install python3`
- `scoop install python`

---

## Step 3: Font Verification

Fonts are pre-installed in the system font directory `/usr/share/fonts/`.

- **Font base**: `/usr/share/fonts/`
- **Font list**: `env_setup/font_list.txt` (78 fonts, one relative path per line)
- The setup script reads `font_list.txt` and verifies each font exists under `/usr/share/fonts/`

### Font Directory Structure (78 fonts)

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

### Verify Fonts Manually

Check if a font exists:

```bash
ls /usr/share/fonts/truetype/chinese/NotoSansSC\[wght\].ttf
```

Verify all fonts in the list:

```bash
while read f; do
    [ -f "$f" ] && echo "OK: $f" || echo "MISSING: $f"
done < env_setup/font_list.txt
```

### Post-Setup Variable

`FONT_DIR` is set to the system font directory:

| Value | Path |
|-------|------|
| `FONT_DIR` | `/usr/share/fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### pip (Tsinghua mirror)

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  openpyxl XlsxWriter
```

### Windows (PowerShell) China mirrors

```powershell
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn openpyxl XlsxWriter
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Python | https://npmmirror.com/mirrors/python/ |
