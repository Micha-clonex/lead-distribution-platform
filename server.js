const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');
require('dotenv').config();

const { pool, initDatabase } = require('./config/db');
const { retryFailedWebhooks } = require('./services/webhook');
const { requireAuth } = require('./middleware/auth');
const { pullPartnerStatuses } = require('./services/statusPuller');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
    store: new pgSession({
        pool: pool,
        createTableIfMissing: false,
        tableName: 'sessions'
    }),
    secret: process.env.SESSION_SECRET || 'your-fallback-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Make session data available to all templates
app.use((req, res, next) => {
    res.locals.currentUser = req.session?.adminUsername || null;
    res.locals.isLoggedIn = !!(req.session?.adminId);
    res.locals.currentPath = req.path;
    next();
});

// Set view engine for server-side rendering
app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');

// Import routes
const partnerRoutes = require('./routes/partners');
const leadRoutes = require('./routes/leads');
const webhookRoutes = require('./routes/webhooks');
const analyticsRoutes = require('./routes/analytics');
const alertsRoutes = require('./routes/alerts');
const qualityScoringRoutes = require('./routes/qualityScoring');
const businessHoursRoutes = require('./routes/businessHours');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

// Authentication routes (public)
app.use('/admin', authRoutes);

// Protected routes
app.use('/partners', requireAuth, partnerRoutes);
app.use('/leads', requireAuth, leadRoutes);
app.use('/webhooks', requireAuth, webhookRoutes);
app.use('/analytics', requireAuth, analyticsRoutes);
app.use('/alerts', requireAuth, alertsRoutes);
app.use('/quality', requireAuth, qualityScoringRoutes);
app.use('/business-hours', requireAuth, businessHoursRoutes);
app.use('/partner-management', requireAuth, require('./routes/partnerManagement'));
app.use('/monitoring', requireAuth, require('./routes/monitoring'));
app.use('/email-templates', requireAuth, require('./routes/emailTemplates'));
app.use('/api-settings', requireAuth, require('./routes/apiSettings'));
app.use('/profile', requireAuth, require('./routes/profile'));
app.use('/api', apiRoutes); // API routes handle their own auth

// Dashboard route (protected)
app.get('/', requireAuth, async (req, res) => {
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

// Failed leads retry cron job (every 10 minutes)
const { retryFailedLeads } = require('./services/distribution');
cron.schedule('*/10 * * * *', retryFailedLeads);

// Partner status pulling cron job (every 15 minutes)
cron.schedule('*/15 * * * *', pullPartnerStatuses);

// Automated partner management cron job (every 2 hours)
const partnerManager = require('./services/partnerManager');
cron.schedule('0 */2 * * *', async () => {
    console.log('🤖 Running automated partner management...');
    try {
        const summary = await partnerManager.runAutomatedManagement();
        console.log('✅ Automated partner management completed:', summary);
    } catch (error) {
        console.error('❌ Automated partner management failed:', error.message);
    }
});

// **NEW: Business Hours Scheduled Delivery Processing (every 2 minutes)**
cron.schedule('*/2 * * * *', async () => {
    try {
        const businessHoursIntelligence = require('./services/businessHoursIntelligence');
        const processedCount = await businessHoursIntelligence.processScheduledDeliveries();
        if (processedCount > 0) {
            console.log(`🕐 Processed ${processedCount} business hours scheduled deliveries`);
        }
    } catch (error) {
        console.error('❌ Business hours processing failed:', error.message);
    }
});

// **NEW: Email Marketing System - Initialize email scheduler**
const { initEmailScheduler } = require('./services/emailScheduler');
initEmailScheduler();

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Lead Distribution Platform running on http://0.0.0.0:${PORT}`);
    try {
        // Initialize main database tables first
        await initDatabase();
        
        // Initialize AlertSystem after main database is ready
        const alertSystem = require('./services/alertSystem');
        await alertSystem.initializeDatabase();
        
        console.log('✅ All database systems initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
        process.exit(1);
    }
});

module.exports = { pool };