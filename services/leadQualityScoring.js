const { pool } = require('../config/db');

/**
 * Lead Quality Scoring System
 * Multi-factor assessment for intelligent lead distribution
 * 
 * Quality Factors:
 * - Data Completeness (30%): Essential field presence and richness
 * - Data Quality (25%): Email/phone validation, format correctness
 * - Source Reliability (20%): Historical source conversion rates
 * - Freshness Factor (15%): Time-sensitive quality degradation
 * - Conversion Prediction (10%): ML-based likelihood scoring
 */

class LeadQualityScoring {
    constructor() {
        this.scoringWeights = {
            dataCompleteness: 0.30,
            dataQuality: 0.25,
            sourceReliability: 0.20,
            freshnessFactor: 0.15,
            conversionPrediction: 0.10
        };
        
        // Cache for source reliability scores
        this.sourceCache = new Map();
        this.cacheExpiry = 10 * 60 * 1000; // 10 minutes
    }

    /**
     * Calculate comprehensive quality score for a lead
     */
    async calculateQualityScore(leadData) {
        try {
            const scores = {
                dataCompleteness: this.calculateDataCompleteness(leadData),
                dataQuality: this.calculateDataQuality(leadData),
                sourceReliability: await this.calculateSourceReliability(leadData.source, leadData.niche, leadData.country),
                freshnessFactor: this.calculateFreshnessFactor(leadData.created_at || new Date()),
                conversionPrediction: await this.calculateConversionPrediction(leadData)
            };

            // Calculate weighted total score
            const totalScore = Object.keys(scores).reduce((total, factor) => {
                return total + (scores[factor] * this.scoringWeights[factor]);
            }, 0);

            // Determine quality tier
            const qualityTier = this.determineQualityTier(totalScore);

            return {
                totalScore: Math.round(totalScore),
                qualityTier,
                breakdown: scores,
                recommendation: this.getDistributionRecommendation(totalScore, scores)
            };
            
        } catch (error) {
            console.error('Quality scoring error:', error);
            return this.getDefaultScore();
        }
    }

    /**
     * Data Completeness Scoring (30% weight)
     * Enhanced from existing dataEnrichment.js with more factors
     */
    calculateDataCompleteness(data) {
        let score = 0;
        
        // Essential contact fields (60 points)
        const essentialFields = {
            first_name: { points: 15, validator: val => val && val.length >= 2 },
            last_name: { points: 15, validator: val => val && val.length >= 2 },
            email: { points: 15, validator: val => val && this.isValidEmail(val) },
            phone: { points: 15, validator: val => val && this.isValidPhone(val) }
        };

        Object.entries(essentialFields).forEach(([field, config]) => {
            if (config.validator(data[field])) {
                score += config.points;
            }
        });

        // Additional demographic fields (25 points)
        const demographicFields = ['country', 'age', 'occupation', 'income_range'];
        demographicFields.forEach(field => {
            if (data[field] || (data.data && data.data[field])) {
                score += 6.25;
            }
        });

        // Enrichment data (15 points)
        if (data.data) {
            const enrichmentFields = ['ip_address', 'user_agent', 'referrer', 'utm_source'];
            enrichmentFields.forEach(field => {
                if (data.data[field]) {
                    score += 3.75;
                }
            });
        }

        return Math.min(Math.round(score), 100);
    }

    /**
     * Data Quality Validation (25% weight)
     * Validates format correctness and data integrity
     */
    calculateDataQuality(data) {
        let score = 100;
        let penalties = 0;

        // Email validation (25 points)
        if (data.email) {
            if (!this.isValidEmail(data.email)) {
                penalties += 25;
            } else if (this.isDisposableEmail(data.email)) {
                penalties += 15; // Disposable emails reduce quality
            }
        }

        // Phone validation (25 points) 
        if (data.phone) {
            if (!this.isValidPhone(data.phone)) {
                penalties += 25;
            } else if (!this.isInternationalPhone(data.phone)) {
                penalties += 5; // Local format slight penalty
            }
        }

        // Name validation (20 points)
        if (data.first_name && (data.first_name.length < 2 || this.containsNumbers(data.first_name))) {
            penalties += 10;
        }
        if (data.last_name && (data.last_name.length < 2 || this.containsNumbers(data.last_name))) {
            penalties += 10;
        }

        // Country/niche consistency (15 points)
        if (data.country && data.niche) {
            if (!this.isCountryNicheCompatible(data.country, data.niche)) {
                penalties += 15;
            }
        }

        // Data freshness format (15 points)
        if (data.data && data.data.timestamp) {
            const dataAge = Date.now() - new Date(data.data.timestamp).getTime();
            if (dataAge > 24 * 60 * 60 * 1000) { // Older than 24h
                penalties += Math.min(15, Math.floor(dataAge / (24 * 60 * 60 * 1000)) * 2);
            }
        }

        return Math.max(0, score - penalties);
    }

    /**
     * Source Reliability Scoring (20% weight)
     * Based on historical conversion rates and lead quality
     */
    async calculateSourceReliability(source, niche, country) {
        const cacheKey = `${source}_${niche}_${country}`;
        
        // Check cache first
        if (this.sourceCache.has(cacheKey)) {
            const cached = this.sourceCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheExpiry) {
                return cached.score;
            }
        }

