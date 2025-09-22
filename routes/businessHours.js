const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const businessHoursIntelligence = require('../services/businessHoursIntelligence');

// Apply authentication to all business hours routes
router.use(requireAuth);

/**
 * Business Hours Management Dashboard
 */
router.get('/', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];

        // Get all partners with business hours
        const partnersResult = await pool.query(`
            SELECT 
                p.id, p.name, p.country, p.niche, p.status,
                p.timezone, p.business_hours_start, p.business_hours_end,
                p.weekends_enabled, p.daily_limit, p.premium_ratio,
                COALESCE(ds.leads_received, 0) as todays_leads,
                COALESCE(ds.conversions, 0) as todays_conversions
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            ORDER BY p.status DESC, p.name
        `);

        // Get business hours analytics
        const analytics = await businessHoursIntelligence.getBusinessHoursAnalytics(startDate, endDate);

        // Get scheduled deliveries status
        const scheduledDeliveries = await pool.query(`
            SELECT 
                sd.id, sd.lead_id, sd.partner_id, sd.scheduled_time, sd.status,
                l.source, l.niche, l.country, l.type,
                p.name as partner_name, p.timezone
            FROM scheduled_deliveries sd
            JOIN leads l ON sd.lead_id = l.id
            JOIN partners p ON sd.partner_id = p.id
            WHERE sd.status IN ('scheduled', 'delivered')
            ORDER BY sd.scheduled_time DESC
            LIMIT 50
        `);

        // Current availability status for each partner
        const partnersWithAvailability = [];
        for (const partner of partnersResult.rows) {
            const isAvailable = await businessHoursIntelligence.isPartnerAvailable(partner.id);
            const nextAvailable = isAvailable ? null : businessHoursIntelligence.getNextBusinessHourStart(
                partner.timezone,
                partner.business_hours_start,
                partner.business_hours_end,
                partner.weekends_enabled || false
            );

            partnersWithAvailability.push({
                ...partner,
                isAvailable,
                nextAvailable,
                currentTime: new Date().toLocaleString('en-US', {
                    timeZone: partner.timezone || 'UTC',
                    hour12: false
                })
            });
        }

        res.render('businessHours/dashboard', {
            title: 'Business Hours Intelligence Dashboard',
            partners: partnersWithAvailability,
            analytics: analytics,
            scheduledDeliveries: scheduledDeliveries.rows,
            supportedTimezones: businessHoursIntelligence.getSupportedTimezones(),
            startDate,
            endDate
        });

    } catch (error) {
        console.error('Business hours dashboard error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).render('error', { 
            error: 'Failed to load business hours dashboard',
            message: error.message 
        });
    }
});

/**
 * Update Partner Business Hours
 */
