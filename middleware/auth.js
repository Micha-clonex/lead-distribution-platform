const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
    if (!req.session || !req.session.adminId) {
        return res.redirect('/admin/login');
    }
    next();
}

// Middleware to check if user is already logged in (for login page)
function requireGuest(req, res, next) {
    if (req.session && req.session.adminId) {
        return res.redirect('/');
    }
    next();
}

// Hash password
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
}

// Compare password
async function comparePassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
}

// Get admin by username
async function getAdminByUsername(username) {
    const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    return result.rows[0];
}

// Create admin user
async function createAdmin(username, password, email) {
    const hashedPassword = await hashPassword(password);
    const result = await pool.query(
        'INSERT INTO admin_users (username, password, email) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
        [username, hashedPassword, email]
    );
    return result.rows[0];
}

module.exports = {
    requireAuth,
    requireGuest,
    hashPassword,
    comparePassword,
    getAdminByUsername,
    createAdmin
};