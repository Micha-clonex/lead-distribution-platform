const { pool } = require('../config/db');

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
        
        // Deliver to partner's CRM system directly  
        setImmediate(async () => {
            try {
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
                    console.log(`✅ CRM Delivery Success: ${crmResult.message}`);
                } else {
                    console.error(`❌ CRM Delivery Failed: ${crmResult.error}`);
                }
            } catch (error) {
                console.error(`CRM delivery failed for lead ${leadId}:`, error);
            }
        });
        
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

// Deliver lead data to partner's CRM system using API integration
async function deliverToCRM(leadId, partnerId, leadData) {
    const axios = require('axios');
    
    try {
        // Get partner's name
        const partnerResult = await pool.query(`
            SELECT name FROM partners WHERE id = $1 AND status = 'active'
        `, [partnerId]);
        
        if (partnerResult.rows.length === 0) {
            return { success: false, error: 'Partner not found or inactive' };
        }
        
        const partner = partnerResult.rows[0];
        
        // NOBIS MANTICORE CRM INTEGRATION
        if (partner.name === 'Nobis') {
            console.log(`🚀 Delivering lead ${leadId} to Nobis Manticore CRM API`);
            
            // Apply field mapping for Manticore CRM
            const crmPayload = {
                email: leadData.email,
                numbers: leadData.phone, // phone -> numbers 
                country: leadData.country,
                last_name: leadData.last_name,
                first_name: leadData.first_name
            };
            
            console.log(`📤 Manticore CRM payload:`, crmPayload);
            
            // Send to Manticore CRM API
            const response = await axios.post('https://api.manticore-crm.site/contacts', crmPayload, {
                timeout: 15000,
                headers: {
                    'X-API-Key': '7cd8ae99-3e3f-45eb-9273-e94799d08d67',
                    'Content-Type': 'application/json',
                    'api-key': '7cd8ae99-3e3f-45eb-9273-e94799d08d67'
                }
            });
            
            console.log(`✅ Manticore CRM delivery SUCCESS: Status ${response.status}`);
            console.log(`✅ Response:`, response.data);
            
            // Log successful delivery
            await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, delivered_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [
                leadId, 
                partnerId, 
                'MANTICORE_CRM_API',
                JSON.stringify(crmPayload),
                'success'
            ]);
            
            return { 
                success: true, 
                message: `Lead ${leadId} delivered to Nobis Manticore CRM (Status: ${response.status})` 
            };
        }
        
        // Default webhook delivery for other partners
        else {
            console.log(`📤 Using default webhook delivery for ${partner.name}`);
            
            const webhookPayload = {
                lead_id: leadId,
                first_name: leadData.first_name,
                last_name: leadData.last_name,
                email: leadData.email,
                phone: leadData.phone,
                country: leadData.country,
                niche: leadData.niche,
                type: leadData.type,
                source: leadData.source,
                timestamp: new Date().toISOString()
            };
            
            // Log simulated delivery for non-configured partners
            await pool.query(`
                INSERT INTO webhook_deliveries (lead_id, partner_id, webhook_url, payload, response_status, delivered_at)
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            `, [
                leadId, 
                partnerId, 
                'WEBHOOK_SIMULATED',
                JSON.stringify(webhookPayload),
                'simulated'
            ]);
            
            return { 
                success: true, 
                message: `Lead ${leadId} simulated delivery to ${partner.name}` 
            };
        }
        
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
                'failed'
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