// Open Fiber Map - Backend
// Express server with PostgreSQL/PostGIS, sessions, and auth

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ============ REAL-TIME SYNC (PostgreSQL LISTEN/NOTIFY → SSE + polling) ============

const sseClients = new Set();

// Tracks last-change timestamp per table — used by the polling endpoint
const lastChanged = { closures: Date.now(), poles: Date.now(), routes: Date.now(), sites: Date.now(), layer_groups: Date.now(), layers: Date.now() };

function setupDbListener() {
  const { Client } = require('pg');
  const listenClient = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  listenClient.connect()
    .then(() => listenClient.query('LISTEN map_changes'))
    .then(() => console.log('Listening for DB changes on map_changes'))
    .catch(err => {
      console.error('DB listen connect error:', err.message);
      setTimeout(setupDbListener, 5000);
    });

  listenClient.on('notification', (msg) => {
    try {
      const { table } = JSON.parse(msg.payload);
      if (lastChanged[table] !== undefined) lastChanged[table] = Date.now();
    } catch (_) {}
    for (const res of sseClients) {
      try { res.write(`data: ${msg.payload}\n\n`); }
      catch (_) { sseClients.delete(res); }
    }
  });

  listenClient.on('error', (err) => {
    console.error('DB listen client error:', err.message);
    setTimeout(setupDbListener, 5000);
  });

  listenClient.on('end', () => {
    setTimeout(setupDbListener, 5000);
  });
}

setupDbListener();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

// Session storage in PostgreSQL
app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: false
  }
}));

// Static files (frontend)
app.use(express.static(path.join(__dirname, '../frontend')));

// ============ AUTH MIDDLEWARE ============

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ============ AUTH ENDPOINTS ============

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ id: user.id, username: user.username, fullName: user.full_name, role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role
  });
});

// ============ CLOSURES ============

