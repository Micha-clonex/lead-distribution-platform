const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { distributeLead } = require('../services/distribution');

// Inbound webhook endpoint for receiving leads
router.post('/webhook/:token', async (req, res) => {
    try {
        const { token } = req.params;
        
        // Verify webhook token
        const sourceResult = await pool.query(
            'SELECT * FROM webhook_sources WHERE webhook_token = $1 AND is_active = true',
            [token]
        );
        
        if (sourceResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid webhook token' });
        }
        
        const source = sourceResult.rows[0];
        const leadData = req.body;
        
        // Extract and normalize lead data based on source type
        let normalizedData = {};
        
        if (source.source_type === 'facebook') {
            normalizedData = {
                first_name: leadData.first_name || leadData.firstName,
                last_name: leadData.last_name || leadData.lastName,
                email: leadData.email,
                phone: leadData.phone || leadData.phone_number,
                country: leadData.country || 'unknown',
                niche: leadData.niche || 'forex',
                type: leadData.type || 'raw'
            };
        } else if (source.source_type === 'landing_page') {
            normalizedData = {
                first_name: leadData.first_name,
                last_name: leadData.last_name,
                email: leadData.email,
                phone: leadData.phone,
                country: leadData.country,
                niche: leadData.niche,
                type: leadData.type || 'premium'
            };
        } else {
            // Generic format
            normalizedData = leadData;
        }
        
        // Insert lead into database
        const leadResult = await pool.query(`
            INSERT INTO leads (source, type, niche, country, first_name, last_name, email, phone, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            source.name,
            normalizedData.type || 'raw',
            normalizedData.niche || 'forex',
            normalizedData.country || 'unknown',
            normalizedData.first_name,
            normalizedData.last_name,
            normalizedData.email,
            normalizedData.phone,
            JSON.stringify(leadData)
        ]);
        
        const leadId = leadResult.rows[0].id;
        
        // Trigger distribution asynchronously
        setImmediate(() => {
            distributeLead(leadId).catch(error => {
                console.error(`Distribution failed for lead ${leadId}:`, error);
            });
        });
        
        res.json({ 
            success: true, 
            lead_id: leadId,
            message: 'Lead received and queued for distribution' 
        });
        
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});

// Postback endpoint for conversion tracking
router.post('/postback/:partner_id', async (req, res) => {
    try {
        const { partner_id } = req.params;
        const { lead_id, status, value, data } = req.body;
        
        // Verify partner exists
        const partnerResult = await pool.query('SELECT * FROM partners WHERE id = $1', [partner_id]);
        if (partnerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Partner not found' });
        }
        
        // Update lead status if converted
        if (status === 'converted') {
            await pool.query(`
                UPDATE leads 
                SET status = 'converted', converted_at = CURRENT_TIMESTAMP 
                WHERE id = $1 AND assigned_partner_id = $2
            `, [lead_id, partner_id]);
            
            // Record conversion
            await pool.query(`
                INSERT INTO conversions (lead_id, partner_id, conversion_value, conversion_data, postback_url)
                VALUES ($1, $2, $3, $4, $5)
            `, [lead_id, partner_id, value || 0, JSON.stringify(data || {}), req.url]);
            
            // Update distribution stats
            await pool.query(`
                UPDATE distribution_stats 
                SET conversions = conversions + 1, revenue = revenue + $1
                WHERE partner_id = $2 AND date = CURRENT_DATE
            `, [value || 0, partner_id]);
        }
        
        res.json({ success: true, message: 'Postback processed successfully' });
        
    } catch (error) {
        console.error('Postback processing error:', error);
        res.status(500).json({ error: 'Failed to process postback' });
    }
});


module.exports = router;