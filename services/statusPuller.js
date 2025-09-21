const { pool } = require('../config/db');
const axios = require('axios');

// Status pulling service - pulls lead statuses from partner APIs
async function pullPartnerStatuses() {
    try {
        console.log('Starting status pull from partner APIs...');
        
        // Get all partners with active status pulling configuration
        const partnersResult = await pool.query(`
            SELECT p.id, p.name, pci.*
            FROM partners p
            JOIN partner_crm_integrations pci ON p.id = pci.partner_id
            WHERE p.status = 'active' 
              AND pci.is_active = true 
              AND pci.status_pull_endpoint IS NOT NULL
              AND pci.status_pull_endpoint != ''
              AND (pci.last_status_pull IS NULL OR pci.last_status_pull < NOW() - INTERVAL '1 minute' * pci.pull_frequency)
        `);
        
        console.log(`Found ${partnersResult.rows.length} partners ready for status pulling`);
        
        for (const partner of partnersResult.rows) {
            try {
                await pullStatusForPartner(partner);
            } catch (error) {
                console.error(`Failed to pull status for partner ${partner.name} (${partner.id}):`, error.message);
            }
        }
        
        console.log('Status pulling cycle completed');
        
    } catch (error) {
        console.error('Status pulling service error:', error);
    }
}

async function pullStatusForPartner(partner) {
    console.log(`Pulling status for partner: ${partner.name} (${partner.id})`);
    
    // Get leads assigned to this partner in the last 30 days that need status updates
    const leadsResult = await pool.query(`
        SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.created_at, l.distributed_at
        FROM leads l
        WHERE l.assigned_partner_id = $1 
          AND l.status IN ('distributed', 'pending', 'qualified')
          AND l.created_at > NOW() - INTERVAL '30 days'
        ORDER BY l.distributed_at DESC
        LIMIT 100
    `, [partner.id]);
    
    if (leadsResult.rows.length === 0) {
        console.log(`No leads to check for partner ${partner.name}`);
        return;
    }
    
    console.log(`Checking status for ${leadsResult.rows.length} leads from partner ${partner.name}`);
    
    // Parse field mapping and headers
    let statusFieldMapping = {};
    let requestHeaders = {};
    
    try {
        statusFieldMapping = typeof partner.status_field_mapping === 'string' 
            ? JSON.parse(partner.status_field_mapping) 
            : (partner.status_field_mapping || {});
        requestHeaders = typeof partner.request_headers === 'string' 
            ? JSON.parse(partner.request_headers) 
            : (partner.request_headers || {});
    } catch (e) {
        console.error(`Invalid JSON configuration for partner ${partner.name}, skipping`);
        return;
    }
    
    // **CRITICAL SECURITY: Validate endpoint before calling**
    if (!partner.status_pull_endpoint || typeof partner.status_pull_endpoint !== 'string') {
        console.error(`Invalid status pull endpoint for partner ${partner.name}`);
        return;
    }
    
    // Parse and validate URL
    let url;
    try {
        url = new URL(partner.status_pull_endpoint);
    } catch (e) {
        console.error(`Invalid URL format for partner ${partner.name}:`, e.message);
        return;
    }
    
    // SSRF Protection: Only allow HTTPS
    if (url.protocol !== 'https:') {
        console.error(`Non-HTTPS endpoint rejected for partner ${partner.name}`);
        return;
    }
    
    // **CRITICAL SSRF Protection: Resolve DNS and validate final IP**
    const dns = require('dns').promises;
    let resolvedIPs;
    
    try {
        resolvedIPs = await dns.resolve4(url.hostname);
    } catch (dnsError) {
        try {
            // Try IPv6 if IPv4 fails
            resolvedIPs = await dns.resolve6(url.hostname);
        } catch (dns6Error) {
            console.error(`DNS resolution failed for partner ${partner.name}: ${url.hostname}`);
            return;
        }
    }
    
    // Validate all resolved IPs against private ranges
    for (const ip of resolvedIPs) {
        // IPv4 private ranges
        if (ip.match(/^127\./) ||                          // Loopback
            ip.match(/^192\.168\./) ||                     // Private Class C
            ip.match(/^10\./) ||                           // Private Class A  
            ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||  // Private Class B
            ip.match(/^169\.254\./) ||                     // Link-local
            ip.match(/^224\./) ||                          // Multicast
            ip.match(/^0\./) ||                            // Current network
            ip === '255.255.255.255') {                    // Broadcast
            console.error(`Private/reserved IP ${ip} rejected for partner ${partner.name}`);
            return;
        }
        
        // IPv6 private ranges
        if (ip.startsWith('::1') ||                        // Loopback
            ip.startsWith('::ffff:') ||                    // IPv4-mapped
            ip.startsWith('fe80:') ||                      // Link-local
            ip.startsWith('fc00:') ||                      // Unique local
            ip.startsWith('fd00:')) {                      // Unique local
            console.error(`Private IPv6 ${ip} rejected for partner ${partner.name}`);
            return;
        }
    }
    
    console.log(`DNS validation passed for ${partner.name}: ${url.hostname} -> ${resolvedIPs.join(', ')}`);
    
    // Additional hostname validation - only allow known safe domains if configured
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname.match(/\.local$/)) {
        console.error(`Local hostname rejected for partner ${partner.name}`);
        return;
    }
    
    // Validate method
    const allowedMethods = ['GET', 'POST'];
    if (!allowedMethods.includes(partner.status_pull_method?.toUpperCase())) {
        console.error(`Invalid method ${partner.status_pull_method} for partner ${partner.name}`);
        return;
    }
    
    try {
        // Prepare request headers
        const headers = {
            'Content-Type': 'application/json',
            ...requestHeaders
        };
        
        if (partner.auth_header && partner.api_key) {
            headers[partner.auth_header] = partner.api_key;
        }
        
        // Build request payload with lead IDs
        const leadIds = leadsResult.rows.map(lead => lead.id);
        const requestData = {
            lead_ids: leadIds,
            since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Last 24 hours
        };
        
        // Call partner's status endpoint
        const response = await axios({
            method: partner.status_pull_method.toLowerCase(),
            url: partner.status_pull_endpoint,
            headers: headers,
            data: partner.status_pull_method.toUpperCase() === 'POST' ? requestData : undefined,
            params: partner.status_pull_method.toUpperCase() === 'GET' ? { lead_ids: leadIds.join(',') } : undefined,
            timeout: 30000, // 30 second timeout
            maxRedirects: 0, // Prevent redirect attacks
            maxContentLength: 5 * 1024 * 1024, // 5MB max response
            validateStatus: (status) => status < 500
        });
        
        if (response.status >= 200 && response.status < 400) {
            await processStatusResponse(partner, response.data, leadsResult.rows, statusFieldMapping);
            
            // Update last pull timestamp
            await pool.query(
                'UPDATE partner_crm_integrations SET last_status_pull = CURRENT_TIMESTAMP WHERE partner_id = $1',
                [partner.id]
            );
            
            console.log(`Successfully pulled status for partner ${partner.name}`);
        } else {
            console.error(`Status pull failed for partner ${partner.name}: HTTP ${response.status}`);
        }
        
    } catch (error) {
        console.error(`Status pull request failed for partner ${partner.name}:`, error.message);
    }
}

