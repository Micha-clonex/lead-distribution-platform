const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Apply authentication to all API settings routes
router.use(requireAuth);

// API Settings Management Page
router.get('/', async (req, res) => {
    try {
        const settings = await pool.query(`
            SELECT id, service_name, service_type, is_active, created_at, updated_at 
            FROM api_settings 
            ORDER BY service_type, service_name
        `);
        
        res.render('admin/api-settings', { 
            title: 'API Settings',
            settings: settings.rows
        });
    } catch (error) {
        console.error('API settings page error:', error);
        res.status(500).render('error', { error: 'Failed to load API settings' });
    }
});

// Get single API setting (with decrypted values)
router.get('/api/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const setting = await pool.query(`
            SELECT * FROM api_settings WHERE id = $1
        `, [id]);
        
        if (setting.rows.length === 0) {
            return res.status(404).json({ error: 'API setting not found' });
        }
        
        res.json(setting.rows[0]);
    } catch (error) {
        console.error('Get API setting error:', error);
        res.status(500).json({ error: 'Failed to fetch API setting' });
    }
});

// Create/Update API setting
router.post('/api', async (req, res) => {
    try {
        const { service_name, service_type, settings, is_active } = req.body;
        
        if (!service_name || !service_type || !settings) {
            return res.status(400).json({ error: 'Service name, type, and settings are required' });
        }
        
        // Upsert the API setting
        const result = await pool.query(`
            INSERT INTO api_settings (service_name, service_type, settings, is_active, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (service_name) 
            DO UPDATE SET 
                service_type = EXCLUDED.service_type,
                settings = EXCLUDED.settings,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()
            RETURNING id
        `, [service_name, service_type, JSON.stringify(settings), is_active !== false]);
        
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('Save API setting error:', error);
        res.status(500).json({ error: 'Failed to save API setting' });
    }
});

// Delete API setting
router.delete('/api/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(`
            DELETE FROM api_settings WHERE id = $1
        `, [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'API setting not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete API setting error:', error);
        res.status(500).json({ error: 'Failed to delete API setting' });
    }
});

// Test API connection
router.post('/api/:id/test', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get API setting
        const setting = await pool.query(`
            SELECT * FROM api_settings WHERE id = $1
        `, [id]);
        
        if (setting.rows.length === 0) {
            return res.status(404).json({ error: 'API setting not found' });
        }
        
        const apiSetting = setting.rows[0];
        
        // Test based on service type
        if (apiSetting.service_type === 'email') {
            const { sendTestEmail } = require('../services/emailService');
            const { test_email } = req.body;
            
            if (!test_email) {
                return res.status(400).json({ error: 'Test email address is required' });
            }
            
            // Temporarily set credentials for testing
            const originalToken = process.env.POSTMARK_SERVER_TOKEN;
            const originalFromEmail = process.env.POSTMARK_FROM_EMAIL;
            
            process.env.POSTMARK_SERVER_TOKEN = apiSetting.settings.server_token;
            process.env.POSTMARK_FROM_EMAIL = apiSetting.settings.from_email;
            
            try {
                await sendTestEmail(test_email, 'API Configuration Test', 'Your API settings are working correctly!');
                res.json({ success: true, message: 'Test email sent successfully' });
            } finally {
                // Restore original credentials
                if (originalToken) process.env.POSTMARK_SERVER_TOKEN = originalToken;
                else delete process.env.POSTMARK_SERVER_TOKEN;
                
                if (originalFromEmail) process.env.POSTMARK_FROM_EMAIL = originalFromEmail;
                else delete process.env.POSTMARK_FROM_EMAIL;
            }
        } else {
            res.status(400).json({ error: 'Testing not supported for this service type' });
        }
        
    } catch (error) {
        console.error('API test error:', error);
        res.status(500).json({ error: 'Failed to test API: ' + error.message });
    }
});

module.exports = router;