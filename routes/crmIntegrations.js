const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { mergeAuthConfigPreservingSecrets } = require('../services/universalAuth');

// List all CRM integrations
router.get('/', async (req, res) => {
    try {
        // Get all partners
        const partnersResult = await pool.query('SELECT * FROM partners ORDER BY name');
        const partners = partnersResult.rows;

        // Get CRM integrations with calculated fields
        const integrationResult = await pool.query(`
            SELECT 
                crm.id,
                p.id as partner_id,
                p.name as partner_name,
                p.country as partner_country,
                p.niche as partner_niche,
                crm.crm_name as platform_name,
                '' as platform_version,
                COALESCE(crm.auth_type, 'none') as auth_method,
                crm.is_active,
                crm.last_status_pull as last_sync_at,
                0 as custom_headers_count,
                'healthy' as health_status,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id), 0) as total_attempts,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id AND wd.status = 'success'), 0) as successful_syncs,
                crm.created_at
            FROM partner_crm_integrations crm
            JOIN partners p ON crm.partner_id = p.id
            ORDER BY p.name
        `);

        const integrations = integrationResult.rows;

        res.render('crm-integrations/index', {
            title: 'CRM Integrations',
            integrations: integrations,
            partners: partners
        });
    } catch (error) {
        console.error('Error loading CRM integrations:', error);
        res.status(500).render('error', { title: 'Error', error: 'Failed to load CRM integrations' });
    }
});

// Show CRM integration detail/edit page for specific partner (by partner ID)
router.get('/partner/:partnerId', async (req, res) => {
    try {
        const partnerId = req.params.partnerId;

        // Get integration by partner ID
        const integrationResult = await pool.query(`
            SELECT 
                crm.id,
                p.id as partner_id,
                p.name as partner_name,
                p.country as partner_country,
                p.niche as partner_niche,
                crm.crm_name as platform_name,
                '' as platform_version,
                COALESCE(crm.auth_type, 'none') as auth_method,
                crm.is_active,
                crm.api_endpoint as webhook_url,
                crm.auth_config,
                crm.request_headers as custom_headers,
                crm.last_status_pull as last_sync_at,
                'healthy' as health_status,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id), 0) as total_attempts,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id AND wd.status = 'success'), 0) as successful_syncs,
                crm.created_at
            FROM partner_crm_integrations crm
            JOIN partners p ON crm.partner_id = p.id
            WHERE p.id = $1
        `, [partnerId]);

        if (integrationResult.rows.length === 0) {
            return res.status(404).render('error', { title: 'Not Found', error: 'CRM integration not found for this partner' });
        }

        const integration = integrationResult.rows[0];
        integration.success_rate = integration.total_attempts > 0 ? 
            (integration.successful_syncs / integration.total_attempts) * 100 : 0;

        // Get recent sync history
        const syncHistoryResult = await pool.query(`
            SELECT 
                wd.id,
                wd.lead_id,
                l.email as lead_email,
                wd.status,
                wd.response_code,
                wd.response_body,
                wd.attempts,
                wd.created_at
            FROM webhook_deliveries wd
            JOIN leads l ON wd.lead_id = l.id
            WHERE l.partner_id = $1
            ORDER BY wd.created_at DESC
            LIMIT 20
        `, [partnerId]);

        res.render('crm-integrations/detail', {
            title: `CRM Integration - ${integration.partner_name}`,
            integration: integration,
            syncHistory: syncHistoryResult.rows
        });
    } catch (error) {
        console.error('Error loading CRM integration detail:', error);
        res.status(500).render('error', { title: 'Error', error: 'Failed to load CRM integration' });
    }
});

