const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const axios = require('axios');

// Get all partners
router.get('/', async (req, res) => {
    try {
        const { country, niche, status } = req.query;
        let query = 'SELECT * FROM partners WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (country) {
            query += ` AND country = $${++paramCount}`;
            params.push(country);
        }
        if (niche) {
            query += ` AND niche = $${++paramCount}`;
            params.push(niche);
        }
        if (status) {
            query += ` AND status = $${++paramCount}`;
            params.push(status);
        }

        query += ' ORDER BY created_at DESC';
        
        const result = await pool.query(query, params);
        
        // Get today's performance statistics for each partner
        const statsQuery = `
            SELECT 
                p.id, p.premium_ratio as target_ratio,
                COALESCE(ds.leads_received, 0) as leads_received, 
                COALESCE(ds.premium_leads, 0) as premium_leads,
                CASE 
                    WHEN COALESCE(ds.leads_received, 0) > 0 
                    THEN COALESCE(ds.premium_leads, 0)::decimal / COALESCE(ds.leads_received, 0) 
                    ELSE 0 
                END as actual_ratio
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            WHERE p.id = ANY($1)
        `;
        const partnerIds = result.rows.map(p => p.id);
        const statsResult = partnerIds.length > 0 ? await pool.query(statsQuery, [partnerIds]) : { rows: [] };
        
        // Merge stats with partner data
        const partnersWithStats = result.rows.map(partner => {
            const stats = statsResult.rows.find(s => s.id === partner.id) || {};
            return {
                ...partner,
                todays_leads: stats.leads_received || 0,
                todays_premium: stats.premium_leads || 0,
                actual_ratio: stats.actual_ratio || 0,
                target_ratio: stats.target_ratio || partner.premium_ratio
            };
        });
        
        res.render('partners/index', { 
            partners: partnersWithStats,
            title: 'Partner Management',
            countries: ['germany', 'austria', 'spain', 'canada', 'italy', 'uk', 'norway'],
            niches: ['forex', 'recovery'],
            // Pass current query parameters for filter selection
            currentFilters: {
                country: country || '',
                niche: niche || '',
                status: status || ''
            }
        });
    } catch (error) {
        console.error('Partners fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch partners' });
    }
});