        try {
            // Get 30-day source performance
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_leads,
                    COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                    COUNT(*) FILTER (WHERE status = 'distributed') as distributions,
                    AVG(CASE 
                        WHEN email IS NOT NULL AND phone IS NOT NULL AND first_name IS NOT NULL AND last_name IS NOT NULL THEN 100
                        WHEN (email IS NOT NULL AND phone IS NOT NULL) OR (email IS NOT NULL AND first_name IS NOT NULL) THEN 75
                        WHEN email IS NOT NULL OR phone IS NOT NULL THEN 50
                        ELSE 25
                    END) as avg_completeness,
                    AVG(EXTRACT(EPOCH FROM (distributed_at - created_at))/60) FILTER (WHERE distributed_at IS NOT NULL) as avg_distribution_time
                FROM leads 
                WHERE source = $1 
                  AND niche = $2 
                  AND country = $3
                  AND created_at >= NOW() - INTERVAL '30 days'
            `, [source, niche, country]);

            const stats = result.rows[0];
            let score = 50; // Base score

            if (stats.total_leads > 0) {
                // Conversion rate factor (40% of score)
                const conversionRate = (stats.conversions / stats.total_leads) * 100;
                score += Math.min(30, conversionRate * 3); // Up to 30 points

                // Distribution success rate (30% of score)  
                const distributionRate = (stats.distributions / stats.total_leads) * 100;
                score += Math.min(25, distributionRate * 0.25); // Up to 25 points

                // Data completeness factor (20% of score)
                score += Math.min(15, (stats.avg_completeness / 100) * 15);

                // Speed factor (10% of score) - faster distribution = higher quality source
                if (stats.avg_distribution_time) {
                    const speedBonus = Math.max(0, 10 - (stats.avg_distribution_time / 30)); // Bonus for sub-5min
                    score += Math.min(10, speedBonus);
                }
            } else {
                // New source - moderate score with slight bonus for new leads
                score = 65; 
            }

            const finalScore = Math.min(100, Math.max(0, Math.round(score)));
            
            // Cache the result
            this.sourceCache.set(cacheKey, {
                score: finalScore,
                timestamp: Date.now()
            });

            return finalScore;

        } catch (error) {
            console.error('Source reliability calculation error:', error);
            return 50; // Default moderate score on error
        }
    }

    /**
     * Freshness Factor (15% weight) 
     * Leads lose quality over time in competitive markets
     */
    calculateFreshnessFactor(createdAt) {
        const now = new Date();
        const leadAge = (now - new Date(createdAt)) / 1000; // seconds
        
        // Premium freshness decay curve
        if (leadAge <= 300) return 100;          // 5 minutes: Perfect
        if (leadAge <= 900) return 95;           // 15 minutes: Excellent  
        if (leadAge <= 1800) return 85;          // 30 minutes: Very good
        if (leadAge <= 3600) return 70;          // 1 hour: Good
        if (leadAge <= 7200) return 55;          // 2 hours: Fair
        if (leadAge <= 14400) return 40;         // 4 hours: Poor
        if (leadAge <= 86400) return 25;         // 24 hours: Very poor
        return 10;                               // >24 hours: Critical
    }

    /**
     * Conversion Prediction (10% weight)
     * ML-based likelihood scoring using historical patterns
     */
    async calculateConversionPrediction(data) {
        try {
            // Simplified ML model based on historical patterns
            const features = {
                niche: data.niche === 'forex' ? 1 : 0,
                type: data.type === 'premium' ? 1 : 0,
                hasEmail: data.email ? 1 : 0,
                hasPhone: data.phone ? 1 : 0,
                countryTier: this.getCountryTier(data.country)
            };

            // Get historical patterns for similar leads
            const result = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'converted') as conversions,
                    COUNT(*) as total,
                    AVG(EXTRACT(EPOCH FROM (converted_at - created_at))/3600) FILTER (WHERE converted_at IS NOT NULL) as avg_conversion_time
                FROM leads 
                WHERE niche = $1 
                  AND type = $2 
                  AND country = $3
                  AND created_at >= NOW() - INTERVAL '90 days'
            `, [data.niche, data.type, data.country]);

            const stats = result.rows[0];
            if (stats.total > 5) {
                const baseRate = (stats.conversions / stats.total) * 100;
                
                // Apply feature adjustments
                let adjustedRate = baseRate;
                if (features.hasEmail && features.hasPhone) adjustedRate *= 1.3;
                if (features.countryTier === 1) adjustedRate *= 1.2;
                if (features.countryTier === 3) adjustedRate *= 0.8;
                
                return Math.min(100, Math.round(adjustedRate * 2)); // Scale to 0-100
            }

