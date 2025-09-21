const { pool } = require('../config/db');

// Phone number to country mapping (partial list - can be expanded)
const PHONE_COUNTRY_CODES = {
    '+49': { country: 'germany', country_code: 'DE' },
    '+43': { country: 'austria', country_code: 'AT' },
    '+34': { country: 'spain', country_code: 'ES' },
    '+1': { country: 'usa', country_code: 'US' }, // Can also be Canada
    '+39': { country: 'italy', country_code: 'IT' },
    '+44': { country: 'uk', country_code: 'GB' },
    '+47': { country: 'norway', country_code: 'NO' },
    '+33': { country: 'france', country_code: 'FR' },
    '+41': { country: 'switzerland', country_code: 'CH' },
    '+31': { country: 'netherlands', country_code: 'NL' }
};

// Email domain to country hints (basic heuristics)
const EMAIL_COUNTRY_HINTS = {
    '.de': 'germany',
    '.at': 'austria',
    '.es': 'spain',
    '.ca': 'canada',
    '.it': 'italy',
    '.co.uk': 'uk',
    '.uk': 'uk',
    '.no': 'norway'
};

/**
 * Enriches basic lead data with derived and default values
 */
async function enrichLeadData(basicLeadData, sourceInfo, partnerId = null) {
    const enriched = { ...basicLeadData };
    
    try {
        // 1. **Phone Number Enrichment** - Extract country from phone
        if (enriched.phone && !enriched.country) {
            const phoneCountry = extractCountryFromPhone(enriched.phone);
            if (phoneCountry) {
                enriched.country = phoneCountry.country;
                enriched.country_code = phoneCountry.country_code;
                enriched.phone_country_code = phoneCountry.phone_code;
            }
        }
        
        // 2. **Email Domain Enrichment** - Hint from email domain
        if (enriched.email && !enriched.country) {
            const emailCountry = extractCountryFromEmail(enriched.email);
            if (emailCountry) {
                enriched.country = emailCountry;
            }
        }
        
        // 3. **Source Tracking** - Add proper source information
        enriched.original_source = sourceInfo?.name || 'unknown';
        enriched.source_type = sourceInfo?.source_type || 'webhook';
        enriched.landing_page_url = basicLeadData.landing_page_url || basicLeadData.page_url;
        enriched.utm_source = basicLeadData.utm_source;
        enriched.utm_campaign = basicLeadData.utm_campaign;
        enriched.utm_medium = basicLeadData.utm_medium;
        
        // 4. **Partner-Specific Defaults** - Get partner's default values if needed
        if (partnerId) {
            const partnerDefaults = await getPartnerDefaults(partnerId);
            
            // Apply partner defaults only for missing fields
            if (!enriched.country && partnerDefaults.default_country) {
                enriched.country = partnerDefaults.default_country;
            }
            if (!enriched.country_code && partnerDefaults.default_country_code) {
                enriched.country_code = partnerDefaults.default_country_code;
            }
        }
        
        // 5. **Data Validation & Cleanup**
        enriched.phone = cleanPhoneNumber(enriched.phone);
        enriched.email = cleanEmail(enriched.email);
        enriched.first_name = cleanName(enriched.first_name);
        enriched.last_name = cleanName(enriched.last_name);
        
        // 6. **Lead Quality Scoring** - Basic scoring
        enriched.data_completeness_score = calculateDataCompleteness(enriched);
        
        // 7. **Timezone Detection** - Based on country
        if (enriched.country) {
            enriched.timezone = getTimezoneFromCountry(enriched.country);
        }
        
        console.log(`Lead enriched: ${Object.keys(basicLeadData).length} → ${Object.keys(enriched).length} fields`);
        return enriched;
        
    } catch (error) {
        console.error('Data enrichment error:', error);
        return basicLeadData; // Return original data if enrichment fails
    }
}

function extractCountryFromPhone(phone) {
    if (!phone) return null;
    
    // Clean phone number
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    
    // Check against known country codes
    for (const [code, info] of Object.entries(PHONE_COUNTRY_CODES)) {
        if (cleanPhone.startsWith(code)) {
            return {
                country: info.country,
                country_code: info.country_code,
                phone_code: code
            };
        }
    }
    
    return null;
}

