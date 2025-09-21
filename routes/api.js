const express = require('express');
const axios = require('axios');
const router = express.Router();
const { pool } = require('../server');

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
        setImmediate(() => distributeLead(leadId));
        
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

// Lead distribution function
async function distributeLead(leadId) {
    try {
        // Get lead details
        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        const lead = leadResult.rows[0];
        
        if (!lead) return;
        
        // Find eligible partners
        const partnersQuery = `
            SELECT p.*, COALESCE(ds.leads_received, 0) as todays_leads,
                   COALESCE(ds.premium_leads, 0) as todays_premium
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            WHERE p.status = 'active' 
                AND p.country = $1 
                AND p.niche = $2
                AND COALESCE(ds.leads_received, 0) < p.daily_limit
            ORDER BY COALESCE(ds.leads_received, 0) ASC, RANDOM()
        `;
        
        const partnersResult = await pool.query(partnersQuery, [lead.country, lead.niche]);
        
        if (partnersResult.rows.length === 0) {
            await pool.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
            return;
        }
        
        // Select partner based on premium/raw ratio
        let selectedPartner = partnersResult.rows[0];
        
        for (const partner of partnersResult.rows) {
            const premiumRatio = parseFloat(partner.premium_ratio);
            const currentPremiumRatio = partner.todays_leads > 0 ? 
                partner.todays_premium / partner.todays_leads : 0;
            
            if (lead.type === 'premium' && currentPremiumRatio < premiumRatio) {
                selectedPartner = partner;
                break;
            } else if (lead.type === 'raw' && currentPremiumRatio >= premiumRatio) {
                selectedPartner = partner;
                break;
            }
        }
        
        // Update lead assignment
        await pool.query(`
            UPDATE leads 
            SET assigned_partner_id = $1, status = 'distributed', distributed_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [selectedPartner.id, leadId]);
        
        // Update distribution stats
        await pool.query(`
            INSERT INTO distribution_stats (partner_id, date, leads_received, premium_leads, raw_leads)
            VALUES ($1, CURRENT_DATE, 1, $2, $3)
            ON CONFLICT (partner_id, date) 
            DO UPDATE SET 
                leads_received = distribution_stats.leads_received + 1,
                premium_leads = distribution_stats.premium_leads + $2,
                raw_leads = distribution_stats.raw_leads + $3
        `, [selectedPartner.id, lead.type === 'premium' ? 1 : 0, lead.type === 'raw' ? 1 : 0]);
        
        // Send webhook to partner
        await sendWebhook(lead, selectedPartner);
        
    } catch (error) {
        console.error('Lead distribution error:', error);
        await pool.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
    }
}

// Send webhook to partner
async function sendWebhook(lead, partner) {
    try {
        const payload = {
            lead_id: lead.id,
            first_name: lead.first_name,
            last_name: lead.last_name,
            email: lead.email,
            phone: lead.phone,
            country: lead.country,
            niche: lead.niche,
            type: lead.type,
            source: lead.source,
            timestamp: lead.created_at,
            postback_url: `${process.env.APP_URL || 'http://localhost:5000'}/api/postback/${partner.id}`
        };
        
        // Record webhook delivery attempt
        const deliveryResult = await pool.query(`
            INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING id
        `, [lead.id, partner.id, partner.webhook_url, JSON.stringify(payload)]);
        
        const deliveryId = deliveryResult.rows[0].id;
        
        // Send webhook
        const response = await axios.post(partner.webhook_url, payload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'LeadDistribution/1.0'
            }
        });
        
        // Update delivery status
        await pool.query(`
            UPDATE webhook_deliveries 
            SET status = 'success', response_code = $1, response_body = $2, delivered_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [response.status, response.data ? JSON.stringify(response.data) : '', deliveryId]);
        
        console.log(`Webhook delivered to ${partner.name} for lead ${lead.id}`);
        
    } catch (error) {
        console.error('Webhook delivery error:', error);
        
        // Update delivery status as failed
        await pool.query(`
            UPDATE webhook_deliveries 
            SET status = 'failed', response_code = $1, response_body = $2
            WHERE lead_id = $3 AND partner_id = $4 AND status = 'pending'
        `, [error.response?.status || 0, error.message, lead.id, partner.id]);
    }
}

module.exports = router;