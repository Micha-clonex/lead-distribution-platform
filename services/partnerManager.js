const { pool } = require('../config/db');
const { sendAlert } = require('./alertSystem');

/**
 * Automated Partner Management System
 * Monitors partner performance and automatically pauses/resumes partners based on criteria
 */
class PartnerManager {
    constructor() {
        this.thresholds = {
            // Conversion rate thresholds
            minConversionRate: 2.0, // Minimum 2% conversion rate
            minLeadsForAnalysis: 20, // Need at least 20 leads for reliable analysis
            
            // Webhook delivery thresholds  
            maxFailureRate: 25.0, // Max 25% webhook failure rate
            minDeliveryAttempts: 10, // Need at least 10 delivery attempts
            
            // Time-based criteria
            analysisWindow: 7, // Days to analyze performance
            pauseDuration: 24, // Hours to keep partner paused before review
            
            // Performance improvement thresholds for auto-resume
            resumeConversionRate: 5.0, // 5% conversion rate to auto-resume
            resumeFailureRate: 10.0 // Max 10% failure rate to auto-resume
        };
    }

    /**
     * Main automated partner management workflow
     */
    async runAutomatedManagement() {
        try {
            console.log('🤖 Running Automated Partner Management...');
            
            const activePartners = await this.getActivePartners();
            const analysisResults = [];
            
            for (const partner of activePartners) {
                const analysis = await this.analyzePartnerPerformance(partner);
                analysisResults.push(analysis);
                
                // Auto-pause poor performers
                if (analysis.shouldPause) {
                    await this.autoPausePartner(partner, analysis);
                }
            }
            
            // Check paused partners for auto-resume
            const pausedPartners = await this.getPausedPartners();
            for (const partner of pausedPartners) {
                const resumeAnalysis = await this.analyzePartnerForResume(partner);
                if (resumeAnalysis.shouldResume) {
                    await this.autoResumePartner(partner, resumeAnalysis);
                }
            }
            
            // Generate summary report
            const summary = this.generateManagementSummary(analysisResults);
            console.log('📊 Partner Management Summary:', summary);
            
            return summary;
        } catch (error) {
            console.error('❌ Automated Partner Management error:', error);
            await sendAlert('system_error', {
                title: 'Automated Partner Management Failed',
                message: `Partner management automation encountered an error: ${error.message}`,
                severity: 'high',
                component: 'partner_manager'
            });
            throw error;
        }
    }

