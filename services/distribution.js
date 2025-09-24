const { pool, safeQuery } = require('../config/db');
const queuedWebhook = require('./queuedWebhook');

// Simple, working lead distribution without business hours complexity
async function distributeLead(leadId) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Get lead details with lock
        const leadResult = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [leadId]);
        const lead = leadResult.rows[0];
        
        if (!lead) {
            await client.query('ROLLBACK');
            return;
        }
        
        // Skip if already distributed
        if (lead.status !== 'pending') {
            await client.query('ROLLBACK');
            return;
        }
        
        console.log(`Distributing lead ${leadId} - Country: ${lead.country}, Niche: ${lead.niche || 'all'}`);
        
        // Find available partners
        const partnersQuery = `
            SELECT p.*, COALESCE(ds.leads_received, 0) as todays_leads,
                   COALESCE(ds.premium_leads, 0) as todays_premium
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            WHERE p.status = 'active' 
                AND p.country = $1 
                AND p.niche = $2
                AND COALESCE(ds.leads_received, 0) < p.daily_limit
            ORDER BY COALESCE(ds.leads_received, 0) ASC, RANDOM()
            FOR UPDATE OF p
        `;
        
        const partnersResult = await client.query(partnersQuery, [lead.country, lead.niche]);
        
        if (partnersResult.rows.length === 0) {
            console.log(`No available partners for ${lead.country}/${lead.niche} - marking as failed`);
            await client.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
            await client.query('COMMIT');
            return;
        }
        
        // Select first available partner (round-robin by load)
        const selectedPartner = partnersResult.rows[0];
        console.log(`Distributing lead ${leadId} to partner ${selectedPartner.name} (${selectedPartner.id})`);
        
        // Update lead with assigned partner
        await client.query(`
            UPDATE leads 
            SET assigned_partner_id = $1, status = 'distributed', distributed_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [selectedPartner.id, leadId]);
        
        // Update distribution stats
        await client.query(`
            INSERT INTO distribution_stats (partner_id, date, leads_received, premium_leads, raw_leads)
            VALUES ($1, CURRENT_DATE, 1, $2, $3)
            ON CONFLICT (partner_id, date) 
            DO UPDATE SET 
                leads_received = distribution_stats.leads_received + 1,
                premium_leads = distribution_stats.premium_leads + $2,
                raw_leads = distribution_stats.raw_leads + $3
        `, [selectedPartner.id, lead.type === 'premium' ? 1 : 0, lead.type === 'raw' ? 1 : 0]);
        
        await client.query('COMMIT');
        
        console.log(`✅ Lead ${leadId} successfully distributed to ${selectedPartner.name}`);
        
        // Queue webhook delivery for reliable processing with retries
        try {
            const { transformLeadData } = require('./webhook');
            const transformedPayload = transformLeadData(lead, selectedPartner);
            
            // Prepare webhook job data
            const webhookData = {
                leadId: leadId,
                partnerId: selectedPartner.id,
                webhookUrl: selectedPartner.webhook_url,
                payload: transformedPayload,
                authConfig: selectedPartner.auth_config ? {
                    type: selectedPartner.auth_type,
                    config: selectedPartner.auth_config
                } : { type: 'none' },
                contentType: selectedPartner.content_type || 'application/json'
            };
            
            // Enqueue webhook for reliable delivery
            const jobId = await queuedWebhook.enqueueWebhook(webhookData);
            console.log(`📤 Webhook delivery queued: Job ${jobId} for lead ${leadId} → ${selectedPartner.name}`);
            
        } catch (queueError) {
            console.error(`Failed to queue webhook for lead ${leadId}:`, queueError.message);
            
            // Emergency fallback to immediate delivery if queue fails
            setImmediate(async () => {
                try {
                    const { sendWebhook } = require('./webhook');
                    const webhookResult = await sendWebhook(lead, selectedPartner);
                    if (webhookResult) {
                        console.log(`✅ Emergency webhook delivery succeeded for lead ${leadId}`);
                    } else {
                        console.log(`⚠️ Emergency webhook delivery failed for lead ${leadId}`);
                    }
                } catch (emergencyError) {
                    console.error(`Emergency webhook delivery failed for lead ${leadId}:`, emergencyError.message);
                }
            });
        }
        
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError);
        }
        console.error('Lead distribution error:', error);
        
        // Mark lead as failed using separate connection
        try {
            await pool.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
        } catch (updateError) {
            console.error('Failed to mark lead as failed:', updateError);
        }
        
        throw error;
    } finally {
        try {
            client.release();
        } catch (releaseError) {
            console.error('Client release error:', releaseError);
        }
    }
}

// Deliver lead data to partner's CRM system using dynamic CRM integration settings
// SSRF protection - validates URLs to prevent internal network access
function validateUrlForSSRF(url) {
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

async function deliverToCRM(leadId, partnerId, leadData) {
    const axios = require('axios');
    
    try {
        // Get partner's CRM integration settings with universal auth
        const crmResult = await pool.query(`
            SELECT 
                p.name as partner_name,
                crm.crm_name,
                crm.api_endpoint,
                crm.auth_type,
                crm.auth_config,
                crm.request_method,
                crm.request_headers,
                crm.field_mapping,
                crm.is_active
            FROM partners p
            LEFT JOIN partner_crm_integrations crm ON p.id = crm.partner_id 
            WHERE p.id = $1 AND p.status = 'active'
        `, [partnerId]);
        
        if (crmResult.rows.length === 0) {
            return { success: false, error: 'Partner not found or inactive' };
        }
        
        const { partner_name, crm_name, api_endpoint, auth_type, auth_config, request_method, request_headers, field_mapping, is_active } = crmResult.rows[0];
        
        // Use mutable variable for the final request URL
        let requestUrl = api_endpoint;
        
        // Check if CRM integration is configured and active
        if (!is_active || !api_endpoint) {
            console.log(`⚠️ No active CRM integration for ${partner_name} - skipping delivery`);
            
            // Log skipped delivery
            await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, delivered_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [
                leadId, 
                partnerId, 
                'NO_CRM_INTEGRATION',
                JSON.stringify({ reason: 'No active CRM integration configured' }),
                0
            ]);
            
            return { 
                success: true, 
                message: `No CRM integration configured for ${partner_name} - delivery skipped` 
            };
        }
        
        console.log(`🚀 Delivering lead ${leadId} to ${partner_name} ${crm_name} CRM API`);
        
        // Apply field mapping from CRM integration settings
        const crmPayload = {};
        const fieldMap = field_mapping || {};
        
        // Map lead fields to CRM fields based on stored configuration
        Object.keys(fieldMap).forEach(leadField => {
            const crmField = fieldMap[leadField];
            if (leadData[leadField]) {
                crmPayload[crmField] = leadData[leadField];
            }
        });
        
        // If no field mapping, use default mapping
        if (Object.keys(crmPayload).length === 0) {
            crmPayload.email = leadData.email;
            crmPayload.phone = leadData.phone;
            crmPayload.country = leadData.country;
            crmPayload.last_name = leadData.last_name;
            crmPayload.first_name = leadData.first_name;
        }
        
        console.log(`📤 ${crm_name} CRM payload:`, crmPayload);
        
        // Prepare headers from stored configuration
        const headers = request_headers || {};
        
        // Apply universal authentication if configured
        if (auth_type && auth_config) {
            const { generateAuth } = require('./universalAuth');
            try {
                const authResult = await generateAuth(auth_type, auth_config, api_endpoint);
                
                // Check if authentication setup was valid
                if (!authResult.isValid) {
                    console.error(`❌ Authentication validation failed for ${partner_name}: ${authResult.error}`);
                    return { success: false, error: `Authentication validation failed: ${authResult.error}` };
                }
                
                // Use the URL and headers returned by generateAuth
                if (authResult.url) {
                    requestUrl = authResult.url;
                }
                
                if (authResult.headers) {
                    Object.assign(headers, authResult.headers);
                }
                
                console.log(`🔐 Applied ${auth_type} authentication for ${partner_name}`);
            } catch (authError) {
                console.error(`❌ Authentication setup failed for ${partner_name}:`, authError.message);
                return { success: false, error: `Authentication setup failed: ${authError.message}` };
            }
        }
        
        // SSRF protection - validate final request URL
        const ssrfValidation = validateUrlForSSRF(requestUrl);
        if (!ssrfValidation.valid) {
            console.error(`❌ SSRF validation failed for ${partner_name}: ${ssrfValidation.error}`);
            return { success: false, error: `URL validation failed: ${ssrfValidation.error}` };
        }
        
        // Send to partner's CRM API
        const response = await axios({
            method: request_method || 'POST',
            url: requestUrl,
            data: crmPayload,
            timeout: 15000,
            headers: headers
        });
        
        console.log(`✅ ${crm_name} CRM delivery SUCCESS: Status ${response.status}`);
        console.log(`✅ Response:`, response.data);
        
        // Log successful delivery
        await pool.query(`
            INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, delivered_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [
            leadId, 
            partnerId, 
            `${crm_name}_CRM_API`,
            JSON.stringify(crmPayload),
            response.status
        ]);
        
        return { 
            success: true, 
            message: `Lead ${leadId} delivered to ${partner_name} ${crm_name} CRM (Status: ${response.status})` 
        };
        
    } catch (error) {
        console.error(`❌ CRM delivery FAILED for partner ${partnerId}:`, error.message);
        
        // Log failed delivery
        try {
            await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, delivered_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [
                leadId, 
                partnerId, 
                'CRM_DELIVERY_FAILED',
                JSON.stringify({ error: error.message }),
                error.response?.status || 0
            ]);
        } catch (logError) {
            console.error('Failed to log CRM delivery error:', logError);
        }
        
        return { 
            success: false, 
            error: `CRM delivery failed: ${error.message}` 
        };
    }
}

module.exports = {
    distributeLead
};