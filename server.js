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

// API endpoint for recent activity (missing endpoint fix)
app.get('/api/recent-activity', async (req, res) => {
    try {
        const recentActivity = await pool.query(`
            SELECT 
                'Lead ' || l.id || ' distributed to ' || p.name as description,
                l.distributed_at as time
            FROM leads l 
            JOIN partners p ON l.assigned_partner_id = p.id 
            WHERE l.distributed_at IS NOT NULL
            ORDER BY l.distributed_at DESC 
            LIMIT 5
        `);
        
        res.json(recentActivity.rows);
    } catch (error) {
        console.error('Recent activity error:', error);
        res.json([]);
    }
});

// Cron jobs
// Daily quota reset (runs at midnight UTC)
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

// Webhook retry cron job (every 5 minutes)
cron.schedule('*/5 * * * *', retryFailedWebhooks);

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Lead Distribution Platform running on http://0.0.0.0:${PORT}`);
    await initDatabase();
});

module.exports = { pool };