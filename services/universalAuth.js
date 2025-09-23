const axios = require('axios');

/**
 * Universal Authentication System
 * Handles ANY authentication method partners might use
 */

const AUTH_TYPES = {
    BEARER_TOKEN: 'bearer_token',
    API_KEY: 'api_key', 
    BASIC_AUTH: 'basic_auth',
    CUSTOM_HEADER: 'custom_header',
    QUERY_PARAM: 'query_param',
    OAUTH2: 'oauth2',
    CUSTOM: 'custom'
};

/**
 * Generate authentication headers and URL parameters based on auth config
 * @param {string} authType - Type of authentication
 * @param {object} authConfig - Authentication configuration
 * @param {string} apiEndpoint - Base API endpoint
 * @returns {object} { headers, url, isValid }
 */
function generateAuth(authType, authConfig, apiEndpoint) {
    const result = {
        headers: {},
        url: apiEndpoint,
        isValid: false,
        error: null
    };

    try {
        switch (authType) {
            case AUTH_TYPES.BEARER_TOKEN:
                if (!authConfig.token) {
                    result.error = 'Bearer token is required';
                    return result;
                }
                result.headers['Authorization'] = `Bearer ${authConfig.token}`;
                result.isValid = true;
                break;

            case AUTH_TYPES.API_KEY:
                if (!authConfig.key || !authConfig.header_name) {
                    result.error = 'API key and header name are required';
                    return result;
                }
                result.headers[authConfig.header_name] = authConfig.key;
                result.isValid = true;
                break;

            case AUTH_TYPES.BASIC_AUTH:
                if (!authConfig.username || !authConfig.password) {
                    result.error = 'Username and password are required for Basic Auth';
                    return result;
                }
                const credentials = Buffer.from(`${authConfig.username}:${authConfig.password}`).toString('base64');
                result.headers['Authorization'] = `Basic ${credentials}`;
                result.isValid = true;
                break;

            case AUTH_TYPES.CUSTOM_HEADER:
                if (!authConfig.headers || typeof authConfig.headers !== 'object') {
                    result.error = 'Custom headers object is required';
                    return result;
                }
                Object.assign(result.headers, authConfig.headers);
                result.isValid = true;
                break;

            case AUTH_TYPES.QUERY_PARAM:
                if (!authConfig.param_name || !authConfig.param_value) {
                    result.error = 'Query parameter name and value are required';
                    return result;
                }
                const url = new URL(apiEndpoint);
                url.searchParams.set(authConfig.param_name, authConfig.param_value);
                result.url = url.toString();
                result.isValid = true;
                break;

            case AUTH_TYPES.OAUTH2:
                if (!authConfig.access_token) {
                    result.error = 'OAuth2 access token is required';
                    return result;
                }
                result.headers['Authorization'] = `Bearer ${authConfig.access_token}`;
                result.isValid = true;
                break;

            case AUTH_TYPES.CUSTOM:
                // For completely custom auth methods
                if (authConfig.headers) {
                    Object.assign(result.headers, authConfig.headers);
                }
                if (authConfig.url_params) {
                    const url = new URL(apiEndpoint);
                    Object.entries(authConfig.url_params).forEach(([key, value]) => {
                        url.searchParams.set(key, value);
                    });
                    result.url = url.toString();
                }
                result.isValid = true;
                break;

            default:
                result.error = `Unsupported authentication type: ${authType}`;
                return result;
        }

        // Add any additional headers from request_headers
        if (authConfig.additional_headers) {
            Object.assign(result.headers, authConfig.additional_headers);
        }

    } catch (error) {
        result.error = `Authentication generation failed: ${error.message}`;
        return result;
    }

    return result;
}

/**
 * Test API authentication by making a test request
 * @param {string} authType - Authentication type
 * @param {object} authConfig - Authentication configuration  
 * @param {string} apiEndpoint - API endpoint to test
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {object} testPayload - Test payload for POST requests
 * @returns {object} Test result
 */
