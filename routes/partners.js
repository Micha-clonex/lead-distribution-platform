const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const axios = require('axios');

// Get all partners
router.get('/', async (req, res) => {
    try {
        const { country, niche, status } = req.query;
        let query = 'SELECT * FROM partners WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (country) {
            query += ` AND country = $${++paramCount}`;
            params.push(country);
        }
        if (niche) {
            query += ` AND niche = $${++paramCount}`;
            params.push(niche);
        }
        if (status) {
            query += ` AND status = $${++paramCount}`;
            params.push(status);
        }

        query += ' ORDER BY created_at DESC';
        
        const result = await pool.query(query, params);
        
        // Get today's performance statistics for each partner
        const statsQuery = `
            SELECT 
                p.id, p.premium_ratio as target_ratio,
                COALESCE(ds.leads_received, 0) as leads_received, 
                COALESCE(ds.premium_leads, 0) as premium_leads,
                CASE 
                    WHEN COALESCE(ds.leads_received, 0) > 0 
                    THEN COALESCE(ds.premium_leads, 0)::decimal / COALESCE(ds.leads_received, 0) 
                    ELSE 0 
                END as actual_ratio
            FROM partners p
            LEFT JOIN distribution_stats ds ON p.id = ds.partner_id AND ds.date = CURRENT_DATE
            WHERE p.id = ANY($1)
        `;
        const partnerIds = result.rows.map(p => p.id);
        const statsResult = partnerIds.length > 0 ? await pool.query(statsQuery, [partnerIds]) : { rows: [] };
        
        // Merge stats with partner data
        const partnersWithStats = result.rows.map(partner => {
            const stats = statsResult.rows.find(s => s.id === partner.id) || {};
            return {
                ...partner,
                todays_leads: stats.leads_received || 0,
                todays_premium: stats.premium_leads || 0,
                actual_ratio: stats.actual_ratio || 0,
                target_ratio: stats.target_ratio || partner.premium_ratio
            };
        });
        
        res.render('partners/index', { 
            partners: partnersWithStats,
            title: 'Partner Management',
            countries: ['germany', 'austria', 'spain', 'canada', 'italy', 'uk', 'norway'],
            niches: ['forex', 'recovery'],
            // Pass current query parameters for filter selection
            currentFilters: {
                country: country || '',
                niche: niche || '',
                status: status || ''
            }
        });
    } catch (error) {
        console.error('Partners fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch partners' });
    }
});