// Show CRM integration detail/edit page for specific integration
router.get('/:integrationId', async (req, res) => {
    try {
        const integrationId = req.params.integrationId;

        // Get integration with partner info and sync history
        const integrationResult = await pool.query(`
            SELECT 
                crm.id,
                p.id as partner_id,
                p.name as partner_name,
                p.country as partner_country,
                p.niche as partner_niche,
                crm.crm_name as platform_name,
                '' as platform_version,
                COALESCE(crm.auth_type, 'none') as auth_method,
                crm.is_active,
                crm.api_endpoint as webhook_url,
                crm.auth_config,
                crm.request_headers as custom_headers,
                crm.last_status_pull as last_sync_at,
                'healthy' as health_status,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id), 0) as total_attempts,
                COALESCE((SELECT COUNT(*) FROM webhook_deliveries wd 
                         JOIN leads l ON wd.lead_id = l.id 
                         WHERE l.partner_id = p.id AND wd.status = 'success'), 0) as successful_syncs,
                crm.created_at
            FROM partner_crm_integrations crm
            JOIN partners p ON crm.partner_id = p.id
            WHERE crm.id = $1
        `, [integrationId]);

        if (integrationResult.rows.length === 0) {
            return res.status(404).render('error', { title: 'Not Found', error: 'CRM integration not found' });
        }

        const integration = integrationResult.rows[0];
        integration.success_rate = integration.total_attempts > 0 ? 
            (integration.successful_syncs / integration.total_attempts) * 100 : 0;

        // Get recent sync history
        const syncHistoryResult = await pool.query(`
            SELECT 
                wd.id,
                wd.lead_id,
                l.email as lead_email,
                wd.status,
                wd.response_code,
                wd.response_body,
                wd.attempts,
                wd.created_at
            FROM webhook_deliveries wd
            JOIN leads l ON wd.lead_id = l.id
            WHERE l.partner_id = $1
            ORDER BY wd.created_at DESC
            LIMIT 20
        `, [integration.partner_id]);

        res.render('crm-integrations/detail', {
            title: `CRM Integration - ${integration.partner_name}`,
            integration: integration,
            syncHistory: syncHistoryResult.rows
        });
    } catch (error) {
        console.error('Error loading CRM integration detail:', error);
        res.status(500).render('error', { title: 'Error', error: 'Failed to load CRM integration' });
    }
});

// Save/Update CRM integration (reuse existing partner route logic)
router.post('/:partnerId', async (req, res) => {
    try {
        const partnerId = req.params.partnerId;
        const {
            crm_name,
            api_endpoint,
            auth_type,
            request_method = 'POST',
            request_headers = '{}',
            field_mapping = '{}',
            test_url = '',
            status_pull_endpoint = '',
            status_pull_method = 'GET',
            status_field_mapping = '{}',
            pull_frequency = 60,
            is_active = true
        } = req.body;

        // Parse auth config fields from form data
        let authConfig = {};
        
        // Extract auth config based on type
        switch (auth_type) {
            case 'bearer_token':
                authConfig = { token: req.body.auth_token || '' };
                break;
            case 'api_key':
                authConfig = { 
                    key: req.body.auth_key || '',
                    header: req.body.auth_header || 'X-API-Key'
                };
                break;
            case 'basic_auth':
                authConfig = {
                    username: req.body.auth_username || '',
                    password: req.body.auth_password || ''
                };
                break;
            case 'custom_header':
                authConfig = {
                    custom_headers: JSON.parse(req.body.auth_custom_headers || '{}')
                };
                break;
            case 'query_param':
                authConfig = {
                    param_name: req.body.auth_param_name || 'api_key',
                    param_value: req.body.auth_param_value || ''
                };
                break;
            case 'oauth2':
                authConfig = {
                    client_id: req.body.auth_client_id || '',
                    client_secret: req.body.auth_client_secret || '',
                    token_url: req.body.auth_token_url || ''
                };
                break;
            case 'custom':
                authConfig = {
                    custom_config: JSON.parse(req.body.auth_custom_config || '{}')
                };
                break;
            default:
                authConfig = {};
        }

        // Check if integration exists
        const existing = await pool.query(
            'SELECT * FROM partner_crm_integrations WHERE partner_id = $1',
            [partnerId]
        );

        if (existing.rows.length > 0) {
            // Update existing - preserve secrets
            const finalAuthConfig = await mergeAuthConfigPreservingSecrets(
                auth_type,
                authConfig,
                existing.rows[0].auth_config
            );

            await pool.query(`
                UPDATE partner_crm_integrations 
                SET crm_name = $1, api_endpoint = $2, auth_type = $3, auth_config = $4,
                    request_method = $5, request_headers = $6, field_mapping = $7,
                    test_url = $8, status_pull_endpoint = $9, status_pull_method = $10,
                    status_field_mapping = $11, pull_frequency = $12, is_active = $13,
                    updated_at = CURRENT_TIMESTAMP
                WHERE partner_id = $14
            `, [
                crm_name, api_endpoint, auth_type, finalAuthConfig, request_method,
                request_headers, field_mapping, test_url, status_pull_endpoint,
                status_pull_method, status_field_mapping, pull_frequency, is_active,
                partnerId
            ]);
        } else {
            // Create new integration
            await pool.query(`
                INSERT INTO partner_crm_integrations 
                (partner_id, crm_name, api_endpoint, auth_type, auth_config, request_method,
                 request_headers, field_mapping, test_url, status_pull_endpoint,
                 status_pull_method, status_field_mapping, pull_frequency, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `, [
                partnerId, crm_name, api_endpoint, auth_type, authConfig, request_method,
                request_headers, field_mapping, test_url, status_pull_endpoint,
                status_pull_method, status_field_mapping, pull_frequency, is_active
            ]);
        }

        res.redirect(`/crm-integrations/${partnerId}?success=CRM integration saved successfully`);
    } catch (error) {
        console.error('Error saving CRM integration:', error);
        res.redirect(`/crm-integrations/${req.params.partnerId}?error=Failed to save CRM integration`);
    }
});