async function processStatusResponse(partner, responseData, leads, statusFieldMapping) {
    try {
        // Assume response format: { leads: [{ id: X, status: 'converted', value: 100 }] }
        // Partners can customize this format via field mapping
        
        const statusUpdates = Array.isArray(responseData.leads) ? responseData.leads : 
                              Array.isArray(responseData) ? responseData : [];
        
        let updatesProcessed = 0;
        
        for (const statusUpdate of statusUpdates) {
            const leadId = statusUpdate.id || statusUpdate.lead_id;
            const status = statusUpdate.status;
            const value = statusUpdate.value || statusUpdate.conversion_value;
            const quality = statusUpdate.quality_score || statusUpdate.quality;
            const feedback = statusUpdate.feedback || statusUpdate.notes;
            const reference = statusUpdate.reference || statusUpdate.partner_ref;
            
            if (!leadId || !status) continue;
            
            // Find matching lead in our list
            const lead = leads.find(l => l.id == leadId);
            if (!lead) continue;
            
            // Map status using partner's field mapping
            let mappedStatus = status;
            if (statusFieldMapping[status]) {
                mappedStatus = statusFieldMapping[status];
            }
            
            // Skip if status hasn't changed (basic deduplication)
            const existingStatusResult = await pool.query(
                'SELECT status FROM lead_status_updates WHERE lead_id = $1 AND partner_id = $2 ORDER BY created_at DESC LIMIT 1',
                [leadId, partner.id]
            );
            
            if (existingStatusResult.rows.length > 0 && existingStatusResult.rows[0].status === mappedStatus) {
                continue; // Skip duplicate status
            }
            
            // Record status update with idempotency protection
            try {
                await pool.query(`
                    INSERT INTO lead_status_updates 
                    (lead_id, partner_id, status, conversion_value, quality_score, 
                     partner_feedback, update_source, partner_reference, raw_data)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (lead_id, partner_id, status, COALESCE(partner_reference, 'none'), DATE_TRUNC('minute', created_at))
                    DO NOTHING
                `, [
                    leadId,
                    partner.id,
                    mappedStatus,
                    value,
                    quality,
                    feedback,
                    'pulled',
                    reference,
                    JSON.stringify(statusUpdate)
                ]);
            } catch (duplicateError) {
                // Skip duplicates silently (handled by unique constraint)
                continue;
            }
            
            // Update main leads table
            await pool.query(`
                UPDATE leads 
                SET status = CASE 
                    WHEN $2 IN ('converted', 'qualified', 'rejected') THEN $2
                    ELSE status 
                END,
                conversion_value = CASE 
                    WHEN $3 IS NOT NULL THEN COALESCE(conversion_value, 0) + $3
                    ELSE conversion_value 
                END,
                quality_score = COALESCE($4, quality_score),
                converted_at = CASE 
                    WHEN $2 = 'converted' AND converted_at IS NULL THEN CURRENT_TIMESTAMP
                    ELSE converted_at 
                END
                WHERE id = $1
            `, [leadId, mappedStatus, value, quality]);
            
            updatesProcessed++;
        }
        
        console.log(`Processed ${updatesProcessed} status updates from partner ${partner.name}`);
        
    } catch (error) {
        console.error(`Error processing status response for partner ${partner.name}:`, error.message);
    }
}

module.exports = { pullPartnerStatuses, pullStatusForPartner };