// Add new partner
router.post('/', async (req, res) => {
    try {
        const { name, email, country, niche, daily_limit, premium_ratio, timezone } = req.body;
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio ? (parseFloat(premium_ratio) / 100) : 0.70;
        
        // Validate required fields
        if (!name || !email || !country || !niche) {
            return res.redirect('/partners?error=Name, email, country, and niche are required');
        }
        
        // Since external webhooks are not used, provide internal default
        const defaultWebhookUrl = 'internal://partner-endpoint';
        
        await pool.query(`
            INSERT INTO partners (name, email, country, niche, daily_limit, premium_ratio, timezone, webhook_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [name, email, country, niche, daily_limit || 50, ratioDecimal, timezone || 'UTC', defaultWebhookUrl]);
        
        res.redirect('/partners?success=Partner added successfully');
    } catch (error) {
        console.error('Partner creation error:', error);
        res.redirect('/partners?error=Failed to add partner: ' + error.message);
    }
});

// Update partner
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, country, niche, daily_limit, premium_ratio, status, timezone, recovery_fields_format } = req.body;
        
        // Validate premium_ratio
        if (premium_ratio !== undefined && premium_ratio !== null && premium_ratio !== '') {
            const ratio = parseFloat(premium_ratio);
            if (isNaN(ratio) || ratio < 0 || ratio > 100) {
                return res.status(400).json({ success: false, error: 'Premium ratio must be between 0 and 100' });
            }
        }
        
        // Validate daily_limit  
        if (daily_limit !== undefined && daily_limit !== null && daily_limit !== '') {
            const limit = parseInt(daily_limit);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ success: false, error: 'Daily limit must be at least 1' });
            }
        }
        
        // **NEW: Validate recovery_fields_format**
        if (recovery_fields_format && !['separate', 'notes'].includes(recovery_fields_format)) {
            return res.status(400).json({ success: false, error: 'Recovery fields format must be either "separate" or "notes"' });
        }
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio && premium_ratio !== '' ? (parseFloat(premium_ratio) / 100) : null;
        
        await pool.query(`
            UPDATE partners 
            SET name = $1, email = $2, country = $3, niche = $4, 
                daily_limit = $5, premium_ratio = $6, status = $7, timezone = $8, 
                recovery_fields_format = $9, updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
        `, [name, email, country, niche, daily_limit, ratioDecimal, status, timezone, recovery_fields_format || 'separate', id]);
        
        res.json({ success: true, message: 'Partner updated successfully' });
    } catch (error) {
        console.error('Partner update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update partner' });
    }
});

// Delete partner
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM partners WHERE id = $1', [id]);
        res.json({ success: true, message: 'Partner deleted successfully' });
    } catch (error) {
        console.error('Partner deletion error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete partner' });
    }
});

// CRM Integration endpoints  
router.get('/:id/crm-integration', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(
            'SELECT id, partner_id, crm_name, api_endpoint, auth_type, auth_config, auth_header, request_method, test_url, request_headers, field_mapping, is_active, created_at, updated_at, CASE WHEN api_key IS NOT NULL AND api_key != \'\' THEN true ELSE false END as api_key_set FROM partner_crm_integrations WHERE partner_id = $1',
            [id]
        );
        
        const integration = result.rows[0];
        
        // Mask sensitive data in auth_config for security
        if (integration && integration.auth_config) {
            const maskedConfig = { ...integration.auth_config };
            
            // Mask common sensitive fields
            if (maskedConfig.token) maskedConfig.token = '***masked***';
            if (maskedConfig.key) maskedConfig.key = '***masked***';
            if (maskedConfig.password) maskedConfig.password = '***masked***';
            if (maskedConfig.access_token) maskedConfig.access_token = '***masked***';
            if (maskedConfig.param_value) maskedConfig.param_value = '***masked***';
            if (maskedConfig.secret) maskedConfig.secret = '***masked***';
            if (maskedConfig.client_secret) maskedConfig.client_secret = '***masked***';
            
            // Mask custom headers that might contain secrets
            if (maskedConfig.headers) {
                Object.keys(maskedConfig.headers).forEach(key => {
                    if (key.toLowerCase().includes('token') || 
                        key.toLowerCase().includes('key') || 
                        key.toLowerCase().includes('auth')) {
                        maskedConfig.headers[key] = '***masked***';
                    }
                });
            }
            
            integration.auth_config = maskedConfig;
        }
        
        res.json({
            success: true,
            integration: integration || null
        });
    } catch (error) {
        console.error('Get CRM integration error:', error);
        res.status(500).json({ error: 'Failed to get CRM integration' });
    }
});

router.post('/:id/crm-integration', async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            crm_name, api_endpoint, request_method, field_mapping, is_active, test_url,
            auth_type, auth_config, request_headers
        } = req.body;
        
        console.log('=== CRM Integration Request ===');
        console.log('Partner ID:', id);
        console.log('Auth Type:', auth_type);
        console.log('CRM Name:', crm_name);
        
        // Validate API endpoint URL
        if (api_endpoint) {
            try {
                const url = new URL(api_endpoint);
                if (url.protocol !== 'https:') {
                    return res.status(400).json({ error: 'Only HTTPS endpoints are allowed' });
                }
            } catch (e) {
                return res.status(400).json({ error: 'Invalid API endpoint URL format' });
            }
        }
        
        // Validate request method
        const allowedMethods = ['POST', 'PUT'];
        if (request_method && !allowedMethods.includes(request_method.toUpperCase())) {
            return res.status(400).json({ error: 'Invalid request method. Only POST and PUT are allowed.' });
        }
        
        // Validate required fields
        if (!crm_name || !api_endpoint) {
            return res.status(400).json({ error: 'CRM name and API endpoint are required' });
        }
        
        // Validate auth_type if provided
        const { AUTH_TYPES } = require('../services/universalAuth');
        if (auth_type && !Object.values(AUTH_TYPES).includes(auth_type)) {
            return res.status(400).json({ 
                error: `Invalid auth_type. Must be one of: ${Object.values(AUTH_TYPES).join(', ')}` 
            });
        }
        
        // Check if integration already exists
        const existingResult = await pool.query(
            'SELECT id FROM partner_crm_integrations WHERE partner_id = $1',
            [id]
        );
        
        if (existingResult.rows.length > 0) {
            // Update existing integration with universal auth
            await pool.query(`
                UPDATE partner_crm_integrations 
                SET crm_name = $1, api_endpoint = $2, auth_type = $3, auth_config = $4,
                    request_method = $5, test_url = $6, request_headers = $7,
                    field_mapping = $8, is_active = $9, updated_at = CURRENT_TIMESTAMP
                WHERE partner_id = $10
            `, [
                crm_name, 
                api_endpoint, 
                auth_type || 'api_key', 
                JSON.stringify(auth_config || {}),
                request_method || 'POST',
                test_url,
                JSON.stringify(request_headers || {}),
                JSON.stringify(field_mapping || {}),
                is_active !== false, // Default to true
                id
            ]);
        } else {
            // Create new integration with universal auth
            await pool.query(`
                INSERT INTO partner_crm_integrations 
                (partner_id, crm_name, api_endpoint, auth_type, auth_config, request_method,
                 test_url, request_headers, field_mapping, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                id, 
                crm_name, 
                api_endpoint, 
                auth_type || 'api_key', 
                JSON.stringify(auth_config || {}),
                request_method || 'POST',
                test_url,
                JSON.stringify(request_headers || {}),
                JSON.stringify(field_mapping || {}),
                is_active !== false // Default to true
            ]);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Save CRM integration error:', error);
        console.error('Request body:', req.body);
        console.error('Partner ID:', id);
        res.status(500).json({ error: 'Failed to save CRM integration', details: error.message });
    }
});