            // Fallback prediction for new patterns
            return features.type * 30 + features.hasEmail * 20 + features.hasPhone * 20 + features.countryTier * 10;

        } catch (error) {
            console.error('Conversion prediction error:', error);
            return 50;
        }
    }

    /**
     * Determine quality tier based on total score
     */
    determineQualityTier(score) {
        if (score >= 85) return 'premium';
        if (score >= 70) return 'high';
        if (score >= 55) return 'standard';
        if (score >= 40) return 'low';
        return 'reject';
    }

    /**
     * Distribution recommendation based on score and breakdown
     */
    getDistributionRecommendation(totalScore, breakdown) {
        if (totalScore >= 85) {
            return {
                action: 'route_premium',
                reason: 'Exceptional lead quality - route to premium partners',
                priority: 'urgent'
            };
        }
        
        if (totalScore >= 70) {
            return {
                action: 'route_standard',
                reason: 'Good quality lead - standard distribution',
                priority: 'high'
            };
        }
        
        if (totalScore >= 55) {
            return {
                action: 'route_bulk',
                reason: 'Acceptable quality - bulk distribution partners',
                priority: 'normal'
            };
        }

        if (totalScore >= 40) {
            return {
                action: 'route_secondary',
                reason: 'Low quality - secondary/backup partners only',
                priority: 'low'
            };
        }

        return {
            action: 'reject',
            reason: 'Quality too low for distribution - requires manual review',
            priority: 'none'
        };
    }

    /**
     * Validation helper methods
     */
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email) && !email.includes('..') && email.length <= 254;
    }

    isValidPhone(phone) {
        // Remove all non-digits and check length
        const cleaned = phone.replace(/\D/g, '');
        return cleaned.length >= 7 && cleaned.length <= 15;
    }

    isInternationalPhone(phone) {
        return phone.startsWith('+') || phone.startsWith('00');
    }

    isDisposableEmail(email) {
        const disposableDomains = [
            '10minutemail.com', 'guerrillamail.com', 'mailinator.com',
            'tempmail.org', 'yopmail.com', 'throwaway.email'
        ];
        const domain = email.split('@')[1]?.toLowerCase();
        return disposableDomains.includes(domain);
    }

    containsNumbers(str) {
        return /\d/.test(str);
    }

    isCountryNicheCompatible(country, niche) {
        // Forex regulations vary by country
        const forexRestricted = ['usa']; // Simplified
        if (niche === 'forex' && forexRestricted.includes(country.toLowerCase())) {
            return false;
        }
        return true;
    }

    getCountryTier(country) {
        const tier1 = ['germany', 'uk', 'norway', 'switzerland', 'canada'];
        const tier2 = ['austria', 'spain', 'italy', 'france'];
        const tier3 = ['others'];
        
        const countryLower = country.toLowerCase();
        if (tier1.includes(countryLower)) return 1;
        if (tier2.includes(countryLower)) return 2;
        return 3;
    }

    getDefaultScore() {
        return {
            totalScore: 50,
            qualityTier: 'standard',
            breakdown: {
                dataCompleteness: 50,
                dataQuality: 50,
                sourceReliability: 50,
                freshnessFactor: 50,
                conversionPrediction: 50
            },
            recommendation: {
                action: 'route_standard',
                reason: 'Default scoring due to calculation error',
                priority: 'normal'
            }
        };
    }

    /**
     * Batch quality scoring for analytics
     */
    async batchCalculateQualityScores(leads) {
        const results = [];
        
        for (const lead of leads) {
            const score = await this.calculateQualityScore(lead);
            results.push({
                leadId: lead.id,
                ...score
            });
        }
        
        return results;
    }

    /**
     * Get quality distribution statistics
     */
    async getQualityDistributionStats(startDate, endDate) {
        try {
            // This would be enhanced with actual quality scores stored in DB
            const result = await pool.query(`
                SELECT 
                    l.source,
                    l.niche,
                    l.country,
                    l.type,
                    COUNT(*) as total_leads,
                    AVG(CASE 
                        WHEN l.email IS NOT NULL AND l.phone IS NOT NULL AND l.first_name IS NOT NULL AND l.last_name IS NOT NULL THEN 100
                        WHEN (l.email IS NOT NULL AND l.phone IS NOT NULL) OR (l.email IS NOT NULL AND l.first_name IS NOT NULL) THEN 75
                        WHEN l.email IS NOT NULL OR l.phone IS NOT NULL THEN 50
                        ELSE 25
                    END) as avg_completeness_score,
                    COUNT(*) FILTER (WHERE l.status = 'converted') as conversions,
                    ROUND((COUNT(*) FILTER (WHERE l.status = 'converted')::decimal / COUNT(*)) * 100, 2) as conversion_rate,
                    AVG(EXTRACT(EPOCH FROM (l.distributed_at - l.created_at))/60) FILTER (WHERE l.distributed_at IS NOT NULL) as avg_distribution_time
                FROM leads l
                WHERE l.created_at >= $1 AND l.created_at <= $2
                GROUP BY l.source, l.niche, l.country, l.type
                HAVING COUNT(*) >= 5
                ORDER BY conversion_rate DESC, total_leads DESC
            `, [startDate, endDate]);

            return result.rows;
        } catch (error) {
            console.error('Quality distribution stats error:', error);
            return [];
        }
    }
}

module.exports = new LeadQualityScoring();