router.post('/partner/:partnerId/update', async (req, res) => {
    try {
        const { partnerId } = req.params;
        const { timezone, business_hours_start, business_hours_end, weekends_enabled } = req.body;

        // Validate inputs
        if (!timezone || !business_hours_start || !business_hours_end) {
            return res.status(400).json({ 
                error: 'Timezone, start time, and end time are required' 
            });
        }

        // Validate time format (HH:MM)
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(business_hours_start) || !timeRegex.test(business_hours_end)) {
            return res.status(400).json({ 
                error: 'Invalid time format. Use HH:MM format (e.g., 09:00)' 
            });
        }

        // Update partner business hours including weekend setting
        await pool.query(`
            UPDATE partners 
            SET timezone = $2, 
                business_hours_start = $3, 
                business_hours_end = $4,
                weekends_enabled = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [partnerId, timezone, business_hours_start, business_hours_end, weekends_enabled || false]);

        // Clear business hours cache
        businessHoursIntelligence.partnerHoursCache.delete(`partner_${partnerId}`);
        
        const success = true;

        if (success) {
            res.json({ 
                success: true, 
                message: 'Business hours updated successfully' 
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to update business hours' 
            });
        }

    } catch (error) {
        console.error('Update business hours error:', error);
        res.status(500).json({ error: 'Failed to update business hours' });
    }
});

/**
 * API: Get Partner Availability Status
 */
router.get('/api/partner/:partnerId/availability', async (req, res) => {
    try {
        const { partnerId } = req.params;
        
        const isAvailable = await businessHoursIntelligence.isPartnerAvailable(partnerId);
        const partner = await businessHoursIntelligence.getPartnerBusinessHours(partnerId);
        
        if (!partner) {
            return res.status(404).json({ error: 'Partner not found' });
        }

        const nextAvailable = isAvailable ? null : businessHoursIntelligence.getNextBusinessHourStart(
            partner.timezone,
            partner.business_hours_start,
            partner.business_hours_end
        );

        const currentPartnerTime = new Date().toLocaleString('en-US', {
            timeZone: partner.timezone || 'UTC',
            hour12: false
        });

        res.json({
            success: true,
            partnerId: parseInt(partnerId),
            partnerName: partner.name,
            isAvailable,
            currentPartnerTime,
            timezone: partner.timezone,
            businessHours: {
                start: partner.business_hours_start,
                end: partner.business_hours_end
            },
            nextAvailable: nextAvailable ? nextAvailable.toISOString() : null
        });

    } catch (error) {
        console.error('Partner availability API error:', error);
        res.status(500).json({ error: 'Failed to check partner availability' });
    }
});

/**
 * API: Get Business Hours Analytics Chart Data
 */
router.get('/api/chart-data', async (req, res) => {
    try {
        const { type, start_date, end_date } = req.query;
        const startDate = start_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = end_date || new Date().toISOString().split('T')[0];

        let chartData = {};

        if (type === 'hourly-distribution') {
            const result = await pool.query(`
                SELECT 
                    EXTRACT(HOUR FROM l.distributed_at) as hour,
                    COUNT(*) as distributed_leads,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate
                FROM leads l
                WHERE l.distributed_at >= $1 AND l.distributed_at <= $2
                  AND l.distributed_at IS NOT NULL
                GROUP BY EXTRACT(HOUR FROM l.distributed_at)
                ORDER BY hour
            `, [startDate, endDate + ' 23:59:59']);

            // Fill missing hours with 0
            const hourlyData = Array.from({ length: 24 }, (_, i) => {
                const hourData = result.rows.find(row => parseInt(row.hour) === i);
                return {
                    hour: i,
                    distributed_leads: hourData ? parseInt(hourData.distributed_leads) : 0,
                    conversions: hourData ? parseInt(hourData.conversions) : 0,
                    conversion_rate: hourData ? parseFloat(hourData.conversion_rate) : 0
                };
            });

            chartData = {
                labels: hourlyData.map(h => `${h.hour.toString().padStart(2, '0')}:00`),
                datasets: [
                    {
                        label: 'Distributed Leads',
                        data: hourlyData.map(h => h.distributed_leads),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Conversion Rate %',
                        data: hourlyData.map(h => h.conversion_rate),
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.2)',
                        yAxisID: 'y1'
                    }
                ]
            };

        } else if (type === 'business-vs-outside') {
            const result = await pool.query(`
                SELECT 
                    CASE 
                        WHEN EXTRACT(DOW FROM l.distributed_at) IN (1,2,3,4,5) 
                             AND EXTRACT(HOUR FROM l.distributed_at) BETWEEN 9 AND 17 
                        THEN 'Business Hours'
                        ELSE 'Outside Hours'
                    END as period_type,
                    COUNT(*) as leads_distributed,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate
                FROM leads l
                WHERE l.distributed_at >= $1 AND l.distributed_at <= $2
                  AND l.distributed_at IS NOT NULL
                GROUP BY period_type
            `, [startDate, endDate + ' 23:59:59']);

            chartData = {
                labels: result.rows.map(row => row.period_type),
                datasets: [{
                    label: 'Leads Distributed',
                    data: result.rows.map(row => parseInt(row.leads_distributed)),
                    backgroundColor: ['#10B981', '#EF4444'],
                    borderColor: ['#059669', '#DC2626'],
                    borderWidth: 2
                }]
            };

        } else if (type === 'timezone-performance') {
            const result = await pool.query(`
                SELECT 
                    p.timezone,
                    COUNT(l.id) as total_leads,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(l.id)) * 100, 2) as conversion_rate,
                    ROUND(AVG(EXTRACT(EPOCH FROM (l.distributed_at - l.created_at))/60), 2) as avg_response_time_minutes
                FROM partners p
                LEFT JOIN leads l ON p.id = l.assigned_partner_id 
                    AND l.distributed_at >= $1 AND l.distributed_at <= $2
                WHERE p.status = 'active'
                GROUP BY p.timezone
                HAVING COUNT(l.id) > 0
                ORDER BY conversion_rate DESC
            `, [startDate, endDate + ' 23:59:59']);

            chartData = {
                labels: result.rows.map(row => row.timezone),
                datasets: [
                    {
                        label: 'Total Leads',
                        data: result.rows.map(row => parseInt(row.total_leads)),
                        backgroundColor: 'rgba(75, 192, 192, 0.6)',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Conversion Rate %',
                        data: result.rows.map(row => parseFloat(row.conversion_rate)),
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
        console.error('Business hours chart data error:', error);
        res.status(500).json({ error: 'Failed to fetch chart data' });
    }
});

/**
 * API: Get Scheduled Deliveries Status
 */
router.get('/api/scheduled-deliveries', async (req, res) => {
    try {
        const { status = 'all', limit = 100 } = req.query;
        
        let statusCondition = '';
        if (status !== 'all') {
            statusCondition = 'AND sd.status = $2';
        }

        const query = `
            SELECT 
                sd.id, sd.lead_id, sd.partner_id, sd.scheduled_time, sd.status, sd.attempts,
                l.source, l.niche, l.country, l.type, l.created_at,
                p.name as partner_name, p.timezone,
                EXTRACT(EPOCH FROM (sd.scheduled_time - NOW()))/60 as minutes_until_delivery
            FROM scheduled_deliveries sd
            JOIN leads l ON sd.lead_id = l.id
            JOIN partners p ON sd.partner_id = p.id
            WHERE 1=1 ${statusCondition}
            ORDER BY sd.scheduled_time ASC
            LIMIT $1
        `;

        const params = status === 'all' ? [limit] : [limit, status];
        const result = await pool.query(query, params);

        const deliveries = result.rows.map(row => ({
            ...row,
            minutesUntilDelivery: parseInt(row.minutes_until_delivery),
            isOverdue: row.status === 'scheduled' && new Date(row.scheduled_time) < new Date(),
            formattedScheduledTime: new Date(row.scheduled_time).toLocaleString()
        }));

        res.json({
            success: true,
            deliveries,
            totalCount: deliveries.length
        });

    } catch (error) {
        console.error('Scheduled deliveries API error:', error);
        res.status(500).json({ error: 'Failed to fetch scheduled deliveries' });
    }
});

/**
 * API: Bulk Update Partner Timezones (useful for initial setup)
 */
router.post('/api/bulk-update-timezones', async (req, res) => {
    try {
        const updates = req.body.updates; // Array of {partnerId, timezone}
        
        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ error: 'Updates array is required' });
        }

        let successCount = 0;
        const errors = [];

        for (const update of updates) {
            try {
                const { partnerId, timezone } = update;
                
                if (!partnerId || !timezone) {
                    errors.push(`Invalid update: missing partnerId or timezone`);
                    continue;
                }

                await pool.query(`
                    UPDATE partners 
                    SET timezone = $2, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [partnerId, timezone]);

                successCount++;
            } catch (error) {
                errors.push(`Partner ${update.partnerId}: ${error.message}`);
            }
        }

        res.json({
            success: true,
            message: `Updated ${successCount} partners`,
            successCount,
            errorCount: errors.length,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('Bulk update timezones error:', error);
        res.status(500).json({ error: 'Failed to bulk update timezones' });
    }
});

module.exports = router;