router.post('/:id/test-crm', async (req, res) => {
    try {
        const { api_endpoint, auth_type, auth_config, request_method, test_payload } = req.body;
        
        // Basic SSRF protection - validate URL
        if (!api_endpoint || typeof api_endpoint !== 'string') {
            return res.json({ success: false, error: 'Invalid API endpoint' });
        }
        
        let url;
        try {
            url = new URL(api_endpoint);
        } catch (e) {
            return res.json({ success: false, error: 'Invalid URL format' });
        }
        
        // Only allow HTTPS and standard ports for security
        if (url.protocol !== 'https:') {
            return res.json({ success: false, error: 'Only HTTPS endpoints are allowed' });
        }
        
        // Block private IP ranges (basic protection)
        const hostname = url.hostname;
        if (hostname === 'localhost' || hostname.match(/^127\./) || 
            hostname.match(/^192\.168\./) || hostname.match(/^10\./) || 
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
            hostname.match(/^0\./) || hostname === '::1') {
            return res.json({ success: false, error: 'Private IP addresses not allowed' });
        }
        
        // Validate method - include GET for testing ping endpoints
        const allowedMethods = ['GET', 'POST', 'PUT'];
        if (!allowedMethods.includes(request_method?.toUpperCase())) {
            return res.json({ success: false, error: 'Invalid request method. Allowed: GET, POST, PUT' });
        }
        
        // Get CRM type or use field mapping to determine test payload format
        const { crm_type, field_mapping } = req.body;
        
        // Define different CRM test payload templates
        const crmTemplates = {
            'manticore': {
                first_name: 'John',
                last_name: 'Wick',
                birth_date: '1990-01-01',
                gender: 'M',
                country: 'Germany',
                city: 'Berlin',
                language: 'English',
                description: 'Test lead from Lead Distribution Platform',
                numbers: '+1234567890',
                emails: 'test@example.com'
            },
            'generic': {
                firstName: 'John',
                lastName: 'Doe',
                email: 'test@example.com',
                phone: '+1234567890',
                country: 'test',
                source: 'Lead Platform Test'
            },
            'salesforce': {
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'test@example.com',
                Phone: '+1234567890',
                Company: 'Test Company',
                LeadSource: 'API Test'
            },
            'hubspot': {
                properties: {
                    firstname: 'John',
                    lastname: 'Doe',
                    email: 'test@example.com',
                    phone: '+1234567890',
                    lifecyclestage: 'lead'
                }
            }
        };
        
        // Determine which template to use
        let testPayload;
        
        if (crm_type && crmTemplates[crm_type.toLowerCase()]) {
            // Use specific CRM template
            testPayload = crmTemplates[crm_type.toLowerCase()];
        } else if (field_mapping && field_mapping.trim()) {
            // Use field mapping to transform generic payload
            try {
                const mapping = JSON.parse(field_mapping);
                const genericData = {
                    firstName: 'John',
                    lastName: 'Doe',
                    email: 'test@example.com',
                    phone: '+1234567890',
                    country: 'Germany',
                    source: 'Lead Platform Test',
                    description: 'Test lead submission'
                };
                
                testPayload = {};
                Object.keys(mapping).forEach(targetField => {
                    const sourceField = mapping[targetField];
                    if (genericData[sourceField]) {
                        testPayload[targetField] = genericData[sourceField];
                    }
                });
                
                // Add some default fields if mapping is incomplete
                if (Object.keys(testPayload).length === 0) {
                    testPayload = crmTemplates.generic;
                }
            } catch (e) {
                // Fall back to generic if mapping is invalid
                testPayload = crmTemplates.generic;
            }
        } else {
            // Default to generic format
            testPayload = crmTemplates.generic;
        }
        
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Apply universal authentication if configured
        let testEndpoint = api_endpoint;
        if (auth_type && auth_config) {
            const { generateAuth } = require('../services/universalAuth');
            try {
                const authData = await generateAuth(auth_type, auth_config, api_endpoint);
                
                // Apply headers from universal auth
                if (authData.headers) {
                    Object.assign(headers, authData.headers);
                }
                
                // Apply query parameters if needed (for query_param auth)
                if (authData.params && Object.keys(authData.params).length > 0) {
                    const testUrl = new URL(api_endpoint);
                    Object.keys(authData.params).forEach(key => {
                        testUrl.searchParams.set(key, authData.params[key]);
                    });
                    testEndpoint = testUrl.toString();
                }
                
                console.log(`🔐 Test using ${auth_type} authentication`);
            } catch (authError) {
                console.error(`❌ Authentication setup failed:`, authError.message);
                return res.json({ 
                    success: false, 
                    error: `Authentication setup failed: ${authError.message}` 
                });
            }
        }
        
        const startTime = Date.now();
        const response = await axios({
            method: request_method.toLowerCase(),
            url: testEndpoint,
            headers: headers,
            data: testPayload,
            timeout: 10000,
            maxRedirects: 0, // Prevent redirect attacks
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        });
        
        if (response.status >= 200 && response.status < 400) {
            res.json({ 
                success: true, 
                status: response.status,
                statusText: response.statusText,
                message: `✅ Connection successful! HTTP ${response.status} - ${response.statusText}`,
                responseTime: Date.now() - startTime,
                responseHeaders: response.headers,
                responseData: typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500)
            });
        } else {
            res.json({ 
                success: false, 
                status: response.status,
                statusText: response.statusText,
                error: `❌ HTTP ${response.status}: ${response.statusText}`,
                responseTime: Date.now() - startTime,
                responseData: typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500)
            });
        }
    } catch (error) {
        console.error('Test CRM error:', error);
        let errorMessage = '❌ Connection failed';
        let errorDetails = error.message;
        
        if (error.code === 'ECONNABORTED') {
            errorMessage = '⏱️ Connection timeout (10 seconds)';
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = '🌐 DNS lookup failed - domain not found';
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = '🚫 Connection refused - server not accepting connections';
        } else if (error.response) {
            // Server responded with error status
            errorMessage = `❌ HTTP ${error.response.status}: ${error.response.statusText}`;
            errorDetails = error.response.data;
        }
        
        res.json({ 
            success: false, 
            error: errorMessage,
            details: errorDetails,
            status: error.response?.status || null,
            statusText: error.response?.statusText || null
        });
    }
});

