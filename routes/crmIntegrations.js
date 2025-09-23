const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { mergeAuthConfigPreservingSecrets } = require('../services/universalAuth');

// List all CRM integrations
router.get('/', async (req, res) => {
    try {
        const integrations = await pool.query(`
            SELECT 
                p.id as partner_id,
                p.name as partner_name,
                p.email as partner_email,
                p.country,
                p.niche,
                p.status as partner_status,
                crm.id as crm_id,
                crm.crm_name,
                crm.api_endpoint,
                crm.auth_type,
                crm.is_active as crm_active,
                crm.test_url,
                crm.last_status_pull,
                crm.created_at as crm_created_at,
                crm.updated_at as crm_updated_at
            FROM partners p
            LEFT JOIN partner_crm_integrations crm ON p.id = crm.partner_id
            ORDER BY p.name
        `);

        const partnersWithCRM = integrations.rows.map(row => ({
            partner_id: row.partner_id,
            partner_name: row.partner_name,
            partner_email: row.partner_email,
            country: row.country,
            niche: row.niche,
            partner_status: row.partner_status,
            crm_status: row.crm_id ? 'configured' : 'missing',
            crm_active: row.crm_active || false,
            crm_name: row.crm_name || 'Not configured',
            api_endpoint: row.api_endpoint || '',
            auth_type: row.auth_type || '',
            test_url: row.test_url || '',
            last_status_pull: row.last_status_pull,
            crm_created_at: row.crm_created_at,
            crm_updated_at: row.crm_updated_at
        }));

        res.render('crm-integrations/index', {
            title: 'CRM Integrations',
            partners: partnersWithCRM
        });
    } catch (error) {
        console.error('Error loading CRM integrations:', error);
        res.status(500).render('error', { error: 'Failed to load CRM integrations' });
    }
});

// Show CRM integration detail/edit page for specific partner
router.get('/:partnerId', async (req, res) => {
    try {
        const partnerId = req.params.partnerId;

        // Get partner info
        const partner = await pool.query('SELECT * FROM partners WHERE id = $1', [partnerId]);
        if (partner.rows.length === 0) {
            return res.status(404).render('error', { error: 'Partner not found' });
        }

        // Get existing CRM integration if exists
        const integration = await pool.query(
            'SELECT * FROM partner_crm_integrations WHERE partner_id = $1',
            [partnerId]
        );

        res.render('crm-integrations/detail', {
            title: `CRM Integration - ${partner.rows[0].name}`,
            partner: partner.rows[0],
            integration: integration.rows[0] || null
        });
    } catch (error) {
        console.error('Error loading CRM integration detail:', error);
        res.status(500).render('error', { error: 'Failed to load CRM integration' });
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

module.exports = router;