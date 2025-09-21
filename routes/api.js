const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { distributeLead } = require('../services/distribution');

// Authentication middleware for partner API endpoints
const authenticatePartner = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const apiKey = authHeader && authHeader.startsWith('Bearer ') 
            ? authHeader.substring(7) 
            : req.headers['x-api-key'];
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required. Provide in Authorization header or x-api-key header.' });
        }
        
        const result = await pool.query(`
            SELECT pak.partner_id, p.name as partner_name, p.status
            FROM partner_api_keys pak 
            JOIN partners p ON pak.partner_id = p.id
            WHERE pak.api_key = $1 AND pak.is_active = true AND p.status = 'active'
        `, [apiKey]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or inactive API key' });
        }
        
        req.partner = result.rows[0];
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

// Rate limiting store (simple in-memory - use Redis in production)
const rateLimitStore = new Map();
const rateLimit = (maxRequests = 50, windowMs = 60000) => {
    return (req, res, next) => {
        const key = req.ip + ':' + req.partner?.partner_id;
        const now = Date.now();
        const windowStart = now - windowMs;
        
        if (!rateLimitStore.has(key)) {
            rateLimitStore.set(key, []);
        }
        
        const requests = rateLimitStore.get(key);
        const recentRequests = requests.filter(time => time > windowStart);
        
        if (recentRequests.length >= maxRequests) {
            return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        }
        
        recentRequests.push(now);
        rateLimitStore.set(key, recentRequests);
        next();
    };
};

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

