#!/usr/bin/env bash
set -euo pipefail

# Open Fiber Map — uninstaller

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
section() { echo -e "\n${BOLD}==> $*${NC}"; }

confirm() {
    read -rp "$1 [y/N]: " _ans
    [[ "${_ans,,}" == "y" || "${_ans,,}" == "yes" ]]
}

[[ $EUID -eq 0 ]] || { echo "Please run as root: sudo bash uninstall.sh" >&2; exit 1; }

section "Open Fiber Map — Uninstaller"
warn "This will remove the Open Fiber Map application from this server."
echo ""

# Detect install directory from service file
INSTALL_DIR=""
if [[ -f /etc/systemd/system/open-fiber-map.service ]]; then
    INSTALL_DIR="$(grep WorkingDirectory /etc/systemd/system/open-fiber-map.service | sed 's/.*=//;s|/backend||')"
fi
INSTALL_DIR="${INSTALL_DIR:-/opt/open-fiber-map}"

# Read DB config from .env if present
DB_NAME="fibermap"
DB_USER="fiberadmin"
if [[ -f "$INSTALL_DIR/backend/.env" ]]; then
    DB_NAME="$(grep '^DB_NAME=' "$INSTALL_DIR/backend/.env" | cut -d= -f2)"
    DB_USER="$(grep '^DB_USER=' "$INSTALL_DIR/backend/.env" | cut -d= -f2)"
fi

echo "  Install directory : $INSTALL_DIR"
echo "  Database name     : $DB_NAME"
echo "  Database user     : $DB_USER"
echo ""

confirm "Proceed with uninstall?" || { info "Uninstall cancelled."; exit 0; }

# ── Stop and remove service ────────────────────────────────────────────────────
section "Removing service"
if systemctl is-active --quiet open-fiber-map 2>/dev/null; then
    systemctl stop open-fiber-map
    info "Service stopped."
fi
if systemctl is-enabled --quiet open-fiber-map 2>/dev/null; then
    systemctl disable open-fiber-map
fi
if [[ -f /etc/systemd/system/open-fiber-map.service ]]; then
    rm /etc/systemd/system/open-fiber-map.service
    systemctl daemon-reload
    info "Service removed."
fi

# ── Remove Apache config ───────────────────────────────────────────────────────
section "Removing Apache config"
if [[ -f /etc/apache2/sites-enabled/open-fiber-map.conf ]]; then
    a2dissite open-fiber-map >/dev/null 2>&1 || true
fi
if [[ -f /etc/apache2/sites-available/open-fiber-map.conf ]]; then
    rm /etc/apache2/sites-available/open-fiber-map.conf
    systemctl reload apache2 2>/dev/null || true
    info "Apache config removed."
fi

# ── Remove application files ───────────────────────────────────────────────────
section "Removing application files"
if [[ -d "$INSTALL_DIR" ]]; then
    if confirm "Delete application directory '$INSTALL_DIR'?"; then
        rm -rf "$INSTALL_DIR"
        info "Application files removed."
    else
        info "Skipped removing $INSTALL_DIR"
    fi
fi

# ── Drop database ──────────────────────────────────────────────────────────────
section "Removing database"
warn "This will permanently delete the database '$DB_NAME' and all fiber map data."
if confirm "Drop database '$DB_NAME' and user '$DB_USER'?"; then
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null 2>&1 && info "Database '$DB_NAME' dropped."
    sudo -u postgres psql -c "DROP ROLE IF EXISTS \"$DB_USER\";" >/dev/null 2>&1 && info "User '$DB_USER' dropped."
else
    info "Skipped database removal."
fi

section "Uninstall complete"
echo ""
info "Open Fiber Map has been removed."
echo ""
