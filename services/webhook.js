const axios = require('axios');
const { pool } = require('../config/db');

/**
 * SECURITY: Validates webhook URLs to prevent SSRF attacks
 */
function validateWebhookUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;
        
        // Only allow HTTPS
        if (parsedUrl.protocol !== 'https:') {
            return { valid: false, error: 'Only HTTPS URLs are allowed' };
        }
        
        // Block private/reserved IP ranges
        const privatePatterns = [
            /^127\./, // 127.0.0.0/8 - Loopback
            /^192\.168\./, // 192.168.0.0/16 - Private
            /^10\./, // 10.0.0.0/8 - Private  
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12 - Private
            /^169\.254\./, // 169.254.0.0/16 - Link-local
            /^0\./, // 0.0.0.0/8 - Current network
            /^224\./, // 224.0.0.0/4 - Multicast
            /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./ // 100.64.0.0/10 - Shared address space
        ];
        
        // Block localhost and private hostnames
        if (hostname === 'localhost' || hostname === '::1' || 
            privatePatterns.some(pattern => pattern.test(hostname))) {
            return { valid: false, error: 'Private/reserved IP addresses are not allowed' };
        }
        
        return { valid: true };
    } catch (error) {
        return { valid: false, error: 'Invalid URL format' };
    }
}

