const { pool } = require('../config/db');

/**
 * Live System Monitoring Service
 * Provides real-time metrics for operational monitoring and system health
 */
class LiveMonitor {
    constructor() {
        this.startTime = Date.now();
        this.metrics = {
            lastUpdate: null,
            uptime: 0,
            status: 'starting'
        };
    }

    /**
     * Get comprehensive system health metrics
     */
    async getSystemHealth() {
        try {
            const now = Date.now();
            const uptime = Math.floor((now - this.startTime) / 1000);
            
            // Parallel execution of all monitoring queries for efficiency
            const [
                leadsMetrics,
                partnersMetrics, 
                webhookMetrics,
                alertsMetrics,
                distributionMetrics,
                dbPerformance
            ] = await Promise.all([
                this.getLeadsMetrics(),
                this.getPartnersMetrics(),
                this.getWebhookMetrics(),
                this.getAlertsMetrics(),
                this.getDistributionMetrics(),
                this.getDatabasePerformance()
            ]);

            const systemHealth = {
                timestamp: new Date().toISOString(),
                uptime: uptime,
                status: this.determineSystemStatus(leadsMetrics, partnersMetrics, webhookMetrics),
                
                leads: leadsMetrics,
                partners: partnersMetrics,
                webhooks: webhookMetrics,
                alerts: alertsMetrics,
                distribution: distributionMetrics,
                database: dbPerformance,
                
                // System-wide health score
                healthScore: this.calculateHealthScore(leadsMetrics, partnersMetrics, webhookMetrics, alertsMetrics)
            };

            this.metrics = systemHealth;
            return systemHealth;

        } catch (error) {
            console.error('❌ System health monitoring error:', error);
            return {
                timestamp: new Date().toISOString(),
                uptime: Math.floor((Date.now() - this.startTime) / 1000),
                status: 'error',
                error: error.message,
                healthScore: 0
            };
        }
    }

    /**
     * Get real-time leads processing metrics
     */
    async getLeadsMetrics() {
        const result = await pool.query(`
            SELECT 
                -- Today's metrics
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as today_total,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'distributed' THEN 1 END) as today_distributed,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'failed' THEN 1 END) as today_failed,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'pending' THEN 1 END) as today_pending,
                
                -- Last hour metrics  
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as hour_total,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' AND status = 'distributed' THEN 1 END) as hour_distributed,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' AND status = 'failed' THEN 1 END) as hour_failed,
                
                -- Last 15 minutes (real-time)
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '15 minutes' THEN 1 END) as recent_total,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '15 minutes' AND status = 'distributed' THEN 1 END) as recent_distributed,
                
                -- Processing times
                ROUND(AVG(CASE 
                    WHEN status = 'distributed' AND distributed_at IS NOT NULL 
                    THEN EXTRACT(EPOCH FROM (distributed_at - created_at))
                    ELSE NULL 
                END), 2) as avg_processing_time_seconds
                
            FROM leads 
            WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
        `);

        const metrics = result.rows[0];
        
        // Get current pending queue (all pending leads, not date-restricted)
        const pendingResult = await pool.query(`
            SELECT COUNT(*) as pending_queue
            FROM leads 
            WHERE status = 'pending'
        `);
        
        const pendingQueue = parseInt(pendingResult.rows[0].pending_queue) || 0;
        
        return {
            today: {
                total: parseInt(metrics.today_total) || 0,
                distributed: parseInt(metrics.today_distributed) || 0,
                failed: parseInt(metrics.today_failed) || 0,
                pending: parseInt(metrics.today_pending) || 0,
                distributionRate: metrics.today_total > 0 ? 
                    Math.round((metrics.today_distributed / metrics.today_total) * 100) : 0
            },
            lastHour: {
                total: parseInt(metrics.hour_total) || 0,
                distributed: parseInt(metrics.hour_distributed) || 0,
                failed: parseInt(metrics.hour_failed) || 0,
                rate: parseInt(metrics.hour_total) || 0 // leads per hour
            },
            recent: {
                total: parseInt(metrics.recent_total) || 0,
                distributed: parseInt(metrics.recent_distributed) || 0,
                rate: Math.round((parseInt(metrics.recent_total) || 0) * 4) // leads per hour projection
            },
            performance: {
                avgProcessingTime: parseFloat(metrics.avg_processing_time_seconds) || 0,
                pendingQueue: pendingQueue
            }
        };
    }

