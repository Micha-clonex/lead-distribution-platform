const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const leadQualityScoring = require('../services/leadQualityScoring');

// Apply authentication to all quality scoring routes
router.use(requireAuth);

/**
 * Quality Scoring Dashboard
 */
router.get('/', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];

        // Get quality distribution statistics
        const qualityDistribution = await leadQualityScoring.getQualityDistributionStats(startDate, endDate + ' 23:59:59');

        // Get quality trends by day
        const qualityTrendsQuery = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_leads,
                AVG(COALESCE((data->>'quality_score')::numeric, 50)) as avg_quality_score,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'premium') as premium_leads,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'high') as high_quality_leads,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'standard') as standard_quality_leads,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'low') as low_quality_leads,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'reject') as rejected_leads,
                COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                ROUND((COUNT(*) FILTER (WHERE status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate
            FROM leads 
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [startDate, endDate + ' 23:59:59']);

        // Get source quality performance 
        const sourceQualityQuery = await pool.query(`
            SELECT 
                source,
                niche,
                COUNT(*) as total_leads,
                AVG(COALESCE((data->>'quality_score')::numeric, 50)) as avg_quality_score,
                STDDEV(COALESCE((data->>'quality_score')::numeric, 50)) as quality_score_std,
                COUNT(*) FILTER (WHERE (data->>'quality_tier') IN ('premium', 'high')) as high_quality_count,
                ROUND((COUNT(*) FILTER (WHERE (data->>'quality_tier') IN ('premium', 'high'))::decimal / COUNT(*)) * 100, 1) as high_quality_rate,
                COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                ROUND((COUNT(*) FILTER (WHERE status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate,
                AVG(EXTRACT(EPOCH FROM (distributed_at - created_at))/60) FILTER (WHERE distributed_at IS NOT NULL) as avg_distribution_time_minutes
            FROM leads 
            WHERE created_at >= $1 AND created_at <= $2
            GROUP BY source, niche
            HAVING COUNT(*) >= 5
            ORDER BY avg_quality_score DESC, conversion_rate DESC
        `, [startDate, endDate + ' 23:59:59']);

        // Get quality factor breakdown
        const qualityBreakdownQuery = await pool.query(`
            SELECT 
                country,
                niche,
                type,
                COUNT(*) as leads_count,
                AVG(COALESCE((data->>'quality_score')::numeric, 50)) as avg_total_score,
                AVG(COALESCE((data->'quality_breakdown'->>'dataCompleteness')::numeric, 50)) as avg_completeness,
                AVG(COALESCE((data->'quality_breakdown'->>'dataQuality')::numeric, 50)) as avg_data_quality,
                AVG(COALESCE((data->'quality_breakdown'->>'sourceReliability')::numeric, 50)) as avg_source_reliability,
                AVG(COALESCE((data->'quality_breakdown'->>'freshnessFactor')::numeric, 50)) as avg_freshness,
                AVG(COALESCE((data->'quality_breakdown'->>'conversionPrediction')::numeric, 50)) as avg_conversion_prediction,
                COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                ROUND((COUNT(*) FILTER (WHERE status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2
              AND data ? 'quality_breakdown'
            GROUP BY country, niche, type
            HAVING COUNT(*) >= 3
            ORDER BY avg_total_score DESC
        `, [startDate, endDate + ' 23:59:59']);

        res.render('qualityScoring/dashboard', {
            title: 'Lead Quality Scoring Dashboard',
            qualityTrends: qualityTrendsQuery.rows,
            sourceQuality: sourceQualityQuery.rows,
            qualityBreakdown: qualityBreakdownQuery.rows,
            qualityDistribution,
            startDate,
            endDate
        });

    } catch (error) {
        console.error('Quality scoring dashboard error:', error);
        res.status(500).render('error', { error: 'Failed to load quality scoring dashboard' });
    }
});

/**
 * API: Get quality score for a specific lead
 */
router.get('/api/lead/:leadId/quality', async (req, res) => {
    try {
        const { leadId } = req.params;
        
        const leadResult = await pool.query(`
            SELECT id, source, type, niche, country, first_name, last_name, email, phone, 
                   data, status, created_at, distributed_at, converted_at
            FROM leads WHERE id = $1
        `, [leadId]);

        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found' });
        }

        const lead = leadResult.rows[0];
        
        // Check if quality score already exists
        if (lead.data && lead.data.quality_score) {
            res.json({
                success: true,
                leadId: lead.id,
                qualityScore: lead.data.quality_score,
                qualityTier: lead.data.quality_tier,
                breakdown: lead.data.quality_breakdown,
                recommendation: lead.data.distribution_recommendation,
                calculatedAt: lead.data.quality_calculated_at,
                fromCache: true
            });
        } else {
            // Calculate fresh quality score
            const qualityScore = await leadQualityScoring.calculateQualityScore(lead);
            
            res.json({
                success: true,
                leadId: lead.id,
                qualityScore: qualityScore.totalScore,
                qualityTier: qualityScore.qualityTier,
                breakdown: qualityScore.breakdown,
                recommendation: qualityScore.recommendation,
                calculatedAt: new Date().toISOString(),
                fromCache: false
            });
        }

    } catch (error) {
        console.error('Lead quality API error:', error);
        res.status(500).json({ error: 'Failed to get lead quality score' });
    }
});

