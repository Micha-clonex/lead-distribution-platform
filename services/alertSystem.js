const { pool } = require('../config/db');

class AlertSystem {
    constructor() {
        this.alertTypes = {
            STRANDED_LEAD: { severity: 'high', cooldown: 300000 }, // 5 minutes
            WEBHOOK_FAILURES: { severity: 'medium', cooldown: 900000 }, // 15 minutes
            PARTNER_OFFLINE: { severity: 'medium', cooldown: 1800000 }, // 30 minutes
            LOW_CONVERSION_RATE: { severity: 'medium', cooldown: 3600000 }, // 1 hour
            SYSTEM_ERROR: { severity: 'critical', cooldown: 60000 }, // 1 minute
            HIGH_LEAD_REJECTION: { severity: 'high', cooldown: 600000 } // 10 minutes
        };
        
        this.lastAlerts = new Map();
        // Database initialization moved to explicit call after main db init
    }

    async initializeDatabase() {
        try {
            // Create system_alerts table if not exists
            await pool.query(`
                CREATE TABLE IF NOT EXISTS system_alerts (
                    id SERIAL PRIMARY KEY,
                    type VARCHAR(50) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    title VARCHAR(200) NOT NULL,
                    message TEXT NOT NULL,
                    data JSONB,
                    resolved BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    resolved_at TIMESTAMP,
                    
                    -- References
                    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
                    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
                    webhook_delivery_id INTEGER REFERENCES webhook_deliveries(id) ON DELETE SET NULL
                );
            `);

            // Create alert_subscriptions table for notification preferences
            await pool.query(`
                CREATE TABLE IF NOT EXISTS alert_subscriptions (
                    id SERIAL PRIMARY KEY,
                    alert_type VARCHAR(50) NOT NULL,
                    notification_method VARCHAR(20) NOT NULL, -- email, console, webhook
                    target VARCHAR(200) NOT NULL, -- email address, webhook url, etc.
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Add unique constraint for alert subscriptions
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS alert_subscriptions_unique 
                ON alert_subscriptions (alert_type, notification_method, target)
            `);
            
            // Insert default console notifications
            await pool.query(`
                INSERT INTO alert_subscriptions (alert_type, notification_method, target, is_active)
                VALUES 
                    ('STRANDED_LEAD', 'console', 'system', true),
                    ('WEBHOOK_FAILURES', 'console', 'system', true),
                    ('PARTNER_OFFLINE', 'console', 'system', true),
                    ('SYSTEM_ERROR', 'console', 'system', true)
                ON CONFLICT (alert_type, notification_method, target) DO NOTHING
            `);
            
        } catch (error) {
            console.error('Failed to initialize alert system database:', error);
        }
    }

    async createAlert(type, title, message, data = {}) {
        try {
            const alertConfig = this.alertTypes[type];
            if (!alertConfig) {
                console.error(`Unknown alert type: ${type}`);
                return false;
            }

            // Check cooldown to prevent spam
            const alertKey = `${type}_${JSON.stringify(data)}`;
            const lastAlert = this.lastAlerts.get(alertKey);
            const now = Date.now();
            
            if (lastAlert && (now - lastAlert) < alertConfig.cooldown) {
                console.log(`Alert ${type} is in cooldown period, skipping...`);
                return false;
            }

            // Store alert in database
            const alertResult = await pool.query(`
                INSERT INTO system_alerts (
                    type, severity, title, message, data,
                    lead_id, partner_id, webhook_delivery_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
            `, [
                type,
                alertConfig.severity,
                title,
                message,
                JSON.stringify(data),
                data.lead_id || null,
                data.partner_id || null,
                data.webhook_delivery_id || null
            ]);

            const alertId = alertResult.rows[0].id;
            this.lastAlerts.set(alertKey, now);

            // Send notifications
            await this.sendNotifications(type, {
                id: alertId,
                severity: alertConfig.severity,
                title,
                message,
                data
            });

            console.log(`🚨 ALERT [${alertConfig.severity.toUpperCase()}]: ${title}`);
            return alertId;

        } catch (error) {
            console.error('Failed to create alert:', error);
            return false;
        }
    }

    async sendNotifications(alertType, alert) {
        try {
            // Get active subscriptions for this alert type
            const subscriptions = await pool.query(`
                SELECT * FROM alert_subscriptions 
                WHERE alert_type = $1 AND is_active = true
            `, [alertType]);

            for (const subscription of subscriptions.rows) {
                switch (subscription.notification_method) {
                    case 'console':
                        this.sendConsoleNotification(alert);
                        break;
                    case 'email':
                        await this.sendEmailNotification(subscription.target, alert);
                        break;
                    case 'webhook':
                        await this.sendWebhookNotification(subscription.target, alert);
                        break;
                }
            }
        } catch (error) {
            console.error('Failed to send notifications:', error);
        }
    }

