const express = require('express');
const router = express.Router();
const { requireGuest, getAdminByUsername, comparePassword } = require('../middleware/auth');

// Login page
router.get('/login', requireGuest, (req, res) => {
    res.render('auth/login', { 
        layout: false,  // Disable layout for login page
        title: 'Admin Login',
        error: req.query.error,
        success: req.query.success
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

// Setup page (GET) - shows form to create first admin user
router.get('/setup', async (req, res) => {
    try {
        const { pool } = require('../config/db');
        const existingAdmins = await pool.query('SELECT COUNT(*) as count FROM admin_users');
        
        if (existingAdmins.rows[0].count > 0) {
            return res.redirect('/admin/login?error=Admin users already exist');
        }
        
        res.render('auth/setup', { 
            layout: false,
            title: 'Admin Setup',
            error: req.query.error 
        });
    } catch (error) {
        console.error('Setup page error:', error);
        res.redirect('/admin/login?error=Setup page unavailable');
    }
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
            return res.redirect('/admin/setup?error=Username, password, and email are required');
        }
        
        const admin = await createAdmin(username, password, email);
        console.log('✅ First admin user created:', { id: admin.id, username: admin.username, email: admin.email });
        res.redirect('/admin/login?success=Admin user created successfully. Please login.');
        
    } catch (error) {
        console.error('Setup error:', error);
        res.redirect('/admin/setup?error=Failed to create admin user. Please try again.');
    }
});

module.exports = router;