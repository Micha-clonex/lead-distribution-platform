const { Pool } = require('pg');
require('dotenv').config();

// Database connection singleton
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database initialization function
async function initDatabase() {
    try {
        await pool.query(`
        CREATE TABLE IF NOT EXISTS partners (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            country VARCHAR(50) NOT NULL,
            niche VARCHAR(50) NOT NULL CHECK (niche IN ('forex', 'recovery')),
            webhook_url TEXT NOT NULL,
            daily_limit INTEGER DEFAULT 50,
            premium_ratio DECIMAL(3,2) DEFAULT 0.70,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused')),
            timezone VARCHAR(50) DEFAULT 'UTC',
            business_hours_start TIME DEFAULT '09:00:00',
            business_hours_end TIME DEFAULT '18:00:00',
            weekends_enabled BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS leads (
            id SERIAL PRIMARY KEY,
            source VARCHAR(100) NOT NULL,
            type VARCHAR(20) NOT NULL CHECK (type IN ('premium', 'raw')),
            niche VARCHAR(50) NOT NULL CHECK (niche IN ('forex', 'recovery')),
            country VARCHAR(50) NOT NULL,
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            email VARCHAR(255),
            phone VARCHAR(50),
            data JSONB,
            status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'distributed', 'converted', 'failed')),
            assigned_partner_id INTEGER REFERENCES partners(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            distributed_at TIMESTAMP,
            converted_at TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES leads(id),
            partner_id INTEGER REFERENCES partners(id),
            webhook_url TEXT NOT NULL,
            payload JSONB,
            response_code INTEGER,
            response_body TEXT,
            attempts INTEGER DEFAULT 1,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            delivered_at TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS distribution_stats (
            id SERIAL PRIMARY KEY,
            partner_id INTEGER REFERENCES partners(id),
            date DATE DEFAULT CURRENT_DATE,
            leads_received INTEGER DEFAULT 0,
            premium_leads INTEGER DEFAULT 0,
            raw_leads INTEGER DEFAULT 0,
            conversions INTEGER DEFAULT 0,
            revenue DECIMAL(10,2) DEFAULT 0.00,
            UNIQUE(partner_id, date)
        );
        
        CREATE TABLE IF NOT EXISTS conversions (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES leads(id),
            partner_id INTEGER REFERENCES partners(id),
            conversion_value DECIMAL(10,2),
            conversion_data JSONB,
            postback_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS webhook_sources (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            source_type VARCHAR(50) NOT NULL,
            country VARCHAR(50) NOT NULL,
            niche VARCHAR(50) NOT NULL CHECK (niche IN ('forex', 'recovery')),
            description TEXT,
            webhook_token VARCHAR(255) UNIQUE NOT NULL,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS sessions (
            sid VARCHAR NOT NULL COLLATE "default",
            sess JSON NOT NULL,
            expire TIMESTAMP(6) NOT NULL
        ) WITH (OIDS=FALSE);
        
        -- Create indexes for performance
        CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_niche_country ON leads(niche, country);
        CREATE INDEX IF NOT EXISTS idx_partners_country_niche ON partners(country, niche, status);
        CREATE INDEX IF NOT EXISTS idx_distribution_stats_date ON distribution_stats(date);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
        
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_session_sid" ON sessions ("sid" COLLATE "default");
        CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON sessions ("expire");
        
        -- Partner Management Log table for automated partner management  
        CREATE TABLE IF NOT EXISTS partner_management_log (
            id SERIAL PRIMARY KEY,
            partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
            action VARCHAR(50) NOT NULL CHECK (action IN ('auto_pause', 'auto_resume', 'manual_pause', 'manual_resume', 'performance_review')),
            reason TEXT,
            metrics JSONB,
            admin_user VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_partner_management_log_partner ON partner_management_log(partner_id);
        CREATE INDEX IF NOT EXISTS idx_partner_management_log_action ON partner_management_log(action);
        CREATE INDEX IF NOT EXISTS idx_partner_management_log_created ON partner_management_log(created_at);
        
        -- Performance indexes for Live Monitoring Dashboard
        CREATE INDEX IF NOT EXISTS idx_leads_created_status ON leads(created_at, status);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_status ON webhook_deliveries(created_at, status);
        CREATE INDEX IF NOT EXISTS idx_system_alerts_created_severity ON system_alerts(created_at, severity, resolved);
        
        -- Scheduled Deliveries table for Business Hours Intelligence
        CREATE TABLE IF NOT EXISTS scheduled_deliveries (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
            partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
            scheduled_time TIMESTAMP NOT NULL,
            status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'delivered', 'cancelled', 'failed')),
            reason TEXT,
            attempts INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(lead_id, partner_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_status_time ON scheduled_deliveries(status, scheduled_time);
        CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_partner ON scheduled_deliveries(partner_id, status);
        CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_lead ON scheduled_deliveries(lead_id, status);
        `);
        
        // **CRITICAL**: Safe schema migration for existing deployments
        await pool.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS weekends_enabled BOOLEAN DEFAULT false
        `);
        
        // Backfill any NULL values to false for data consistency
        await pool.query(`
            UPDATE partners 
            SET weekends_enabled = false 
            WHERE weekends_enabled IS NULL
        `);
        
        // **CRITICAL**: Add lead_type to webhook_sources for premium/raw identification
        await pool.query(`
            ALTER TABLE webhook_sources 
            ADD COLUMN IF NOT EXISTS lead_type VARCHAR(20) DEFAULT 'raw' CHECK (lead_type IN ('premium', 'raw'))
        `);
        
        // Backfill existing webhook sources with appropriate defaults
        await pool.query(`
            UPDATE webhook_sources 
            SET lead_type = CASE 
                WHEN source_type = 'landing_page' THEN 'premium'
                ELSE 'raw'
            END
            WHERE lead_type IS NULL
        `);
        
        console.log('Database tables initialized successfully');
        return true;
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
}

module.exports = { pool, initDatabase };