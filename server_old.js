const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const { pool, initDatabase } = require('./config/db');
const { retryFailedWebhooks } = require('./services/webhook');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Set view engine for server-side rendering
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Import routes
const partnerRoutes = require('./routes/partners');
const leadRoutes = require('./routes/leads');
const webhookRoutes = require('./routes/webhooks');
const analyticsRoutes = require('./routes/analytics');
const apiRoutes = require('./routes/api');

// Use routes
app.use('/partners', partnerRoutes);
app.use('/leads', leadRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/api', apiRoutes);

// Dashboard route
app.get('/', async (req, res) => {
    try {
        // Get dashboard stats
        const partnersQuery = await pool.query('SELECT COUNT(*) as count FROM partners WHERE status = $1', ['active']);
        const leadsQuery = await pool.query('SELECT COUNT(*) as count FROM leads WHERE created_at >= CURRENT_DATE');
        const conversionsQuery = await pool.query('SELECT COUNT(*) as count FROM conversions WHERE created_at >= CURRENT_DATE');
        
        const stats = {
            activePartners: partnersQuery.rows[0].count,
            todayLeads: leadsQuery.rows[0].count,
            todayConversions: conversionsQuery.rows[0].count
        };
        
        res.render('dashboard', { stats, title: 'Lead Distribution Dashboard' });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.render('dashboard', { 
            stats: { activePartners: 0, todayLeads: 0, todayConversions: 0 },
            title: 'Lead Distribution Dashboard',
            error: 'Unable to load dashboard stats'
        });
    }
});

// Database initialization
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
            webhook_token VARCHAR(255) UNIQUE NOT NULL,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `);
        
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

// Daily quota reset cron job (runs at midnight UTC)
cron.schedule('0 0 * * *', async () => {
    try {
        await pool.query(`
            INSERT INTO distribution_stats (partner_id, date, leads_received, premium_leads, raw_leads, conversions, revenue)
            SELECT id, CURRENT_DATE, 0, 0, 0, 0, 0.00 FROM partners WHERE status = 'active'
            ON CONFLICT (partner_id, date) DO NOTHING
        `);
        console.log('Daily stats reset completed');
    } catch (error) {
        console.error('Daily reset error:', error);
    }
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Lead Distribution Platform running on http://0.0.0.0:${PORT}`);
    await initDatabase();
});

// Export pool for use in routes
module.exports = { pool };