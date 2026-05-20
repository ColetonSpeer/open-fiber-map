require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const username = process.argv[2];
const password = process.argv[3];
if (!username || !password) {
  console.log('Usage: node create-admin.js <username> <password>');
  process.exit(1);
}
(async () => {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)',
    [username, hash, username, 'admin']
  );
  console.log('Admin user created:', username);
  process.exit(0);
})();
