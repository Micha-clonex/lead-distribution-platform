const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
// Remove PostgreSQL session dependency for stability
// const pgSession = require('connect-pg-simple')(session);
const expressLayouts = require('express-ejs-layouts');
require('dotenv').config();

const { pool, initDatabase, getPoolHealth, testConnection } = require('./config/db');
const { initRedis, getRedisHealth } = require('./config/redis');
const { requestLogger } = require('./utils/logger');
const { retryFailedWebhooks } = require('./services/webhook');
const { requireAuth } = require('./middleware/auth');
const { pullPartnerStatuses } = require('./services/statusPuller');

const app = express();
const PORT = process.env.PORT || 5000;

// Add structured logging middleware early
app.use(requestLogger);

// Add response completion logging
app.use((req, res, next) => {
    const originalSend = res.send;
    const startTime = Date.now();
    
    res.send = function(body) {
        const duration = Date.now() - startTime;
        req.logger.info('Request completed', {
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration_ms: duration,
            contentLength: body ? body.length : 0
        });
        return originalSend.call(this, body);
    };
    
    next();
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Disable caching for dynamic content to prevent browser cache issues
app.use((req, res, next) => {
    // Set cache control headers for EJS pages and API responses
    if (req.path.startsWith('/partners') || req.path.startsWith('/webhooks') || 
        req.path.startsWith('/leads') || req.path.startsWith('/analytics') || 
        req.path.includes('/api/')) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

// Session configuration - Using signed cookies for stability (no DB dependency)
app.use(session({
    // No store = uses memory store (signed cookies)
    secret: process.env.SESSION_SECRET || 'your-fallback-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    name: 'lead.session' // Custom session name
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
// const crmIntegrationsRoutes = require('./routes/crmIntegrations'); // Disabled - causing production errors
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

// Authentication routes (public)
app.use('/admin', authRoutes);

// Health check endpoint (public, no auth required)
app.get('/health', async (req, res) => {
    try {
        const startTime = Date.now();
        
        // Test database connectivity
        let dbStatus = 'unknown';
        let dbLatency = 0;
        let poolHealth = null;
        
        try {
            const dbStart = Date.now();
            await testConnection(1); // Quick connection test
            dbLatency = Date.now() - dbStart;
            dbStatus = 'connected';
            poolHealth = await getPoolHealth();
        } catch (dbError) {
            dbStatus = 'error';
            console.error('Health check DB error:', dbError.message);
        }

        // Test Redis connectivity
        const redisHealth = await getRedisHealth();
        
        const totalTime = Date.now() - startTime;
        
        const health = {
            status: dbStatus === 'connected' ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: {
                status: dbStatus,
                latency_ms: dbLatency,
                pool: poolHealth
            },
            redis: redisHealth,
            response_time_ms: totalTime,
            environment: process.env.NODE_ENV || 'development'
        };
        
        const statusCode = health.status === 'healthy' ? 200 : 503;
        res.status(statusCode).json(health);
        
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

// Protected routes
app.use('/partners', requireAuth, partnerRoutes);
app.use('/leads', requireAuth, leadRoutes);
app.use('/webhooks', requireAuth, webhookRoutes);
app.use('/analytics', requireAuth, analyticsRoutes);
app.use('/alerts', requireAuth, alertsRoutes);
app.use('/quality', requireAuth, qualityScoringRoutes);
// app.use('/crm-integrations', requireAuth, crmIntegrationsRoutes); // Disabled - causing production errors
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

// CRM delivery monitoring (disabled - using real-time CRM integration)
// cron.schedule('*/5 * * * *', retryFailedWebhooks);

// Failed leads retry cron job (every 10 minutes) - DISABLED for now
// const { retryFailedLeads } = require('./services/distribution');
// cron.schedule('*/10 * * * *', retryFailedLeads);

// OPTIMIZED: Background tasks with safer scheduling and error handling

// Essential partner management (every 30 minutes - less frequent, safer)
cron.schedule('*/30 * * * *', async () => {
    try {
        console.log('🔄 Running essential maintenance...');
        // Only run critical maintenance, skip heavy operations
        const { pool } = require('./config/db');
        await pool.query('SELECT 1'); // Simple health check
        console.log('✅ System health check completed');
    } catch (error) {
        console.error('⚠️ Maintenance check failed:', error.message);
        // Continue without crashing
    }
});

// Daily stats reset (once per day at midnight)
cron.schedule('0 0 * * *', async () => {
    try {
        console.log('📊 Running daily statistics reset...');
        const { pool } = require('./config/db');
        await pool.query(`
            INSERT INTO distribution_stats (partner_id, date, leads_received, premium_leads, raw_leads, conversions, revenue)
            SELECT id, CURRENT_DATE, 0, 0, 0, 0, 0.00 FROM partners WHERE status = 'active'
            ON CONFLICT (partner_id, date) DO NOTHING
        `);
        console.log('✅ Daily stats reset completed');
    } catch (error) {
        console.error('⚠️ Daily reset failed:', error.message);
    }
});

// DISABLED: Heavy background tasks that caused pool conflicts
// These can be re-enabled individually after testing:
// - Partner status pulling
// - Business hours processing  
// - Email marketing system
// - Automated partner management

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Lead Distribution Platform running on http://0.0.0.0:${PORT}`);
    try {
        // Initialize main database tables first
        await initDatabase();
        
        // Initialize Redis queue system
        await initRedis();
        
        // Initialize AlertSystem after main database is ready
        const alertSystem = require('./services/alertSystem');
        await alertSystem.initializeDatabase();
        
        // Initialize queued webhook service
        require('./services/queuedWebhook');
        
        console.log('✅ All database and queue systems initialized successfully');
    } catch (error) {
        console.error('❌ System initialization failed:', error);
        console.log('⚠️ Server will continue running with limited functionality');
        // Don't exit - let health checks handle monitoring
        // Server stays alive for debugging and recovery attempts
    }
});

module.exports = { pool };