    sendConsoleNotification(alert) {
        const timestamp = new Date().toISOString();
        const severityIcon = {
            low: '💡',
            medium: '⚠️',
            high: '🔥',
            critical: '🚨'
        }[alert.severity] || '📢';
        
        console.log(`\n${severityIcon} [${alert.severity.toUpperCase()}] ${timestamp}\n${alert.title}\n${alert.message}\n${'-'.repeat(50)}`);
    }

    async sendEmailNotification(email, alert) {
        // Placeholder for email integration
        console.log(`📧 Email notification would be sent to ${email}: ${alert.title}`);
    }

    async sendWebhookNotification(webhookUrl, alert) {
        // Placeholder for webhook notification
        console.log(`🔗 Webhook notification would be sent to ${webhookUrl}: ${alert.title}`);
    }

    // Alert helper methods
    async alertStrandedLead(lead) {
        return await this.createAlert(
            'STRANDED_LEAD',
            `Stranded Lead: ${lead.first_name} ${lead.last_name}`,
            `Lead ${lead.id} from ${lead.country}/${lead.niche} has no available partners`,
            { lead_id: lead.id, country: lead.country, niche: lead.niche }
        );
    }

    async alertWebhookFailures(failedCount, partnerId = null) {
        return await this.createAlert(
            'WEBHOOK_FAILURES',
            'Multiple Webhook Failures Detected',
            `${failedCount} webhook deliveries have failed in the last hour`,
            { failed_count: failedCount, partner_id: partnerId }
        );
    }

    async alertPartnerOffline(partner) {
        return await this.createAlert(
            'PARTNER_OFFLINE',
            `Partner Offline: ${partner.name}`,
            `Partner ${partner.name} (${partner.country}/${partner.niche}) appears to be offline - webhook failures detected`,
            { partner_id: partner.id, country: partner.country, niche: partner.niche }
        );
    }

    async alertLowConversionRate(partner, rate) {
        return await this.createAlert(
            'LOW_CONVERSION_RATE',
            `Low Conversion Rate: ${partner.name}`,
            `Partner ${partner.name} conversion rate dropped to ${rate}% (below threshold)`,
            { partner_id: partner.id, conversion_rate: rate }
        );
    }

    async alertSystemError(error, context = {}) {
        return await this.createAlert(
            'SYSTEM_ERROR',
            'System Error Detected',
            `Critical error: ${error.message}`,
            { error: error.message, stack: error.stack, context }
        );
    }

    async alertHighLeadRejection(source, rejectionRate) {
        return await this.createAlert(
            'HIGH_LEAD_REJECTION',
            `High Lead Rejection Rate: ${source}`,
            `Lead source "${source}" has ${rejectionRate}% rejection rate in the last hour`,
            { source, rejection_rate: rejectionRate }
        );
    }

    // Get active alerts for dashboard
    async getActiveAlerts(limit = 10) {
        try {
            const result = await pool.query(`
                SELECT sa.*, 
                       l.first_name, l.last_name, l.email as lead_email,
                       p.name as partner_name, p.country as partner_country
                FROM system_alerts sa
                LEFT JOIN leads l ON sa.lead_id = l.id
                LEFT JOIN partners p ON sa.partner_id = p.id
                WHERE sa.resolved = false
                ORDER BY sa.created_at DESC
                LIMIT $1
            `, [limit]);
            
            return result.rows;
        } catch (error) {
            console.error('Failed to get active alerts:', error);
            return [];
        }
    }

    // Resolve alert
    async resolveAlert(alertId, userId = 'system') {
        try {
            await pool.query(`
                UPDATE system_alerts 
                SET resolved = true, resolved_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [alertId]);
            
            console.log(`✅ Alert ${alertId} resolved by ${userId}`);
            return true;
        } catch (error) {
            console.error('Failed to resolve alert:', error);
            return false;
        }
    }

    // Auto-resolve old alerts
    async autoResolveOldAlerts() {
        try {
            const result = await pool.query(`
                UPDATE system_alerts 
                SET resolved = true, resolved_at = CURRENT_TIMESTAMP 
                WHERE resolved = false 
                    AND created_at < NOW() - INTERVAL '7 days'
                RETURNING id
            `);
            
            if (result.rows.length > 0) {
                console.log(`Auto-resolved ${result.rows.length} old alerts`);
            }
        } catch (error) {
            console.error('Failed to auto-resolve old alerts:', error);
        }
    }
}

// Create singleton instance
const alertSystem = new AlertSystem();

module.exports = alertSystem;