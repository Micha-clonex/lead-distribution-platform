const { pool } = require('../config/db');
const { sendWebhook } = require('./webhook');

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
        
        // Send webhook asynchronously (outside transaction)
        setImmediate(async () => {
            try {
                await sendWebhook(lead, selectedPartner);
                console.log(`Lead ${leadId} distributed to partner ${selectedPartner.name}`);
            } catch (error) {
                console.error(`Webhook delivery failed for lead ${leadId}:`, error);
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

module.exports = { distributeLead, retryFailedLeads };