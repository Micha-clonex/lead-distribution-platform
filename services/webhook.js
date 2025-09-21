const axios = require('axios');
const { pool } = require('../config/db');

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
        
        // Send webhook with timeout
        const response = await axios.post(partner.webhook_url, payload, {
            timeout: 15000,
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
        console.error(`Webhook delivery error:`, error.message);
        
        // Update delivery status as failed (only if deliveryId exists)
        if (typeof deliveryId !== 'undefined') {
            await pool.query(`
                UPDATE webhook_deliveries 
                SET status = 'failed', response_code = $1, response_body = $2
                WHERE id = $3
            `, [error.response?.status || 0, error.message.substring(0, 500), deliveryId]);
            
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
 * Create webhook payload with recovery field formatting based on partner preferences
 */
async function createPayloadForPartner(lead, partner) {
    // Base payload with standard fields
    const basePayload = {
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
    
    // **NEW: Recovery-specific field handling**
    if (lead.niche === 'recovery' && lead.data) {
        const leadData = typeof lead.data === 'string' ? JSON.parse(lead.data) : lead.data;
        const recoveryData = leadData.enriched || leadData.original || leadData;
        
        // Extract recovery-specific fields
        const amountLost = recoveryData.amount_lost || recoveryData.amountLost;
        const fraudType = recoveryData.fraud_type || recoveryData.fraudType || recoveryData.type_of_fraud;
        
        // Format according to partner preference
        if (partner.recovery_fields_format === 'notes' && (amountLost || fraudType)) {
            // **OPTION 1: Combined into notes field**
            let notes = '';
            if (amountLost) {
                notes += `Amount Lost: ${amountLost}`;
            }
            if (fraudType) {
                if (notes) notes += ' | ';
                notes += `Fraud Type: ${fraudType}`;
            }
            basePayload.notes = notes;
        } else {
            // **OPTION 2: Separate fields (default)**
            if (amountLost) {
                basePayload.amount_lost = amountLost;
            }
            if (fraudType) {
                basePayload.fraud_type = fraudType;
            }
        }
    }
    
    return basePayload;
}

module.exports = { sendWebhook, retryFailedWebhooks, createPayloadForPartner };