/**
 * API: Bulk quality scoring for analytics
 */
router.post('/api/bulk-score', async (req, res) => {
    try {
        const { leadIds, recalculate = false } = req.body;

        if (!Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ error: 'leadIds array is required' });
        }

        if (leadIds.length > 100) {
            return res.status(400).json({ error: 'Maximum 100 leads can be processed at once' });
        }

        const leadsResult = await pool.query(`
            SELECT id, source, type, niche, country, first_name, last_name, email, phone, 
                   data, status, created_at, distributed_at, converted_at
            FROM leads WHERE id = ANY($1)
        `, [leadIds]);

        const results = [];
        
        for (const lead of leadsResult.rows) {
            // Use cached score unless recalculate is requested
            if (!recalculate && lead.data && lead.data.quality_score) {
                results.push({
                    leadId: lead.id,
                    qualityScore: lead.data.quality_score,
                    qualityTier: lead.data.quality_tier,
                    breakdown: lead.data.quality_breakdown,
                    recommendation: lead.data.distribution_recommendation,
                    fromCache: true
                });
            } else {
                const qualityScore = await leadQualityScoring.calculateQualityScore(lead);
                results.push({
                    leadId: lead.id,
                    qualityScore: qualityScore.totalScore,
                    qualityTier: qualityScore.qualityTier,
                    breakdown: qualityScore.breakdown,
                    recommendation: qualityScore.recommendation,
                    fromCache: false
                });
            }
        }

        res.json({
            success: true,
            results,
            processed: results.length,
            requested: leadIds.length
        });

    } catch (error) {
        console.error('Bulk quality scoring error:', error);
        res.status(500).json({ error: 'Failed to process bulk quality scoring' });
    }
});

/**
 * API: Quality analytics chart data
 */
