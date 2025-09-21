const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const partnerManager = require('../services/partnerManager');

// Partner Management Dashboard
router.get('/', async (req, res) => {
    try {
        const { action, timeframe } = req.query;
        const daysBack = timeframe === '30' ? 30 : (timeframe === '7' ? 7 : 1);
        
        // Get recent automated actions
        let actionsQuery = `
            SELECT pml.*, p.name as partner_name, p.country, p.niche, p.status as current_status
            FROM partner_management_log pml
            JOIN partners p ON pml.partner_id = p.id
            WHERE pml.created_at > NOW() - INTERVAL '${daysBack} days'
        `;
        const params = [];
        
        if (action) {
            actionsQuery += ' AND pml.action = $1';
            params.push(action);
        }
        
        actionsQuery += ' ORDER BY pml.created_at DESC LIMIT 50';
        
        const actionsResult = await pool.query(actionsQuery, params);
        
        // Get summary statistics
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(*) as total_actions,
                COUNT(CASE WHEN action = 'auto_pause' THEN 1 END) as auto_pauses,
                COUNT(CASE WHEN action = 'auto_resume' THEN 1 END) as auto_resumes,
                COUNT(CASE WHEN action = 'manual_pause' THEN 1 END) as manual_pauses,
                COUNT(CASE WHEN action = 'manual_resume' THEN 1 END) as manual_resumes
            FROM partner_management_log
            WHERE created_at > NOW() - INTERVAL '${daysBack} days'
        `);
        
        // Get current partner status breakdown
        const statusResult = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count,
                ROUND(AVG(CASE 
                    WHEN ds.leads_received > 0 THEN 
                        (ds.premium_leads::decimal / ds.leads_received * 100)
                    ELSE 0 
                END), 2) as avg_premium_ratio
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            GROUP BY status
        `);
        
        // Get performance insights
        const insightsResult = await pool.query(`
            SELECT 
                p.id, p.name, p.country, p.niche, p.status,
                COALESCE(ds.leads_received, 0) as today_leads,
                COALESCE(ds.conversions, 0) as today_conversions,
                CASE 
                    WHEN COALESCE(ds.leads_received, 0) > 0 THEN 
                        ROUND((COALESCE(ds.conversions, 0)::decimal / COALESCE(ds.leads_received, 0) * 100), 2)
                    ELSE 0 
                END as today_conversion_rate,
                
                -- Recent webhook failure rate
                (SELECT 
                    CASE 
                        WHEN COUNT(wd.id) > 0 THEN 
                            ROUND((COUNT(CASE WHEN wd.response_code >= 400 OR wd.response_code IS NULL THEN 1 END)::decimal / COUNT(wd.id) * 100), 2)
                        ELSE 0 
                    END
                 FROM webhook_deliveries wd 
                 JOIN leads l ON wd.lead_id = l.id
                 WHERE l.assigned_partner_id = p.id 
                   AND wd.created_at > NOW() - INTERVAL '24 hours'
                ) as webhook_failure_rate,
                
                -- Last automated action
                (SELECT pml.action || ' - ' || pml.reason
                 FROM partner_management_log pml 
                 WHERE pml.partner_id = p.id 
                 ORDER BY pml.created_at DESC 
                 LIMIT 1
                ) as last_action
                
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            ORDER BY p.status, COALESCE(ds.leads_received, 0) DESC
        `);
        
        res.render('partner-management/index', {
            title: 'Automated Partner Management',
            actions: actionsResult.rows,
            summary: summaryResult.rows[0] || {},
            statusBreakdown: statusResult.rows,
            insights: insightsResult.rows,
            currentFilters: {
                action: action || '',
                timeframe: daysBack.toString()
            },
            actionTypes: ['auto_pause', 'auto_resume', 'manual_pause', 'manual_resume', 'performance_review']
        });
        
    } catch (error) {
        console.error('Partner management dashboard error:', error);
        res.status(500).render('error', { error: 'Failed to load partner management data' });
    }
});

// Manual Partner Actions
router.post('/partners/:id/pause', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const adminUser = req.session?.user?.username || 'Admin';
        
        // Update partner status
        await pool.query(
            'UPDATE partners SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['paused', id]
        );
        
        // Log manual action
        await pool.query(`
            INSERT INTO partner_management_log 
            (partner_id, action, reason, admin_user, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, 'manual_pause', reason || 'Manual pause by admin', adminUser]);
        
        res.json({ success: true, message: 'Partner paused successfully' });
        
    } catch (error) {
        console.error('Manual pause error:', error);
        res.status(500).json({ success: false, error: 'Failed to pause partner' });
    }
});

router.post('/partners/:id/resume', async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const adminUser = req.session?.user?.username || 'Admin';
        
        // Update partner status
        await pool.query(
            'UPDATE partners SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['active', id]
        );
        
        // Log manual action
        await pool.query(`
            INSERT INTO partner_management_log 
            (partner_id, action, reason, admin_user, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [id, 'manual_resume', reason || 'Manual resume by admin', adminUser]);
        
        res.json({ success: true, message: 'Partner resumed successfully' });
        
    } catch (error) {
        console.error('Manual resume error:', error);
        res.status(500).json({ success: false, error: 'Failed to resume partner' });
    }
});

// Run Partner Analysis Manually
router.post('/analyze', async (req, res) => {
    try {
        console.log('🔍 Running manual partner analysis...');
        const summary = await partnerManager.runAutomatedManagement();
        
        res.json({ 
            success: true, 
            message: 'Partner analysis completed',
            summary: summary
        });
        
    } catch (error) {
        console.error('Manual partner analysis error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to run partner analysis: ' + error.message 
        });
    }
});

// Get Partner Analysis Details
router.get('/partners/:id/analysis', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get partner details
        const partnerResult = await pool.query('SELECT * FROM partners WHERE id = $1', [id]);
        const partner = partnerResult.rows[0];
        
        if (!partner) {
            return res.status(404).json({ success: false, error: 'Partner not found' });
        }
        
        // Run analysis for this specific partner
        const analysisResults = await Promise.all([
            partnerManager.analyzePartnerPerformance(partner),
            partnerManager.analyzePartnerForResume(partner)
        ]);
        
        const [performanceAnalysis, resumeAnalysis] = analysisResults;
        
        // Get management history
        const historyResult = await pool.query(`
            SELECT * FROM partner_management_log 
            WHERE partner_id = $1 
            ORDER BY created_at DESC 
            LIMIT 20
        `, [id]);
        
        res.json({
            success: true,
            partner: partner,
            performance: performanceAnalysis,
            resumeAnalysis: resumeAnalysis,
            history: historyResult.rows
        });
        
    } catch (error) {
        console.error('Partner analysis error:', error);
        res.status(500).json({ success: false, error: 'Failed to analyze partner' });
    }
});

module.exports = router;