    /**
     * Get real-time partner availability metrics
     */
    async getPartnersMetrics() {
        const result = await pool.query(`
            SELECT 
                p.status,
                p.country,
                p.niche,
                COUNT(*) as count,
                
                -- Today's performance
                COALESCE(SUM(ds.leads_received), 0) as total_leads_today,
                COALESCE(SUM(ds.conversions), 0) as total_conversions_today,
                
                -- Daily limit utilization
                ROUND(AVG(
                    CASE 
                        WHEN p.daily_limit > 0 THEN 
                            (COALESCE(ds.leads_received, 0)::decimal / p.daily_limit * 100)
                        ELSE 0 
                    END
                ), 1) as avg_utilization,
                
                -- Partners at or near capacity
                COUNT(CASE 
                    WHEN COALESCE(ds.leads_received, 0)::decimal / p.daily_limit >= 0.9 
                    THEN 1 
                END) as near_capacity
                
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            GROUP BY p.status, p.country, p.niche
            ORDER BY p.status, count DESC
        `);

        const statusSummary = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count,
                ROUND(AVG(daily_limit), 0) as avg_daily_limit
            FROM partners 
            GROUP BY status
        `);

        return {
            byStatus: statusSummary.rows.reduce((acc, row) => {
                acc[row.status] = {
                    count: parseInt(row.count),
                    avgDailyLimit: parseInt(row.avg_daily_limit) || 0
                };
                return acc;
            }, {}),
            breakdown: result.rows.map(row => ({
                status: row.status,
                country: row.country,
                niche: row.niche,
                count: parseInt(row.count),
                leadsToday: parseInt(row.total_leads_today) || 0,
                conversionsToday: parseInt(row.total_conversions_today) || 0,
                utilization: parseFloat(row.avg_utilization) || 0,
                nearCapacity: parseInt(row.near_capacity) || 0
            })),
            summary: {
                active: result.rows.filter(r => r.status === 'active').reduce((sum, r) => sum + parseInt(r.count), 0),
                paused: result.rows.filter(r => r.status === 'paused').reduce((sum, r) => sum + parseInt(r.count), 0),
                inactive: result.rows.filter(r => r.status === 'inactive').reduce((sum, r) => sum + parseInt(r.count), 0)
            }
        };
    }

    /**
     * Get webhook delivery health metrics  
     */
    async getWebhookMetrics() {
        const result = await pool.query(`
            SELECT 
                -- Today's webhook performance
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as today_attempts,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'success' THEN 1 END) as today_success,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'failed' THEN 1 END) as today_failed,
                COUNT(CASE WHEN created_at >= CURRENT_DATE AND status = 'pending' THEN 1 END) as today_pending,
                
                -- Last hour performance
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as hour_attempts,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' AND status = 'success' THEN 1 END) as hour_success,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' AND status = 'failed' THEN 1 END) as hour_failed,
                
                -- Response time performance
                ROUND(AVG(CASE 
                    WHEN status = 'success' AND delivered_at IS NOT NULL 
                    THEN EXTRACT(EPOCH FROM (delivered_at - created_at))
                    ELSE NULL 
                END), 2) as avg_response_time,
                
                -- Current retry queue
                COUNT(CASE WHEN status = 'failed' AND attempts < 3 THEN 1 END) as retry_queue,
                
                -- HTTP status codes today
                COUNT(CASE WHEN response_code BETWEEN 200 AND 299 THEN 1 END) as http_2xx,
                COUNT(CASE WHEN response_code BETWEEN 400 AND 499 THEN 1 END) as http_4xx,
                COUNT(CASE WHEN response_code BETWEEN 500 AND 599 THEN 1 END) as http_5xx
                
            FROM webhook_deliveries 
            WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
        `);

        const metrics = result.rows[0];
        
        return {
            today: {
                attempts: parseInt(metrics.today_attempts) || 0,
                success: parseInt(metrics.today_success) || 0,
                failed: parseInt(metrics.today_failed) || 0,
                pending: parseInt(metrics.today_pending) || 0,
                successRate: metrics.today_attempts > 0 ? 
                    Math.round((metrics.today_success / metrics.today_attempts) * 100) : 0
            },
            lastHour: {
                attempts: parseInt(metrics.hour_attempts) || 0,
                success: parseInt(metrics.hour_success) || 0,
                failed: parseInt(metrics.hour_failed) || 0,
                successRate: metrics.hour_attempts > 0 ? 
                    Math.round((metrics.hour_success / metrics.hour_attempts) * 100) : 0
            },
            performance: {
                avgResponseTime: parseFloat(metrics.avg_response_time) || 0,
                retryQueue: parseInt(metrics.retry_queue) || 0
            },
            httpStatus: {
                success: parseInt(metrics.http_2xx) || 0,
                clientError: parseInt(metrics.http_4xx) || 0,
                serverError: parseInt(metrics.http_5xx) || 0
            }
        };
    }

    /**
     * Get current alerts status
     */
    async getAlertsMetrics() {
        const result = await pool.query(`
            SELECT 
                severity,
                CASE WHEN resolved THEN 'resolved' ELSE 'active' END as status,
                COUNT(*) as count,
                MIN(created_at) as oldest_alert,
                MAX(created_at) as newest_alert
            FROM system_alerts
            WHERE created_at >= NOW() - INTERVAL '24 hours'
            GROUP BY severity, CASE WHEN resolved THEN 'resolved' ELSE 'active' END
            ORDER BY 
                CASE severity 
                    WHEN 'high' THEN 1 
                    WHEN 'medium' THEN 2 
                    WHEN 'low' THEN 3 
                END
        `);

        const recentCritical = await pool.query(`
            SELECT id, title, message, severity, created_at
            FROM system_alerts 
            WHERE severity = 'high' 
              AND resolved = false
              AND created_at >= NOW() - INTERVAL '1 hour'
            ORDER BY created_at DESC
            LIMIT 5
        `);

        return {
            summary: result.rows.reduce((acc, row) => {
                const key = `${row.severity}_${row.status}`;
                acc[key] = parseInt(row.count);
                return acc;
            }, {}),
            recentCritical: recentCritical.rows.map(alert => ({
                id: alert.id,
                title: alert.title,
                message: alert.message.substring(0, 100) + (alert.message.length > 100 ? '...' : ''),
                severity: alert.severity,
                timestamp: alert.created_at
            }))
        };
    }

    /**
     * Get lead distribution performance  
     */
    async getDistributionMetrics() {
        const result = await pool.query(`
            SELECT 
                country,
                niche,
                COUNT(*) as total_leads,
                COUNT(CASE WHEN assigned_partner_id IS NOT NULL THEN 1 END) as distributed_leads,
                COUNT(CASE WHEN assigned_partner_id IS NULL THEN 1 END) as unassigned_leads,
                ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(distributed_at, created_at) - created_at))), 2) as avg_distribution_time
            FROM leads 
            WHERE created_at >= NOW() - INTERVAL '6 hours'
            GROUP BY country, niche
            ORDER BY total_leads DESC
        `);

        return {
            byMarket: result.rows.map(row => ({
                country: row.country,
                niche: row.niche,
                totalLeads: parseInt(row.total_leads),
                distributedLeads: parseInt(row.distributed_leads),
                unassignedLeads: parseInt(row.unassigned_leads),
                distributionRate: row.total_leads > 0 ? 
                    Math.round((row.distributed_leads / row.total_leads) * 100) : 0,
                avgDistributionTime: parseFloat(row.avg_distribution_time) || 0
            }))
        };
    }

    /**
     * Get database performance metrics
     */
    async getDatabasePerformance() {
        try {
            const connectionTest = await pool.query('SELECT NOW() as timestamp, pg_database_size(current_database()) as db_size');
            const tableStats = await pool.query(`
                SELECT 
                    schemaname,
                    tablename,
                    n_tup_ins as inserts,
                    n_tup_upd as updates,
                    n_tup_del as deletes,
                    n_live_tup as live_tuples,
                    n_dead_tup as dead_tuples
                FROM pg_stat_user_tables 
                WHERE schemaname = 'public'
                ORDER BY n_live_tup DESC
                LIMIT 10
            `);

            return {
                connected: true,
                timestamp: connectionTest.rows[0].timestamp,
                databaseSize: parseInt(connectionTest.rows[0].db_size),
                tables: tableStats.rows.map(row => ({
                    name: row.tablename,
                    inserts: parseInt(row.inserts) || 0,
                    updates: parseInt(row.updates) || 0,
                    deletes: parseInt(row.deletes) || 0,
                    liveTuples: parseInt(row.live_tuples) || 0,
                    deadTuples: parseInt(row.dead_tuples) || 0
                }))
            };
        } catch (error) {
            return {
                connected: false,
                error: error.message
            };
        }
    }

    /**
     * Determine overall system status
     */
    determineSystemStatus(leads, partners, webhooks) {
        // Critical: High lead failure rate or no active partners
        if (leads.today.distributionRate < 50 || partners.summary.active === 0) {
            return 'critical';
        }
        
        // Warning: Moderate webhook failures or low partner availability  
        if (webhooks.today.successRate < 80 || partners.summary.active < 3) {
            return 'warning';
        }
        
        // Degraded: Recent processing issues
        if (leads.recent.rate === 0 && leads.performance.pendingQueue > 10) {
            return 'degraded';
        }
        
        return 'healthy';
    }

    /**
     * Calculate overall system health score (0-100)
     */
    calculateHealthScore(leads, partners, webhooks, alerts) {
        let score = 100;
        
        // Lead processing health (40% weight)
        const leadScore = Math.min(leads.today.distributionRate, 100);
        score = score * 0.6 + leadScore * 0.4;
        
        // Partner availability (30% weight)
        const partnerScore = partners.summary.active > 0 ? 
            Math.min((partners.summary.active / Math.max(partners.summary.active + partners.summary.paused, 1)) * 100, 100) : 0;
        score = score * 0.7 + partnerScore * 0.3;
        
        // Webhook reliability (20% weight)  
        const webhookScore = webhooks.today.successRate;
        score = score * 0.8 + webhookScore * 0.2;
        
        // Alert penalty (10% weight)
        const criticalAlerts = alerts.summary.high_active || 0;
        const alertPenalty = Math.min(criticalAlerts * 10, 50);
        score = Math.max(score - alertPenalty, 0);
        
        return Math.round(score);
    }
}

module.exports = new LiveMonitor();