// Send webhook to partner with improved retry logic
async function sendWebhook(lead, partner) {
    try {
        // Check if successful delivery already exists (idempotency)
        const existingSuccess = await pool.query(`
            SELECT id FROM webhook_deliveries 
            WHERE lead_id = $1 AND partner_id = $2 AND status = 'success'
        `, [lead.id, partner.id]);
        
        if (existingSuccess.rows.length > 0) {
            console.log(`Webhook already delivered successfully for lead ${lead.id} to partner ${partner.name}`);
            return true;
        }
        
        // Get or create webhook delivery record
        let deliveryId;
        const existingRecord = await pool.query(`
            SELECT id, attempts FROM webhook_deliveries 
            WHERE lead_id = $1 AND partner_id = $2 AND status IN ('pending', 'failed')
            ORDER BY created_at DESC
            LIMIT 1
        `, [lead.id, partner.id]);
        
        // **CRITICAL FIX: Always regenerate payload to honor partner preference changes**
        const payload = await createPayloadForPartner(lead, partner);
        
        if (existingRecord.rows.length > 0) {
            // Update existing record for retry with fresh payload
            deliveryId = existingRecord.rows[0].id;
            const currentAttempts = existingRecord.rows[0].attempts;
            
            await pool.query(`
                UPDATE webhook_deliveries 
                SET attempts = $1, status = 'pending', payload = $2, created_at = CURRENT_TIMESTAMP
                WHERE id = $3
            `, [currentAttempts + 1, JSON.stringify(payload), deliveryId]);
        } else {
            // Create new delivery record with recovery field formatting
            const result = await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, attempts, status)
                VALUES ($1, $2, $3, $4, 1, 'pending')
                RETURNING id
            `, [lead.id, partner.id, partner.webhook_url, JSON.stringify(payload)]);
            
            deliveryId = result.rows[0].id;
        }
        
        // Get current attempt count
        const delivery = await pool.query(`
            SELECT attempts FROM webhook_deliveries WHERE id = $1
        `, [deliveryId]);
        const currentAttempt = delivery.rows[0].attempts;
        
        // Handle internal endpoints - route to CRM delivery system instead
        if (partner.webhook_url.startsWith('internal://')) {
            console.log(`🔄 Internal endpoint detected: Routing lead ${lead.id} to CRM delivery system for ${partner.name}`);
            
            // Mark webhook as skipped and let CRM delivery handle it
            await pool.query(`
                UPDATE webhook_deliveries 
                SET status = 'failed', response_code = 0, response_body = 'Routed to CRM delivery (internal endpoint)'
                WHERE id = $1
            `, [deliveryId]);
            
            // Return false to trigger CRM fallback in distribution logic
            return false;
        }
        
        // SECURITY: Validate external webhook URL before sending (SSRF protection)
        const urlValidation = validateWebhookUrl(partner.webhook_url);
        if (!urlValidation.valid) {
            throw new Error(`Invalid webhook URL: ${urlValidation.error}`);
        }
        
        // Send webhook with timeout and strict redirect policy
        const response = await axios.post(partner.webhook_url, payload, {
            timeout: 15000,
            maxRedirects: 0, // Prevent redirect-based SSRF
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'LeadDistribution/1.0'
            }
        });
        
        // Update delivery status on success
        await pool.query(`
            UPDATE webhook_deliveries 
            SET status = 'success', response_code = $1, response_body = $2, delivered_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [response.status, response.data ? JSON.stringify(response.data) : '', deliveryId]);
        
        console.log(`Webhook delivered to ${partner.name} for lead ${lead.id} (attempt ${currentAttempt})`);
        return true;
        
    } catch (error) {
        console.error(`Webhook delivery error to ${partner.name}:`, error.message);
        
        // Extract detailed partner response information
        const responseCode = error.response?.status || 0;
        const partnerResponseBody = error.response?.data || error.message;
        
        // Create comprehensive error message with partner details
        let errorDetails = '';
        if (error.response?.data) {
            // Partner returned structured error response
            errorDetails = typeof error.response.data === 'object' 
                ? JSON.stringify(error.response.data) 
                : String(error.response.data);
            console.error(`Partner ${partner.name} rejected lead ${lead.id}: ${errorDetails}`);
        } else {
            // Network/connection error
            errorDetails = `Network error: ${error.message}`;
            console.error(`Network error sending to ${partner.name}: ${error.message}`);
        }
        
        // CRITICAL FIX: Always update delivery status, even if deliveryId is undefined
        if (typeof deliveryId !== 'undefined') {
            await pool.query(`
                UPDATE webhook_deliveries 
                SET status = 'failed', response_code = $1, response_body = $2
                WHERE id = $3
            `, [responseCode, errorDetails.substring(0, 1000), deliveryId]);
        } else {
            // Fallback: Find and update any pending delivery for this lead/partner
            console.error(`DeliveryId undefined for lead ${lead.id}, partner ${partner.id} - updating pending deliveries`);
            await pool.query(`
                UPDATE webhook_deliveries 
                SET status = 'failed', response_code = $1, response_body = $2
                WHERE lead_id = $3 AND partner_id = $4 AND status = 'pending'
            `, [responseCode, errorDetails.substring(0, 1000), lead.id, partner.id]);
        }
        
        // Get attempt count for alerting
        try {
            const delivery = await pool.query(`
                SELECT attempts FROM webhook_deliveries WHERE id = $1
            `, [deliveryId]);
            
            const attempts = delivery.rows[0]?.attempts || 0;
            
            // Alert on multiple failures (final attempt)
            if (attempts >= 3) {
                const alertSystem = require('./alertSystem');
                await alertSystem.alertPartnerOffline({
                    id: partner.id,
                    name: partner.name,
                    country: partner.country || 'unknown',
                    niche: partner.niche || 'unknown'
                });
            }
        } catch (alertError) {
            console.error('Failed to send partner offline alert:', alertError);
        }
        
        throw error;
    }
}

