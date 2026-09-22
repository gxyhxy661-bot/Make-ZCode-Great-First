#!/usr/bin/env bash
# Lightweight environment check for XLSX skill.
# Exit 0 = all OK, exit 1 = missing dependencies.
# Also resolves and exports XLSX_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING: $desc"; FAIL=1; fi; }

# ── Resolve XLSX_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
XLSX_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export XLSX_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

check "python3"     command -v python3
check "openpyxl"    python3 -c "import openpyxl"
check "xlsxwriter"  python3 -c "import xlsxwriter"

# Font check
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|wenquanyi" || { $QUIET || echo "MISSING: CJK fonts"; FAIL=1; }
fi

$QUIET || echo "XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
