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
        
        // **NEW: Add recovery field formatting preferences to partners**
        await pool.query(`
            ALTER TABLE partners 
            ADD COLUMN IF NOT EXISTS recovery_fields_format VARCHAR(20) DEFAULT 'separate' CHECK (recovery_fields_format IN ('separate', 'notes'))
        `);
        
        // Backfill partners with default recovery field format
        await pool.query(`
            UPDATE partners 
            SET recovery_fields_format = 'separate' 
            WHERE recovery_fields_format IS NULL
        `);
        
        // **NEW: Email marketing system tables**
        await pool.query(`
            -- Email templates table
            CREATE TABLE IF NOT EXISTS email_templates (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                subject VARCHAR(500) NOT NULL,
                html_content TEXT NOT NULL,
                text_content TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Email queue for delayed sending
            CREATE TABLE IF NOT EXISTS email_queue (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
                email_address VARCHAR(255) NOT NULL,
                template_id INTEGER REFERENCES email_templates(id),
                scheduled_at TIMESTAMP NOT NULL,
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
                attempts INTEGER DEFAULT 0,
                last_attempt_at TIMESTAMP,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Email sending log
            CREATE TABLE IF NOT EXISTS email_logs (
                id SERIAL PRIMARY KEY,
                queue_id INTEGER REFERENCES email_queue(id),
                email_address VARCHAR(255) NOT NULL,
                template_name VARCHAR(255),
                subject VARCHAR(500),
                status VARCHAR(20) NOT NULL,
                message_id VARCHAR(255),
                response_data JSONB,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Indexes for email performance
            CREATE INDEX IF NOT EXISTS idx_email_queue_status_scheduled ON email_queue(status, scheduled_at);
            CREATE INDEX IF NOT EXISTS idx_email_queue_lead ON email_queue(lead_id);
            CREATE INDEX IF NOT EXISTS idx_email_logs_sent_at ON email_logs(sent_at);
            
            -- Unique constraint for ON CONFLICT clause in email scheduling
            CREATE UNIQUE INDEX IF NOT EXISTS idx_email_queue_lead_template_unique ON email_queue(lead_id, template_id);
        `);
        
        // **NEW: API Settings table for managing external service credentials**
        await pool.query(`
            CREATE TABLE IF NOT EXISTS api_settings (
                id SERIAL PRIMARY KEY,
                service_name VARCHAR(100) NOT NULL UNIQUE,
                service_type VARCHAR(50) NOT NULL,
                settings JSONB NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_api_settings_service_type ON api_settings(service_type);
            CREATE INDEX IF NOT EXISTS idx_api_settings_active ON api_settings(is_active);
        `);
        
        // Insert default promotional email template using parameterized query
        try {
            await pool.query(`
                INSERT INTO email_templates (name, subject, html_content, text_content, is_active)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (name) DO NOTHING
            `, [
                'promotional_default',
                'Exclusive Trading Opportunity - Don\'t Miss Out!',
                `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="margin: 0; font-size: 28px;">Special Trading Opportunity</h1>
                        <p style="margin: 10px 0 0; font-size: 16px; opacity: 0.9;">Exclusive access to premium trading signals</p>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                        <h2 style="color: #333; margin-top: 0;">Hello {{first_name}},</h2>
                        <p style="color: #666; line-height: 1.6; font-size: 16px;">
                            We noticed you recently showed interest in trading opportunities. We have an exclusive offer that could significantly boost your trading success!
                        </p>
                        <div style="background: #f8f9fa; padding: 20px; border-left: 4px solid #667eea; margin: 20px 0;">
                            <h3 style="color: #667eea; margin-top: 0;">What you get:</h3>
                            <ul style="color: #666; line-height: 1.8;">
                                <li>🎯 Premium trading signals with 85% accuracy</li>
                                <li>📈 Real-time market analysis and insights</li>
                                <li>💰 Potential returns of up to 200% monthly</li>
                                <li>🔒 Risk management strategies</li>
                                <li>📞 24/7 personal trading support</li>
                            </ul>
                        </div>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="#" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; display: inline-block; font-weight: bold; font-size: 18px;">
                                🚀 Start Trading Now
                            </a>
                        </div>
                        <p style="color: #666; line-height: 1.6; font-size: 14px;">
                            <strong>Limited Time:</strong> This exclusive offer is only available for the next 48 hours. Don't miss your chance to join thousands of successful traders!
                        </p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                        <p style="color: #999; font-size: 12px; text-align: center;">
                            If you no longer wish to receive these emails, you can <a href="#" style="color: #667eea;">unsubscribe here</a>.
                        </p>
                    </div>
                </div>`,
                `Hello {{first_name}},

We noticed you recently showed interest in trading opportunities. We have an exclusive offer that could significantly boost your trading success!

WHAT YOU GET:
• Premium trading signals with 85% accuracy
• Real-time market analysis and insights  
• Potential returns of up to 200% monthly
• Risk management strategies
• 24/7 personal trading support

LIMITED TIME: This exclusive offer is only available for the next 48 hours. Don't miss your chance to join thousands of successful traders!

Start Trading Now: [LINK]

If you no longer wish to receive these emails, you can unsubscribe here.`,
                true
            ]);
        } catch (error) {
            // Ignore duplicate key errors
            if (error.code !== '23505') {
                throw error;
            }
        }
        
        console.log('Database tables initialized successfully');
        return true;
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
}

module.exports = { pool, initDatabase };