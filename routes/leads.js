const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { distributeLead } = require('../services/distribution');

// Get all leads
router.get('/', async (req, res) => {
    try {
        const { status, niche, country, type } = req.query;
        let query = `
            SELECT l.*, p.name as partner_name 
            FROM leads l 
            LEFT JOIN partners p ON l.assigned_partner_id = p.id 
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;

        if (status) {
            query += ` AND l.status = $${++paramCount}`;
            params.push(status);
        }
        if (niche) {
            query += ` AND l.niche = $${++paramCount}`;
            params.push(niche);
        }
        if (country) {
            query += ` AND l.country = $${++paramCount}`;
            params.push(country);
        }
        if (type) {
            query += ` AND l.type = $${++paramCount}`;
            params.push(type);
        }

        query += ' ORDER BY l.created_at DESC LIMIT 500';
        
        const result = await pool.query(query, params);
        res.render('leads/index', { 
            leads: result.rows,
            title: 'Lead Management',
            countries: ['germany', 'austria', 'spain', 'canada', 'italy', 'uk', 'norway'],
            niches: ['forex', 'recovery'],
            types: ['premium', 'raw'],
            statuses: ['pending', 'distributed', 'converted', 'failed'],
            // Pass current query parameters for filter selection
            currentFilters: {
                status: status || '',
                country: country || '',
                niche: niche || '',
                type: type || ''
            }
        });
    } catch (error) {
        console.error('Leads fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch leads' });
    }
});

// Get single lead details
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT l.*, p.name as partner_name, p.webhook_url as partner_webhook_url,
                   ws.name as source_name, ws.description as source_description
            FROM leads l 
            LEFT JOIN partners p ON l.assigned_partner_id = p.id
            LEFT JOIN webhook_sources ws ON l.source = ws.name
            WHERE l.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        
        const lead = result.rows[0];
        
        // Get webhook delivery history for this lead
        const deliveriesResult = await pool.query(`
            SELECT wd.*, p.name as partner_name
            FROM webhook_deliveries wd
            JOIN partners p ON wd.partner_id = p.id
            WHERE wd.lead_id = $1
            ORDER BY wd.created_at DESC
        `, [id]);
        
        lead.deliveries = deliveriesResult.rows;
        
        res.json({ success: true, lead });
    } catch (error) {
        console.error('Lead details fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch lead details' });
    }
});

// Manual lead injection
router.post('/inject', async (req, res) => {
    try {
        const { source, type, niche, country, first_name, last_name, email, phone, data } = req.body;
        
        const result = await pool.query(`
            INSERT INTO leads (source, type, niche, country, first_name, last_name, email, phone, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [source, type, niche, country, first_name, last_name, email, phone, JSON.stringify(data || {})]);
        
        const leadId = result.rows[0].id;
        
        // Trigger distribution asynchronously
        setImmediate(() => {
            distributeLead(leadId).catch(error => {
                console.error(`Distribution failed for lead ${leadId}:`, error);
            });
        });
        
        res.redirect('/leads?success=Lead injected and distributed successfully');
    } catch (error) {
        console.error('Lead injection error:', error);
        res.redirect('/leads?error=Failed to inject lead');
    }
});


module.exports = router;