app.get('/api/closures', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, notes, pole_id, layer_id, ST_AsGeoJSON(geom) as geom, created_at, updated_at
      FROM closures ORDER BY id
    `);
    res.json(result.rows.map(r => ({
      ...r,
      geom: JSON.parse(r.geom)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/closures', requireAuth, async (req, res) => {
  try {
    const { name, notes, lat, lng, pole_id, layer_id } = req.body;
    const layerId = layer_id || (await getDefaultLayerId());
    const result = await pool.query(`
      INSERT INTO closures (name, notes, geom, created_by, pole_id, layer_id)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7)
      RETURNING id, name, notes, pole_id, layer_id, ST_AsGeoJSON(geom) as geom
    `, [name, notes || null, lng, lat, req.session.userId, pole_id || null, layerId || null]);
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/closures/:id', requireAuth, async (req, res) => {
  try {
    const { name, notes, lat, lng } = req.body;
    const updatePoleId = 'pole_id' in req.body;
    let query, params;
    if (updatePoleId) {
      query = `UPDATE closures SET name=$1, notes=$2, geom=ST_SetSRID(ST_MakePoint($3,$4),4326), pole_id=$5, updated_at=NOW() WHERE id=$6 RETURNING id, name, notes, pole_id, ST_AsGeoJSON(geom) as geom`;
      params = [name, notes || null, lng, lat, req.body.pole_id || null, req.params.id];
    } else {
      query = `UPDATE closures SET name=$1, notes=$2, geom=ST_SetSRID(ST_MakePoint($3,$4),4326), updated_at=NOW() WHERE id=$5 RETURNING id, name, notes, pole_id, ST_AsGeoJSON(geom) as geom`;
      params = [name, notes || null, lng, lat, req.params.id];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/closures/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM closures WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ POLES ============

app.get('/api/poles', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, notes, layer_id, ST_AsGeoJSON(geom) as geom
      FROM poles ORDER BY id
    `);
    res.json(result.rows.map(r => ({ ...r, geom: JSON.parse(r.geom) })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/poles', requireAuth, async (req, res) => {
  try {
    const { name, notes, lat, lng, layer_id } = req.body;
    const layerId = layer_id || (await getDefaultLayerId());
    const result = await pool.query(`
      INSERT INTO poles (name, notes, geom, created_by, layer_id)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6)
      RETURNING id, name, notes, layer_id, ST_AsGeoJSON(geom) as geom
    `, [name, notes || null, lng, lat, req.session.userId, layerId || null]);
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/poles/:id', requireAuth, async (req, res) => {
  try {
    const { name, notes, lat, lng } = req.body;
    let query, params;
    if (lat !== undefined && lng !== undefined) {
      query = 'UPDATE poles SET name=$1, notes=$2, geom=ST_SetSRID(ST_MakePoint($3,$4),4326) WHERE id=$5 RETURNING id, name, notes, layer_id, ST_AsGeoJSON(geom) as geom';
      params = [name, notes || null, lng, lat, req.params.id];
    } else {
      query = 'UPDATE poles SET name=$1, notes=$2 WHERE id=$3 RETURNING id, name, notes, layer_id, ST_AsGeoJSON(geom) as geom';
      params = [name, notes || null, req.params.id];
    }
    const result = await pool.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/poles/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM poles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ROUTES ============

app.get('/api/routes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, notes, color, fiber_count, attached_poles, attached_sites, layer_id, ST_AsGeoJSON(geom) as geom
      FROM routes ORDER BY id
    `);
    res.json(result.rows.map(r => ({ ...r, geom: JSON.parse(r.geom) })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/routes', requireAuth, async (req, res) => {
  try {
    const { name, notes, points, fiber_count, color, attached_poles, attached_sites, layer_id } = req.body;
    const layerId = layer_id || (await getDefaultLayerId());
    const wkt = `LINESTRING(${points.map(p => `${p[0]} ${p[1]}`).join(',')})`;
    const result = await pool.query(`
      INSERT INTO routes (name, notes, geom, created_by, fiber_count, color, attached_poles, attached_sites, layer_id)
      VALUES ($1, $2, ST_GeomFromText($3, 4326), $4, $5, $6, $7, $8, $9)
      RETURNING id, name, notes, color, fiber_count, attached_poles, attached_sites, layer_id, ST_AsGeoJSON(geom) as geom
    `, [name, notes || null, wkt, req.session.userId, fiber_count || 12, color || '#FF8800', attached_poles || [], attached_sites || [], layerId || null]);
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/routes/:id', requireAuth, async (req, res) => {
  try {
    const { name, notes, fiber_count, color, attached_poles, points } = req.body;
    let query, params;
    if (points && points.length >= 2) {
      const wkt = `LINESTRING(${points.map(p => `${p[0]} ${p[1]}`).join(',')})`;
      query = `UPDATE routes SET name=$1, notes=$2, fiber_count=$3, color=$4, attached_poles=$5, geom=ST_GeomFromText($6,4326) WHERE id=$7 RETURNING id, name, notes, color, fiber_count, attached_poles, attached_sites, layer_id, ST_AsGeoJSON(geom) as geom`;
      params = [name, notes || null, fiber_count || 12, color || '#FF8800', attached_poles || [], wkt, req.params.id];
    } else {
      query = `UPDATE routes SET name=$1, notes=$2, fiber_count=$3, color=$4, attached_poles=$5 WHERE id=$6 RETURNING id, name, notes, color, fiber_count, attached_poles, attached_sites, ST_AsGeoJSON(geom) as geom`;
      params = [name, notes || null, fiber_count || 12, color || '#FF8800', attached_poles || [], req.params.id];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    res.json({ ...row, geom: JSON.parse(row.geom) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/routes/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cables WHERE route_id = $1', [req.params.id]);
    await pool.query('DELETE FROM routes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ CABLES ============

app.get('/api/closures/:id/cables', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cables WHERE closure_id = $1 ORDER BY id',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/closures/:id/cables', requireAuth, async (req, res) => {
  try {
    const { name, fiber_count, direction, notes, route_id, link_closure_id } = req.body;
    const result = await pool.query(`
      INSERT INTO cables (closure_id, name, fiber_count, direction, notes, route_id, link_closure_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [req.params.id, name, fiber_count, direction, notes || null, route_id || null, link_closure_id || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cables/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM cables WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SPLICES ============

app.get('/api/closures/:id/splices', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM splices WHERE closure_id = $1',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/splices', requireAuth, async (req, res) => {
  try {
    const { closure_id, from_cable_id, from_fiber, to_cable_id, to_fiber, splice_type, notes } = req.body;
    const result = await pool.query(`
      INSERT INTO splices (closure_id, from_cable_id, from_fiber, to_cable_id, to_fiber, splice_type, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [closure_id, from_cable_id, from_fiber, to_cable_id, to_fiber, splice_type || 'fusion', notes || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/splices/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM splices WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SPLITTERS & TAPS ============
// A splitter has one input fiber and N output legs. Balanced splitters divide
// power equally (1:N); taps (FBT) divide it unevenly by percentage per leg.
// Fiber numbers here follow the closure UI's 0-based convention, like splices.

// Builds the output-leg rows for a splitter from a high-level spec.
function buildSplitterLegs({ splitter_type, ratio, excess_loss_db, outputs }) {
  if (splitter_type === 'tap') {
    return (outputs || []).map((o, i) => ({
      leg_index: i + 1,
      label: o.label || (i === 0 ? 'tap' : 'pass'),
      output_cable_id: o.output_cable_id ?? null,
      output_fiber: o.output_fiber ?? null,
      tap_percent: o.tap_percent ?? null,
      loss_db: o.loss_db != null ? +o.loss_db
        : (o.tap_percent != null ? tapLegLoss(o.tap_percent, excess_loss_db) : null),
    }));
  }
  // balanced: N legs derived from ratio like "1:8"
  const n = parseInt(String(ratio).split(':')[1], 10) || (outputs ? outputs.length : 2);
  const legLoss = balancedLegLoss(n, excess_loss_db);
  return Array.from({ length: n }, (_, i) => {
    const o = (outputs && outputs[i]) || {};
    return {
      leg_index: i + 1,
      label: o.label || String(i + 1),
      output_cable_id: o.output_cable_id ?? null,
      output_fiber: o.output_fiber ?? null,
      tap_percent: null,
      loss_db: o.loss_db != null ? +o.loss_db : legLoss,
    };
  });
}

async function loadSplitters(closureId) {
  const sR = await pool.query('SELECT * FROM splitters WHERE closure_id=$1 ORDER BY id', [closureId]);
  if (!sR.rows.length) return [];
  const oR = await pool.query(
    'SELECT * FROM splitter_outputs WHERE splitter_id = ANY($1) ORDER BY leg_index',
    [sR.rows.map(s => s.id)]
  );
  const byId = new Map(sR.rows.map(s => [s.id, { ...s, outputs: [] }]));
  oR.rows.forEach(o => byId.get(o.splitter_id)?.outputs.push(o));
  return [...byId.values()];
}

app.get('/api/closures/:id/splitters', requireAuth, async (req, res) => {
  try {
    res.json(await loadSplitters(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/splitters', requireAuth, async (req, res) => {
  const { closure_id, name, splitter_type, ratio, excess_loss_db,
          input_cable_id, input_fiber, outputs } = req.body;
  if (!closure_id || !name) return res.status(400).json({ error: 'closure_id and name required' });
  const type = splitter_type === 'tap' ? 'tap' : 'balanced';
  const legs = buildSplitterLegs({ splitter_type: type, ratio, excess_loss_db, outputs });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sR = await client.query(
      `INSERT INTO splitters (closure_id, name, ratio, splitter_type, excess_loss_db, input_cable_id, input_fiber)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [closure_id, name, ratio || (type === 'tap' ? 'tap' : '1:2'), type,
       excess_loss_db || 0, input_cable_id || null, input_fiber ?? null]
    );
    const splitter = sR.rows[0];
    for (const leg of legs) {
      await client.query(
        `INSERT INTO splitter_outputs (splitter_id, leg_index, label, output_cable_id, output_fiber, tap_percent, loss_db)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [splitter.id, leg.leg_index, leg.label, leg.output_cable_id, leg.output_fiber, leg.tap_percent, leg.loss_db]
      );
    }
    await client.query('COMMIT');
    const all = await loadSplitters(closure_id);
    res.json(all.find(s => s.id === splitter.id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// Replace a splitter's outputs (used to assign fibers/loss after creation)
app.put('/api/splitters/:id', requireAuth, async (req, res) => {
  const { name, excess_loss_db, input_cable_id, input_fiber, outputs } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM splitters WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const s = cur.rows[0];
    await client.query(
      `UPDATE splitters SET name=$2, excess_loss_db=$3, input_cable_id=$4, input_fiber=$5 WHERE id=$1`,
      [s.id, name ?? s.name, excess_loss_db ?? s.excess_loss_db,
       input_cable_id !== undefined ? input_cable_id : s.input_cable_id,
       input_fiber !== undefined ? input_fiber : s.input_fiber]
    );
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        await client.query(
          `UPDATE splitter_outputs SET output_cable_id=$2, output_fiber=$3, tap_percent=$4, loss_db=$5, label=COALESCE($6,label)
           WHERE splitter_id=$1 AND leg_index=$7`,
          [s.id, o.output_cable_id ?? null, o.output_fiber ?? null,
           o.tap_percent ?? null, o.loss_db ?? null, o.label ?? null, o.leg_index]
        );
      }
    }
    await client.query('COMMIT');
    res.json((await loadSplitters(s.closure_id)).find(x => x.id === s.id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

app.delete('/api/splitters/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM splitters WHERE id=$1', [req.params.id]); // cascades outputs
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ============ CUSTOM FIELDS ============

app.get('/api/field-defs', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM custom_field_defs ORDER BY entity_type, sort_order, id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/field-defs', requireAdmin, async (req, res) => {
  try {
    const { entity_type, field_label, field_type, options } = req.body;
    if (!entity_type || !field_label) return res.status(400).json({ error: 'entity_type and field_label required' });
    const result = await pool.query(
      'INSERT INTO custom_field_defs (entity_type, field_label, field_type, options) VALUES ($1,$2,$3,$4) RETURNING *',
      [entity_type, field_label, field_type || 'text', options && options.length ? options : null]
    );
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/field-defs/:id', requireAdmin, async (req, res) => {
  try {
    const { field_label, options, show_on_create } = req.body;
    const result = await pool.query(
      'UPDATE custom_field_defs SET field_label=$1, options=$2, show_on_create=$3 WHERE id=$4 RETURNING *',
      [field_label, options && options.length ? options : null, show_on_create ?? false, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/field-defs/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM custom_field_defs WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/connector-types', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT name, enabled FROM connector_types ORDER BY sort_order');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/connector-types', requireAdmin, async (req, res) => {
  try {
    const { name, enabled } = req.body;
    const r = await pool.query(
      'UPDATE connector_types SET enabled=$1 WHERE name=$2 RETURNING name, enabled',
      [enabled, name]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── SFP types ──────────────────────────────────────────────────────────────

app.get('/api/sfp-types', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM sfp_types ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sfp-types', requireAdmin, async (req, res) => {
  try {
    const { name, port_configs, notes, compatible_port_types } = req.body;
    if (!name || !Array.isArray(port_configs)) return res.status(400).json({ error: 'name and port_configs required' });
    const compat = Array.isArray(compatible_port_types) ? compatible_port_types : [];
    const r = await pool.query(
      'INSERT INTO sfp_types (name,port_configs,notes,compatible_port_types) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, JSON.stringify(port_configs), notes || null, JSON.stringify(compat)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SFP type name already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/sfp-types/:id', requireAdmin, async (req, res) => {
  try {
    const { name, port_configs, notes, compatible_port_types } = req.body;
    if (!name || !Array.isArray(port_configs)) return res.status(400).json({ error: 'name and port_configs required' });
    const compat = Array.isArray(compatible_port_types) ? compatible_port_types : [];
    const r = await pool.query(
      'UPDATE sfp_types SET name=$1,port_configs=$2,notes=$3,compatible_port_types=$4 WHERE id=$5 RETURNING *',
      [name, JSON.stringify(port_configs), notes || null, JSON.stringify(compat), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SFP type name already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/sfp-types/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM sfp_types WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Card types ──────────────────────────────────────────────────────────────

app.get('/api/card-types', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM card_types ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/card-types', requireAdmin, async (req, res) => {
  try {
    const { name, port_groups, notes } = req.body;
    if (!name || !Array.isArray(port_groups)) return res.status(400).json({ error: 'name and port_groups required' });
    const r = await pool.query(
      'INSERT INTO card_types (name,port_groups,notes) VALUES ($1,$2,$3) RETURNING *',
      [name, JSON.stringify(port_groups), notes || null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Card type name already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/card-types/:id', requireAdmin, async (req, res) => {
  try {
    const { name, port_groups, notes } = req.body;
    if (!name || !Array.isArray(port_groups)) return res.status(400).json({ error: 'name and port_groups required' });
    const r = await pool.query(
      'UPDATE card_types SET name=$1,port_groups=$2,notes=$3 WHERE id=$4 RETURNING *',
      [name, JSON.stringify(port_groups), notes || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Card type name already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/card-types/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM card_types WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Equipment templates ─────────────────────────────────────────────────────

app.get('/api/equipment-templates', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM equipment_templates ORDER BY equipment_type, name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/equipment-templates', requireAdmin, async (req, res) => {
  try {
    const { name, equipment_type, port_groups,
            fixed_port_count, fixed_port_prefix, fixed_port_type,
            fixed_connector_type, sfp_slot_count, sfp_slot_prefix,
            card_slot_count, card_slot_prefix_pattern } = req.body;
    if (!name || !equipment_type) return res.status(400).json({ error: 'name and equipment_type required' });
    const r = await pool.query(
      `INSERT INTO equipment_templates
         (name,equipment_type,port_groups,fixed_port_count,fixed_port_prefix,fixed_port_type,
          fixed_connector_type,sfp_slot_count,sfp_slot_prefix,card_slot_count,card_slot_prefix_pattern)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, equipment_type,
       port_groups ? JSON.stringify(port_groups) : null,
       fixed_port_count||null, fixed_port_prefix||null,
       fixed_port_type||'optical', fixed_connector_type||null,
       sfp_slot_count||null, sfp_slot_prefix||'Card',
       card_slot_count||null, card_slot_prefix_pattern||null]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/equipment-templates/:id', requireAdmin, async (req, res) => {
  try {
    const { name, equipment_type, port_groups,
            fixed_port_count, fixed_port_prefix, fixed_port_type,
            fixed_connector_type, sfp_slot_count, sfp_slot_prefix,
            card_slot_count, card_slot_prefix_pattern } = req.body;
    if (!name || !equipment_type) return res.status(400).json({ error: 'name and equipment_type required' });
    const r = await pool.query(
      `UPDATE equipment_templates SET
         name=$1,equipment_type=$2,port_groups=$3,fixed_port_count=$4,fixed_port_prefix=$5,
         fixed_port_type=$6,fixed_connector_type=$7,sfp_slot_count=$8,sfp_slot_prefix=$9,
         card_slot_count=$10,card_slot_prefix_pattern=$11
       WHERE id=$12 RETURNING *`,
      [name, equipment_type,
       port_groups ? JSON.stringify(port_groups) : null,
       fixed_port_count||null, fixed_port_prefix||null,
       fixed_port_type||'optical', fixed_connector_type||null,
       sfp_slot_count||null, sfp_slot_prefix||'Card',
       card_slot_count||null, card_slot_prefix_pattern||null,
       req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/equipment-templates/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM equipment_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Equipment ──────────────────────────────────────────────────────────────

app.get('/api/sites/:id/equipment', requireAuth, async (req, res) => {
  try {
    const siteId = req.params.id;
    const equipRes = await pool.query(
      'SELECT * FROM equipment WHERE site_id=$1 ORDER BY created_at', [siteId]
    );
    const portRes = await pool.query(
      `SELECT ep.* FROM equipment_ports ep
       JOIN equipment e ON e.id = ep.equipment_id
       WHERE e.site_id=$1 ORDER BY ep.equipment_id, ep.port_order, ep.port_label`,
      [siteId]
    );
    const connRes = await pool.query(
      `SELECT c.*,
        ea.name AS a_equip_name, epa.port_label AS a_port_label,
        eb.name AS b_equip_name, epb.port_label AS b_port_label,
        ppa.name AS a_panel_name, ra.name AS a_route_name, ra.fiber_count AS a_fiber_count,
        ppb.name AS b_panel_name, rb.name AS b_route_name, rb.fiber_count AS b_fiber_count
       FROM connections c
       LEFT JOIN equipment_ports epa ON epa.id = c.a_port_id
       LEFT JOIN equipment ea ON ea.id = epa.equipment_id
       LEFT JOIN equipment_ports epb ON epb.id = c.b_port_id
       LEFT JOIN equipment eb ON eb.id = epb.equipment_id
       LEFT JOIN panel_fibers pfa ON pfa.id = c.a_panel_fiber_id
       LEFT JOIN patch_panels ppa ON ppa.id = pfa.panel_id
       LEFT JOIN routes ra ON ra.id = pfa.route_id
       LEFT JOIN panel_fibers pfb ON pfb.id = c.b_panel_fiber_id
       LEFT JOIN patch_panels ppb ON ppb.id = pfb.panel_id
       LEFT JOIN routes rb ON rb.id = pfb.route_id
       WHERE ea.site_id=$1 OR eb.site_id=$1 OR ppa.site_id=$1 OR ppb.site_id=$1`,
      [siteId]
    );

    const connByPort = {};
    const addConn = (portId, side, row) => {
      if (!connByPort[portId]) connByPort[portId] = [];
      connByPort[portId].push({ side, row });
    };
    for (const c of connRes.rows) {
      if (c.a_port_id) addConn(c.a_port_id, 'a', c);
      if (c.b_port_id) addConn(c.b_port_id, 'b', c);
    }

    const portsByEquip = {};
    for (const p of portRes.rows) {
      if (!portsByEquip[p.equipment_id]) portsByEquip[p.equipment_id] = [];
      const connections = (connByPort[p.id] || []).map(info => {
        const c = info.row;
        const o = info.side === 'a' ? 'b' : 'a';
        return {
          id: c.id,
          pair_id: c.pair_id,
          other_type: c[`${o}_port_id`] ? 'equipment_port' : 'panel_strand',
          other_port_id: c[`${o}_port_id`],
          other_port_label: c[`${o}_port_label`],
          other_equipment_name: c[`${o}_equip_name`],
          other_panel_fiber_id: c[`${o}_panel_fiber_id`],
          other_strand: c[`${o}_strand`],
          other_panel_name: c[`${o}_panel_name`],
          other_route_name: c[`${o}_route_name`],
        };
      });
      portsByEquip[p.equipment_id].push({ ...p, connections });
    }

    // Attach sfp_assignments to each equipment item
    const sfpAssignRes = await pool.query(
      `SELECT esa.*, st.name AS sfp_name, st.port_configs
       FROM equipment_sfp_assignments esa
       JOIN sfp_types st ON st.id = esa.sfp_type_id
       JOIN equipment e ON e.id = esa.equipment_id
       WHERE e.site_id=$1 ORDER BY esa.equipment_id, esa.slot_number`,
      [siteId]
    );
    const sfpByEquip = {};
    sfpAssignRes.rows.forEach(a => {
      if (!sfpByEquip[a.equipment_id]) sfpByEquip[a.equipment_id] = [];
      sfpByEquip[a.equipment_id].push(a);
    });

    // Attach card_assignments to each equipment item
    const cardAssignRes = await pool.query(
      `SELECT eca.*, ct.name AS card_name, ct.port_groups AS card_port_groups
       FROM equipment_card_assignments eca
       JOIN card_types ct ON ct.id = eca.card_type_id
       JOIN equipment e ON e.id = eca.equipment_id
       WHERE e.site_id=$1 ORDER BY eca.equipment_id, eca.card_slot`,
      [siteId]
    );
    const cardsByEquip = {};
    cardAssignRes.rows.forEach(ca => {
      if (!cardsByEquip[ca.equipment_id]) cardsByEquip[ca.equipment_id] = [];
      cardsByEquip[ca.equipment_id].push(ca);
    });

    res.json(equipRes.rows.map(e => ({
      ...e,
      ports: portsByEquip[e.id] || [],
      sfp_assignments: sfpByEquip[e.id] || [],
      card_assignments: cardsByEquip[e.id] || [],
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sites/:id/equipment', requireAuth, async (req, res) => {
  try {
    const { name, template_id, notes, sfp_assignments, port_prefix, card_assignments } = req.body;
    let equipment_type = req.body.equipment_type;
    let model = req.body.model;
    let template = null;

    if (template_id) {
      const tr = await pool.query('SELECT * FROM equipment_templates WHERE id=$1', [template_id]);
      template = tr.rows[0];
      if (template) { equipment_type = template.equipment_type; model = template.name; }
    }
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!equipment_type) return res.status(400).json({ error: 'equipment_type required' });

    const r = await pool.query(
      'INSERT INTO equipment (site_id,name,equipment_type,model,notes,template_id,port_prefix) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.params.id, name, equipment_type, model||null, notes||null, template_id||null, port_prefix||'']
    );
    const eq = r.rows[0];
    const ports = [];
    let globalOrder = 0;

    if (template && template.card_slot_count) {
      // Chassis template path
      const instancePrefix = eq.port_prefix || '';
      // Static fixed ports defined directly on the chassis template
      if (template.port_groups) {
        for (const group of template.port_groups) {
          if (group.kind !== 'fixed') continue;
          const pfx = instancePrefix + (group.label_prefix || group.id || '');
          for (let n = 1; n <= group.count; n++) {
            globalOrder++;
            const pr = await pool.query(
              `INSERT INTO equipment_ports
                 (equipment_id,port_label,connector_type,port_order,port_type,port_group_id)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
              [eq.id, `${pfx}${n}`, group.connector_type||null, globalOrder, group.port_type||null, group.id]
            );
            ports.push({ ...pr.rows[0], connections: [] });
          }
        }
      }
      // Card slot assignments
      for (const asgn of (card_assignments || [])) {
        const { card_slot, card_type_id } = asgn;
        if (!card_type_id) continue;
        const cardPrefix = (template.card_slot_prefix_pattern || '{n}/').replace('{n}', card_slot);
        const fullPrefix = instancePrefix + cardPrefix;
        const cardR = await pool.query('SELECT * FROM card_types WHERE id=$1', [card_type_id]);
        const cardType = cardR.rows[0];
        if (!cardType) continue;
        await pool.query(
          'INSERT INTO equipment_card_assignments (equipment_id,card_slot,card_type_id) VALUES ($1,$2,$3)',
          [eq.id, card_slot, card_type_id]
        );
        for (const group of cardType.port_groups) {
          const pfx = fullPrefix + (group.label_prefix || group.id || '');
          if (group.kind === 'fixed') {
            for (let n = 1; n <= group.count; n++) {
              globalOrder++;
              const pr = await pool.query(
                `INSERT INTO equipment_ports
                   (equipment_id,port_label,connector_type,port_order,port_type,port_group_id,card_slot)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [eq.id, `${pfx}${n}`, group.connector_type||null, globalOrder, group.port_type||null, group.id, card_slot]
              );
              ports.push({ ...pr.rows[0], connections: [] });
            }
          }
          // sfp_slot groups: ports created when SFPs are inserted via PUT /api/equipment/:id/sfp/:slot
        }
      }
    } else if (template && template.port_groups) {
      // Non-chassis port_groups path
      const instancePrefix = eq.port_prefix || '';
      for (const group of template.port_groups) {
        const pfx = instancePrefix + (group.label_prefix || group.id || '');
        if (group.kind === 'fixed') {
          for (let n = 1; n <= group.count; n++) {
            globalOrder++;
            const pr = await pool.query(
              `INSERT INTO equipment_ports
                 (equipment_id,port_label,connector_type,port_order,port_type,port_group_id)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
              [eq.id, `${pfx}${n}`, group.connector_type||null, globalOrder, group.port_type||null, group.id]
            );
            ports.push({ ...pr.rows[0], connections: [] });
          }
        } else {
          // sfp_slot group
          const groupAsgns = Array.isArray(sfp_assignments)
            ? sfp_assignments.filter(a => a.group_id === group.id)
            : [];
          for (let slot = 1; slot <= group.count; slot++) {
            const asgn = groupAsgns.find(a => a.slot_number === slot);
            if (!asgn?.sfp_type_id) continue;
            const sfpR = await pool.query('SELECT * FROM sfp_types WHERE id=$1', [asgn.sfp_type_id]);
            const sfp = sfpR.rows[0];
            if (!sfp) continue;
            const assignR = await pool.query(
              'INSERT INTO equipment_sfp_assignments (equipment_id,slot_number,sfp_type_id,port_group_id) VALUES ($1,$2,$3,$4) RETURNING *',
              [eq.id, slot, asgn.sfp_type_id, group.id]
            );
            const assignment = assignR.rows[0];
            const configs = sfp.port_configs;
            const cfgCount = configs.length;
            const maxPerSlotFlat = group.max_ports_per_slot || cfgCount;
            const isSharedFiberFlat = cfgCount === 1 && maxPerSlotFlat >= 2;
            const portCountFlat = isSharedFiberFlat ? maxPerSlotFlat : cfgCount;
            for (let ci = 0; ci < portCountFlat; ci++) {
              const cfg = configs[isSharedFiberFlat ? 0 : ci];
              const logicalNum = (slot - 1) * maxPerSlotFlat + ci + 1;
              const label = `${pfx}${logicalNum}`;
              globalOrder++;
              const pr = await pool.query(
                `INSERT INTO equipment_ports
                   (equipment_id,port_label,connector_type,port_order,slot_number,sfp_assignment_id,port_type,port_group_id,is_shared_fiber)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
                [eq.id, label, cfg.connector_type||null, globalOrder, slot, assignment.id, group.port_type||null, group.id, isSharedFiberFlat]
              );
              ports.push({ ...pr.rows[0], connections: [] });
            }
          }
        }
      }
    } else if (template) {
      // Legacy path: fixed_port_count + sfp_slot_count
      if (template.fixed_port_count) {
        const pfx = template.fixed_port_prefix || '';
        const sep = pfx ? ' ' : '';
        for (let p = 1; p <= template.fixed_port_count; p++) {
          globalOrder++;
          const pr = await pool.query(
            'INSERT INTO equipment_ports (equipment_id,port_label,connector_type,port_type,port_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [eq.id, `${pfx}${sep}${p}`, template.fixed_connector_type||null, template.fixed_port_type||'optical', globalOrder]
          );
          ports.push({ ...pr.rows[0], connections: [] });
        }
      }
      if (template.sfp_slot_count && Array.isArray(sfp_assignments)) {
        for (const asgn of sfp_assignments) {
          const { slot_number, sfp_type_id } = asgn;
          if (!sfp_type_id) continue;
          const sfpR = await pool.query('SELECT * FROM sfp_types WHERE id=$1', [sfp_type_id]);
          const sfp = sfpR.rows[0];
          if (!sfp) continue;
          const assignR = await pool.query(
            'INSERT INTO equipment_sfp_assignments (equipment_id,slot_number,sfp_type_id) VALUES ($1,$2,$3) RETURNING *',
            [eq.id, slot_number, sfp_type_id]
          );
          const assignment = assignR.rows[0];
          const configs = sfp.port_configs;
          const pfx = template.sfp_slot_prefix || 'Card';
          let order = (template.fixed_port_count || 0) + (slot_number - 1) * 10;
          for (const cfg of configs) {
            const label = cfg.label ? `${slot_number}/${cfg.label}` : `${pfx} ${slot_number}`;
            order++;
            const pr = await pool.query(
              `INSERT INTO equipment_ports
                 (equipment_id,port_label,connector_type,port_order,slot_number,sfp_assignment_id)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
              [eq.id, label, cfg.connector_type||null, order, slot_number, assignment.id]
            );
            ports.push({ ...pr.rows[0], connections: [] });
          }
        }
      }
    }

    res.json({ ...eq, ports, sfp_assignments: [] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/equipment/:id', requireAuth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM equipment WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const e = existing.rows[0];
    const name = req.body.name ?? e.name;
    const equipment_type = req.body.equipment_type ?? e.equipment_type;
    const model = 'model' in req.body ? (req.body.model || null) : e.model;
    const notes = 'notes' in req.body ? (req.body.notes || null) : e.notes;
    const r = await pool.query(
      'UPDATE equipment SET name=$1,equipment_type=$2,model=$3,notes=$4 WHERE id=$5 RETURNING *',
      [name, equipment_type, model, notes, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/equipment/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM equipment WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/equipment/:id/card/:slot', requireAuth, async (req, res) => {
  try {
    const equipId = req.params.id;
    const cardSlot = parseInt(req.params.slot);
    const { card_type_id } = req.body;

    const eqR = await pool.query('SELECT * FROM equipment WHERE id=$1', [equipId]);
    const eq = eqR.rows[0];
    if (!eq) return res.status(404).json({ error: 'Not found' });
    const tmplR = eq.template_id
      ? await pool.query('SELECT * FROM equipment_templates WHERE id=$1', [eq.template_id])
      : { rows: [] };
    const template = tmplR.rows[0];

    // Remove existing card ports/sfp_assignments/card_assignment (connections cascade from port deletes)
    await pool.query('DELETE FROM equipment_ports WHERE equipment_id=$1 AND card_slot=$2', [equipId, cardSlot]);
    await pool.query('DELETE FROM equipment_sfp_assignments WHERE equipment_id=$1 AND card_slot=$2', [equipId, cardSlot]);
    await pool.query('DELETE FROM equipment_card_assignments WHERE equipment_id=$1 AND card_slot=$2', [equipId, cardSlot]);

    if (!card_type_id) return res.json({ ok: true });

    const cardR = await pool.query('SELECT * FROM card_types WHERE id=$1', [card_type_id]);
    const cardType = cardR.rows[0];
    if (!cardType) return res.status(404).json({ error: 'Card type not found' });

    await pool.query(
      'INSERT INTO equipment_card_assignments (equipment_id,card_slot,card_type_id) VALUES ($1,$2,$3)',
      [equipId, cardSlot, card_type_id]
    );

    const instancePrefix = eq.port_prefix || '';
    const cardPrefix = (template?.card_slot_prefix_pattern || '{n}/').replace('{n}', cardSlot);
    const fullPrefix = instancePrefix + cardPrefix;

    const maxOrdR = await pool.query(
      'SELECT COALESCE(MAX(port_order),0) AS mo FROM equipment_ports WHERE equipment_id=$1',
      [equipId]
    );
    let globalOrder = maxOrdR.rows[0].mo;
    const ports = [];

    for (const group of cardType.port_groups) {
      const pfx = fullPrefix + (group.label_prefix || group.id || '');
      if (group.kind === 'fixed') {
        for (let n = 1; n <= group.count; n++) {
          globalOrder++;
          const pr = await pool.query(
            `INSERT INTO equipment_ports
               (equipment_id,port_label,connector_type,port_order,port_type,port_group_id,card_slot)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [equipId, `${pfx}${n}`, group.connector_type||null, globalOrder, group.port_type||null, group.id, cardSlot]
          );
          ports.push({ ...pr.rows[0], connections: [] });
        }
      }
      // sfp_slot groups: inserted via PUT /api/equipment/:id/sfp/:slot
    }

    res.json({ ok: true, ports });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/equipment/:id/sfp/:slot', requireAuth, async (req, res) => {
  try {
    const { sfp_type_id, port_group_id = 'default', card_slot = 0 } = req.body;
    const equipId = req.params.id;
    const slot = parseInt(req.params.slot);
    const cardSlot = parseInt(card_slot) || 0;

    const eqR = await pool.query('SELECT * FROM equipment WHERE id=$1', [equipId]);
    const eq = eqR.rows[0];
    if (!eq) return res.status(404).json({ error: 'Not found' });
    const tmplR = eq.template_id
      ? await pool.query('SELECT * FROM equipment_templates WHERE id=$1', [eq.template_id])
      : { rows: [] };
    const template = tmplR.rows[0];

    // Delete old assignment (cascade deletes sfp ports for this slot+group+card_slot)
    await pool.query(
      'DELETE FROM equipment_sfp_assignments WHERE equipment_id=$1 AND card_slot=$2 AND port_group_id=$3 AND slot_number=$4',
      [equipId, cardSlot, port_group_id, slot]
    );

    if (!sfp_type_id) return res.json({ ok: true });

    const sfpR = await pool.query('SELECT * FROM sfp_types WHERE id=$1', [sfp_type_id]);
    const sfp = sfpR.rows[0];
    if (!sfp) return res.status(404).json({ error: 'SFP type not found' });

    const assignR = await pool.query(
      'INSERT INTO equipment_sfp_assignments (equipment_id,slot_number,sfp_type_id,port_group_id,card_slot) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [equipId, slot, sfp_type_id, port_group_id, cardSlot]
    );
    const assignment = assignR.rows[0];
    const configs = sfp.port_configs;
    const cfgCount = configs.length;

    // Determine group definition: card type's port_groups for chassis, template's for flat
    let group = null;
    if (cardSlot > 0) {
      const caR = await pool.query(
        `SELECT ct.port_groups AS card_port_groups
         FROM equipment_card_assignments eca
         JOIN card_types ct ON ct.id = eca.card_type_id
         WHERE eca.equipment_id=$1 AND eca.card_slot=$2`,
        [equipId, cardSlot]
      );
      if (caR.rows[0]) {
        group = caR.rows[0].card_port_groups?.find(g => g.id === port_group_id);
      }
    } else {
      group = template?.port_groups?.find(g => g.id === port_group_id);
    }

    const instancePrefix = eq.port_prefix || '';
    let labelPfx, portType;

    if (group) {
      let cardPrefix = '';
      if (cardSlot > 0 && template?.card_slot_prefix_pattern) {
        cardPrefix = template.card_slot_prefix_pattern.replace('{n}', cardSlot);
      }
      labelPfx = instancePrefix + cardPrefix + (group.label_prefix || group.id || '');
      portType = group.port_type || null;
    } else {
      labelPfx = template?.sfp_slot_prefix || 'Card ';
      portType = null;
    }

    const maxPerSlot = group?.max_ports_per_slot || cfgCount;
    // Auto-detect shared fiber: single-port SFP in a slot that owns 2+ logical ports
    const isSharedFiberMode = cfgCount === 1 && maxPerSlot >= 2;
    const portCount = isSharedFiberMode ? maxPerSlot : cfgCount;

    const maxOrdR = await pool.query(
      'SELECT COALESCE(MAX(port_order),0) AS mo FROM equipment_ports WHERE equipment_id=$1',
      [equipId]
    );
    let order = maxOrdR.rows[0].mo;

    for (let ci = 0; ci < portCount; ci++) {
      const cfg = configs[isSharedFiberMode ? 0 : ci];
      const isSharedFiber = isSharedFiberMode;
      let label;
      if (group) {
        const logicalNum = (slot - 1) * maxPerSlot + ci + 1;
        label = `${labelPfx}${logicalNum}`;
      } else {
        label = cfg.label ? `${slot}/${cfg.label}` : `${labelPfx}${slot}`;
      }
      order++;
      await pool.query(
        `INSERT INTO equipment_ports
           (equipment_id,port_label,connector_type,port_order,slot_number,sfp_assignment_id,port_type,port_group_id,card_slot,is_shared_fiber)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [equipId, label, cfg.connector_type||null, order, slot, assignment.id, portType, port_group_id, cardSlot, isSharedFiber]
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/equipment/:id/ports', requireAuth, async (req, res) => {
  try {
    const { port_label, connector_type, port_order } = req.body;
    if (!port_label) return res.status(400).json({ error: 'port_label required' });
    const r = await pool.query(
      'INSERT INTO equipment_ports (equipment_id,port_label,connector_type,port_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, port_label, connector_type || null, port_order ?? 0]
    );
    res.json({ ...r.rows[0], connection: null });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Port label already exists on this device' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/equipment-ports/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM equipment_ports WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Connections ────────────────────────────────────────────────────────────

app.get('/api/sites/:id/jumpers', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.a_panel_fiber_id, c.a_strand, c.b_panel_fiber_id, c.b_strand,
        ppa.name AS a_panel_name, ra.name AS a_route_name,
        ppb.name AS b_panel_name, rb.name AS b_route_name
       FROM connections c
       JOIN panel_fibers pfa ON pfa.id = c.a_panel_fiber_id
       JOIN patch_panels ppa ON ppa.id = pfa.panel_id
       JOIN routes ra ON ra.id = pfa.route_id
       JOIN panel_fibers pfb ON pfb.id = c.b_panel_fiber_id
       JOIN patch_panels ppb ON ppb.id = pfb.panel_id
       JOIN routes rb ON rb.id = pfb.route_id
       WHERE ppa.site_id=$1 AND c.a_port_id IS NULL AND c.b_port_id IS NULL`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/connections', requireAuth, async (req, res) => {
  try {
    const { a_port_id, a_panel_fiber_id, a_strand,
            b_port_id, b_panel_fiber_id, b_strand, notes } = req.body;
    const r = await pool.query(
      `INSERT INTO connections
         (a_port_id,a_panel_fiber_id,a_strand,b_port_id,b_panel_fiber_id,b_strand,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a_port_id||null, a_panel_fiber_id||null, a_strand||null,
       b_port_id||null, b_panel_fiber_id||null, b_strand||null, notes||null]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/connections/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM connections WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/connections/duplex', requireAuth, async (req, res) => {
  const { a_port_id, fiber1, fiber2 } = req.body;
  if (!a_port_id || !fiber1?.panel_fiber_id || !fiber2?.panel_fiber_id)
    return res.status(400).json({ error: 'Missing required fields' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r1 = await client.query(
      'INSERT INTO connections (a_port_id,b_panel_fiber_id,b_strand) VALUES ($1,$2,$3) RETURNING *',
      [a_port_id, fiber1.panel_fiber_id, fiber1.strand]
    );
    const pairId = r1.rows[0].id;
    await client.query('UPDATE connections SET pair_id=$1 WHERE id=$1', [pairId]);
    const r2 = await client.query(
      'INSERT INTO connections (a_port_id,b_panel_fiber_id,b_strand,pair_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [a_port_id, fiber2.panel_fiber_id, fiber2.strand, pairId]
    );
    await client.query('COMMIT');
    res.json({ pair_id: pairId, connections: [{ ...r1.rows[0], pair_id: pairId }, r2.rows[0]] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

app.delete('/api/connections/pair/:pairId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM connections WHERE pair_id=$1 OR id=$1', [req.params.pairId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/connections/shared-fiber', requireAuth, async (req, res) => {
  // Connects all shared-fiber sibling ports (same sfp_assignment) to one panel strand
  const { port_id, panel_fiber_id, strand } = req.body;
  if (!port_id || !panel_fiber_id) return res.status(400).json({ error: 'Missing required fields' });

  const portR = await pool.query('SELECT * FROM equipment_ports WHERE id=$1', [port_id]);
  const port = portR.rows[0];
  if (!port) return res.status(404).json({ error: 'Port not found' });

  let siblingPortIds = [parseInt(port_id)];
  if (port.sfp_assignment_id && port.is_shared_fiber) {
    const sibR = await pool.query(
      'SELECT id FROM equipment_ports WHERE sfp_assignment_id=$1 AND is_shared_fiber=true ORDER BY id',
      [port.sfp_assignment_id]
    );
    siblingPortIds = sibR.rows.map(r => r.id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connections = [];
    let pairId = null;

    for (const pid of siblingPortIds) {
      const r = await client.query(
        'INSERT INTO connections (a_port_id,b_panel_fiber_id,b_strand,pair_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [pid, panel_fiber_id, strand || null, pairId]
      );
      if (pairId === null) {
        pairId = r.rows[0].id;
        await client.query('UPDATE connections SET pair_id=$1 WHERE id=$1', [pairId]);
        connections.push({ ...r.rows[0], pair_id: pairId });
      } else {
        connections.push(r.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ pair_id: pairId, connections });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── Fiber path trace ────────────────────────────────────────────────────────
// Walks the connectivity graph and accumulates optical loss along the path:
//   - connections: equipment ports ↔ panel strands (patch / jumper, ~0.5 dB)
//   - splices: route/cable fiber ↔ route/cable fiber (~0.1 dB), fiber # can change
//   - splitters: one input fiber fans out to N output legs, each with its own
//     insertion loss. A splitter is a node so light entering an output leg only
//     continues to the input (upstream) — it does not couple to sibling legs.
//
// Fiber numbers are canonicalized to 1-based: panel strands are already 1-based;
// splice and splitter fibers are stored 0-based (closure UI convention) so we
// add 1 when building node keys.
//
// Node keys:
//   port:<portId>            equipment port
//   rf:<routeId>:<fiber>     fiber N of a route (shared by all cables on it)
//   cf:<cableId>:<fiber>     fiber N of a link cable (no route)
//   spl:<splitterId>         a splitter body

const LOSS_SPLICE = 0.1;   // dB, typical fusion splice
const LOSS_PATCH  = 0.5;   // dB, typical mated connector pair

app.get('/api/trace', requireAuth, async (req, res) => {
  try {
    const [cablesR, splicesR, connsR, portsR, pfR, routesR, splittersR, soR] = await Promise.all([
      pool.query('SELECT id, route_id, name FROM cables'),
      pool.query(
        `SELECT s.id, s.closure_id, cl.name AS closure_name, s.splice_type,
                s.from_cable_id, s.from_fiber, s.to_cable_id, s.to_fiber
         FROM splices s LEFT JOIN closures cl ON cl.id = s.closure_id`),
      pool.query('SELECT * FROM connections'),
      pool.query(
        `SELECT p.id, p.port_label, e.id AS equipment_id, e.name AS eq_name,
                e.site_id, st.name AS site_name
         FROM equipment_ports p
         JOIN equipment e ON e.id = p.equipment_id
         LEFT JOIN sites st ON st.id = e.site_id`),
      pool.query(
        `SELECT pf.id, pf.route_id, pp.name AS panel_name, pp.site_id,
                st.name AS site_name, r.name AS route_name
         FROM panel_fibers pf
         JOIN patch_panels pp ON pp.id = pf.panel_id
         LEFT JOIN sites st ON st.id = pp.site_id
         JOIN routes r ON r.id = pf.route_id`),
      pool.query('SELECT id, name FROM routes'),
      pool.query(
        `SELECT sp.id, sp.name, sp.ratio, sp.splitter_type, sp.input_cable_id, sp.input_fiber,
                cl.name AS closure_name
         FROM splitters sp LEFT JOIN closures cl ON cl.id = sp.closure_id`),
      pool.query('SELECT * FROM splitter_outputs'),
    ]);

    // Latest optical reading per port, for measured-vs-calculated correlation
    const opticalR = await pool.query(
      `SELECT DISTINCT ON (port_id) port_id, rx_dbm, tx_dbm, measured_at
       FROM optical_measurements WHERE port_id IS NOT NULL
       ORDER BY port_id, measured_at DESC`
    );
    const optical = new Map(opticalR.rows.map(o => [o.port_id, o]));

    const cables = new Map(cablesR.rows.map(c => [c.id, c]));
    const ports  = new Map(portsR.rows.map(p => [p.id, p]));
    const pfs    = new Map(pfR.rows.map(f => [f.id, f]));
    const routes = new Map(routesR.rows.map(r => [r.id, r]));
    const splitters = new Map(splittersR.rows.map(s => [s.id, s]));

    // 1-based fiber key for a cable's fiber (route fibers shared across cables)
    const cableNode = (cableId, fiber1) => {
      const c = cables.get(cableId);
      if (!c || fiber1 == null) return null;
      return c.route_id ? `rf:${c.route_id}:${fiber1}` : `cf:${cableId}:${fiber1}`;
    };

    const nodeInfo = (key) => {
      const [type, id, fiber] = key.split(':');
      if (type === 'port') {
        const p = ports.get(+id);
        const o = optical.get(+id);
        return { key, type: 'port', label: p ? `${p.eq_name} › ${p.port_label}` : `Port #${id}`,
                 detail: p?.site_name ? `at ${p.site_name}` : '', site_id: p?.site_id ?? null,
                 rx_dbm: o ? (o.rx_dbm != null ? +o.rx_dbm : null) : null,
                 tx_dbm: o ? (o.tx_dbm != null ? +o.tx_dbm : null) : null,
                 measured_at: o ? o.measured_at : null };
      }
      if (type === 'rf') {
        const r = routes.get(+id);
        return { key, type: 'route_fiber', label: `${r ? r.name : 'Route #' + id} — fiber ${fiber}`,
                 detail: '', route_id: +id };
      }
      if (type === 'spl') {
        const s = splitters.get(+id);
        const ratio = s ? (s.splitter_type === 'tap' ? 'tap' : s.ratio) : '';
        return { key, type: 'splitter',
                 label: `${s ? s.name : 'Splitter #' + id}${ratio ? ' (' + ratio + ')' : ''}`,
                 detail: s?.closure_name ? `at ${s.closure_name}` : '' };
      }
      const c = cables.get(+id);
      return { key, type: 'cable_fiber', label: `${c ? c.name : 'Cable #' + id} (link cable) — fiber ${fiber}`,
               detail: '' };
    };

    // Build adjacency. Each edge carries loss_db and (for splitter edges) side.
    const adj = new Map();
    const addEdge = (a, b, via) => {
      if (!a || !b || a === b) return;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ to: b, via });
      adj.get(b).push({ to: a, via });
    };

    for (const s of splicesR.rows) {
      const a = cableNode(s.from_cable_id, s.from_fiber + 1);
      const b = cableNode(s.to_cable_id, s.to_fiber + 1);
      addEdge(a, b, {
        kind: 'splice', loss_db: LOSS_SPLICE, closure_id: s.closure_id,
        label: `Splice (${s.splice_type})${s.closure_name ? ' @ ' + s.closure_name : ''}: f${s.from_fiber + 1} → f${s.to_fiber + 1}`,
      });
    }

    const connSideNode = (portId, pfId, strand) => {
      if (portId) return `port:${portId}`;
      const pf = pfs.get(pfId);
      return pf ? `rf:${pf.route_id}:${strand}` : null; // strand already 1-based
    };
    for (const c of connsR.rows) {
      const a = connSideNode(c.a_port_id, c.a_panel_fiber_id, c.a_strand);
      const b = connSideNode(c.b_port_id, c.b_panel_fiber_id, c.b_strand);
      const pf = pfs.get(c.a_panel_fiber_id || c.b_panel_fiber_id);
      const isJumper = !c.a_port_id && !c.b_port_id;
      addEdge(a, b, {
        kind: isJumper ? 'jumper' : 'patch', loss_db: LOSS_PATCH,
        label: pf
          ? `${isJumper ? 'Jumper' : 'Patched'} at ${pf.panel_name}${pf.site_name ? ' (' + pf.site_name + ')' : ''}`
          : 'Direct connection',
      });
    }

    // Splitter edges: input fiber ↔ spl (trunk, no loss), spl ↔ each output leg (leg loss)
    const outputsBySplitter = new Map();
    soR.rows.forEach(o => {
      if (!outputsBySplitter.has(o.splitter_id)) outputsBySplitter.set(o.splitter_id, []);
      outputsBySplitter.get(o.splitter_id).push(o);
    });
    for (const s of splittersR.rows) {
      const splKey = `spl:${s.id}`;
      const inNode = cableNode(s.input_cable_id, s.input_fiber != null ? s.input_fiber + 1 : null);
      if (inNode) addEdge(inNode, splKey, { kind: 'splitter', side: 'trunk', loss_db: 0, label: 'Splitter input' });
      for (const o of (outputsBySplitter.get(s.id) || [])) {
        const outNode = cableNode(o.output_cable_id, o.output_fiber != null ? o.output_fiber + 1 : null);
        if (!outNode) continue;
        const pct = o.tap_percent != null ? ` ${o.tap_percent}%` : '';
        addEdge(splKey, outNode, {
          kind: 'splitter', side: 'leg', loss_db: Number(o.loss_db) || 0,
          label: `Splitter leg ${o.label || o.leg_index}${pct} (−${(Number(o.loss_db) || 0).toFixed(1)} dB)`,
        });
      }
    }

    // Resolve start node (start fibers given 0-based for route/fiber query, like splices)
    let startKey = null;
    if (req.query.port) startKey = `port:${+req.query.port}`;
    else if (req.query.panel_fiber && req.query.strand) {
      const pf = pfs.get(+req.query.panel_fiber);
      if (pf) startKey = `rf:${pf.route_id}:${+req.query.strand}`; // strand 1-based
    } else if (req.query.route && req.query.fiber) {
      startKey = `rf:${+req.query.route}:${+req.query.fiber + 1}`; // fiber 0-based → 1-based
    }
    if (!startKey) return res.status(400).json({ error: 'Specify port, panel_fiber+strand, or route+fiber' });

    // DFS walk emitting hops in path order, tracking cumulative loss and the
    // edge used to enter each node (so splitters can enforce directionality).
    const visited = new Set([startKey]);
    const steps = [];
    const routeIds = new Set();
    let branched = false;
    let maxLoss = 0;
    const startInfo = nodeInfo(startKey);
    if (startInfo.route_id) routeIds.add(startInfo.route_id);

    const walk = (key, depth, cumLoss, enteredVia) => {
      let edges = (adj.get(key) || []).filter(e => !visited.has(e.to));
      // Splitter directionality: entering via a leg may only exit the trunk
      // (upstream); entering via the trunk fans out to every leg (PON tree).
      if (key.startsWith('spl:') && enteredVia && enteredVia.kind === 'splitter') {
        if (enteredVia.side === 'leg')        edges = edges.filter(e => e.via.side === 'trunk');
        else if (enteredVia.side === 'trunk') edges = edges.filter(e => e.via.side === 'leg');
      }
      if (edges.length > 1) branched = true;
      for (const e of edges) {
        if (visited.has(e.to)) continue; // earlier sibling may have claimed it
        visited.add(e.to);
        const info = nodeInfo(e.to);
        if (info.route_id) routeIds.add(info.route_id);
        const loss = +(cumLoss + (e.via.loss_db || 0)).toFixed(2);
        if (info.type !== 'splitter' && loss > maxLoss) maxLoss = loss;
        steps.push({ depth, via: e.via, node: info, cum_loss_db: loss });
        walk(e.to, depth + 1, loss, e.via);
      }
    };
    walk(startKey, 1, 0, null);

    res.json({ start: startInfo, steps, route_ids: [...routeIds], branched, total_loss_db: maxLoss });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Optical light-level monitoring ───────────────────────────────────────────
// A monitored_device polls real equipment for per-interface rx/tx optical power
// and stores time-series readings. Drivers are keyed by vendor; each returns
//   [{ interface_name, rx_dbm, tx_dbm, temperature_c }]
// Interfaces are mapped to equipment_ports by matching port_label.

const http = require('http');
const https = require('https');
let snmp = null;
try { snmp = require('net-snmp'); } catch (_) { /* optional — only Juniper needs it */ }

// Juniper DOM MIB (mib-jnx-dom) — jnxDomCurrentTable, indexed by ifIndex.
// These column OIDs and the dBm scaling are the common Junos values; if a
// platform reports power differently (e.g. µW), adjust POWER_SCALE / OIDs.
const JNX = {
  RX:   '1.3.6.1.4.1.2636.3.60.1.1.1.1.5',  // jnxDomCurrentRxLaserPower
  TX:   '1.3.6.1.4.1.2636.3.60.1.1.1.1.7',  // jnxDomCurrentTxLaserOutputPower
  TEMP: '1.3.6.1.4.1.2636.3.60.1.1.1.1.8',  // jnxDomCurrentModuleTemperature (°C)
  POWER_SCALE: 0.01,                         // raw integer → dBm (units of 1/100 dBm)
};
const OID_IFDESCR = '1.3.6.1.2.1.2.2.1.2';   // IF-MIB::ifDescr, maps ifIndex → name

// Walk an SNMP subtree → Map of { indexSuffix: value } (suffix = OID after base).
function snmpSubtree(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    session.subtree(baseOid, 20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          out.set(vb.oid.slice(baseOid.length + 1), vb.value);
        }
      },
      (error) => error ? reject(error) : resolve(out)
    );
  });
}

// Minimal JSON HTTP client. Allows self-signed TLS (internal mgmt interfaces).
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL: ' + urlStr)); }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      method, headers: { ...headers }, rejectUnauthorized: false,
    };
    if (payload != null) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(url, opts, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: resp.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

const round2 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 100) / 100);

const DRIVERS = {
  // Generates realistic readings so the full pipeline (poll → store → display →
  // trace correlation) is verifiable without hardware. One reading per port.
  async simulator(device, ports) {
    const ifaces = ports.length ? ports.map(p => p.port_label)
      : ['xe-0/0/0', 'xe-0/0/1', 'ge-0/0/0'];
    return ifaces.map(name => {
      // PON/SFP-ish values: tx near launch power, rx attenuated downstream
      const tx = 1.5 + (Math.random() * 3 - 1.5);        // ~ -0 .. +4.5 dBm
      const rx = -16 + (Math.random() * 8 - 4);          // ~ -20 .. -12 dBm
      const temp = 38 + (Math.random() * 10 - 5);        // ~ 33 .. 43 °C
      return { interface_name: name, tx_dbm: round2(tx), rx_dbm: round2(rx), temperature_c: round2(temp) };
    });
  },

  // Calix — SMx / Calix Cloud northbound REST. Auth for a bearer token, then
  // read ONT/port optical status. Endpoint paths vary by SMx version, so the
  // base path is configurable (device.base_path) and the JSON parse is lenient.
  async calix(device, ports) {
    const scheme = (device.port === 80 || device.port === 8080) ? 'http' : 'https';
    const origin = `${scheme}://${device.host}:${device.port || 18443}`;
    const base = device.base_path || '/rest/v1';

    // 1) Authenticate → token
    const auth = await httpRequest(`${origin}${base}/auth/token`, {
      method: 'POST', body: { username: device.username, password: device.secret },
    });
    if (auth.status >= 400 || !auth.json) {
      throw new Error(`Calix auth failed (HTTP ${auth.status})`);
    }
    const token = auth.json.token || auth.json.access_token || auth.json.sessionId;
    if (!token) throw new Error('Calix auth returned no token');

    // 2) Fetch optical status for this device's ONTs/ports
    const opt = await httpRequest(`${origin}${base}/devices/${encodeURIComponent(device.username && device.host)}/optical`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    });
    if (opt.status >= 400 || !opt.json) throw new Error(`Calix optical query failed (HTTP ${opt.status})`);

    // Lenient parse: accept {interfaces:[...]} or a bare array. Each item may
    // use rxPower/txPower or rx_dbm/tx_dbm naming.
    const items = Array.isArray(opt.json) ? opt.json
      : (opt.json.interfaces || opt.json.onts || opt.json.data || []);
    return items.map(it => ({
      interface_name: it.interface || it.name || it.ontId || it.port,
      rx_dbm: round2(parseFloat(it.rxPower ?? it.rx_dbm ?? it.rxOpticalPower)),
      tx_dbm: round2(parseFloat(it.txPower ?? it.tx_dbm ?? it.txOpticalPower)),
      temperature_c: round2(parseFloat(it.temperature ?? it.temp)),
    })).filter(r => r.interface_name);
  },

  // Arista — eAPI (JSON-RPC over HTTP/S). "show interfaces transceiver" returns
  // rxPower/txPower in dBm per interface.
  async arista(device, ports) {
    const scheme = (device.port === 80 || device.port === 8080) ? 'http' : 'https';
    const origin = `${scheme}://${device.host}:${device.port || 443}/command-api`;
    const authHeader = 'Basic ' + Buffer.from(`${device.username}:${device.secret}`).toString('base64');
    const rpc = {
      jsonrpc: '2.0', method: 'runCmds', id: 'ofm',
      params: { version: 1, cmds: ['show interfaces transceiver'], format: 'json' },
    };
    const r = await httpRequest(origin, { method: 'POST', headers: { Authorization: authHeader }, body: rpc });
    if (r.status === 401) throw new Error('Arista eAPI: authentication failed');
    if (r.status >= 400 || !r.json) throw new Error(`Arista eAPI failed (HTTP ${r.status})`);
    if (r.json.error) throw new Error('Arista eAPI: ' + (r.json.error.message || JSON.stringify(r.json.error)));
    const ifaces = r.json.result?.[0]?.interfaces || {};
    // DOM fields are top-level on most EOS versions but nested under .details
    // or .parameters on others — read leniently.
    const pick = (d, k) => {
      const v = d[k] ?? d.details?.[k] ?? d.parameters?.[k];
      return (v && typeof v === 'object') ? (v.value ?? null) : v;
    };
    return Object.entries(ifaces).map(([name, d]) => ({
      interface_name: name,
      rx_dbm: round2(pick(d, 'rxPower')),
      tx_dbm: round2(pick(d, 'txPower')),
      temperature_c: round2(pick(d, 'temperature')),
    })).filter(r => r.rx_dbm != null || r.tx_dbm != null);
  },

  // Juniper — optical DDM via SNMP (jnxDomCurrent MIB). Walks rx/tx power and
  // temperature columns, joining ifDescr for interface names.
  async juniper(device, ports) {
    if (!snmp) throw new Error('Juniper polling requires the net-snmp package (npm install net-snmp).');
    const session = snmp.createSession(device.host, device.secret || 'public', {
      port: device.port || 161, version: snmp.Version2c, timeout: 5000, retries: 1,
    });
    try {
      const [rx, tx, temp, names] = await Promise.all([
        snmpSubtree(session, JNX.RX),
        snmpSubtree(session, JNX.TX),
        snmpSubtree(session, JNX.TEMP),
        snmpSubtree(session, OID_IFDESCR),
      ]);
      const readings = [];
      for (const [idx, rxv] of rx) {
        readings.push({
          interface_name: names.has(idx) ? String(names.get(idx)) : ('ifIndex ' + idx),
          rx_dbm: round2(Number(rxv) * JNX.POWER_SCALE),
          tx_dbm: tx.has(idx) ? round2(Number(tx.get(idx)) * JNX.POWER_SCALE) : null,
          temperature_c: temp.has(idx) ? round2(Number(temp.get(idx))) : null,
        });
      }
      if (!readings.length) throw new Error('No DOM entries returned — check SNMP community and that the device supports jnxDomCurrent.');
      return readings;
    } finally {
      session.close();
    }
  },
};

async function pollDevice(deviceRow) {
  const device = { ...deviceRow, secret: decryptSecret(deviceRow.secret_enc) };
  const driver = DRIVERS[device.vendor];
  if (!driver) throw new Error('No driver for vendor: ' + device.vendor);
  const portsR = await pool.query(
    'SELECT id, port_label FROM equipment_ports WHERE equipment_id=$1 ORDER BY port_order, id',
    [device.equipment_id]
  );
  const ports = portsR.rows;
  const readings = await driver(device, ports) || [];
  const byLabel = new Map(ports.map(p => [String(p.port_label).toLowerCase(), p.id]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of readings) {
      const portId = byLabel.get(String(r.interface_name || '').toLowerCase()) || null;
      await client.query(
        `INSERT INTO optical_measurements (device_id, port_id, interface_name, rx_dbm, tx_dbm, temperature_c)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [device.id, portId, r.interface_name || null, r.rx_dbm ?? null, r.tx_dbm ?? null, r.temperature_c ?? null]
      );
    }
    await client.query(
      `UPDATE monitored_devices SET last_polled_at=now(), last_status='ok', last_error=NULL WHERE id=$1`,
      [device.id]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return readings;
}

async function pollDeviceSafe(deviceRow) {
  try {
    const readings = await pollDevice(deviceRow);
    return { ok: true, count: readings.length };
  } catch (e) {
    await pool.query(
      `UPDATE monitored_devices SET last_polled_at=now(), last_status='error', last_error=$2 WHERE id=$1`,
      [deviceRow.id, String(e.message).slice(0, 500)]
    ).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// Background scheduler: every 30s, poll devices whose interval has elapsed.
let _pollTimer = null;
async function pollScheduler() {
  try {
    const due = await pool.query(
      `SELECT * FROM monitored_devices
       WHERE enabled AND poll_interval_sec > 0
         AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => poll_interval_sec))`
    );
    for (const d of due.rows) await pollDeviceSafe(d);
  } catch (e) { console.error('Poll scheduler error:', e.message); }
}

const devicePublic = (d) => ({
  id: d.id, equipment_id: d.equipment_id, name: d.name, vendor: d.vendor,
  host: d.host, port: d.port, username: d.username, base_path: d.base_path,
  poll_interval_sec: d.poll_interval_sec, enabled: d.enabled,
  last_polled_at: d.last_polled_at, last_status: d.last_status, last_error: d.last_error,
  has_secret: !!d.secret_enc,
});

app.get('/api/sites/:id/devices', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.*, e.name AS equipment_name FROM monitored_devices d
       JOIN equipment e ON e.id = d.equipment_id WHERE e.site_id=$1 ORDER BY d.id`,
      [req.params.id]
    );
    res.json(r.rows.map(d => ({ ...devicePublic(d), equipment_name: d.equipment_name })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Latest reading per port for a site's equipment (for inline display)
app.get('/api/sites/:id/optical', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (port_id) port_id, rx_dbm, tx_dbm, temperature_c, measured_at, interface_name
       FROM optical_measurements
       WHERE port_id IN (SELECT id FROM equipment_ports WHERE equipment_id IN
         (SELECT id FROM equipment WHERE site_id=$1))
       ORDER BY port_id, measured_at DESC`,
      [req.params.id]
    );
    const byPort = {};
    r.rows.forEach(row => { byPort[row.port_id] = row; });
    res.json(byPort);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/devices', requireAuth, async (req, res) => {
  try {
    const { equipment_id, name, vendor, host, port, username, secret, base_path,
            poll_interval_sec, enabled } = req.body;
    if (!equipment_id || !name || !vendor) return res.status(400).json({ error: 'equipment_id, name, vendor required' });
    const r = await pool.query(
      `INSERT INTO monitored_devices
        (equipment_id,name,vendor,host,port,username,secret_enc,base_path,poll_interval_sec,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [equipment_id, name, vendor, host || null, port || null, username || null,
       encryptSecret(secret), base_path || null, poll_interval_sec || 0,
       enabled !== false]
    );
    res.json(devicePublic(r.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM monitored_devices WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const d = cur.rows[0];
    const b = req.body;
    // Only re-encrypt the secret when a non-empty new one is supplied
    const secretEnc = (b.secret != null && b.secret !== '') ? encryptSecret(b.secret) : d.secret_enc;
    const r = await pool.query(
      `UPDATE monitored_devices SET name=$2, vendor=$3, host=$4, port=$5, username=$6,
        secret_enc=$7, base_path=$8, poll_interval_sec=$9, enabled=$10 WHERE id=$1 RETURNING *`,
      [d.id, b.name ?? d.name, b.vendor ?? d.vendor, b.host ?? d.host, b.port ?? d.port,
       b.username ?? d.username, secretEnc, b.base_path ?? d.base_path,
       b.poll_interval_sec ?? d.poll_interval_sec, b.enabled ?? d.enabled]
    );
    res.json(devicePublic(r.rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM monitored_devices WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/devices/:id/poll', requireAuth, async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM monitored_devices WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const result = await pollDeviceSafe(cur.rows[0]);
    const refreshed = await pool.query('SELECT * FROM monitored_devices WHERE id=$1', [req.params.id]);
    res.json({ ...result, device: devicePublic(refreshed.rows[0]) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/devices/:id/measurements', requireAuth, async (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const r = await pool.query(
      `SELECT port_id, interface_name, rx_dbm, tx_dbm, temperature_c, measured_at
       FROM optical_measurements
       WHERE device_id=$1 AND measured_at > now() - make_interval(hours => $2)
       ORDER BY measured_at`,
      [req.params.id, hours]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── Custom field values ────────────────────────────────────────────────────

app.get('/api/field-values/:entityType/:entityId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT field_def_id, value FROM custom_field_values WHERE entity_type=$1 AND entity_id=$2',
      [req.params.entityType, req.params.entityId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/field-values/:entityType/:entityId', requireAuth, async (req, res) => {
  try {
    const { values } = req.body; // { "defId": "value", ... }
    for (const [defId, value] of Object.entries(values)) {
      if (value === '' || value === null || value === undefined) {
        await pool.query('DELETE FROM custom_field_values WHERE field_def_id=$1 AND entity_id=$2',
          [defId, req.params.entityId]);
      } else {
        await pool.query(`
          INSERT INTO custom_field_values (field_def_id, entity_type, entity_id, value)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (field_def_id, entity_id) DO UPDATE SET value=$4
        `, [defId, req.params.entityType, req.params.entityId, value]);
      }
    }
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ============ USER PREFERENCES ============

app.get('/api/preferences', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT prefs FROM user_preferences WHERE user_id=$1', [req.session.userId]);
    res.json(r.rows[0]?.prefs ?? {});
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/preferences', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO user_preferences(user_id, prefs) VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET prefs=$2`,
      [req.session.userId, req.body]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ ADMIN: USER MANAGEMENT ============

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, full_name, role, created_at FROM users ORDER BY id'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, full_name, role
    `, [username, hash, full_name || null, role || 'user']);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SITES ============

app.get('/api/sites', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id,name,site_type,notes,layer_id,ST_AsGeoJSON(geom) as geom FROM sites ORDER BY id`);
    res.json(r.rows.map(row => ({ ...row, geom: JSON.parse(row.geom) })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/sites/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id,name,site_type,notes,ST_AsGeoJSON(geom) as geom FROM sites WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...r.rows[0], geom: JSON.parse(r.rows[0].geom) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sites', requireAuth, async (req, res) => {
  try {
    const { name, notes, lat, lng, site_type, layer_id } = req.body;
    const layerId = layer_id || (await getDefaultLayerId());
    const r = await pool.query(
      `INSERT INTO sites (name,notes,geom,site_type,created_by,layer_id) VALUES ($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326),$5,$6,$7)
       RETURNING id,name,site_type,notes,layer_id,ST_AsGeoJSON(geom) as geom`,
      [name, notes||null, lng, lat, site_type, req.session.userId, layerId || null]
    );
    res.json({ ...r.rows[0], geom: JSON.parse(r.rows[0].geom) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/sites/:id', requireAuth, async (req, res) => {
  try {
    const { name, notes } = req.body;
    const r = await pool.query(
      `UPDATE sites SET name=$1,notes=$2,updated_at=NOW() WHERE id=$3
       RETURNING id,name,site_type,notes,ST_AsGeoJSON(geom) as geom`,
      [name, notes||null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...r.rows[0], geom: JSON.parse(r.rows[0].geom) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/sites/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sites WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/sites/:id/routes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, notes, color, fiber_count, attached_sites
      FROM routes
      WHERE $1 = ANY(attached_sites)
      ORDER BY id
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============ PATCH PANELS ============

app.get('/api/sites/:id/patch-panels', requireAuth, async (req, res) => {
  try {
    const panels = await pool.query(
      `SELECT id, name, default_connector FROM patch_panels WHERE site_id=$1 ORDER BY id`,
      [req.params.id]
    );
    const fibers = await pool.query(
      `SELECT pf.id, pf.panel_id, pf.route_id, pf.connector,
              r.name as route_name, r.fiber_count, r.color
       FROM panel_fibers pf
       JOIN routes r ON r.id = pf.route_id
       WHERE pf.panel_id = ANY(
         SELECT id FROM patch_panels WHERE site_id=$1
       )`,
      [req.params.id]
    );
    const fibersByPanel = {};
    fibers.rows.forEach(f => { (fibersByPanel[f.panel_id] ||= []).push(f); });
    res.json(panels.rows.map(p => ({ ...p, fibers: fibersByPanel[p.id] || [] })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sites/:id/patch-panels', requireAuth, async (req, res) => {
  try {
    const { name, default_connector, route_id } = req.body;
    const siteId = req.params.id;
    const pRes = await pool.query(
      `INSERT INTO patch_panels (site_id, name, default_connector) VALUES ($1,$2,$3)
       RETURNING id, name, default_connector`,
      [siteId, name, default_connector || 'LC/UPC (Single)']
    );
    const panel = pRes.rows[0];
    if (route_id) {
      await pool.query(
        `INSERT INTO panel_fibers (panel_id, route_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [panel.id, route_id]
      );
    }
    const fibers = await pool.query(
      `SELECT pf.id, pf.panel_id, pf.route_id, pf.connector,
              r.name as route_name, r.fiber_count, r.color
       FROM panel_fibers pf JOIN routes r ON r.id=pf.route_id
       WHERE pf.panel_id=$1`,
      [panel.id]
    );
    res.json({ ...panel, fibers: fibers.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/patch-panels/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM patch_panels WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/panel-fibers/:id', requireAuth, async (req, res) => {
  try {
    const { connector } = req.body;
    const r = await pool.query(
      `UPDATE panel_fibers SET connector=$1 WHERE id=$2
       RETURNING id, panel_id, route_id, connector`,
      [connector || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/panel-fibers/:id/strands', requireAuth, async (req, res) => {
  try {
    const pf = await pool.query(
      `SELECT pf.id, pf.panel_id, pf.route_id,
              r.name as route_name, r.fiber_count, r.color,
              pp.default_connector
       FROM panel_fibers pf
       JOIN routes r ON r.id = pf.route_id
       JOIN patch_panels pp ON pp.id = pf.panel_id
       WHERE pf.id = $1`,
      [req.params.id]
    );
    if (!pf.rows.length) return res.status(404).json({ error: 'Not found' });
    const strands = await pool.query(
      `SELECT strand_number, connector FROM panel_fiber_strands
       WHERE panel_fiber_id = $1 ORDER BY strand_number`,
      [req.params.id]
    );
    res.json({ ...pf.rows[0], strands: strands.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/panel-fiber-strands', requireAuth, async (req, res) => {
  try {
    const { panel_fiber_id, strand_number, connector, panel_default } = req.body;
    if (!connector || connector === panel_default) {
      await pool.query(
        `DELETE FROM panel_fiber_strands WHERE panel_fiber_id=$1 AND strand_number=$2`,
        [panel_fiber_id, strand_number]
      );
      res.json({ strand_number, connector: null });
    } else {
      const r = await pool.query(
        `INSERT INTO panel_fiber_strands (panel_fiber_id, strand_number, connector)
         VALUES ($1,$2,$3)
         ON CONFLICT (panel_fiber_id, strand_number) DO UPDATE SET connector=EXCLUDED.connector
         RETURNING strand_number, connector`,
        [panel_fiber_id, strand_number, connector]
      );
      res.json(r.rows[0]);
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Serve site detail page
app.get('/site/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/site.html'));
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// ============ REAL-TIME EVENTS (SSE + polling fallback) ============

// Lightweight poll endpoint — returns last-change ms timestamp per table
app.get('/api/changes', requireAuth, (req, res) => {
  res.json(lastChanged);
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 25000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// ============ MAP LAYERS ============

async function getDefaultLayerId() {
  const r = await pool.query(
    `SELECT l.id FROM layers l JOIN layer_groups g ON g.id=l.group_id WHERE g.name='Default' AND l.name='Default' LIMIT 1`
  );
  return r.rows[0]?.id || null;
}

// Idempotent schema additions applied at boot — keeps installed DBs in sync
// with features added after the initial schema.sql import.
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE splitters ADD COLUMN IF NOT EXISTS splitter_type varchar(10) DEFAULT 'balanced';
    ALTER TABLE splitters ADD COLUMN IF NOT EXISTS excess_loss_db numeric(5,2) DEFAULT 0;
    CREATE TABLE IF NOT EXISTS splitter_outputs (
      id serial PRIMARY KEY,
      splitter_id integer NOT NULL REFERENCES splitters(id) ON DELETE CASCADE,
      leg_index integer NOT NULL,
      label varchar(30),
      output_cable_id integer REFERENCES cables(id) ON DELETE SET NULL,
      output_fiber integer,
      tap_percent numeric(5,2),
      loss_db numeric(5,2),
      UNIQUE (splitter_id, leg_index)
    );
    CREATE TABLE IF NOT EXISTS monitored_devices (
      id serial PRIMARY KEY,
      equipment_id integer REFERENCES equipment(id) ON DELETE CASCADE,
      name varchar(100) NOT NULL,
      vendor varchar(20) NOT NULL,
      host varchar(255),
      port integer,
      username varchar(100),
      secret_enc text,
      base_path varchar(255),
      poll_interval_sec integer DEFAULT 0,
      enabled boolean DEFAULT true,
      last_polled_at timestamptz,
      last_status varchar(20),
      last_error text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS optical_measurements (
      id bigserial PRIMARY KEY,
      device_id integer REFERENCES monitored_devices(id) ON DELETE CASCADE,
      port_id integer REFERENCES equipment_ports(id) ON DELETE SET NULL,
      interface_name varchar(120),
      rx_dbm numeric(6,2),
      tx_dbm numeric(6,2),
      temperature_c numeric(5,1),
      measured_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_optical_device_time ON optical_measurements (device_id, measured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_optical_port_time ON optical_measurements (port_id, measured_at DESC);
    INSERT INTO connector_types (name, enabled, sort_order) VALUES
      ('LC/UPC', true, 1),
      ('LC/APC', true, 2),
      ('SC/UPC', true, 3),
      ('SC/APC', true, 4),
      ('MPO-12', true, 5),
      ('FC/UPC', true, 6),
      ('FC/APC', true, 7),
      ('ST/UPC', true, 8)
    ON CONFLICT (name) DO NOTHING;
  `);
}

// ── Credential encryption (AES-256-GCM, key derived from SESSION_SECRET) ──────
const crypto = require('crypto');
function credKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'dev-only-insecure-key').digest();
}
function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + [iv, tag, ct].map(b => b.toString('base64')).join(':');
}
function decryptSecret(enc) {
  if (!enc || !enc.startsWith('v1:')) return null;
  try {
    const [, ivB, tagB, ctB] = enc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', credKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch (_) { return null; }
}

// Optical loss for one leg of a balanced 1:N splitter (split loss + excess).
function balancedLegLoss(n, excess) {
  return +(10 * Math.log10(n) + (Number(excess) || 0)).toFixed(2);
}
// Optical loss for one leg of an unbalanced tap, given that leg's power share %.
function tapLegLoss(percent, excess) {
  const p = Math.max(0.01, Math.min(100, Number(percent) || 0));
  return +(-10 * Math.log10(p / 100) + (Number(excess) || 0)).toFixed(2);
}

async function ensureDefaultLayer() {
  await pool.query(`INSERT INTO layer_groups(name,visible,sort_order) SELECT 'Default',true,0 WHERE NOT EXISTS (SELECT 1 FROM layer_groups WHERE name='Default')`);
  const g = await pool.query(`SELECT id FROM layer_groups WHERE name='Default' LIMIT 1`);
  if (g.rows[0]) {
    await pool.query(
      `INSERT INTO layers(group_id,name,visible,allowed_types,sort_order) VALUES($1,'Default',true,'{}',0) ON CONFLICT(group_id,name) DO NOTHING`,
      [g.rows[0].id]
    );
  }
}

app.get('/api/layer-groups', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.id, g.name, g.visible, g.sort_order,
        COALESCE(json_agg(l ORDER BY l.sort_order,l.id) FILTER (WHERE l.id IS NOT NULL),'[]') AS layers
      FROM layer_groups g
      LEFT JOIN layers l ON l.group_id=g.id
      GROUP BY g.id ORDER BY g.sort_order,g.id
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/layer-groups', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const r = await pool.query(
      `INSERT INTO layer_groups(name) VALUES($1) RETURNING id,name,visible,sort_order`, [name]
    );
    res.json({ ...r.rows[0], layers: [] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/layer-groups/:id', requireAuth, async (req, res) => {
  try {
    const { name, visible } = req.body;
    const sets = [];
    const vals = [];
    if (name !== undefined) { sets.push(`name=$${vals.length+1}`); vals.push(name); }
    if (visible !== undefined) { sets.push(`visible=$${vals.length+1}`); vals.push(visible); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE layer_groups SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id,name,visible,sort_order`, vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/layer-groups/:id', requireAdmin, async (req, res) => {
  try {
    const g = await pool.query(`SELECT name FROM layer_groups WHERE id=$1`, [req.params.id]);
    if (g.rows[0]?.name === 'Default') return res.status(400).json({ error: 'Cannot delete the Default group' });
    const layerRows = await pool.query(`SELECT id FROM layers WHERE group_id=$1`, [req.params.id]);
    const layerIds = layerRows.rows.map(r => r.id);
    if (layerIds.length) {
      await pool.query(`DELETE FROM poles    WHERE layer_id = ANY($1)`, [layerIds]);
      await pool.query(`DELETE FROM closures WHERE layer_id = ANY($1)`, [layerIds]);
      await pool.query(`DELETE FROM routes   WHERE layer_id = ANY($1)`, [layerIds]);
      await pool.query(`DELETE FROM sites    WHERE layer_id = ANY($1)`, [layerIds]);
    }
    await pool.query(`DELETE FROM layer_groups WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/layer-groups/:id/layers', requireAuth, async (req, res) => {
  try {
    const { name, allowed_types = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const valid = ['closure','route','pole','site'];
    const types = allowed_types.filter(t => valid.includes(t));
    const r = await pool.query(
      `INSERT INTO layers(group_id,name,allowed_types) VALUES($1,$2,$3) RETURNING id,group_id,name,visible,allowed_types,sort_order`,
      [req.params.id, name, types]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/layers/:id', requireAuth, async (req, res) => {
  try {
    const { name, visible, allowed_types } = req.body;
    const sets = [];
    const vals = [];
    if (name !== undefined) { sets.push(`name=$${vals.length+1}`); vals.push(name); }
    if (visible !== undefined) { sets.push(`visible=$${vals.length+1}`); vals.push(visible); }
    if (allowed_types !== undefined) {
      const valid = ['closure','route','pole','site'];
      sets.push(`allowed_types=$${vals.length+1}`);
      vals.push(allowed_types.filter(t => valid.includes(t)));
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE layers SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id,group_id,name,visible,allowed_types,sort_order`, vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/layers/:id', requireAdmin, async (req, res) => {
  try {
    // Protect Default layer
    const l = await pool.query(
      `SELECT l.name, g.name AS group_name FROM layers l JOIN layer_groups g ON g.id=l.group_id WHERE l.id=$1`, [req.params.id]
    );
    if (l.rows[0]?.group_name === 'Default' && l.rows[0]?.name === 'Default')
      return res.status(400).json({ error: 'Cannot delete the Default layer' });
    await pool.query(`DELETE FROM layers WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ============ START SERVER ============

app.listen(PORT, '0.0.0.0', async () => {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('Schema migration failed (some features may be unavailable):', err.message);
  }
  await ensureDefaultLayer();
  _pollTimer = setInterval(pollScheduler, 30000); // background optical polling
  console.log(`Open Fiber Map backend running on port ${PORT}`);
});
