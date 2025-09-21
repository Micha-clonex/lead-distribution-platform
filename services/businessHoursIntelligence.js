const { pool } = require('../config/db');

/**
 * Business Hours Intelligence Service
 * Time-zone aware lead distribution with intelligent scheduling
 * 
 * Features:
 * - Real-time business hours checking across time zones
 * - Intelligent lead queuing for partners outside hours
 * - Business hours optimization analytics
 * - Holiday and weekend handling
 * - Partner availability scoring
 */

class BusinessHoursIntelligence {
    constructor() {
        // Common timezone mappings for countries
        this.countryTimezones = {
            'germany': 'Europe/Berlin',
            'austria': 'Europe/Vienna', 
            'spain': 'Europe/Madrid',
            'canada': 'America/Toronto',
            'italy': 'Europe/Rome',
            'uk': 'Europe/London',
            'norway': 'Europe/Oslo',
            'france': 'Europe/Paris',
            'switzerland': 'Europe/Zurich'
        };

        // Business days (Monday = 1, Sunday = 0)
        this.businessDays = [1, 2, 3, 4, 5]; // Mon-Fri
        
        // Cache for partner business hours (5 min TTL)
        this.partnerHoursCache = new Map();
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Check if partner is currently within business hours
     */
    async isPartnerAvailable(partnerId) {
        try {
            const partner = await this.getPartnerBusinessHours(partnerId);
            if (!partner) return false;

            return this.checkBusinessHoursAvailability(
                partner.timezone,
                partner.business_hours_start,
                partner.business_hours_end,
                partner.weekends_enabled || false
            );
        } catch (error) {
            console.error('Partner availability check error:', error);
            return false; // Default to unavailable on error
        }
    }

    /**
     * Get all available partners within business hours for given country/niche
     */
    async getAvailablePartners(country, niche, includeQueueable = true) {
        try {
            const result = await pool.query(`
                SELECT 
                    p.id, p.name, p.country, p.niche, p.status,
                    p.timezone, p.business_hours_start, p.business_hours_end,
                    p.weekends_enabled, p.daily_limit, p.premium_ratio,
                    COALESCE(ds.leads_received, 0) as todays_leads,
                    COALESCE(ds.premium_leads, 0) as todays_premium
                FROM partners p
                LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
                WHERE p.status = 'active' 
                  AND p.country = $1 
                  AND p.niche = $2
                  AND COALESCE(ds.leads_received, 0) < p.daily_limit
            `, [country, niche]);

            const partners = result.rows;
            const availabilityResults = [];

            for (const partner of partners) {
                const isAvailable = this.checkBusinessHoursAvailability(
                    partner.timezone,
                    partner.business_hours_start,
                    partner.business_hours_end,
                    partner.weekends_enabled || false
                );

                const nextAvailable = isAvailable ? null : this.getNextBusinessHourStart(
                    partner.timezone,
                    partner.business_hours_start,
                    partner.business_hours_end,
                    partner.weekends_enabled || false
                );

                const availabilityScore = this.calculateAvailabilityScore(
                    isAvailable,
                    nextAvailable,
                    partner.todays_leads,
                    partner.daily_limit
                );

                availabilityResults.push({
                    ...partner,
                    isAvailable,
                    nextAvailable,
                    availabilityScore,
                    queueable: includeQueueable && !isAvailable && nextAvailable
                });
            }

            // Sort by availability first, then by load balancing
            return availabilityResults.sort((a, b) => {
                // Available partners first
                if (a.isAvailable && !b.isAvailable) return -1;
                if (!a.isAvailable && b.isAvailable) return 1;
                
                // Among available/unavailable, sort by availability score then load
                if (a.availabilityScore !== b.availabilityScore) {
                    return b.availabilityScore - a.availabilityScore;
                }
                
                return a.todays_leads - b.todays_leads; // Load balancing
            });

        } catch (error) {
            console.error('Get available partners error:', error);
            return [];
        }
    }

    /**
     * Check if given time and timezone falls within business hours
     */
    checkBusinessHoursAvailability(timezone, startTime, endTime, weekendsEnabled = false) {
        try {
            // **FIXED**: Proper timezone handling using Intl.DateTimeFormat
            const now = new Date();
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone || 'UTC',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                weekday: 'short'
            });

            const parts = formatter.formatToParts(now);
            const currentTimeStr = `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
            const weekday = parts.find(p => p.type === 'weekday').value;
            
            // Convert weekday to day number (0 = Sunday, 1 = Monday, etc.)
            const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
            const dayOfWeek = dayMap[weekday] || 0;
            
            // Check if it's a business day
            if (!weekendsEnabled && !this.businessDays.includes(dayOfWeek)) {
                return false; // Weekend and weekends not enabled
            }

            // Handle business hours that cross midnight (e.g., 22:00 to 06:00)
            if (startTime > endTime) {
                return currentTimeStr >= startTime || currentTimeStr <= endTime;
            } else {
                return currentTimeStr >= startTime && currentTimeStr <= endTime;
            }

        } catch (error) {
            console.error('Business hours check error:', error);
            return false;
        }
    }

    /**
     * Get next business hour start time for a partner
     */
    getNextBusinessHourStart(timezone, startTime, endTime, weekendsEnabled = false) {
        try {
            const now = new Date();
            let nextStart = new Date(now);

            // Convert to partner's timezone for calculation
            const partnerTimeStr = now.toLocaleString('en-US', {
                timeZone: timezone || 'UTC',
                hour12: false
            });
            const partnerTime = new Date(partnerTimeStr);
            
            // If currently within business hours, next start is tomorrow
            if (this.checkBusinessHoursAvailability(timezone, startTime, endTime, weekendsEnabled)) {
                partnerTime.setDate(partnerTime.getDate() + 1);
            }
            
            // Find next business day
            let daysToAdd = 0;
            let checkDate = new Date(partnerTime);
            
            while (daysToAdd < 7) { // Max 1 week search
                const dayOfWeek = checkDate.getDay();
                
                if (weekendsEnabled || this.businessDays.includes(dayOfWeek)) {
                    // Set time to business start
                    const [hours, minutes] = startTime.split(':');
                    checkDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
                    
                    // Convert back to UTC for return
                    return new Date(checkDate.toLocaleString('en-US', {timeZone: 'UTC'}));
                }
                
                checkDate.setDate(checkDate.getDate() + 1);
                daysToAdd++;
            }
            
            return null; // Couldn't find next business hour
        } catch (error) {
            console.error('Next business hour calculation error:', error);
            return null;
        }
    }

    /**
     * Calculate availability score for partner prioritization
     */
    calculateAvailabilityScore(isAvailable, nextAvailable, currentLeads, dailyLimit) {
        let score = 0;
        
        // Base score for availability
        if (isAvailable) {
            score += 100;
        } else if (nextAvailable) {
            // Score based on how soon they'll be available
            const hoursUntilAvailable = (nextAvailable - new Date()) / (1000 * 60 * 60);
            score += Math.max(0, 50 - hoursUntilAvailable); // Up to 50 points for soon availability
        }
        
        // Capacity score (partners with more capacity get higher scores)
        const capacityRatio = currentLeads / dailyLimit;
        score += (1 - capacityRatio) * 25; // Up to 25 points for capacity
        
        return Math.round(score);
    }

    /**
     * Get partner business hours with caching
     */
    async getPartnerBusinessHours(partnerId) {
        const cacheKey = `partner_${partnerId}`;
        
        // Check cache first
        if (this.partnerHoursCache.has(cacheKey)) {
            const cached = this.partnerHoursCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheExpiry) {
                return cached.data;
            }
        }

        try {
            const result = await pool.query(`
                SELECT id, name, timezone, business_hours_start, business_hours_end,
                       country, niche, status, daily_limit
                FROM partners 
                WHERE id = $1 AND status = 'active'
            `, [partnerId]);

            const partner = result.rows[0] || null;
            
            // Cache the result
            this.partnerHoursCache.set(cacheKey, {
                data: partner,
                timestamp: Date.now()
            });

            return partner;
        } catch (error) {
            console.error('Get partner business hours error:', error);
            return null;
        }
    }

    /**
     * Queue lead for future delivery when partner comes online
     */
    async queueLeadForBusinessHours(leadId, partnerId, scheduledDeliveryTime) {
        try {
            await pool.query(`
                INSERT INTO scheduled_deliveries (lead_id, partner_id, scheduled_time, status, created_at)
                VALUES ($1, $2, $3, 'scheduled', CURRENT_TIMESTAMP)
                ON CONFLICT (lead_id, partner_id) 
                DO UPDATE SET 
                    scheduled_time = $3,
                    status = 'scheduled',
                    updated_at = CURRENT_TIMESTAMP
            `, [leadId, partnerId, scheduledDeliveryTime]);

            console.log(`Lead ${leadId} queued for partner ${partnerId} at ${scheduledDeliveryTime}`);
            return true;
        } catch (error) {
            console.error('Queue lead for business hours error:', error);
            return false;
        }
    }

    /**
     * Process scheduled lead deliveries (called by cron job)
     */
    async processScheduledDeliveries() {
        try {
            const result = await pool.query(`
                SELECT sd.id, sd.lead_id, sd.partner_id, sd.scheduled_time,
                       l.status as lead_status, p.status as partner_status
                FROM scheduled_deliveries sd
                JOIN leads l ON sd.lead_id = l.id
                JOIN partners p ON sd.partner_id = p.id
                WHERE sd.status = 'scheduled' 
                  AND sd.scheduled_time <= CURRENT_TIMESTAMP
                  AND l.status = 'pending'
                  AND p.status = 'active'
                ORDER BY sd.scheduled_time ASC
                LIMIT 50
            `);

            const deliveries = result.rows;
            let processedCount = 0;

            for (const delivery of deliveries) {
                // Check if partner is now available
                const isAvailable = await this.isPartnerAvailable(delivery.partner_id);
                
                if (isAvailable) {
                    // Trigger distribution
                    const { distributeLead } = require('./distribution');
                    await distributeLead(delivery.lead_id, delivery.partner_id);
                    
                    // Mark as processed
                    await pool.query(`
                        UPDATE scheduled_deliveries 
                        SET status = 'delivered', updated_at = CURRENT_TIMESTAMP
                        WHERE id = $1
                    `, [delivery.id]);
                    
                    processedCount++;
                } else {
                    // Reschedule for next business hour
                    const partner = await this.getPartnerBusinessHours(delivery.partner_id);
                    if (partner) {
                        const nextAvailable = this.getNextBusinessHourStart(
                            partner.timezone,
                            partner.business_hours_start,
                            partner.business_hours_end
                        );
                        
                        if (nextAvailable) {
                            await pool.query(`
                                UPDATE scheduled_deliveries 
                                SET scheduled_time = $2, updated_at = CURRENT_TIMESTAMP
                                WHERE id = $1
                            `, [delivery.id, nextAvailable]);
                        }
                    }
                }
            }

            // Always log processed count for monitoring (including zero)
            console.log(`Business Hours Cron: Processed ${processedCount} scheduled deliveries`);
            return processedCount;
            
        } catch (error) {
            console.error('Process scheduled deliveries error:', error);
            return 0;
        }
    }

    /**
     * Get business hours analytics
     */
    async getBusinessHoursAnalytics(startDate, endDate) {
        try {
            // Distribution by hour analysis
            const hourlyDistribution = await pool.query(`
                SELECT 
                    EXTRACT(HOUR FROM l.distributed_at) as hour,
                    COUNT(*) as distributed_leads,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate,
                    COUNT(DISTINCT l.assigned_partner_id) as active_partners
                FROM leads l
                WHERE l.distributed_at >= $1 AND l.distributed_at <= $2
                  AND l.distributed_at IS NOT NULL
                GROUP BY EXTRACT(HOUR FROM l.distributed_at)
                ORDER BY hour
            `, [startDate, endDate]);

            // Partner availability patterns
            const partnerPatterns = await pool.query(`
                SELECT 
                    p.id, p.name, p.timezone, p.business_hours_start, p.business_hours_end,
                    COUNT(l.id) as total_leads,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND(AVG(EXTRACT(EPOCH FROM (l.distributed_at - l.created_at))/60), 2) as avg_response_time_minutes
                FROM partners p
                LEFT JOIN leads l ON p.id = l.assigned_partner_id 
                    AND l.distributed_at >= $1 AND l.distributed_at <= $2
                WHERE p.status = 'active'
                GROUP BY p.id, p.name, p.timezone, p.business_hours_start, p.business_hours_end
                ORDER BY total_leads DESC
            `, [startDate, endDate]);

            // Business hours vs outside hours performance
            const businessHoursPerformance = await pool.query(`
                SELECT 
                    CASE 
                        WHEN EXTRACT(DOW FROM l.distributed_at) IN (1,2,3,4,5) 
                             AND EXTRACT(HOUR FROM l.distributed_at) BETWEEN 9 AND 17 
                        THEN 'business_hours'
                        ELSE 'outside_hours'
                    END as period_type,
                    COUNT(*) as leads_distributed,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate,
                    ROUND(AVG(EXTRACT(EPOCH FROM (l.converted_at - l.distributed_at))/3600), 2) as avg_conversion_time_hours
                FROM leads l
                WHERE l.distributed_at >= $1 AND l.distributed_at <= $2
                  AND l.distributed_at IS NOT NULL
                GROUP BY 
                    CASE 
                        WHEN EXTRACT(DOW FROM l.distributed_at) IN (1,2,3,4,5) 
                             AND EXTRACT(HOUR FROM l.distributed_at) BETWEEN 9 AND 17 
                        THEN 'business_hours'
                        ELSE 'outside_hours'
                    END
            `, [startDate, endDate]);

            return {
                hourlyDistribution: hourlyDistribution.rows,
                partnerPatterns: partnerPatterns.rows,
                businessHoursPerformance: businessHoursPerformance.rows
            };

        } catch (error) {
            console.error('Business hours analytics error:', error);
            return {
                hourlyDistribution: [],
                partnerPatterns: [],
                businessHoursPerformance: []
            };
        }
    }

    /**
     * Update partner business hours
     */
    async updatePartnerBusinessHours(partnerId, timezone, startTime, endTime, weekendsEnabled = false) {
        try {
            await pool.query(`
                UPDATE partners 
                SET timezone = $2, 
                    business_hours_start = $3, 
                    business_hours_end = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [partnerId, timezone, startTime, endTime]);