    /**
     * Analyze individual partner performance
     */
    async analyzePartnerPerformance(partner) {
        const analysis = {
            partnerId: partner.id,
            partnerName: partner.name,
            country: partner.country,
            niche: partner.niche,
            shouldPause: false,
            reasons: [],
            metrics: {}
        };

        try {
            // Get performance metrics for the analysis window
            const metricsResult = await pool.query(`
                SELECT 
                    COUNT(l.id) as total_leads,
                    COUNT(c.id) as conversions,
                    CASE 
                        WHEN COUNT(l.id) > 0 THEN 
                            ROUND((COUNT(c.id)::decimal / COUNT(l.id) * 100), 2)
                        ELSE 0 
                    END as conversion_rate,
                    
                    COUNT(wd.id) as webhook_attempts,
                    COUNT(CASE WHEN wd.response_code >= 400 OR wd.response_code IS NULL THEN 1 END) as webhook_failures,
                    CASE 
                        WHEN COUNT(wd.id) > 0 THEN 
                            ROUND((COUNT(CASE WHEN wd.response_code >= 400 OR wd.response_code IS NULL THEN 1 END)::decimal / COUNT(wd.id) * 100), 2)
                        ELSE 0 
                    END as failure_rate,
                    
                    AVG(EXTRACT(EPOCH FROM (wd.delivered_at - wd.created_at))/60) as avg_delivery_time_minutes
                    
                FROM leads l
                LEFT JOIN conversions c ON l.id = c.lead_id AND l.assigned_partner_id = c.partner_id
                LEFT JOIN webhook_deliveries wd ON l.id = wd.lead_id
                WHERE l.assigned_partner_id = $1 
                  AND l.created_at > NOW() - INTERVAL '${this.thresholds.analysisWindow} days'
            `, [partner.id]);

            const metrics = metricsResult.rows[0];
            analysis.metrics = {
                totalLeads: parseInt(metrics.total_leads) || 0,
                conversions: parseInt(metrics.conversions) || 0,
                conversionRate: parseFloat(metrics.conversion_rate) || 0,
                webhookAttempts: parseInt(metrics.webhook_attempts) || 0,
                webhookFailures: parseInt(metrics.webhook_failures) || 0,
                failureRate: parseFloat(metrics.failure_rate) || 0,
                avgDeliveryTime: parseFloat(metrics.avg_delivery_time_minutes) || 0
            };

            // Decision logic for auto-pausing
            
            // 1. Low conversion rate analysis
            if (metrics.total_leads >= this.thresholds.minLeadsForAnalysis) {
                if (metrics.conversion_rate < this.thresholds.minConversionRate) {
                    analysis.shouldPause = true;
                    analysis.reasons.push(`Low conversion rate: ${metrics.conversion_rate}% (minimum: ${this.thresholds.minConversionRate}%)`);
                }
            }
            
            // 2. High webhook failure rate analysis  
            if (metrics.webhook_attempts >= this.thresholds.minDeliveryAttempts) {
                if (metrics.failure_rate > this.thresholds.maxFailureRate) {
                    analysis.shouldPause = true;
                    analysis.reasons.push(`High webhook failure rate: ${metrics.failure_rate}% (maximum: ${this.thresholds.maxFailureRate}%)`);
                }
            }
            
            // 3. Complete non-responsiveness (no conversions despite adequate volume)
            if (metrics.total_leads >= this.thresholds.minLeadsForAnalysis * 2 && metrics.conversions === 0) {
                analysis.shouldPause = true;
                analysis.reasons.push(`Zero conversions despite ${metrics.total_leads} leads over ${this.thresholds.analysisWindow} days`);
            }

        } catch (error) {
            console.error(`❌ Error analyzing partner ${partner.id}:`, error);
            analysis.error = error.message;
        }

        return analysis;
    }

