const express = require('express');
const router = express.Router();
const { pool } = require('../server');

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
            statuses: ['pending', 'distributed', 'converted', 'failed']
        });
    } catch (error) {
        console.error('Leads fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch leads' });
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
        
        // Trigger distribution
        await distributeLead(leadId);
        
        res.redirect('/leads?success=Lead injected and distributed successfully');
    } catch (error) {
        console.error('Lead injection error:', error);
        res.redirect('/leads?error=Failed to inject lead');
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
        let selectedPartner = null;
        
        for (const partner of partnersResult.rows) {
            const premiumRatio = parseFloat(partner.premium_ratio);
            const currentPremiumRatio = partner.todays_leads > 0 ? 
                partner.todays_premium / partner.todays_leads : 0;
            
            if (lead.type === 'premium') {
                if (currentPremiumRatio < premiumRatio) {
                    selectedPartner = partner;
                    break;
                }
            } else {
                const rawRatio = 1 - premiumRatio;
                const currentRawRatio = 1 - currentPremiumRatio;
                if (currentRawRatio < rawRatio) {
                    selectedPartner = partner;
                    break;
                }
            }
        }
        
        // Fallback to first available partner if ratio-based selection fails
        if (!selectedPartner) {
            selectedPartner = partnersResult.rows[0];
        }
        
        // Update lead and send webhook
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
        
        // Send webhook (implement webhook delivery)
        console.log(`Lead ${leadId} distributed to partner ${selectedPartner.name}`);
        
    } catch (error) {
        console.error('Lead distribution error:', error);
        await pool.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
    }
}

module.exports = router;