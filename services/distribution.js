const { pool } = require('../config/db');
const { sendWebhook } = require('./webhook');
const axios = require('axios');

// CRM lead delivery function
async function deliverToCRM(leadId, partnerId, leadData) {
    try {
        // Get partner's CRM integration settings
        const crmResult = await pool.query(`
            SELECT * FROM partner_crm_integrations 
            WHERE partner_id = $1 AND is_active = true
        `, [partnerId]);
        
        if (crmResult.rows.length === 0) {
            console.log(`No active CRM integration for partner ${partnerId}`);
            return { success: true, message: 'No CRM integration configured' };
        }
        
        const integration = crmResult.rows[0];
        
        // Parse JSON fields (stored as strings in database)
        let fieldMapping = {};
        let requestHeaders = {};
        
        try {
            fieldMapping = typeof integration.field_mapping === 'string' 
                ? JSON.parse(integration.field_mapping) 
                : (integration.field_mapping || {});
        } catch (e) {
            console.error('Invalid field mapping JSON, using defaults');
            fieldMapping = {};
        }
        
        try {
            requestHeaders = typeof integration.request_headers === 'string' 
                ? JSON.parse(integration.request_headers) 
                : (integration.request_headers || {});
        } catch (e) {
            console.error('Invalid request headers JSON, using defaults');
            requestHeaders = {};
        }
        
        // **ENHANCED: Use data enrichment for partner-specific preparation**
        const { prepareDataForPartner } = require('./dataEnrichment');
        
        // Parse stored lead data (includes enriched fields)
        let enrichedLeadData = leadData;
        if (typeof leadData.data === 'string') {
            try {
                const parsedData = JSON.parse(leadData.data);
                enrichedLeadData = { ...leadData, ...(parsedData.enriched || parsedData) };
            } catch (e) {
                // Fallback to original lead data
                enrichedLeadData = leadData;
            }
        }
        
        // Prepare data specifically for this partner's requirements
        let mappedData = await prepareDataForPartner(enrichedLeadData, partnerId);
        
        // Apply legacy field mapping for backwards compatibility
        const legacyMapped = {};
        for (const [ourField, theirField] of Object.entries(fieldMapping)) {
            if (enrichedLeadData[ourField] !== undefined) {
                legacyMapped[theirField] = enrichedLeadData[ourField];
            }
        }
        
        // Merge legacy mapping with new enriched mapping
        mappedData = { ...mappedData, ...legacyMapped };
        
        // Add essential default fields if still missing
        if (!mappedData.source && !mappedData.original_source) {
            mappedData.source = enrichedLeadData.original_source || 'Lead Distribution Platform';
        }
        if (!mappedData.timestamp) {
            mappedData.timestamp = new Date().toISOString();
        }
        if (!mappedData.country && enrichedLeadData.country) {
            mappedData.country = enrichedLeadData.country;
        }
        if (!mappedData.country_code && enrichedLeadData.country_code) {
            mappedData.country_code = enrichedLeadData.country_code;
        }
        
        // **CRITICAL SECURITY: Validate endpoint and method before sending**
        if (!integration.api_endpoint || typeof integration.api_endpoint !== 'string') {
            return { success: false, error: 'Invalid API endpoint configuration' };
        }
        
        // Parse and validate URL
        let url;
        try {
            url = new URL(integration.api_endpoint);
        } catch (e) {
            return { success: false, error: 'Invalid URL format in CRM configuration' };
        }
        
        // SSRF Protection: Only allow HTTPS
        if (url.protocol !== 'https:') {
            return { success: false, error: 'Only HTTPS endpoints are allowed for security' };
        }
        
        // SSRF Protection: Block private IP ranges
        const hostname = url.hostname;
        if (hostname === 'localhost' || hostname.match(/^127\./) || 
            hostname.match(/^192\.168\./) || hostname.match(/^10\./) || 
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
            hostname.match(/^0\./) || hostname === '::1') {
            return { success: false, error: 'Private IP addresses not allowed for security' };
        }
        
        // Validate request method
        const allowedMethods = ['POST', 'PUT'];
        if (!allowedMethods.includes(integration.request_method?.toUpperCase())) {
            return { success: false, error: 'Invalid request method in CRM configuration' };
        }
        
        // Prepare headers - validate auth header exists
        const headers = {
            'Content-Type': 'application/json',
            ...requestHeaders
        };
        
        // Handle different authentication types
        if (integration.auth_header && integration.api_key) {
            // Determine auth type from header name or stored type
            const authHeader = integration.auth_header.toLowerCase();
            
            if (authHeader === 'authorization') {
                // Check if this should be Bearer or Token format
                if (integration.api_key.startsWith('Bearer ') || integration.api_key.startsWith('Token ')) {
                    headers[integration.auth_header] = integration.api_key;
                } else {
                    // Default to Bearer for Authorization header
                    headers[integration.auth_header] = `Bearer ${integration.api_key}`;
                }
            } else {
                // Direct header assignment for API keys and custom headers
                headers[integration.auth_header] = integration.api_key;
            }
        }
        
        // Send lead to partner's CRM with security controls
        const response = await axios({
            method: integration.request_method.toLowerCase(),
            url: integration.api_endpoint,
            headers: headers,
            data: mappedData,
            timeout: 15000,
            maxRedirects: 0, // CRITICAL: Prevent redirect-based SSRF
            maxContentLength: 1024 * 1024, // Limit response size to 1MB
            validateStatus: (status) => status < 500
        });
        
        // Log the delivery
        await pool.query(`
            INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, response_body, delivered_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        `, [
            leadId, 
            partnerId, 
            integration.api_endpoint, 
            JSON.stringify(mappedData),
            response.status,
            JSON.stringify(response.data).substring(0, 1000) // Limit response size
        ]);
        
        if (response.status >= 200 && response.status < 400) {
            return { 
                success: true, 
                message: `Lead delivered to ${integration.crm_name}`,
                crmName: integration.crm_name 
            };
        } else {
            return { 
                success: false, 
                error: `CRM delivery failed: HTTP ${response.status}`,
                crmName: integration.crm_name
            };
        }
        
    } catch (error) {
        console.error(`CRM delivery error for partner ${partnerId}:`, error);
        
        // Log failed delivery
        try {
            await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, error_message, delivered_at)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            `, [
                leadId, 
                partnerId, 
                'CRM_DELIVERY_FAILED',
                JSON.stringify({ error: 'Failed to map or send data' }),
                0,
                error.message?.substring(0, 500)
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

// Lead distribution function with transaction safety
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
        
        // Find eligible partners with transaction safety
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
            await client.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
            await client.query('COMMIT');
            return;
        }
        
        // Select partner based on premium/raw ratio
        let selectedPartner = partnersResult.rows[0];
        
        for (const partner of partnersResult.rows) {
            const premiumRatio = parseFloat(partner.premium_ratio);
            const currentPremiumRatio = partner.todays_leads > 0 ? 
                partner.todays_premium / partner.todays_leads : 0;
            
            if (lead.type === 'premium' && currentPremiumRatio < premiumRatio) {
                selectedPartner = partner;
                break;
            } else if (lead.type === 'raw' && currentPremiumRatio >= premiumRatio) {
                selectedPartner = partner;
                break;
            }
        }
        
        // Update lead assignment
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
        
        // Send webhook and CRM delivery asynchronously (outside transaction)
        setImmediate(async () => {
            try {
                // Send traditional webhook
                await sendWebhook(lead, selectedPartner);
                console.log(`Lead ${leadId} distributed to partner ${selectedPartner.name}`);
                
                // Also deliver to partner's CRM system
                const crmResult = await deliverToCRM(leadId, selectedPartner.id, {
                    first_name: lead.first_name,
                    last_name: lead.last_name,
                    email: lead.email,
                    phone: lead.phone,
                    country: lead.country,
                    niche: lead.niche,
                    type: lead.type,
                    source: lead.source
                });
                
                if (crmResult.success) {
                    console.log(`CRM Delivery: ${crmResult.message}`);
                } else {
                    console.error(`CRM Delivery Failed: ${crmResult.error}`);
                }
            } catch (error) {
                console.error(`Delivery failed for lead ${leadId}:`, error);
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Lead distribution error:', error);
        
        // Mark lead as failed
        try {
            await pool.query('UPDATE leads SET status = $1 WHERE id = $2', ['failed', leadId]);
        } catch (updateError) {
            console.error('Failed to mark lead as failed:', updateError);
        }
        
        throw error;
    } finally {
        client.release();
    }
}

// Retry failed leads (called by cron)
async function retryFailedLeads() {
    try {
        // Only retry leads that failed due to no available partners
        const failedLeads = await pool.query(`
            SELECT l.*, p.name as partner_name 
            FROM leads l
            LEFT JOIN partners p ON l.assigned_partner_id = p.id
            WHERE l.status = 'failed' 
                AND l.created_at > NOW() - INTERVAL '24 hours'
                AND l.assigned_partner_id IS NULL
            ORDER BY l.created_at ASC
            LIMIT 10
        `);
        
        for (const lead of failedLeads.rows) {
            try {
                console.log(`Retrying distribution for failed lead ${lead.id} (${lead.country}/${lead.niche})`);
                
                // Check if eligible partners are now available
                const availablePartners = await pool.query(`
                    SELECT p.*, ds.leads_received
                    FROM partners p
                    LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
                    WHERE p.status = 'active' 
                        AND (p.country = $1 OR p.country = 'global')
                        AND (p.niche = $2 OR p.niche = 'all')
                        AND (ds.leads_received IS NULL OR ds.leads_received < p.daily_limit)
                    ORDER BY COALESCE(ds.leads_received, 0) ASC, p.created_at ASC
                `, [lead.country, lead.niche]);
                
                if (availablePartners.rows.length > 0) {
                    await distributeLead(lead.id);
                    console.log(`Successfully redistributed failed lead ${lead.id}`);
                } else {
                    console.log(`No eligible partners available yet for lead ${lead.id} (${lead.country}/${lead.niche})`);
                }
            } catch (error) {
                console.error(`Retry failed for lead ${lead.id}:`, error.message);
            }
        }
        
        console.log(`Processed ${failedLeads.rows.length} failed leads for retry`);
    } catch (error) {
        console.error('Failed lead retry error:', error);
    }
}

module.exports = { distributeLead, retryFailedLeads, deliverToCRM };