// Webhook retry worker (called by cron)
async function retryFailedWebhooks() {
    try {
        const failedWebhooks = await pool.query(`
            SELECT wd.id as delivery_id, wd.lead_id, wd.partner_id, wd.attempts, wd.created_at,
                   l.first_name, l.last_name, l.email, l.phone, l.country, l.niche, l.type, l.source,
                   p.name as partner_name, p.webhook_url
            FROM webhook_deliveries wd
            JOIN leads l ON wd.lead_id = l.id
            JOIN partners p ON wd.partner_id = p.id
            WHERE wd.status = 'failed' 
                AND wd.attempts < 3
                AND wd.created_at > NOW() - INTERVAL '24 hours'
                AND NOT EXISTS (
                    SELECT 1 FROM webhook_deliveries wd2 
                    WHERE wd2.lead_id = wd.lead_id 
                        AND wd2.partner_id = wd.partner_id 
                        AND wd2.status = 'success'
                )
            ORDER BY wd.created_at ASC
            LIMIT 10
        `);
        
        for (const webhook of failedWebhooks.rows) {
            try {
                // Add exponential backoff delay based on attempt number
                const backoffDelay = Math.pow(2, webhook.attempts - 1) * 1000;
                const timeSinceLastAttempt = Date.now() - new Date(webhook.created_at).getTime();
                
                if (timeSinceLastAttempt < backoffDelay) {
                    continue; // Skip if not enough time has passed
                }
                
                // **ENHANCED: Get complete partner data for recovery field formatting**
                const partnerResult = await pool.query(`
                    SELECT * FROM partners WHERE id = $1
                `, [webhook.partner_id]);
                
                const partner = partnerResult.rows[0];
                
                // **ENHANCED: Get complete lead data including JSONB data for recovery fields**
                const leadResult = await pool.query(`
                    SELECT * FROM leads WHERE id = $1
                `, [webhook.lead_id]);
                
                const lead = leadResult.rows[0];
                
                await sendWebhook(lead, partner);
            } catch (error) {
                console.error(`Retry failed for webhook ${webhook.delivery_id}:`, error.message);
            }
        }
        
        console.log(`Processed ${failedWebhooks.rows.length} failed webhooks for retry`);
        
        // Alert if we have many webhook failures
        if (failedWebhooks.rows.length >= 5) {
            const alertSystem = require('./alertSystem');
            await alertSystem.alertWebhookFailures(failedWebhooks.rows.length);
        }
        
    } catch (error) {
        console.error('Webhook retry worker error:', error);
        
        // Alert on system errors
        const alertSystem = require('./alertSystem');
        await alertSystem.alertSystemError(error, { context: 'webhook_retry_worker' });
    }
}

/**
 * Universal Smart Transformation Service - Creates partner-specific payloads
 * Supports field mapping, phone formatting, auto-enrichment, and niche-specific fields
 */
async function createPayloadForPartner(lead, partner) {
    // Step 1: Create base lead data with all available fields
    const baseData = {
        lead_id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        country: lead.country,
        niche: lead.niche,
        type: lead.type,
        source: lead.source,
        timestamp: lead.created_at,
        postback_url: `${process.env.APP_URL || 'http://localhost:5000'}/api/postback/${partner.id}`
    };

    // Step 2: Add niche-specific fields
    if (lead.niche === 'recovery' && lead.data) {
        const leadData = typeof lead.data === 'string' ? JSON.parse(lead.data) : lead.data;
        const recoveryData = leadData.enriched || leadData.original || leadData;
        
        // Add recovery-specific fields to base data
        baseData.amount_lost = recoveryData.amount_lost || recoveryData.amountLost;
        baseData.fraud_type = recoveryData.fraud_type || recoveryData.fraudType || recoveryData.type_of_fraud;
    }

    // Step 3: Auto-enrich missing required fields
    const enrichedData = await autoEnrichMissingFields(baseData, partner);
    
    // Step 4: Format phone number according to partner preference
    const phoneFormattedData = formatPhoneForPartner(enrichedData, partner);
    
    // Step 5: Apply partner-specific field mapping
    const finalPayload = applyFieldMapping(phoneFormattedData, partner);
    
    return finalPayload;
}

/**
 * Auto-enrichment: Fill missing required fields with smart defaults
 */