// Add new partner
router.post('/', async (req, res) => {
    try {
        const { name, email, country, niche, webhook_url, daily_limit, premium_ratio, timezone } = req.body;
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio ? (parseFloat(premium_ratio) / 100) : 0.70;
        
        await pool.query(`
            INSERT INTO partners (name, email, country, niche, webhook_url, daily_limit, premium_ratio, timezone)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [name, email, country, niche, webhook_url, daily_limit || 50, ratioDecimal, timezone || 'UTC']);
        
        res.redirect('/partners?success=Partner added successfully');
    } catch (error) {
        console.error('Partner creation error:', error);
        res.redirect('/partners?error=Failed to add partner');
    }
});

// Update partner
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, country, niche, webhook_url, daily_limit, premium_ratio, status, timezone } = req.body;
        
        // Validate premium_ratio
        if (premium_ratio !== undefined && premium_ratio !== null && premium_ratio !== '') {
            const ratio = parseFloat(premium_ratio);
            if (isNaN(ratio) || ratio < 0 || ratio > 100) {
                return res.status(400).json({ success: false, error: 'Premium ratio must be between 0 and 100' });
            }
        }
        
        // Validate daily_limit  
        if (daily_limit !== undefined && daily_limit !== null && daily_limit !== '') {
            const limit = parseInt(daily_limit);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ success: false, error: 'Daily limit must be at least 1' });
            }
        }
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio && premium_ratio !== '' ? (parseFloat(premium_ratio) / 100) : null;
        
        await pool.query(`
            UPDATE partners 
            SET name = $1, email = $2, country = $3, niche = $4, webhook_url = $5, 
                daily_limit = $6, premium_ratio = $7, status = $8, timezone = $9, updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
        `, [name, email, country, niche, webhook_url, daily_limit, ratioDecimal, status, timezone, id]);
        
        res.json({ success: true, message: 'Partner updated successfully' });
    } catch (error) {
        console.error('Partner update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update partner' });
    }
});

// Delete partner
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM partners WHERE id = $1', [id]);
        res.json({ success: true, message: 'Partner deleted successfully' });
    } catch (error) {
        console.error('Partner deletion error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete partner' });
    }
});

// CRM Integration endpoints  
router.get('/:id/crm-integration', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(
            'SELECT id, partner_id, crm_name, api_endpoint, auth_header, request_method, test_url, request_headers, field_mapping, is_active, created_at, updated_at, CASE WHEN api_key IS NOT NULL AND api_key != \'\' THEN true ELSE false END as api_key_set FROM partner_crm_integrations WHERE partner_id = $1',
            [id]
        );
        
        const integration = result.rows[0];
        
        res.json({
            success: true,
            integration: integration || null
        });
    } catch (error) {
        console.error('Get CRM integration error:', error);
        res.status(500).json({ error: 'Failed to get CRM integration' });
    }
});

router.post('/:id/crm-integration', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            crm_name,
            api_endpoint,
            api_key,
            auth_header,
            request_method,
            test_url,
            request_headers,
            field_mapping,
            is_active
        } = req.body;
        
        // Validate API endpoint URL
        if (api_endpoint) {
            try {
                const url = new URL(api_endpoint);
                if (url.protocol !== 'https:') {
                    return res.status(400).json({ error: 'Only HTTPS endpoints are allowed' });
                }
            } catch (e) {
                return res.status(400).json({ error: 'Invalid API endpoint URL format' });
            }
        }
        
        // Validate request method
        const allowedMethods = ['POST', 'PUT'];
        if (request_method && !allowedMethods.includes(request_method.toUpperCase())) {
            return res.status(400).json({ error: 'Invalid request method. Only POST and PUT are allowed.' });
        }
        
        // Check if integration already exists
        const existingResult = await pool.query(
            'SELECT id FROM partner_crm_integrations WHERE partner_id = $1',
            [id]
        );
        
        if (existingResult.rows.length > 0) {
            // Update existing integration - only update API key if provided
            if (api_key && api_key.trim()) {
                await pool.query(`
                    UPDATE partner_crm_integrations 
                    SET crm_name = $1, api_endpoint = $2, api_key = $3, auth_header = $4,
                        request_method = $5, test_url = $6, request_headers = $7,
                        field_mapping = $8, is_active = $9, updated_at = CURRENT_TIMESTAMP
                    WHERE partner_id = $10
                `, [crm_name, api_endpoint, api_key, auth_header, request_method, 
                    test_url, JSON.stringify(request_headers), JSON.stringify(field_mapping), 
                    is_active, id]);
            } else {
                // Don't update API key if empty (keep existing)
                await pool.query(`
                    UPDATE partner_crm_integrations 
                    SET crm_name = $1, api_endpoint = $2, auth_header = $3,
                        request_method = $4, test_url = $5, request_headers = $6,
                        field_mapping = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
                    WHERE partner_id = $9
                `, [crm_name, api_endpoint, auth_header, request_method, 
                    test_url, JSON.stringify(request_headers), JSON.stringify(field_mapping), 
                    is_active, id]);
            }
        } else {
            // Create new integration - require API key
            if (!api_key || !api_key.trim()) {
                return res.status(400).json({ error: 'API key is required for new integrations' });
            }
            await pool.query(`
                INSERT INTO partner_crm_integrations 
                (partner_id, crm_name, api_endpoint, api_key, auth_header, request_method,
                 test_url, request_headers, field_mapping, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [id, crm_name, api_endpoint, api_key, auth_header, request_method,
                test_url, JSON.stringify(request_headers), JSON.stringify(field_mapping), 
                is_active]);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Save CRM integration error:', error);
        res.status(500).json({ error: 'Failed to save CRM integration' });
    }
});

router.post('/:id/test-crm', async (req, res) => {
    try {
        const { api_endpoint, api_key, auth_header, request_method } = req.body;
        
        // Basic SSRF protection - validate URL
        if (!api_endpoint || typeof api_endpoint !== 'string') {
            return res.json({ success: false, error: 'Invalid API endpoint' });
        }
        
        let url;
        try {
            url = new URL(api_endpoint);
        } catch (e) {
            return res.json({ success: false, error: 'Invalid URL format' });
        }
        
        // Only allow HTTPS and standard ports for security
        if (url.protocol !== 'https:') {
            return res.json({ success: false, error: 'Only HTTPS endpoints are allowed' });
        }
        
        // Block private IP ranges (basic protection)
        const hostname = url.hostname;
        if (hostname === 'localhost' || hostname.match(/^127\./) || 
            hostname.match(/^192\.168\./) || hostname.match(/^10\./) || 
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
            hostname.match(/^0\./) || hostname === '::1') {
            return res.json({ success: false, error: 'Private IP addresses not allowed' });
        }
        
        // Validate method
        const allowedMethods = ['POST', 'PUT'];
        if (!allowedMethods.includes(request_method?.toUpperCase())) {
            return res.json({ success: false, error: 'Invalid request method' });
        }
        
        const testPayload = {
            firstName: 'John',
            lastName: 'Doe',
            email: 'test@example.com',
            phone: '+1234567890',
            country: 'test',
            source: 'Lead Platform Test'
        };
        
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (auth_header && api_key) {
            headers[auth_header] = api_key;
        }
        
        const response = await axios({
            method: request_method.toLowerCase(),
            url: api_endpoint,
            headers: headers,
            data: testPayload,
            timeout: 10000,
            maxRedirects: 0, // Prevent redirect attacks
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        });
        
        if (response.status >= 200 && response.status < 400) {
            res.json({ success: true, status: response.status });
        } else {
            res.json({ 
                success: false, 
                error: `HTTP ${response.status}: ${response.statusText}` 
            });
        }
    } catch (error) {
        console.error('Test CRM error:', error);
        res.json({ 
            success: false, 
            error: error.code === 'ECONNABORTED' ? 'Connection timeout' : 'Connection failed'
        });
    }
});

// Status tracking endpoint for admin interface
router.get('/:id/status-tracking', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get partner summary stats
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(l.id) as total_leads,
                COUNT(CASE WHEN lsu.status = 'converted' THEN 1 END) as conversions,
                SUM(lsu.conversion_value) as total_revenue,
                AVG(lsu.quality_score) as avg_quality,
                CASE 
                    WHEN COUNT(l.id) > 0 THEN 
                        ROUND((COUNT(CASE WHEN lsu.status = 'converted' THEN 1 END)::decimal / COUNT(l.id) * 100), 2)
                    ELSE 0 
                END as conversion_rate
            FROM leads l
            LEFT JOIN lead_status_updates lsu ON l.id = lsu.lead_id
            WHERE l.assigned_partner_id = $1 
              AND l.created_at > NOW() - INTERVAL '30 days'
        `, [id]);
        
        // Get recent status updates
        const updatesResult = await pool.query(`
            SELECT lsu.*, l.email as lead_email
            FROM lead_status_updates lsu
            JOIN leads l ON lsu.lead_id = l.id
            WHERE lsu.partner_id = $1
            ORDER BY lsu.created_at DESC
            LIMIT 50
        `, [id]);
        
        // Get postback configuration
        const postbackResult = await pool.query(
            'SELECT postback_token, is_active FROM partner_postback_config WHERE partner_id = $1',
            [id]
        );
        
        res.json({
            success: true,
            summary: summaryResult.rows[0] || {},
            recent_updates: updatesResult.rows,
            postback_config: postbackResult.rows[0] || null
        });
        
    } catch (error) {
        console.error('Status tracking error:', error);
        res.status(500).json({ error: 'Failed to get status tracking data' });
    }
});

module.exports = router;