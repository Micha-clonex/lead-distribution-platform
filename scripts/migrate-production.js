#!/usr/bin/env node

/**
 * Production Database Migration Script - BULLETPROOF VERSION
 * Runs automatically during Render deployment
 * Ensures database schema is up-to-date before starting the application
 * Fixed SSL configuration and error handling
 */

const { Pool } = require('pg');
require('dotenv').config();

// Use same SSL configuration as main app for consistency
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('postgres://') ? { rejectUnauthorized: false } : false,
    max: 2,
    min: 1,
    connectionTimeoutMillis: 15000,
    acquireTimeoutMillis: 20000,
    application_name: 'migration_script'
});

async function runMigrations() {
    const client = await pool.connect();
    
    try {
        console.log('🔄 Starting production database migrations...');
        
        // Add missing auth_type column to partner_crm_integrations table
        await client.query(`
            ALTER TABLE partner_crm_integrations 
            ADD COLUMN IF NOT EXISTS auth_type VARCHAR(255)
        `);
        console.log('✅ Added auth_type column to partner_crm_integrations');

        // Add missing auth_config column for storing authentication configuration
        await client.query(`
            ALTER TABLE partner_crm_integrations 
            ADD COLUMN IF NOT EXISTS auth_config JSONB DEFAULT '{}'
        `);
        console.log('✅ Added auth_config column to partner_crm_integrations');

        // Add field mapping columns to partners table for smart transformation
        await client.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS field_mapping JSONB DEFAULT '{}'
        `);
        console.log('✅ Added field_mapping column to partners');

        await client.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS default_values JSONB DEFAULT '{}'
        `);
        console.log('✅ Added default_values column to partners');

        await client.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS required_fields JSONB DEFAULT '[]'
        `);
        console.log('✅ Added required_fields column to partners');

        await client.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS phone_format VARCHAR(50) DEFAULT 'with_plus'
        `);
        console.log('✅ Added phone_format column to partners');

        // Update any existing CRM integrations to have a default auth_type
        const updateResult = await client.query(`
            UPDATE partner_crm_integrations 
            SET auth_type = 'api_key' 
            WHERE auth_type IS NULL
        `);
        console.log(`✅ Updated ${updateResult.rowCount} CRM integrations with default auth_type`);

        // BULLETPROOF VERIFICATION: Check all critical columns exist
        const criticalColumns = [
            { table: 'partners', column: 'phone_format' },
            { table: 'partners', column: 'field_mapping' },
            { table: 'partners', column: 'default_values' },
            { table: 'partners', column: 'required_fields' },
            { table: 'partners', column: 'auth_type' },
            { table: 'partners', column: 'auth_config' }
        ];
        
        for (const { table, column } of criticalColumns) {
            const result = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = $1 AND column_name = $2
            `, [table, column]);
            
            if (result.rows.length === 0) {
                throw new Error(`Critical column ${table}.${column} missing after migration!`);
            }
            console.log(`✅ Verified ${table}.${column} exists`);
        }
        
        console.log('🎉 Production database migration completed successfully!');
        console.log('🔍 All critical columns verified and ready for production!');
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

// Only run if this script is executed directly
if (require.main === module) {
    runMigrations()
        .then(() => {
            console.log('🚀 Ready for production deployment!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration script failed:', error);
            process.exit(1);
        });
}

module.exports = { runMigrations };