async function autoEnrichMissingFields(data, partner) {
    const enrichedData = { ...data };
    
    // Get partner's required fields and default values
    const requiredFields = partner.required_fields || [];
    const defaultValues = partner.default_values || {};
    
    // Auto-fill missing required fields
    for (const field of requiredFields) {
        if (!enrichedData[field] || enrichedData[field] === '') {
            // Try to auto-fill from various sources
            switch (field) {
                case 'country':
                    enrichedData[field] = defaultValues.country || partner.country || data.country;
                    break;
                case 'source':
                    enrichedData[field] = defaultValues.source || data.source || 'Lead Distribution Platform';
                    break;
                case 'niche':
                    enrichedData[field] = defaultValues.niche || partner.niche || data.niche;
                    break;
                case 'type':
                    enrichedData[field] = defaultValues.type || data.type || 'raw';
                    break;
                default:
                    // Use default value if specified
                    if (defaultValues[field]) {
                        enrichedData[field] = defaultValues[field];
                    }
                    break;
            }
        }
    }
    
    return enrichedData;
}

/**
 * Phone formatting based on partner preferences
 */
function formatPhoneForPartner(data, partner) {
    const formattedData = { ...data };
    
    if (!data.phone) return formattedData;
    
    const phoneFormat = partner.phone_format || 'with_plus';
    let phone = data.phone.toString().replace(/\s+/g, ''); // Remove spaces
    
    // Extract country code mapping for phone formatting
    const countryCodeMap = {
        'IT': '+39',
        'DE': '+49', 
        'ES': '+34',
        'CA': '+1',
        'UK': '+44',
        'NO': '+47',
        'AT': '+43'
    };
    
    const countryCode = countryCodeMap[partner.country] || countryCodeMap[data.country] || '+1';
    
    switch (phoneFormat) {
        case 'with_plus':
            // Format: +39123456789
            if (!phone.startsWith('+')) {
                // Remove leading zeros and add country code
                phone = phone.replace(/^0+/, '');
                formattedData.phone = countryCode + phone;
            } else {
                formattedData.phone = phone;
            }
            break;
            
        case 'no_plus':
            // Format: 123456789 (remove all prefixes)
            formattedData.phone = phone.replace(/^\+?[0-9]{1,4}/, '').replace(/^0+/, '');
            break;
            
        case 'country_code':
            // Format: 0039123456789
            if (!phone.startsWith('00')) {
                phone = phone.replace(/^\+/, '00').replace(/^0+/, '');
                formattedData.phone = '00' + countryCode.substring(1) + phone;
            } else {
                formattedData.phone = phone;
            }
            break;
            
        case 'local_format':
            // Format: 0123456789 (local format with leading 0)
            phone = phone.replace(/^\+?[0-9]{1,4}/, '').replace(/^0+/, '');
            formattedData.phone = '0' + phone;
            break;
            
        default:
            // Keep original format
            formattedData.phone = phone;
    }
    
    return formattedData;
}

/**
 * Apply partner-specific field mapping to transform field names and structure
 */
function applyFieldMapping(data, partner) {
    const fieldMapping = partner.field_mapping || {};
    
    // If no custom mapping, return data as-is with standard field names
    if (Object.keys(fieldMapping).length === 0) {
        return data;
    }
    
    const mappedPayload = {};
    
    // Apply field mappings
    for (const [originalField, mappedField] of Object.entries(fieldMapping)) {
        if (data[originalField] !== undefined && data[originalField] !== null) {
            mappedPayload[mappedField] = data[originalField];
        }
    }
    
    // Add any unmapped fields that weren't specified in mapping
    for (const [field, value] of Object.entries(data)) {
        if (!fieldMapping[field] && value !== undefined && value !== null) {
            mappedPayload[field] = value;
        }
    }
    
    return mappedPayload;
}

module.exports = { sendWebhook, retryFailedWebhooks, createPayloadForPartner, validateWebhookUrl };