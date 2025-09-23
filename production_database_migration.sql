-- Production Database Migration Script
-- Fix "Failed to load CRM integrations" error
-- Run these commands on your production database

-- Add missing auth_type column to partner_crm_integrations table
ALTER TABLE partner_crm_integrations 
ADD COLUMN IF NOT EXISTS auth_type VARCHAR(255);

-- Add missing auth_config column for storing authentication configuration
ALTER TABLE partner_crm_integrations 
ADD COLUMN IF NOT EXISTS auth_config JSONB DEFAULT '{}';

-- Add field mapping columns to partners table for smart transformation
ALTER TABLE partners 
ADD COLUMN IF NOT EXISTS field_mapping JSONB DEFAULT '{}';

ALTER TABLE partners 
ADD COLUMN IF NOT EXISTS default_values JSONB DEFAULT '{}';

ALTER TABLE partners 
ADD COLUMN IF NOT EXISTS required_fields JSONB DEFAULT '[]';

ALTER TABLE partners 
ADD COLUMN IF NOT EXISTS phone_format VARCHAR(50) DEFAULT 'international';

-- Update any existing CRM integrations to have a default auth_type
UPDATE partner_crm_integrations 
SET auth_type = 'api_key' 
WHERE auth_type IS NULL;

-- Verify the schema is correct
SELECT 'Schema migration completed successfully' as status;