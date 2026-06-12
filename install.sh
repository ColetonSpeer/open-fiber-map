#!/usr/bin/env bash
set -euo pipefail

# Open Fiber Map — installer
# Supports: Debian 12+, Ubuntu 22.04+
# Run as root or with sudo

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}==> $*${NC}"; }

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Please run as root: sudo bash install.sh"

# ── OS check ──────────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
    error "Cannot detect OS. This installer supports Debian 12+ and Ubuntu 22.04+."
fi
source /etc/os-release
if [[ "$ID" != "debian" && "$ID" != "ubuntu" && "$ID_LIKE" != *"debian"* ]]; then
    error "Unsupported OS: $PRETTY_NAME. This installer supports Debian/Ubuntu only."
fi
info "Detected OS: $PRETTY_NAME"

# ── Source directory ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Interactive prompts ────────────────────────────────────────────────────────
section "Configuration"
echo "Press Enter to accept the default shown in brackets."
echo ""

read -rp "Install directory [/opt/open-fiber-map]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-/opt/open-fiber-map}"

read -rp "PostgreSQL database name [fibermap]: " DB_NAME
DB_NAME="${DB_NAME:-fibermap}"

read -rp "PostgreSQL database user [fiberadmin]: " DB_USER
DB_USER="${DB_USER:-fiberadmin}"

while true; do
    read -rsp "PostgreSQL database password (required): " DB_PASSWORD
    echo ""
    [[ -n "$DB_PASSWORD" ]] && break
    warn "Password cannot be empty."
done

read -rp "Application port [3000]: " APP_PORT
APP_PORT="${APP_PORT:-3000}"

echo ""
echo "Server hostname for Apache (e.g. fiber.example.com)."
echo "Leave blank to accept requests on any hostname (catch-all)."
read -rp "Server hostname [blank = catch-all]: " SERVER_NAME

echo ""
echo "Create the first admin user:"
read -rp "  Admin username [admin]: " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"

while true; do
    read -rsp "  Admin password (required): " ADMIN_PASS
    echo ""
    [[ -n "$ADMIN_PASS" ]] && break
    warn "Admin password cannot be empty."
done

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
section "Install summary"
echo "  Install directory : $INSTALL_DIR"
echo "  Database name     : $DB_NAME"
echo "  Database user     : $DB_USER"
echo "  App port          : $APP_PORT"
echo "  Server hostname   : ${SERVER_NAME:-<catch-all>}"
echo "  Admin username    : $ADMIN_USER"
echo ""
read -rp "Proceed with installation? [y/N]: " CONFIRM
[[ "${CONFIRM,,}" == "y" || "${CONFIRM,,}" == "yes" ]] || { info "Installation cancelled."; exit 0; }

# ── Install system packages ────────────────────────────────────────────────────
section "Installing system packages"
apt-get update -qq

# Node.js 20.x via NodeSource
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
    info "Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
else
    info "Node.js $(node --version) already installed."
fi

# PostgreSQL 16
if ! command -v psql &>/dev/null; then
    info "Installing PostgreSQL 16..."
    apt-get install -y postgresql postgresql-contrib postgis >/dev/null 2>&1
else
    info "PostgreSQL $(psql --version | awk '{print $3}') already installed."
    apt-get install -y postgis >/dev/null 2>&1
fi

# Apache2
if ! command -v apache2 &>/dev/null; then
    info "Installing Apache2..."
    apt-get install -y apache2 >/dev/null 2>&1
else
    info "Apache2 already installed."
fi

# Ensure services are running
systemctl enable --now postgresql >/dev/null 2>&1
systemctl enable --now apache2 >/dev/null 2>&1

# ── Enable Apache modules ──────────────────────────────────────────────────────
section "Enabling Apache modules"
a2enmod proxy proxy_http rewrite headers >/dev/null 2>&1
info "Modules enabled: proxy proxy_http rewrite headers"

# ── Set up PostgreSQL database ─────────────────────────────────────────────────
section "Setting up PostgreSQL"

# Create role if it doesn't exist
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    info "Database user '$DB_USER' already exists — updating password."
    sudo -u postgres psql -c "ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASSWORD';" >/dev/null
else
    info "Creating database user '$DB_USER'..."
    sudo -u postgres psql -c "CREATE ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASSWORD';" >/dev/null
fi