async function testAuthentication(authType, authConfig, apiEndpoint, method = 'GET', testPayload = null) {
    const result = {
        success: false,
        statusCode: null,
        response: null,
        error: null,
        authValid: false
    };

    try {
        // Generate authentication
        const auth = generateAuth(authType, authConfig, apiEndpoint);
        
        if (!auth.isValid) {
            result.error = auth.error;
            return result;
        }

        // Prepare request config
        const requestConfig = {
            method: method.toUpperCase(),
            url: auth.url,
            headers: {
                'Content-Type': 'application/json',
                ...auth.headers
            },
            timeout: 10000, // 10 second timeout
            validateStatus: () => true // Don't throw on HTTP errors
        };

        // Add payload for POST/PUT requests
        if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && testPayload) {
            requestConfig.data = testPayload;
        }

        // Make the test request
        const response = await axios(requestConfig);
        
        result.statusCode = response.status;
        result.response = response.data;

        // Consider authentication successful for 2xx, 400 (bad request data), and 422 (validation errors)
        // These indicate the auth worked, even if the request itself had issues
        if (response.status >= 200 && response.status < 300) {
            result.success = true;
            result.authValid = true;
        } else if (response.status === 400 || response.status === 422) {
            // Auth likely worked, but request data was invalid
            result.authValid = true;
            result.error = `Request data issue (${response.status}): ${JSON.stringify(response.data)}`;
        } else if (response.status === 401 || response.status === 403) {
            result.authValid = false;
            result.error = `Authentication failed (${response.status}): ${JSON.stringify(response.data)}`;
        } else {
            result.error = `Request failed (${response.status}): ${JSON.stringify(response.data)}`;
        }

    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            result.error = 'Request timeout - API endpoint may be slow or unreachable';
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            result.error = 'API endpoint unreachable - check URL';
        } else {
            result.error = `Test request failed: ${error.message}`;
        }
    }

    return result;
}

/**
 * Create authentication configuration templates for common scenarios
 */
const AUTH_TEMPLATES = {
    [AUTH_TYPES.BEARER_TOKEN]: {
        name: 'Bearer Token',
        description: 'Uses Authorization: Bearer {token}',
        config_template: {
            token: '{YOUR_BEARER_TOKEN}'
        },
        example: 'Authorization: Bearer abc123xyz'
    },
    
    [AUTH_TYPES.API_KEY]: {
        name: 'API Key (Custom Header)',
        description: 'Uses custom header name with API key',
        config_template: {
            header_name: 'X-API-Key',
            key: '{YOUR_API_KEY}'
        },
        example: 'X-API-Key: your-secret-key-here'
    },
    
    [AUTH_TYPES.BASIC_AUTH]: {
        name: 'Basic Authentication',
        description: 'Uses username:password encoded in Authorization header',
        config_template: {
            username: '{USERNAME}',
            password: '{PASSWORD}'
        },
        example: 'Authorization: Basic dXNlcjpwYXNz'
    },
    
    [AUTH_TYPES.CUSTOM_HEADER]: {
        name: 'Custom Headers',
        description: 'Any custom headers needed by the API',
        config_template: {
            headers: {
                'X-Custom-Auth': '{VALUE}',
                'X-Client-ID': '{CLIENT_ID}'
            }
        },
        example: 'X-Custom-Auth: secret, X-Client-ID: client123'
    },
    
    [AUTH_TYPES.QUERY_PARAM]: {
        name: 'Query Parameter',
        description: 'Authentication via URL query parameter',
        config_template: {
            param_name: 'token',
            param_value: '{YOUR_TOKEN}'
        },
        example: '?token=your-token-here'
    }
};

/**
 * Get authentication template by type
 * @param {string} authType - Authentication type
 * @returns {object} Template configuration
 */
function getAuthTemplate(authType) {
    return AUTH_TEMPLATES[authType] || null;
}

/**
 * Get all available authentication types and templates
 * @returns {object} All auth types with templates
 */
function getAllAuthTypes() {
    return {
        types: AUTH_TYPES,
        templates: AUTH_TEMPLATES
    };
}

/**
 * Merge auth config while preserving existing secrets
 * @param {string} authType - Authentication type
 * @param {object} newConfig - New configuration to merge
 * @param {object} existingConfig - Existing configuration with potential secrets
 * @returns {object} Merged configuration preserving secrets
 */
function mergeAuthConfigPreservingSecrets(authType, newConfig, existingConfig) {
    // If no existing config, return new config
    if (!existingConfig) {
        return newConfig;
    }

    const merged = { ...existingConfig };

    // Only update non-empty fields from new config
    for (const [key, value] of Object.entries(newConfig)) {
        if (value !== '' && value !== null && value !== undefined) {
            merged[key] = value;
        }
    }

    return merged;
}

module.exports = {
    AUTH_TYPES,
    generateAuth,
    testAuthentication,
    getAuthTemplate,
    getAllAuthTypes,
    mergeAuthConfigPreservingSecrets
};