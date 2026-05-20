# Open Fiber Map

A self-hosted fiber network mapping application. Track fiber routes, closures, poles, splices, equipment, and patch panel connections on an interactive map.

**Tech stack:** Node.js · Express · PostgreSQL + PostGIS · Apache · Leaflet

---

## Features

- Interactive map (Leaflet) with fiber routes, closures, poles, and sites
- Full fiber path tracing — cables, splices, splitters
- Equipment and port inventory with SFP/card templates
- Patch panel and connection management
- Real-time multi-user sync via Server-Sent Events (PostgreSQL LISTEN/NOTIFY)
- Role-based access (admin / user)
- Custom fields on any entity type
- Layer groups for organizing map elements
- KML/KMZ import

---

## Requirements

- **OS:** Debian 12+ or Ubuntu 22.04+
- **Access:** root or sudo
- **Ports:** 80 (HTTP), 5432 (PostgreSQL — local only by default)

The installer handles all other dependencies (Node.js 20, PostgreSQL 16, PostGIS, Apache).

---

## Quick Install

```bash
git clone https://github.com/your-org/open-fiber-map.git
cd open-fiber-map
sudo bash install.sh
```

The installer will prompt you for:
- Install directory (default: `/opt/open-fiber-map`)
- Database name, user, and password
- Application port (default: `3000`)
- Server hostname (optional — leave blank for catch-all)
- Admin username and password

At the end it prints the URL to access the application.

---

## Post-Install

### Access the UI

Open `http://<your-server-ip>/` (or the hostname you configured) in a browser and log in with the admin credentials you set during install.

### Add more users

```bash
cd /opt/open-fiber-map/backend
node create-admin.js <username> <password>
```

Users created this way get the `admin` role. To create a regular user, edit `create-admin.js` or use the admin panel in the UI.

### Service management

```bash
systemctl status open-fiber-map      # check status
systemctl restart open-fiber-map     # restart backend
journalctl -u open-fiber-map -f      # tail logs
```

---

## Upgrading

```bash
cd /path/to/open-fiber-map   # your git clone
git pull
sudo rsync -a --exclude='backend/.env' --exclude='backend/node_modules' \
    --exclude='.git' ./ /opt/open-fiber-map/
cd /opt/open-fiber-map/backend
sudo npm install --omit=dev
sudo systemctl restart open-fiber-map
```

If the release notes mention schema changes, run the provided migration SQL before restarting.

---

## Uninstall

```bash
sudo bash uninstall.sh
```

The uninstaller will ask before deleting the application directory and before dropping the database.

---

## Configuration Reference

All configuration is in `/opt/open-fiber-map/backend/.env`:

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `fibermap` | Database name |
| `DB_USER` | `fiberadmin` | Database user |
| `DB_PASSWORD` | *(set during install)* | Database password |
| `SESSION_SECRET` | *(auto-generated)* | Express session signing key — keep secret |
| `PORT` | `3000` | Port the Node.js backend listens on |

After editing `.env`, restart the service:

```bash
systemctl restart open-fiber-map
```

---

## Development Setup

To run locally without `install.sh`:

**Prerequisites:** Node.js 20+, PostgreSQL 16 with PostGIS

```bash
# 1. Create database
createdb fibermap
psql fibermap < schema.sql

# 2. Configure backend
cp .env.example backend/.env
# Edit backend/.env with your local DB credentials and a random SESSION_SECRET

# 3. Install dependencies and start
cd backend
npm install
node server.js
```

The backend runs on `http://localhost:3000`. Open `frontend/index.html` in a browser or point Apache/nginx at the `frontend/` directory.

---

## License

MIT