# Create database if it doesn't exist
if sudo -u postgres psql -lqt | cut -d\| -f1 | grep -qw "$DB_NAME"; then
    warn "Database '$DB_NAME' already exists — skipping schema import."
    DB_EXISTS=1
else
    info "Creating database '$DB_NAME'..."
    sudo -u postgres psql -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" >/dev/null
    DB_EXISTS=0
fi

if [[ $DB_EXISTS -eq 0 ]]; then
    info "Importing schema..."
    sudo -u postgres psql "$DB_NAME" < "$SCRIPT_DIR/schema.sql" >/dev/null 2>&1
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$DB_USER\";" >/dev/null
    sudo -u postgres psql "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\";" >/dev/null
    sudo -u postgres psql "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"$DB_USER\";" >/dev/null
    sudo -u postgres psql "$DB_NAME" -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";" >/dev/null
    info "Schema imported successfully."
fi

# ── Copy application files ─────────────────────────────────────────────────────
section "Installing application files"
info "Copying files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
rsync -a --exclude='backend/.env' --exclude='backend/node_modules' --exclude='.git' \
      --exclude='.claude' --exclude='config' --exclude='install.sh' --exclude='uninstall.sh' \
      "$SCRIPT_DIR/" "$INSTALL_DIR/"

# ── Write .env ─────────────────────────────────────────────────────────────────
section "Writing configuration"
SESSION_SECRET="$(openssl rand -hex 32)"
cat > "$INSTALL_DIR/backend/.env" <<EOF
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
SESSION_SECRET=$SESSION_SECRET
PORT=$APP_PORT
EOF
chmod 600 "$INSTALL_DIR/backend/.env"
info ".env written with generated session secret."

# ── Install Node dependencies ──────────────────────────────────────────────────
section "Installing Node.js dependencies"
cd "$INSTALL_DIR/backend"
npm install --omit=dev --silent
info "Dependencies installed."

# ── Set file permissions ───────────────────────────────────────────────────────
chown -R www-data:www-data "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/backend/.env"

# ── Install Apache config ──────────────────────────────────────────────────────
section "Configuring Apache"
APACHE_CONF=/etc/apache2/sites-available/open-fiber-map.conf

sed "s|INSTALL_DIR|$INSTALL_DIR|g; s|APP_PORT|$APP_PORT|g" \
    "$SCRIPT_DIR/config/open-fiber-map.conf" > "$APACHE_CONF"

if [[ -n "$SERVER_NAME" ]]; then
    sed -i "s|SERVER_NAME|$SERVER_NAME|g" "$APACHE_CONF"
else
    # Remove the ServerName line entirely for a catch-all VirtualHost
    sed -i '/ServerName SERVER_NAME/d' "$APACHE_CONF"
fi

a2ensite open-fiber-map >/dev/null 2>&1
a2dissite 000-default >/dev/null 2>&1 || true
apache2ctl configtest
systemctl reload apache2
info "Apache configured and reloaded."

# ── Install systemd service ────────────────────────────────────────────────────
section "Installing systemd service"
sed "s|INSTALL_DIR|$INSTALL_DIR|g" \
    "$SCRIPT_DIR/config/open-fiber-map.service" \
    > /etc/systemd/system/open-fiber-map.service

systemctl daemon-reload
systemctl enable open-fiber-map
systemctl restart open-fiber-map
info "Service installed and started."

# ── Create admin user ──────────────────────────────────────────────────────────
section "Creating admin user"
cd "$INSTALL_DIR/backend"
node create-admin.js "$ADMIN_USER" "$ADMIN_PASS"
info "Admin user '$ADMIN_USER' created."

# ── Done ───────────────────────────────────────────────────────────────────────
section "Installation complete"
if [[ -n "$SERVER_NAME" ]]; then
    ACCESS_URL="http://$SERVER_NAME"
else
    IP=$(hostname -I | awk '{print $1}')
    ACCESS_URL="http://$IP"
fi

echo ""
echo -e "${GREEN}Open Fiber Map is running!${NC}"
echo ""
echo "  Access URL : $ACCESS_URL"
echo "  Admin user : $ADMIN_USER"
echo ""
echo "Service management:"
echo "  systemctl status open-fiber-map"
echo "  systemctl restart open-fiber-map"
echo "  journalctl -u open-fiber-map -f"
echo ""
echo "To add more users:"
echo "  cd $INSTALL_DIR/backend && node create-admin.js <username> <password>"
echo ""