function extractCountryFromEmail(email) {
    if (!email) return null;
    
    const domain = email.toLowerCase();
    for (const [tld, country] of Object.entries(EMAIL_COUNTRY_HINTS)) {
        if (domain.includes(tld)) {
            return country;
        }
    }
    
    return null;
}

async function getPartnerDefaults(partnerId) {
    try {
        const result = await pool.query(`
            SELECT default_country, default_country_code, required_fields, optional_fields
            FROM partner_crm_integrations 
            WHERE partner_id = $1 AND is_active = true
        `, [partnerId]);
        
        return result.rows[0] || {};
    } catch (error) {
        console.error('Error getting partner defaults:', error);
        return {};
    }
}

function cleanPhoneNumber(phone) {
    if (!phone) return phone;
    
    // Remove extra spaces, dashes, parentheses
    return phone.replace(/[^\d+]/g, '').replace(/^00/, '+');
}

function cleanEmail(email) {
    if (!email) return email;
    return email.toLowerCase().trim();
}

function cleanName(name) {
    if (!name) return name;
    
    // Capitalize first letter, handle basic cleanup
    return name.trim()
        .toLowerCase()
        .replace(/^\w/, c => c.toUpperCase());
}

function calculateDataCompleteness(data) {
    const essentialFields = ['first_name', 'last_name', 'email', 'phone'];
    const additionalFields = ['country', 'country_code', 'source_type'];
    
    let score = 0;
    
    // Essential fields (70 points)
    essentialFields.forEach(field => {
        if (data[field] && data[field].length > 0) {
            score += 17.5;
        }
    });
    
    // Additional fields (30 points)
    additionalFields.forEach(field => {
        if (data[field] && data[field].length > 0) {
            score += 10;
        }
    });
    
    return Math.round(score);
}

function getTimezoneFromCountry(country) {
    const timezones = {
        'germany': 'Europe/Berlin',
        'austria': 'Europe/Vienna',
        'spain': 'Europe/Madrid',
        'canada': 'America/Toronto',
        'italy': 'Europe/Rome',
        'uk': 'Europe/London',
        'norway': 'Europe/Oslo',
        'france': 'Europe/Paris',
        'switzerland': 'Europe/Zurich'
    };
    
    return timezones[country] || 'UTC';
}

/**
 * Prepares enriched data for specific partner based on their requirements
 */
async function prepareDataForPartner(enrichedData, partnerId) {
    try {
        // Get partner's CRM configuration
        const crmResult = await pool.query(`
            SELECT field_mapping, required_fields, optional_fields, auto_enrich_data
            FROM partner_crm_integrations 
            WHERE partner_id = $1 AND is_active = true
        `, [partnerId]);
        
        if (crmResult.rows.length === 0) {
            return enrichedData; // No specific requirements
        }
        
        const config = crmResult.rows[0];
        const fieldMapping = typeof config.field_mapping === 'string' 
            ? JSON.parse(config.field_mapping) 
            : (config.field_mapping || {});
        
        // Apply field mapping
        const mappedData = {};
        
        for (const [ourField, theirField] of Object.entries(fieldMapping)) {
            if (enrichedData[ourField] !== undefined) {
                mappedData[theirField] = enrichedData[ourField];
            }
        }
        
        // Add any missing required fields with defaults
        const requiredFields = Array.isArray(config.required_fields) ? config.required_fields : [];
        requiredFields.forEach(field => {
            if (!mappedData[field]) {
                mappedData[field] = getDefaultValue(field, enrichedData);
            }
        });
        
        return mappedData;
        
    } catch (error) {
        console.error('Error preparing data for partner:', error);
        return enrichedData;
    }
}

function getDefaultValue(field, data) {
    const defaults = {
        'source': 'Lead Distribution Platform',
        'country': 'unknown',
        'country_code': 'XX',
        'phone_country_code': '+1',
        'lead_type': 'web_form',
        'campaign': 'direct',
        'timestamp': new Date().toISOString()
    };
    
    return defaults[field] || 'N/A';
}

module.exports = {
    enrichLeadData,
    prepareDataForPartner,
    extractCountryFromPhone,
    extractCountryFromEmail
};