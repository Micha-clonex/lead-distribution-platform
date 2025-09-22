const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');

// Get webhook sources and deliveries
router.get('/', async (req, res) => {
    try {
        // Get webhook sources with lead count
        const sourcesResult = await pool.query(`
            SELECT ws.*, 
                   COALESCE((SELECT COUNT(*) FROM leads l WHERE l.source = ws.name), 0) as leads_received
            FROM webhook_sources ws 
            ORDER BY ws.created_at DESC
        `);
        
        const deliveriesResult = await pool.query(`
            SELECT wd.*, p.name as partner_name, l.email as lead_email 
            FROM webhook_deliveries wd
            JOIN partners p ON wd.partner_id = p.id
            JOIN leads l ON wd.lead_id = l.id
            ORDER BY wd.created_at DESC
            LIMIT 100
        `);
        
        res.render('webhooks/index', {
            title: 'Webhook Management',
            sources: sourcesResult.rows,
            deliveries: deliveriesResult.rows
        });
    } catch (error) {
        console.error('Webhooks fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch webhook data' });
    }
});

// Create new webhook source
router.post('/sources', async (req, res) => {
    try {
        const { name, source_type, country, niche, lead_type, description } = req.body;
        
        // Validate required fields
        if (!country || !niche || !lead_type) {
            return res.redirect('/webhooks?error=Country, Niche, and Lead Type are required fields');
        }
        
        // Validate lead_type
        if (!['premium', 'raw'].includes(lead_type)) {
            return res.redirect('/webhooks?error=Lead Type must be either premium or raw');
        }
        
        const webhook_token = crypto.randomBytes(32).toString('hex');
        
        await pool.query(`
            INSERT INTO webhook_sources (name, source_type, country, niche, lead_type, description, webhook_token)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [name, source_type, country, niche, lead_type, description, webhook_token]);
        
        res.redirect('/webhooks?success=Webhook source created successfully');
    } catch (error) {
        console.error('Webhook source creation error:', error);
        res.redirect('/webhooks?error=Failed to create webhook source');
    }
});

// Toggle webhook source status
router.put('/sources/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(`
            UPDATE webhook_sources 
            SET is_active = NOT is_active 
            WHERE id = $1
        `, [id]);
        
        res.json({ success: true, message: 'Webhook source status updated' });
    } catch (error) {
        console.error('Webhook toggle error:', error);
        res.status(500).json({ success: false, error: 'Failed to update webhook source' });
    }
});

// Get detailed delivery information
router.get('/deliveries/:id', async (req, res) => {
    try {
        const deliveryId = req.params.id;
        
        const delivery = await pool.query(`
            SELECT wd.*, 
                   p.name as partner_name, p.webhook_url, p.country as partner_country, p.niche as partner_niche,
                   l.first_name, l.last_name, l.email, l.phone, l.country as lead_country, 
                   l.niche as lead_niche, l.type, l.source, l.created_at as lead_created_at
            FROM webhook_deliveries wd
            JOIN partners p ON wd.partner_id = p.id
            JOIN leads l ON wd.lead_id = l.id
            WHERE wd.id = $1
        `, [deliveryId]);
        
        if (delivery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }
        
        const deliveryData = delivery.rows[0];
        
        // Fix JSON parsing issues with payload
        if (deliveryData.payload) {
            try {
                // Handle double-encoded JSON
                if (typeof deliveryData.payload === 'string') {
                    deliveryData.payload = JSON.parse(deliveryData.payload);
                }
            } catch (e) {
                console.error('Payload JSON parsing error:', e);
                deliveryData.payload = { error: 'Invalid JSON payload' };
            }
        }
        
        // Fix JSON parsing issues with response_body
        if (deliveryData.response_body) {
            try {
                if (typeof deliveryData.response_body === 'string') {
                    deliveryData.response_body = JSON.parse(deliveryData.response_body);
                }
            } catch (e) {
                // Keep as string if it's not valid JSON
                // deliveryData.response_body remains as string
            }
        }
        
        res.json({ success: true, delivery: deliveryData });
    } catch (error) {
        console.error('Error fetching delivery details:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;