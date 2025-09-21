const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const alertSystem = require('../services/alertSystem');

// Alerts dashboard
router.get('/', async (req, res) => {
    try {
        const { severity, resolved } = req.query;
        
        // Get alerts with filters
        let query = `
            SELECT sa.*, 
                   l.first_name, l.last_name, l.email as lead_email, l.country as lead_country, l.niche as lead_niche,
                   p.name as partner_name, p.country as partner_country, p.niche as partner_niche,
                   wd.webhook_url, wd.attempts as webhook_attempts
            FROM system_alerts sa
            LEFT JOIN leads l ON sa.lead_id = l.id
            LEFT JOIN partners p ON sa.partner_id = p.id
            LEFT JOIN webhook_deliveries wd ON sa.webhook_delivery_id = wd.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 0;
        
        if (severity) {
            query += ` AND sa.severity = $${++paramCount}`;
            params.push(severity);
        }
        
        if (resolved !== undefined) {
            query += ` AND sa.resolved = $${++paramCount}`;
            params.push(resolved === 'true');
        }
        
        query += ' ORDER BY sa.created_at DESC LIMIT 100';
        
        const alertsResult = await pool.query(query, params);
        
        // Get alert statistics
        const statsQuery = await pool.query(`
            SELECT 
                severity,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE resolved = false) as active_count
            FROM system_alerts
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY severity
            ORDER BY 
                CASE severity 
                    WHEN 'critical' THEN 1
                    WHEN 'high' THEN 2  
                    WHEN 'medium' THEN 3
                    WHEN 'low' THEN 4
                    ELSE 5
                END
        `);
        
        // Get alert type breakdown
        const typeBreakdownQuery = await pool.query(`
            SELECT 
                type,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE resolved = false) as active_count
            FROM system_alerts
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY type
            ORDER BY count DESC
        `);
        
        res.render('alerts/index', {
            title: 'System Alerts',
            alerts: alertsResult.rows,
            stats: statsQuery.rows,
            typeBreakdown: typeBreakdownQuery.rows,
            filters: { severity, resolved }
        });
        
    } catch (error) {
        console.error('Alerts dashboard error:', error);
        res.status(500).render('error', { 
            error: 'Failed to load alerts dashboard',
            message: error.message 
        });
    }
});

// Resolve alert
router.post('/:id/resolve', async (req, res) => {
    try {
        const alertId = parseInt(req.params.id);
        const success = await alertSystem.resolveAlert(alertId, req.session.user || 'admin');
        
        if (success) {
            res.redirect('/alerts?success=Alert resolved successfully');
        } else {
            res.redirect('/alerts?error=Failed to resolve alert');
        }
        
    } catch (error) {
        console.error('Resolve alert error:', error);
        res.redirect('/alerts?error=Failed to resolve alert');
    }
});

// Resolve all alerts of a type
router.post('/resolve-type/:type', async (req, res) => {
    try {
        const alertType = req.params.type;
        
        const result = await pool.query(`
            UPDATE system_alerts 
            SET resolved = true, resolved_at = CURRENT_TIMESTAMP 
            WHERE type = $1 AND resolved = false
            RETURNING id
        `, [alertType]);
        
        const resolvedCount = result.rows.length;
        res.redirect(`/alerts?success=Resolved ${resolvedCount} ${alertType} alerts`);
        
    } catch (error) {
        console.error('Bulk resolve error:', error);
        res.redirect('/alerts?error=Failed to resolve alerts');
    }
});

// API endpoint for real-time alerts (for AJAX polling)
router.get('/api/active', async (req, res) => {
    try {
        const activeAlerts = await alertSystem.getActiveAlerts(20);
        res.json(activeAlerts);
    } catch (error) {
        console.error('Active alerts API error:', error);
        res.status(500).json({ error: 'Failed to fetch active alerts' });
    }
});

// Test alert endpoint (for development)
router.post('/test', async (req, res) => {
    try {
        const { type } = req.body;
        
        switch (type) {
            case 'stranded_lead':
                await alertSystem.alertStrandedLead({
                    id: 999,
                    first_name: 'Test',
                    last_name: 'User',
                    country: 'germany',
                    niche: 'forex'
                });
                break;
            case 'webhook_failures':
                await alertSystem.alertWebhookFailures(5);
                break;
            case 'system_error':
                await alertSystem.alertSystemError(new Error('Test system error'), { context: 'test' });
                break;
            default:
                throw new Error('Unknown test alert type');
        }
        
        res.redirect('/alerts?success=Test alert created');
    } catch (error) {
        res.redirect('/alerts?error=Failed to create test alert');
    }
});

module.exports = router;