    /**
     * Auto-pause a poor performing partner
     */
    async autoPausePartner(partner, analysis) {
        try {
            // Idempotency check - don't pause if already paused
            if (partner.status === 'paused') {
                console.log(`⏸️ Partner ${partner.name} already paused - logging performance review`);
                
                await pool.query(`
                    INSERT INTO partner_management_log 
                    (partner_id, action, reason, metrics, created_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                `, [
                    partner.id,
                    'performance_review',
                    'Partner remains paused due to: ' + analysis.reasons.join('; '),
                    JSON.stringify(analysis.metrics)
                ]);
                return;
            }
            
            console.log(`⏸️ Auto-pausing partner: ${partner.name} (ID: ${partner.id})`);
            
            // Update partner status to paused
            await pool.query(
                'UPDATE partners SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                ['paused', partner.id]
            );
            
            // Log the auto-pause action
            await pool.query(`
                INSERT INTO partner_management_log 
                (partner_id, action, reason, metrics, created_at)
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [
                partner.id,
                'auto_pause',
                analysis.reasons.join('; '),
                JSON.stringify(analysis.metrics)
            ]);
            
            // Send alert notification
            await sendAlert('partner_paused', {
                title: `Partner Auto-Paused: ${partner.name}`,
                message: `Partner "${partner.name}" (${partner.country}/${partner.niche}) has been automatically paused due to poor performance:
                
Reasons:
${analysis.reasons.map(r => `• ${r}`).join('\n')}

Recent Performance:
• Leads: ${analysis.metrics.totalLeads}
• Conversions: ${analysis.metrics.conversions}  
• Conversion Rate: ${analysis.metrics.conversionRate}%
• Webhook Failures: ${analysis.metrics.failureRate}%

The partner will be eligible for automatic review in ${this.thresholds.pauseDuration} hours.`,
                severity: 'medium',
                component: 'partner_manager',
                partnerId: partner.id
            });
            
            console.log(`✅ Partner ${partner.name} successfully auto-paused`);
            
        } catch (error) {
            console.error(`❌ Error auto-pausing partner ${partner.id}:`, error);
            throw error;
        }
    }

    /**
     * Analyze paused partner for potential auto-resume
     */
    async analyzePartnerForResume(partner) {
        const analysis = {
            partnerId: partner.id,
            partnerName: partner.name,
            shouldResume: false,
            reasons: [],
            metrics: {}
        };

        try {
            // Check if partner has been paused long enough based on actual pause event
            const pauseTimeResult = await pool.query(`
                SELECT created_at FROM partner_management_log 
                WHERE partner_id = $1 
                  AND action IN ('auto_pause', 'manual_pause')
                ORDER BY created_at DESC 
                LIMIT 1
            `, [partner.id]);
            
            if (pauseTimeResult.rows.length === 0) {
                return analysis; // No pause record found
            }
            
            const pauseTime = new Date(pauseTimeResult.rows[0].created_at);
            const hoursSincePause = (Date.now() - pauseTime.getTime()) / (1000 * 60 * 60);
            
            if (hoursSincePause < this.thresholds.pauseDuration) {
                return analysis; // Not enough time has passed since actual pause
            }
            
            // Check recent performance (last 3 days) for improvement signs
            const recentMetricsResult = await pool.query(`
                SELECT 
                    COUNT(l.id) as total_leads,
                    COUNT(c.id) as conversions,
                    CASE 
                        WHEN COUNT(l.id) > 0 THEN 
                            ROUND((COUNT(c.id)::decimal / COUNT(l.id) * 100), 2)
                        ELSE 0 
                    END as conversion_rate,
                    
                    COUNT(wd.id) as webhook_attempts,
                    COUNT(CASE WHEN wd.response_code >= 400 OR wd.response_code IS NULL THEN 1 END) as webhook_failures,
                    CASE 
                        WHEN COUNT(wd.id) > 0 THEN 
                            ROUND((COUNT(CASE WHEN wd.response_code >= 400 OR wd.response_code IS NULL THEN 1 END)::decimal / COUNT(wd.id) * 100), 2)
                        ELSE 0 
                    END as failure_rate
                    
                FROM leads l
                LEFT JOIN conversions c ON l.id = c.lead_id AND l.assigned_partner_id = c.partner_id
                LEFT JOIN webhook_deliveries wd ON l.id = wd.lead_id
                WHERE l.assigned_partner_id = $1 
                  AND l.created_at > NOW() - INTERVAL '3 days'
            `, [partner.id]);
            
            const metrics = recentMetricsResult.rows[0];
            analysis.metrics = {
                totalLeads: parseInt(metrics.total_leads) || 0,
                conversions: parseInt(metrics.conversions) || 0,
                conversionRate: parseFloat(metrics.conversion_rate) || 0,
                failureRate: parseFloat(metrics.failure_rate) || 0
            };
            
            // Auto-resume criteria - BOTH conditions must be met simultaneously
            if (metrics.total_leads >= 5) { // Minimum activity required
                const conversionMet = metrics.conversion_rate >= this.thresholds.resumeConversionRate;
                const failureMet = metrics.failure_rate <= this.thresholds.resumeFailureRate;
                
                if (conversionMet) {
                    analysis.reasons.push(`Improved conversion rate: ${metrics.conversion_rate}%`);
                }
                
                if (failureMet) {
                    analysis.reasons.push(`Low webhook failure rate: ${metrics.failure_rate}%`);
                }
                
                // Both conversion rate AND failure rate thresholds must be met
                if (conversionMet && failureMet) {
                    analysis.shouldResume = true;
                }
            }
            
        } catch (error) {
            console.error(`❌ Error analyzing partner ${partner.id} for resume:`, error);
            analysis.error = error.message;
        }

        return analysis;
    }

    /**
     * Auto-resume a partner that has shown improvement
     */
    async autoResumePartner(partner, analysis) {
        try {
            // Idempotency check - don't resume if already active
            if (partner.status === 'active') {
                console.log(`▶️ Partner ${partner.name} already active - logging performance review`);
                
                await pool.query(`
                    INSERT INTO partner_management_log 
                    (partner_id, action, reason, metrics, created_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                `, [
                    partner.id,
                    'performance_review',
                    'Partner remains active due to good performance: ' + analysis.reasons.join('; '),
                    JSON.stringify(analysis.metrics)
                ]);
                return;
            }
            
            console.log(`▶️ Auto-resuming partner: ${partner.name} (ID: ${partner.id})`);
            
            // Update partner status to active
            await pool.query(
                'UPDATE partners SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                ['active', partner.id]
            );
            
            // Log the auto-resume action
            await pool.query(`
                INSERT INTO partner_management_log 
                (partner_id, action, reason, metrics, created_at)
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            `, [
                partner.id,
                'auto_resume',
                analysis.reasons.join('; '),
                JSON.stringify(analysis.metrics)
            ]);
            
            // Send alert notification
            await sendAlert('partner_resumed', {
                title: `Partner Auto-Resumed: ${partner.name}`,
                message: `Partner "${partner.name}" (${partner.country}/${partner.niche}) has been automatically resumed due to improved performance:
                
Improvement Indicators:
${analysis.reasons.map(r => `• ${r}`).join('\n')}

Recent Performance (Last 3 Days):
• Leads: ${analysis.metrics.totalLeads}
• Conversions: ${analysis.metrics.conversions}
• Conversion Rate: ${analysis.metrics.conversionRate}%
• Webhook Failures: ${analysis.metrics.failureRate}%

The partner is now active and will receive new leads.`,
                severity: 'low',
                component: 'partner_manager',
                partnerId: partner.id
            });
            
            console.log(`✅ Partner ${partner.name} successfully auto-resumed`);
            
        } catch (error) {
            console.error(`❌ Error auto-resuming partner ${partner.id}:`, error);
            throw error;
        }
    }

    /**
     * Get all active partners for analysis
     */
    async getActivePartners() {
        const result = await pool.query(
            "SELECT * FROM partners WHERE status = 'active' ORDER BY created_at"
        );
        return result.rows;
    }

    /**
     * Get all paused partners for resume analysis
     */
    async getPausedPartners() {
        const result = await pool.query(
            "SELECT * FROM partners WHERE status = 'paused' ORDER BY updated_at"
        );
        return result.rows;
    }

    /**
     * Generate management summary
     */
    generateManagementSummary(analysisResults) {
        const summary = {
            timestamp: new Date().toISOString(),
            partnersAnalyzed: analysisResults.length,
            partnersPaused: analysisResults.filter(a => a.shouldPause).length,
            pauseReasons: {},
            averageMetrics: {}
        };

        // Collect pause reasons
        analysisResults.forEach(analysis => {
            if (analysis.shouldPause) {
                analysis.reasons.forEach(reason => {
                    const key = reason.split(':')[0]; // Extract reason type
                    summary.pauseReasons[key] = (summary.pauseReasons[key] || 0) + 1;
                });
            }
        });

        // Calculate average metrics
        const validAnalyses = analysisResults.filter(a => !a.error && a.metrics.totalLeads > 0);
        if (validAnalyses.length > 0) {
            summary.averageMetrics = {
                avgConversionRate: (validAnalyses.reduce((sum, a) => sum + a.metrics.conversionRate, 0) / validAnalyses.length).toFixed(2),
                avgFailureRate: (validAnalyses.reduce((sum, a) => sum + a.metrics.failureRate, 0) / validAnalyses.length).toFixed(2),
                totalLeadsProcessed: validAnalyses.reduce((sum, a) => sum + a.metrics.totalLeads, 0)
            };
        }

        return summary;
    }
}

module.exports = new PartnerManager();