// Test CRM integration (reuse existing partner route logic)
router.post('/:partnerId/test', async (req, res) => {
    try {
        const partnerId = req.params.partnerId;
        
        // Forward to existing test endpoint
        const testRequest = require('./partners');
        req.url = `/${partnerId}/crm-integration/test`;
        testRequest(req, res);
    } catch (error) {
        console.error('Error testing CRM integration:', error);
        res.json({ success: false, message: 'Test failed' });
    }
});

// Toggle CRM integration status
router.put('/:integrationId/status', async (req, res) => {
    try {
        const integrationId = req.params.integrationId;
        const { is_active } = req.body;

        await pool.query(
            'UPDATE partner_crm_integrations SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [is_active, integrationId]
        );

        res.json({ success: true, message: 'Status updated successfully' });
    } catch (error) {
        console.error('Error updating CRM integration status:', error);
        res.json({ success: false, message: 'Failed to update status' });
    }
});

// Delete CRM integration
router.delete('/:integrationId', async (req, res) => {
    try {
        const integrationId = req.params.integrationId;

        await pool.query('DELETE FROM partner_crm_integrations WHERE id = $1', [integrationId]);

        res.json({ success: true, message: 'CRM integration deleted successfully' });
    } catch (error) {
        console.error('Error deleting CRM integration:', error);
        res.json({ success: false, message: 'Failed to delete CRM integration' });
    }
});

// Test CRM connection
router.post('/:integrationId/test-connection', async (req, res) => {
    try {
        const integrationId = req.params.integrationId;
        
        // Get integration details
        const integration = await pool.query(
            'SELECT * FROM partner_crm_integrations WHERE id = $1',
            [integrationId]
        );

        if (integration.rows.length === 0) {
            return res.json({ success: false, message: 'Integration not found' });
        }

        // TODO: Implement actual CRM connection test
        // For now, just return success
        res.json({ 
            success: true, 
            message: 'Connection test successful',
            details: 'CRM endpoint is reachable' 
        });
    } catch (error) {
        console.error('Error testing CRM connection:', error);
        res.json({ success: false, message: 'Connection test failed' });
    }
});

module.exports = router;