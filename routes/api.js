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

// Enhanced conversion tracking endpoint - Partners report detailed lead conversions
router.post('/conversion/:partnerId', async (req, res) => {
    try {
        const { partnerId } = req.params;
        const { lead_id, external_transaction_id, conversion_type, conversion_value, metadata } = req.body;
        
        // Verify partner exists and is active
        const partnerResult = await pool.query(
            'SELECT * FROM partners WHERE id = $1 AND status = $2',
            [partnerId, 'active']
        );
        
        if (partnerResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or inactive partner' });
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
        
        // Record conversion
        await pool.query(`
            INSERT INTO lead_conversions (lead_id, partner_id, conversion_type, conversion_value, external_transaction_id, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [lead_id, partnerId, conversion_type, conversion_value || 0, external_transaction_id, JSON.stringify(metadata || {})]);
        
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

// Lead status lookup endpoint - Get real-time lead status
router.get('/lead/:leadId/status', async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const result = await pool.query(`
            SELECT l.*, p.name as partner_name,
                   COALESCE(
                       (SELECT COUNT(*) FROM lead_conversions WHERE lead_id = l.id), 0
                   ) as conversion_count
            FROM leads l
            LEFT JOIN partners p ON l.assigned_partner_id = p.id
            WHERE l.id = $1
        `, [leadId]);
        
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
                email: lead.email,
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

// CPA Analytics endpoint - Real-time performance metrics
router.get('/analytics/cpa', async (req, res) => {
    try {
        const { partner_id, date_from, date_to } = req.query;
        
        let whereClause = '1=1';
        const params = [];
        let paramCount = 0;
        
        if (partner_id) {
            whereClause += ` AND l.assigned_partner_id = $${++paramCount}`;
            params.push(partner_id);
        }
        
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