            // Clear cache
            this.partnerHoursCache.delete(`partner_${partnerId}`);
            
            console.log(`Updated business hours for partner ${partnerId}: ${startTime}-${endTime} ${timezone}`);
            return true;
        } catch (error) {
            console.error('Update partner business hours error:', error);
            return false;
        }
    }

    /**
     * Get timezone suggestions based on country
     */
    getTimezoneByCountry(country) {
        const countryLower = country.toLowerCase();
        return this.countryTimezones[countryLower] || 'UTC';
    }

    /**
     * Get all supported timezones
     */
    getSupportedTimezones() {
        return [
            { value: 'UTC', label: 'UTC - Coordinated Universal Time' },
            { value: 'Europe/Berlin', label: 'Europe/Berlin - Germany' },
            { value: 'Europe/Vienna', label: 'Europe/Vienna - Austria' },
            { value: 'Europe/Madrid', label: 'Europe/Madrid - Spain' },
            { value: 'Europe/Rome', label: 'Europe/Rome - Italy' },
            { value: 'Europe/London', label: 'Europe/London - United Kingdom' },
            { value: 'Europe/Oslo', label: 'Europe/Oslo - Norway' },
            { value: 'Europe/Paris', label: 'Europe/Paris - France' },
            { value: 'Europe/Zurich', label: 'Europe/Zurich - Switzerland' },
            { value: 'America/Toronto', label: 'America/Toronto - Canada (Eastern)' },
            { value: 'America/Vancouver', label: 'America/Vancouver - Canada (Pacific)' },
            { value: 'America/New_York', label: 'America/New_York - US Eastern' },
            { value: 'America/Chicago', label: 'America/Chicago - US Central' },
            { value: 'America/Denver', label: 'America/Denver - US Mountain' },
            { value: 'America/Los_Angeles', label: 'America/Los_Angeles - US Pacific' },
            { value: 'Asia/Tokyo', label: 'Asia/Tokyo - Japan' },
            { value: 'Asia/Shanghai', label: 'Asia/Shanghai - China' },
            { value: 'Asia/Singapore', label: 'Asia/Singapore - Singapore' },
            { value: 'Australia/Sydney', label: 'Australia/Sydney - Australia (Eastern)' }
        ];
    }
}

module.exports = new BusinessHoursIntelligence();