const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');
const { pool } = require('../config/db');

// Live Monitoring Dashboard
router.get('/', async (req, res) => {
    try {
        const systemHealth = await liveMonitor.getSystemHealth();
        
        res.render('monitoring/index', {
            title: 'Live System Monitoring',
            health: systemHealth,
            refreshInterval: 30 // seconds
        });
        
    } catch (error) {
        console.error('Live monitoring dashboard error:', error);
        res.status(500).render('error', { 
            error: 'Failed to load monitoring data: ' + error.message 
        });
    }
});

// API endpoint for real-time data updates (AJAX polling)
router.get('/api/health', async (req, res) => {
    try {
        const systemHealth = await liveMonitor.getSystemHealth();
        res.json({
            success: true,
            data: systemHealth,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Health API error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// System status summary (for status badges/widgets)
router.get('/api/status', async (req, res) => {
    try {
        const health = await liveMonitor.getSystemHealth();
        
        res.json({
            success: true,
            status: health.status,
            healthScore: health.healthScore,
            uptime: health.uptime,
            summary: {
                leadsToday: health.leads?.today?.total || 0,
                activePartners: health.partners?.summary?.active || 0,
                webhookSuccessRate: health.webhooks?.today?.successRate || 0,
                pendingAlerts: (health.alerts?.summary?.high_active || 0) + (health.alerts?.summary?.medium_active || 0)
            },
            timestamp: health.timestamp
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'error',
            error: error.message
        });
    }
});

// Historical performance data for charts
router.get('/api/trends', async (req, res) => {
    try {
        const { hours = 24 } = req.query;
        const hoursInput = parseInt(hours);
        const hoursBack = (isNaN(hoursInput) || hoursInput < 1) ? 24 : Math.min(hoursInput, 168); // Default 24, max 1 week
        
        // Get hourly trends
        const trendsResult = await pool.query(`
            SELECT 
                date_trunc('hour', created_at) as hour,
                
                COUNT(*) as total_leads,
                COUNT(CASE WHEN status = 'distributed' THEN 1 END) as distributed_leads,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_leads,
                
                -- Webhook performance for this hour
                (SELECT COUNT(*) 
                 FROM webhook_deliveries wd 
                 WHERE date_trunc('hour', wd.created_at) = date_trunc('hour', l.created_at)
                ) as webhook_attempts,
                
                (SELECT COUNT(*) 
                 FROM webhook_deliveries wd 
                 WHERE date_trunc('hour', wd.created_at) = date_trunc('hour', l.created_at)
                   AND wd.status = 'success'
                ) as webhook_success
                
            FROM leads l
            WHERE l.created_at >= NOW() - make_interval(hours => $1)
            GROUP BY date_trunc('hour', l.created_at)
            ORDER BY hour DESC
            LIMIT $2
        `, [hoursBack, hoursBack]);
        
        const trends = trendsResult.rows.map(row => ({
            hour: row.hour,
            leads: {
                total: parseInt(row.total_leads),
                distributed: parseInt(row.distributed_leads),
                failed: parseInt(row.failed_leads),
                distributionRate: row.total_leads > 0 ? 
                    Math.round((row.distributed_leads / row.total_leads) * 100) : 0
            },
            webhooks: {
                attempts: parseInt(row.webhook_attempts) || 0,
                success: parseInt(row.webhook_success) || 0,
                successRate: row.webhook_attempts > 0 ? 
                    Math.round((row.webhook_success / row.webhook_attempts) * 100) : 0
            }
        }));
        
        res.json({
            success: true,
            trends: trends,
            period: `${hoursBack} hours`,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Trends API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// System diagnostics endpoint
router.get('/api/diagnostics', async (req, res) => {
    try {
        const diagnostics = {
            timestamp: new Date().toISOString(),
            checks: []
        };
        
        // Database connectivity
        try {
            await pool.query('SELECT 1');
            diagnostics.checks.push({
                name: 'Database Connection',
                status: 'healthy',
                message: 'Database connection successful'
            });
        } catch (error) {
            diagnostics.checks.push({
                name: 'Database Connection',
                status: 'critical',
                message: 'Database connection failed: ' + error.message
            });
        }
        
        // Check for stuck leads (pending > 30 minutes)
        const stuckLeads = await pool.query(`
            SELECT COUNT(*) as count 
            FROM leads 
            WHERE status = 'pending' 
              AND created_at < NOW() - INTERVAL '30 minutes'
        `);
        
        const stuckCount = parseInt(stuckLeads.rows[0].count);
        diagnostics.checks.push({
            name: 'Stuck Leads Check',
            status: stuckCount > 0 ? 'warning' : 'healthy',
            message: stuckCount > 0 ? 
                `${stuckCount} leads stuck in pending state > 30 minutes` :
                'No stuck leads detected',
            count: stuckCount
        });
        
        // Check webhook retry queue
        const retryQueue = await pool.query(`
            SELECT COUNT(*) as count 
            FROM webhook_deliveries 
            WHERE status = 'failed' 
              AND attempts < 3 
              AND created_at > NOW() - INTERVAL '24 hours'
        `);
        
        const retryCount = parseInt(retryQueue.rows[0].count);
        diagnostics.checks.push({
            name: 'Webhook Retry Queue',
            status: retryCount > 50 ? 'warning' : 'healthy',
            message: `${retryCount} webhooks in retry queue`,
            count: retryCount
        });
        
        // Check partner availability
        const partnerCheck = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active
            FROM partners
        `);
        
        const partnerStats = partnerCheck.rows[0];
        const activeRate = partnerStats.total > 0 ? 
            Math.round((partnerStats.active / partnerStats.total) * 100) : 0;
        
        diagnostics.checks.push({
            name: 'Partner Availability',
            status: activeRate < 50 ? 'critical' : (activeRate < 80 ? 'warning' : 'healthy'),
            message: `${partnerStats.active}/${partnerStats.total} partners active (${activeRate}%)`,
            activePartners: parseInt(partnerStats.active),
            totalPartners: parseInt(partnerStats.total)
        });
        
        res.json({
            success: true,
            diagnostics: diagnostics
        });
        
    } catch (error) {
        console.error('Diagnostics API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;