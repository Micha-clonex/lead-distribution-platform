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
        // Use partner ID for authenticated endpoints, IP for unauthenticated
        const key = req.partner ? `partner:${req.partner.partner_id}` : `ip:${req.ip}`;
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

// Webhook-specific rate limiting (per token)
const webhookRateLimit = (maxRequests = 200, windowMs = 60000) => {
    return (req, res, next) => {
        const key = 'webhook:' + (req.params.token || req.ip);
        const now = Date.now();
        const windowStart = now - windowMs;
        
        if (!rateLimitStore.has(key)) {
            rateLimitStore.set(key, []);
        }
        
        const requests = rateLimitStore.get(key);
        const recentRequests = requests.filter(time => time > windowStart);
        
        if (recentRequests.length >= maxRequests) {
            return res.status(429).json({ error: 'Webhook rate limit exceeded. Try again later.' });
        }
        
        recentRequests.push(now);
        rateLimitStore.set(key, recentRequests);
        next();
    };
};

// Inbound webhook endpoint for receiving leads
router.post('/webhook/:token', webhookRateLimit(200), async (req, res) => {
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
        
        // **ENHANCED: Use webhook source lead_type for automatic premium/raw identification**
        if (source.source_type === 'facebook') {
            normalizedData = {
                first_name: leadData.first_name || leadData.firstName,
                last_name: leadData.last_name || leadData.lastName,
                email: leadData.email,
                phone: leadData.phone || leadData.phone_number,
                country: leadData.country,
                niche: leadData.niche || 'forex',
                type: leadData.type || source.lead_type || 'raw', // Use source's configured lead type
                utm_source: leadData.utm_source,
                utm_campaign: leadData.utm_campaign,
                utm_medium: leadData.utm_medium,
                landing_page_url: leadData.landing_page_url,
                // **NEW: Recovery-specific fields**
                amount_lost: leadData.amount_lost || leadData.amountLost,
                fraud_type: leadData.fraud_type || leadData.fraudType || leadData.type_of_fraud
            };
        } else if (source.source_type === 'landing_page') {
            normalizedData = {
                first_name: leadData.first_name,
                last_name: leadData.last_name,
                email: leadData.email,
                phone: leadData.phone,
                country: leadData.country, // May be empty from landing page
                niche: leadData.niche,
                type: leadData.type || source.lead_type || 'premium', // Use source's configured lead type
                utm_source: leadData.utm_source,
                utm_campaign: leadData.utm_campaign,
                utm_medium: leadData.utm_medium,
                landing_page_url: leadData.landing_page_url || leadData.page_url,
                // **NEW: Recovery-specific fields**
                amount_lost: leadData.amount_lost || leadData.amountLost,
                fraud_type: leadData.fraud_type || leadData.fraudType || leadData.type_of_fraud
            };
        } else {
            // Generic format - use source's lead_type
            normalizedData = {
                ...leadData,
                type: leadData.type || source.lead_type || 'raw',
                // **NEW: Recovery-specific fields**
                amount_lost: leadData.amount_lost || leadData.amountLost,
                fraud_type: leadData.fraud_type || leadData.fraudType || leadData.type_of_fraud
            };
        }
        
        // **NEW: Data Enrichment** - Automatically fill missing fields
        const { enrichLeadData } = require('../services/dataEnrichment');
        const enrichedData = await enrichLeadData(normalizedData, source);
        
        // **CRITICAL FIX**: Use webhook source country/niche/lead_type as defaults (correct precedence)
        const finalCountry = normalizedData.country || source.country || enrichedData.country || 'unknown';
        const finalNiche = normalizedData.niche || source.niche || enrichedData.niche || 'forex';
        
        // **ENHANCED: Robust lead type validation and normalization**
        let finalLeadType = normalizedData.type || source.lead_type || 'raw';
        
        // Normalize and validate lead type to prevent INSERT failures
        if (finalLeadType && typeof finalLeadType === 'string') {
            finalLeadType = finalLeadType.toLowerCase().trim();
            // Only allow valid lead types, fallback to source config if invalid
            if (!['premium', 'raw'].includes(finalLeadType)) {
                console.warn(`Invalid lead type '${normalizedData.type}' from webhook, using source default: ${source.lead_type}`);
                finalLeadType = source.lead_type || 'raw';
            }
        } else {
            finalLeadType = source.lead_type || 'raw';
        }
        
        // **NEW: Quality Scoring** - Calculate comprehensive quality score
        const leadQualityScoring = require('../services/leadQualityScoring');
        
        // Prepare lead data for quality scoring
        const leadForScoring = {
            source: source.name,
            type: finalLeadType, // Use source's configured lead type
            niche: finalNiche,
            country: finalCountry,
            first_name: enrichedData.first_name,
            last_name: enrichedData.last_name,
            email: enrichedData.email,
            phone: enrichedData.phone,
            data: {
                ...enrichedData,
                original: leadData,
                enrichment_score: enrichedData.data_completeness_score
            },
            created_at: new Date()
        };
        
        const qualityScore = await leadQualityScoring.calculateQualityScore(leadForScoring);
        
        // Insert enriched lead with quality scoring into database
        const leadResult = await pool.query(`
            INSERT INTO leads (source, type, niche, country, first_name, last_name, email, phone, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            source.name,
            finalLeadType, // Use source's configured lead type  
            finalNiche,
            finalCountry,
            enrichedData.first_name,
            enrichedData.last_name,
            enrichedData.email,
            enrichedData.phone,
            JSON.stringify({
                original: leadData,
                enriched: enrichedData,
                enrichment_score: enrichedData.data_completeness_score,
                webhook_source: {
                    country: source.country,
                    niche: source.niche,
                    name: source.name
                },
                // **NEW: Quality Scoring Data**
                quality_score: qualityScore.totalScore,
                quality_tier: qualityScore.qualityTier,
                quality_breakdown: qualityScore.breakdown,
                distribution_recommendation: qualityScore.recommendation,
                quality_calculated_at: new Date().toISOString()
            })
        ]);
        
        const leadId = leadResult.rows[0].id;
        
        // **NEW: Schedule promotional email for 30 minutes after lead arrival**
        const { schedulePromotionalEmail } = require('../services/emailScheduler');
        setImmediate(() => {
            // Create lead object for email scheduling
            const leadForEmail = {
                id: leadId,
                email: enrichedData.email,
                first_name: enrichedData.first_name,
                last_name: enrichedData.last_name,
                country: finalCountry,
                niche: finalNiche
            };
            
            // Schedule promotional email if email is present
            schedulePromotionalEmail(leadForEmail).catch(error => {
                console.error(`Email scheduling failed for lead ${leadId}:`, error);
            });
        });
        
        // Trigger distribution asynchronously
        setImmediate(() => {
            distributeLead(leadId).catch(error => {
                console.error(`Distribution failed for lead ${leadId}:`, error);
            });
        });
        
        res.json({ 
            success: true, 
            lead_id: leadId,
            quality_score: qualityScore.totalScore,
            quality_tier: qualityScore.qualityTier,
            distribution_priority: qualityScore.recommendation.priority,
            message: 'Lead received, quality scored, and queued for distribution' 
        });
        
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});

// Legacy postback endpoint for conversion tracking (SECURED)
router.post('/postback/:partner_id', authenticatePartner, rateLimit(30), async (req, res) => {
    try {
        const { partner_id } = req.params;
        const { lead_id, status, value, data } = req.body;
        
        // Verify partner matches authenticated partner
        if (parseInt(partner_id) !== req.partner.partner_id) {
            return res.status(403).json({ error: 'Cannot report conversions for other partners' });
        }
        
        // Verify lead exists and belongs to this partner
        const leadResult = await pool.query(
            'SELECT * FROM leads WHERE id = $1 AND assigned_partner_id = $2',
            [lead_id, partner_id]
        );
        
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found or not assigned to this partner' });
        }
        
        // Update lead status if converted with atomic DB-level idempotency
        if (status === 'converted') {
            const client = await pool.connect();
            try {
                // Use dedicated client for true atomicity
                await client.query('BEGIN');
                
                // Update lead status
                await client.query(`
                    UPDATE leads 
                    SET status = 'converted', converted_at = CURRENT_TIMESTAMP 
                    WHERE id = $1 AND assigned_partner_id = $2
                `, [lead_id, partner_id]);
                
                // Record conversion with DB-level uniqueness constraint
                await client.query(`
                    INSERT INTO conversions (lead_id, partner_id, conversion_value, conversion_data, postback_url)
                    VALUES ($1, $2, $3, $4, $5)
                `, [lead_id, partner_id, value || 0, JSON.stringify(data || {}), req.url]);
                
                // Update distribution stats only after proven unique conversion
                await client.query(`
                    INSERT INTO distribution_stats (partner_id, date, conversions, revenue)
                    VALUES ($1, CURRENT_DATE, 1, $2)
                    ON CONFLICT (partner_id, date) 
                    DO UPDATE SET conversions = distribution_stats.conversions + 1, 
                                  revenue = distribution_stats.revenue + $2
                `, [partner_id, value || 0]);
                
                await client.query('COMMIT');
                
            } catch (duplicateError) {
                await client.query('ROLLBACK');
                
                if (duplicateError.code === '23505') { // Unique constraint violation
                    return res.json({ 
                        success: true, 
                        message: 'Conversion already recorded (idempotent)',
                        legacy_warning: 'Please migrate to /api/conversion/{partnerId} for enhanced features'
                    });
                }
                throw duplicateError;
            } finally {
                client.release();
            }
        }
        
        res.json({ 
            success: true, 
            message: 'Postback processed successfully',
            legacy_warning: 'This endpoint is deprecated. Please migrate to /api/conversion/{partnerId} for enhanced features.'
        });
        
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

// NEW: Partner postback endpoint for lead status updates
router.post('/postback/status/:token', webhookRateLimit(100), async (req, res) => {
    try {
        const { token } = req.params;
        const { lead_id, status, conversion_value, quality_score, partner_feedback, partner_reference } = req.body;
        
        // Verify postback token and get partner info
        const configResult = await pool.query(
            'SELECT * FROM partner_postback_config WHERE postback_token = $1 AND is_active = true',
            [token]
        );
        
        if (configResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid postback token' });
        }
        
        const config = configResult.rows[0];
        
        // Optional: Check allowed IPs if configured
        if (config.allowed_ips && config.allowed_ips.length > 0) {
            const clientIP = req.ip || req.connection.remoteAddress;
            if (!config.allowed_ips.includes(clientIP)) {
                return res.status(403).json({ error: 'IP not allowed' });
            }
        }
        
        // Verify lead exists and belongs to this partner
        const leadResult = await pool.query(
            'SELECT * FROM leads WHERE id = $1 AND assigned_partner_id = $2',
            [lead_id, config.partner_id]
        );
        
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found or not assigned to this partner' });
        }
        
        // Map status fields if configured
        let mappedStatus = status;
        if (config.status_field_mapping && config.status_field_mapping[status]) {
            mappedStatus = config.status_field_mapping[status];
        }
        
        // Record status update with idempotency protection
        try {
            await pool.query(`
                INSERT INTO lead_status_updates 
                (lead_id, partner_id, status, conversion_value, conversion_currency, quality_score, 
                 partner_feedback, update_source, partner_reference, raw_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (lead_id, partner_id, status, COALESCE(partner_reference, 'none'), DATE_TRUNC('minute', created_at))
                DO NOTHING
            `, [
                lead_id,
                config.partner_id,
                mappedStatus,
                conversion_value,
                'USD', // Default currency
                quality_score,
                partner_feedback,
                'postback',
                partner_reference,
                JSON.stringify(req.body)
            ]);
        } catch (duplicateError) {
            // Return success for duplicate status updates (idempotent)
            if (duplicateError.code === '23505') {
                return res.json({
                    success: true,
                    message: 'Status already recorded (idempotent)',
                    lead_id: lead_id,
                    status: mappedStatus
                });
            }
            throw duplicateError;
        }
        
        // Update lead record with latest status
        await pool.query(`
            UPDATE leads 
            SET status = CASE 
                WHEN $2 IN ('converted', 'qualified') THEN $2
                ELSE status 
            END,
            conversion_value = CASE 
                WHEN $3 IS NOT NULL THEN COALESCE(conversion_value, 0) + $3
                ELSE conversion_value 
            END,
            quality_score = COALESCE($4, quality_score),
            converted_at = CASE 
                WHEN $2 = 'converted' AND converted_at IS NULL THEN CURRENT_TIMESTAMP
                ELSE converted_at 
            END
            WHERE id = $1
        `, [lead_id, mappedStatus, conversion_value, quality_score]);
        
        res.json({
            success: true,
            message: 'Lead status update received',
            lead_id: lead_id,
            status: mappedStatus
        });
        
    } catch (error) {
        console.error('Postback status update error:', error);
        res.status(500).json({ error: 'Failed to process status update' });
    }
});

// NEW: Get lead status updates for a partner
router.get('/partner/:partnerId/leads/:leadId/status-history', authenticatePartner, rateLimit(50), async (req, res) => {
    try {
        const { partnerId, leadId } = req.params;
        
        // Verify partner matches authenticated partner
        if (parseInt(partnerId) !== req.partner.partner_id) {
            return res.status(403).json({ error: 'Cannot access other partner data' });
        }
        
        // Get status history for the lead
        const statusResult = await pool.query(`
            SELECT lsu.*, l.first_name, l.last_name, l.email
            FROM lead_status_updates lsu
            JOIN leads l ON lsu.lead_id = l.id
            WHERE lsu.lead_id = $1 AND lsu.partner_id = $2
            ORDER BY lsu.created_at ASC
        `, [leadId, partnerId]);
        
        res.json({
            success: true,
            lead_id: leadId,
            status_updates: statusResult.rows
        });
        
    } catch (error) {
        console.error('Status history error:', error);
        res.status(500).json({ error: 'Failed to get status history' });
    }
});

module.exports = router;