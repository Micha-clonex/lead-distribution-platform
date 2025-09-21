const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// Analytics dashboard
router.get('/', async (req, res) => {
    try {
        // Get date range from query params
        const { start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];
        
        // Partner performance stats
        const partnerStatsQuery = await pool.query(`
            SELECT 
                p.id, p.name, p.country, p.niche,
                COALESCE(SUM(ds.leads_received), 0) as total_leads,
                COALESCE(SUM(ds.premium_leads), 0) as premium_leads,
                COALESCE(SUM(ds.raw_leads), 0) as raw_leads,
                COALESCE(SUM(ds.conversions), 0) as conversions,
                COALESCE(SUM(ds.revenue), 0) as revenue,
                CASE 
                    WHEN SUM(ds.leads_received) > 0 
                    THEN ROUND((SUM(ds.conversions)::decimal / SUM(ds.leads_received)) * 100, 2)
                    ELSE 0 
                END as conversion_rate
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id 
                AND ds.date BETWEEN $1 AND $2
            GROUP BY p.id, p.name, p.country, p.niche
            ORDER BY total_leads DESC
        `, [startDate, endDate]);
        
        // Daily distribution stats
        const dailyStatsQuery = await pool.query(`
            SELECT 
                ds.date,
                SUM(ds.leads_received) as total_leads,
                SUM(ds.premium_leads) as premium_leads,
                SUM(ds.raw_leads) as raw_leads,
                SUM(ds.conversions) as conversions,
                SUM(ds.revenue) as revenue
            FROM distribution_stats ds
            WHERE ds.date BETWEEN $1 AND $2
            GROUP BY ds.date
            ORDER BY ds.date
        `, [startDate, endDate]);
        
        // Country breakdown
        const countryStatsQuery = await pool.query(`
            SELECT 
                p.country,
                COUNT(DISTINCT p.id) as active_partners,
                COALESCE(SUM(ds.leads_received), 0) as total_leads,
                COALESCE(SUM(ds.conversions), 0) as conversions
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id 
                AND ds.date BETWEEN $1 AND $2
            WHERE p.status = 'active'
            GROUP BY p.country
            ORDER BY total_leads DESC
        `, [startDate, endDate]);
        
        // Niche breakdown
        const nicheStatsQuery = await pool.query(`
            SELECT 
                p.niche,
                COUNT(DISTINCT p.id) as active_partners,
                COALESCE(SUM(ds.leads_received), 0) as total_leads,
                COALESCE(SUM(ds.conversions), 0) as conversions
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id 
                AND ds.date BETWEEN $1 AND $2
            WHERE p.status = 'active'
            GROUP BY p.niche
            ORDER BY total_leads DESC
        `, [startDate, endDate]);
        
        // Webhook delivery stats
        const webhookStatsQuery = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count,
                ROUND(AVG(attempts), 2) as avg_attempts
            FROM webhook_deliveries
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY status
        `, [startDate, endDate + ' 23:59:59']);

        // **NEW: Lead Source Performance Analysis**
        const sourceStatsQuery = await pool.query(`
            SELECT 
                l.source,
                COUNT(*) as total_leads,
                COUNT(*) FILTER (WHERE l.type = 'premium') as premium_leads,
                COUNT(*) FILTER (WHERE l.type = 'raw') as raw_leads,
                COUNT(*) FILTER (WHERE l.status = 'distributed') as distributed_leads,
                COUNT(*) FILTER (WHERE l.status = 'converted') as converted_leads,
                COUNT(*) FILTER (WHERE l.status = 'failed') as failed_leads,
                CASE 
                    WHEN COUNT(*) > 0 
                    THEN ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2)
                    ELSE 0 
                END as conversion_rate,
                CASE 
                    WHEN COUNT(*) > 0 
                    THEN ROUND((COUNT(*) FILTER (WHERE l.status = 'distributed')::decimal / COUNT(*)) * 100, 2)
                    ELSE 0 
                END as distribution_rate,
                AVG(EXTRACT(EPOCH FROM (l.distributed_at - l.created_at))/60) FILTER (WHERE l.distributed_at IS NOT NULL) as avg_distribution_time_minutes
            FROM leads l
            WHERE l.created_at >= $1 AND l.created_at <= $2
            GROUP BY l.source
            ORDER BY total_leads DESC
        `, [startDate, endDate + ' 23:59:59']);

        // **NEW: Hourly Performance Analysis**
        const hourlyStatsQuery = await pool.query(`
            SELECT 
                EXTRACT(HOUR FROM l.created_at) as hour,
                COUNT(*) as leads_count,
                COUNT(*) FILTER (WHERE l.status = 'distributed') as distributed_count,
                COUNT(*) FILTER (WHERE l.status = 'converted') as converted_count,
                ROUND(AVG(CASE WHEN l.status = 'converted' THEN 1.0 ELSE 0.0 END) * 100, 2) as conversion_rate
            FROM leads l
            WHERE l.created_at >= $1 AND l.created_at <= $2
            GROUP BY EXTRACT(HOUR FROM l.created_at)
            ORDER BY hour
        `, [startDate, endDate + ' 23:59:59']);

        // **NEW: Lead Quality Analysis**
        const qualityStatsQuery = await pool.query(`
            SELECT 
                l.country,
                l.niche,
                l.type,
                COUNT(*) as total_leads,
                AVG(CASE 
                    WHEN l.email IS NOT NULL AND l.phone IS NOT NULL AND l.first_name IS NOT NULL AND l.last_name IS NOT NULL THEN 100
                    WHEN (l.email IS NOT NULL AND l.phone IS NOT NULL) OR (l.email IS NOT NULL AND l.first_name IS NOT NULL) THEN 75
                    WHEN l.email IS NOT NULL OR l.phone IS NOT NULL THEN 50
                    ELSE 25
                END) as avg_data_completeness_score,
                COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate
            FROM leads l
            WHERE l.created_at >= $1 AND l.created_at <= $2
            GROUP BY l.country, l.niche, l.type
            HAVING COUNT(*) >= 5  -- Only show segments with at least 5 leads
            ORDER BY conversion_rate DESC, total_leads DESC
        `, [startDate, endDate + ' 23:59:59']);

        res.render('analytics/index', {
            title: 'Enhanced Analytics Dashboard',
            partnerStats: partnerStatsQuery.rows,
            dailyStats: dailyStatsQuery.rows,
            countryStats: countryStatsQuery.rows,
            nicheStats: nicheStatsQuery.rows,
            webhookStats: webhookStatsQuery.rows,
            sourceStats: sourceStatsQuery.rows,
            hourlyStats: hourlyStatsQuery.rows,
            qualityStats: qualityStatsQuery.rows,
            startDate,
            endDate
        });
        
    } catch (error) {
        console.error('Analytics fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch analytics data' });
    }
});

// API endpoint for chart data
router.get('/api/chart-data', async (req, res) => {
    try {
        const { type, start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];
        
        let data = [];
        
        if (type === 'daily') {
            const result = await pool.query(`
                SELECT 
                    date,
                    SUM(leads_received) as leads,
                    SUM(conversions) as conversions
                FROM distribution_stats
                WHERE date BETWEEN $1 AND $2
                GROUP BY date
                ORDER BY date
            `, [startDate, endDate]);
            data = result.rows;
        } else if (type === 'partner-performance') {
            const result = await pool.query(`
                SELECT 
                    p.name,
                    SUM(ds.leads_received) as leads,
                    SUM(ds.conversions) as conversions
                FROM partners p
                JOIN distribution_stats ds ON p.id = ds.partner_id
                WHERE ds.date BETWEEN $1 AND $2
                GROUP BY p.id, p.name
                ORDER BY leads DESC
                LIMIT 10
            `, [startDate, endDate]);
            data = result.rows;
        }
        
        res.json(data);
    } catch (error) {
        console.error('Chart data error:', error);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

module.exports = router;