// Enhanced conversion tracking endpoint - Partners report detailed lead conversions
router.post('/conversion/:partnerId', authenticatePartner, rateLimit(50), async (req, res) => {
    try {
        const { partnerId } = req.params;
        const { lead_id, external_transaction_id, conversion_type, conversion_value, metadata } = req.body;
        
        // Verify partner matches authenticated partner
        if (parseInt(partnerId) !== req.partner.partner_id) {
            return res.status(403).json({ error: 'Cannot report conversions for other partners' });
        }
        
        // Verify lead exists and belongs to this partner
        const leadResult = await pool.query(
            'SELECT * FROM leads WHERE id = $1 AND assigned_partner_id = $2',
            [lead_id, partnerId]
        );
        
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found or not assigned to this partner' });
        }
        
        const lead = leadResult.rows[0];
        
        // Record conversion with idempotency protection
        try {
            await pool.query(`
                INSERT INTO lead_conversions (lead_id, partner_id, conversion_type, conversion_value, external_transaction_id, metadata)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [lead_id, partnerId, conversion_type, conversion_value || 0, external_transaction_id, JSON.stringify(metadata || {})]);
        } catch (duplicateError) {
            if (duplicateError.code === '23505') { // Unique constraint violation
                return res.json({
                    success: true,
                    message: 'Conversion already recorded (idempotent)',
                    lead_id: lead_id,
                    conversion_type: conversion_type
                });
            }
            throw duplicateError;
        }
        
        // Update lead status and value
        const statusHistory = Array.isArray(lead.status_history) ? lead.status_history : [];
        statusHistory.push({
            status: conversion_type,
            timestamp: new Date().toISOString(),
            value: conversion_value || 0,
            external_id: external_transaction_id
        });
        
        await pool.query(`
            UPDATE leads 
            SET conversion_value = COALESCE(conversion_value, 0) + $1,
                converted_at = CASE WHEN converted_at IS NULL AND $4 IN ('deposit', 'sale') THEN CURRENT_TIMESTAMP ELSE converted_at END,
                status_history = $2,
                quality_score = CASE 
                    WHEN $4 = 'qualified' THEN 25
                    WHEN $4 = 'demo' THEN 50  
                    WHEN $4 = 'deposit' THEN 75
                    WHEN $4 = 'sale' THEN 100
                    ELSE quality_score
                END
            WHERE id = $3
        `, [conversion_value || 0, JSON.stringify(statusHistory), lead_id, conversion_type]);
        
        res.json({
            success: true,
            message: 'Conversion recorded successfully',
            lead_id: lead_id,
            conversion_type: conversion_type,
            total_value: (lead.conversion_value || 0) + (conversion_value || 0)
        });
        
    } catch (error) {
        console.error('Conversion tracking error:', error);
        res.status(500).json({ error: 'Failed to record conversion' });
    }
});

// Lead status lookup endpoint - Get real-time lead status (Partner-scoped)
router.get('/lead/:leadId/status', authenticatePartner, rateLimit(100), async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const result = await pool.query(`
            SELECT l.*, p.name as partner_name,
                   COALESCE(
                       (SELECT COUNT(*) FROM lead_conversions WHERE lead_id = l.id), 0
                   ) as conversion_count
            FROM leads l
            LEFT JOIN partners p ON l.assigned_partner_id = p.id
            WHERE l.id = $1 AND l.assigned_partner_id = $2
        `, [leadId, req.partner.partner_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        
        const lead = result.rows[0];
        
        // Get conversion history
        const conversionsResult = await pool.query(`
            SELECT * FROM lead_conversions 
            WHERE lead_id = $1 
            ORDER BY created_at ASC
        `, [leadId]);
        
        res.json({
            success: true,
            lead: {
                id: lead.id,
                email: lead.email, // Only show email to assigned partner
                status: lead.status,
                quality_score: lead.quality_score,
                conversion_value: lead.conversion_value,
                converted_at: lead.converted_at,
                partner_name: lead.partner_name,
                status_history: lead.status_history || [],
                conversions: conversionsResult.rows,
                conversion_count: lead.conversion_count
            }
        });
        
    } catch (error) {
        console.error('Lead status lookup error:', error);
        res.status(500).json({ error: 'Failed to retrieve lead status' });
    }
});

// CPA Analytics endpoint - Real-time performance metrics (Partner-scoped)
router.get('/analytics/cpa', authenticatePartner, rateLimit(20), async (req, res) => {
    try {
        const { date_from, date_to } = req.query;
        
        // Only show analytics for the authenticated partner
        let whereClause = `l.assigned_partner_id = $1`;
        const params = [req.partner.partner_id];
        let paramCount = 1;
        
        if (date_from) {
            whereClause += ` AND l.created_at >= $${++paramCount}`;
            params.push(date_from);
        }
        
        if (date_to) {
            whereClause += ` AND l.created_at <= $${++paramCount}`;
            params.push(date_to);
        }
        
        const analyticsQuery = `
            WITH lead_stats AS (
                SELECT 
                    p.id as partner_id,
                    p.name as partner_name,
                    COUNT(l.id) as total_leads,
                    COUNT(CASE WHEN l.converted_at IS NOT NULL THEN 1 END) as conversions,
                    COALESCE(SUM(l.conversion_value), 0) as revenue,
                    AVG(l.quality_score) as avg_quality_score,
                    COUNT(CASE WHEN l.quality_score >= 75 THEN 1 END) as high_quality_leads
                FROM leads l
                JOIN partners p ON l.assigned_partner_id = p.id
                WHERE ${whereClause}
                GROUP BY p.id, p.name
            )
            SELECT 
                *,
                CASE WHEN total_leads > 0 THEN 
                    ROUND((conversions::decimal / total_leads * 100), 2) 
                ELSE 0 END as conversion_rate,
                CASE WHEN conversions > 0 THEN 
                    ROUND(revenue / conversions, 2) 
                ELSE 0 END as avg_conversion_value
            FROM lead_stats
            ORDER BY revenue DESC
        `;
        
        const result = await pool.query(analyticsQuery, params);
        
        res.json({
            success: true,
            analytics: result.rows,
            summary: {
                total_partners: result.rows.length,
                total_leads: result.rows.reduce((sum, row) => sum + parseInt(row.total_leads), 0),
                total_conversions: result.rows.reduce((sum, row) => sum + parseInt(row.conversions), 0),
                total_revenue: result.rows.reduce((sum, row) => sum + parseFloat(row.revenue), 0),
                overall_conversion_rate: result.rows.length > 0 ? 
                    result.rows.reduce((sum, row) => sum + parseFloat(row.conversion_rate), 0) / result.rows.length : 0
            }
        });
        
    } catch (error) {
        console.error('CPA analytics error:', error);
        res.status(500).json({ error: 'Failed to retrieve CPA analytics' });
    }
});

module.exports = router;