// Status tracking endpoint for admin interface
router.get('/:id/status-tracking', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get partner summary stats
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(l.id) as total_leads,
                COUNT(CASE WHEN lsu.status = 'converted' THEN 1 END) as conversions,
                SUM(lsu.conversion_value) as total_revenue,
                AVG(lsu.quality_score) as avg_quality,
                CASE 
                    WHEN COUNT(l.id) > 0 THEN 
                        ROUND((COUNT(CASE WHEN lsu.status = 'converted' THEN 1 END)::decimal / COUNT(l.id) * 100), 2)
                    ELSE 0 
                END as conversion_rate
            FROM leads l
            LEFT JOIN lead_status_updates lsu ON l.id = lsu.lead_id
            WHERE l.assigned_partner_id = $1 
              AND l.created_at > NOW() - INTERVAL '30 days'
        `, [id]);
        
        // Get recent status updates
        const updatesResult = await pool.query(`
            SELECT lsu.*, l.email as lead_email
            FROM lead_status_updates lsu
            JOIN leads l ON lsu.lead_id = l.id
            WHERE lsu.partner_id = $1
            ORDER BY lsu.created_at DESC
            LIMIT 50
        `, [id]);
        
        // Get postback configuration
        const postbackResult = await pool.query(
            'SELECT postback_token, is_active FROM partner_postback_config WHERE partner_id = $1',
            [id]
        );
        
        res.json({
            success: true,
            summary: summaryResult.rows[0] || {},
            recent_updates: updatesResult.rows,
            postback_config: postbackResult.rows[0] || null
        });
        
    } catch (error) {
        console.error('Status tracking error:', error);
        res.status(500).json({ error: 'Failed to get status tracking data' });
    }
});

module.exports = router;