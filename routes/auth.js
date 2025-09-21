const express = require('express');
const router = express.Router();
const { requireGuest, getAdminByUsername, comparePassword } = require('../middleware/auth');

// Login page
router.get('/login', requireGuest, (req, res) => {
    res.render('auth/login', { 
        layout: false,  // Disable layout for login page
        title: 'Admin Login',
        error: req.query.error 
    });
});

// Login process
router.post('/login', requireGuest, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.redirect('/admin/login?error=Username and password are required');
        }
        
        // Get admin user
        const admin = await getAdminByUsername(username);
        if (!admin) {
            return res.redirect('/admin/login?error=Invalid username or password');
        }
        
        // Check password
        const isValidPassword = await comparePassword(password, admin.password);
        if (!isValidPassword) {
            return res.redirect('/admin/login?error=Invalid username or password');
        }
        
        // Set session
        req.session.adminId = admin.id;
        req.session.adminUsername = admin.username;
        req.session.adminEmail = admin.email;
        
        res.redirect('/');
    } catch (error) {
        console.error('Login error:', error);
        res.redirect('/admin/login?error=Login failed. Please try again.');
    }
});

// Logout
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/admin/login');
    });
});

// Create first admin user (should be removed in production)
router.post('/setup', async (req, res) => {
    try {
        const { createAdmin } = require('../middleware/auth');
        
        // Check if any admin users exist
        const { pool } = require('../config/db');
        const existingAdmins = await pool.query('SELECT COUNT(*) as count FROM admin_users');
        
        if (existingAdmins.rows[0].count > 0) {
            return res.status(400).json({ error: 'Admin users already exist' });
        }
        
        const { username, password, email } = req.body;
        
        if (!username || !password || !email) {
            return res.status(400).json({ error: 'Username, password, and email are required' });
        }
        
        const admin = await createAdmin(username, password, email);
        res.json({ success: true, message: 'Admin user created successfully', admin: { id: admin.id, username: admin.username, email: admin.email } });
        
    } catch (error) {
        console.error('Setup error:', error);
        res.status(500).json({ error: 'Failed to create admin user' });
    }
});

module.exports = router;