router.get('/api/chart-data', async (req, res) => {
    try {
        const { type, start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];

        let chartData = {};

        if (type === 'quality-trends') {
            const result = await pool.query(`
                SELECT 
                    DATE(created_at) as date,
                    AVG(COALESCE((data->>'quality_score')::numeric, 50)) as avg_quality_score,
                    COUNT(*) as total_leads,
                    COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                    COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'premium') as premium_count,
                    COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'high') as high_count,
                    COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'standard') as standard_count,
                    COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'low') as low_count,
                    COUNT(*) FILTER (WHERE (data->>'quality_tier') = 'reject') as reject_count
                FROM leads 
                WHERE created_at >= $1 AND created_at <= $2
                GROUP BY DATE(created_at)
                ORDER BY date
            `, [startDate, endDate + ' 23:59:59']);

            chartData = {
                labels: result.rows.map(row => row.date),
                datasets: [
                    {
                        label: 'Avg Quality Score',
                        data: result.rows.map(row => parseFloat(row.avg_quality_score)),
                        borderColor: 'rgb(75, 192, 192)',
                        tension: 0.1,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Total Leads',
                        data: result.rows.map(row => parseInt(row.total_leads)),
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.2)',
                        type: 'bar',
                        yAxisID: 'y1'
                    }
                ]
            };

        } else if (type === 'quality-distribution') {
            const result = await pool.query(`
                SELECT 
                    COALESCE(data->>'quality_tier', 'unknown') as quality_tier,
                    COUNT(*) as count
                FROM leads 
                WHERE created_at >= $1 AND created_at <= $2
                GROUP BY COALESCE(data->>'quality_tier', 'unknown')
                ORDER BY 
                    CASE COALESCE(data->>'quality_tier', 'unknown')
                        WHEN 'premium' THEN 1
                        WHEN 'high' THEN 2
                        WHEN 'standard' THEN 3
                        WHEN 'low' THEN 4
                        WHEN 'reject' THEN 5
                        ELSE 6
                    END
            `, [startDate, endDate + ' 23:59:59']);

            chartData = {
                labels: result.rows.map(row => row.quality_tier.charAt(0).toUpperCase() + row.quality_tier.slice(1)),
                datasets: [{
                    data: result.rows.map(row => parseInt(row.count)),
                    backgroundColor: [
                        '#10B981', // Premium - Green
                        '#3B82F6', // High - Blue  
                        '#F59E0B', // Standard - Yellow
                        '#EF4444', // Low - Red
                        '#6B7280', // Reject - Gray
                        '#9CA3AF'  // Unknown - Light Gray
                    ]
                }]
            };

        } else if (type === 'source-quality') {
            const result = await pool.query(`
                SELECT 
                    source,
                    AVG(COALESCE((data->>'quality_score')::numeric, 50)) as avg_quality_score,
                    COUNT(*) as total_leads,
                    COUNT(*) FILTER (WHERE status = 'converted') as conversions
                FROM leads 
                WHERE created_at >= $1 AND created_at <= $2
                GROUP BY source
                HAVING COUNT(*) >= 3
                ORDER BY avg_quality_score DESC
                LIMIT 10
            `, [startDate, endDate + ' 23:59:59']);

            chartData = {
                labels: result.rows.map(row => row.source),
                datasets: [
                    {
                        label: 'Avg Quality Score',
                        data: result.rows.map(row => parseFloat(row.avg_quality_score)),
                        backgroundColor: 'rgba(75, 192, 192, 0.6)',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Conversion Rate %',
                        data: result.rows.map(row => {
                            return row.total_leads > 0 ? ((row.conversions / row.total_leads) * 100).toFixed(1) : 0;
                        }),
                        backgroundColor: 'rgba(255, 159, 64, 0.6)',
                        yAxisID: 'y1'
                    }
                ]
            };
        }

        res.json({
            success: true,
            chartData,
            period: `${startDate} to ${endDate}`
        });

    } catch (error) {
        console.error('Quality chart data error:', error);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

/**
 * API: Quality factor analysis
 */
router.get('/api/quality-factors', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];

        const factorsQuery = await pool.query(`
            SELECT 
                'Data Completeness' as factor,
                AVG(COALESCE((data->'quality_breakdown'->>'dataCompleteness')::numeric, 50)) as avg_score,
                STDDEV(COALESCE((data->'quality_breakdown'->>'dataCompleteness')::numeric, 50)) as score_variance,
                COUNT(*) as sample_size
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2 AND data ? 'quality_breakdown'
            
            UNION ALL
            
            SELECT 
                'Data Quality' as factor,
                AVG(COALESCE((data->'quality_breakdown'->>'dataQuality')::numeric, 50)) as avg_score,
                STDDEV(COALESCE((data->'quality_breakdown'->>'dataQuality')::numeric, 50)) as score_variance,
                COUNT(*) as sample_size
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2 AND data ? 'quality_breakdown'
            
            UNION ALL
            
            SELECT 
                'Source Reliability' as factor,
                AVG(COALESCE((data->'quality_breakdown'->>'sourceReliability')::numeric, 50)) as avg_score,
                STDDEV(COALESCE((data->'quality_breakdown'->>'sourceReliability')::numeric, 50)) as score_variance,
                COUNT(*) as sample_size
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2 AND data ? 'quality_breakdown'
            
            UNION ALL
            
            SELECT 
                'Freshness Factor' as factor,
                AVG(COALESCE((data->'quality_breakdown'->>'freshnessFactor')::numeric, 50)) as avg_score,
                STDDEV(COALESCE((data->'quality_breakdown'->>'freshnessFactor')::numeric, 50)) as score_variance,
                COUNT(*) as sample_size
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2 AND data ? 'quality_breakdown'
            
            UNION ALL
            
            SELECT 
                'Conversion Prediction' as factor,
                AVG(COALESCE((data->'quality_breakdown'->>'conversionPrediction')::numeric, 50)) as avg_score,
                STDDEV(COALESCE((data->'quality_breakdown'->>'conversionPrediction')::numeric, 50)) as score_variance,
                COUNT(*) as sample_size
            FROM leads
            WHERE created_at >= $1 AND created_at <= $2 AND data ? 'quality_breakdown'
            
            ORDER BY avg_score DESC
        `, [startDate, endDate + ' 23:59:59']);

        res.json({
            success: true,
            factors: factorsQuery.rows.map(row => ({
                factor: row.factor,
                avgScore: parseFloat(row.avg_score),
                variance: parseFloat(row.score_variance || 0),
                sampleSize: parseInt(row.sample_size)
            })),
            period: `${startDate} to ${endDate}`
        });

    } catch (error) {
        console.error('Quality factors analysis error:', error);
        res.status(500).json({ error: 'Failed to analyze quality factors' });
    }
});

module.exports = router;