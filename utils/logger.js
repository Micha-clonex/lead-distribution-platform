const crypto = require('crypto');

// Generate unique request ID
function generateRequestId() {
    return crypto.randomBytes(8).toString('hex');
}

// Structured logger with request context
class Logger {
    constructor(requestId = null) {
        this.requestId = requestId || generateRequestId();
    }

    _log(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            requestId: this.requestId,
            ...meta
        };

        // Output structured JSON for production, readable format for development
        if (process.env.NODE_ENV === 'production') {
            console.log(JSON.stringify(logEntry));
        } else {
            const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
            console.log(`[${timestamp}] ${level.toUpperCase()} [${this.requestId}] ${message}${metaStr}`);
        }
    }

    info(message, meta = {}) {
        this._log('info', message, meta);
    }

    warn(message, meta = {}) {
        this._log('warn', message, meta);
    }

    error(message, meta = {}) {
        this._log('error', message, meta);
    }

    debug(message, meta = {}) {
        if (process.env.NODE_ENV !== 'production') {
            this._log('debug', message, meta);
        }
    }

    // Create child logger with additional context
    child(additionalContext = {}) {
        const childLogger = new Logger(this.requestId);
        childLogger.context = { ...this.context, ...additionalContext };
        return childLogger;
    }

    // Log webhook delivery events
    webhookDelivery(leadId, partnerId, status, meta = {}) {
        this.info('Webhook delivery attempt', {
            component: 'webhook',
            leadId,
            partnerId,
            status,
            ...meta
        });
    }

    // Log lead distribution events
    leadDistribution(leadId, partnerId, action, meta = {}) {
        this.info('Lead distribution event', {
            component: 'distribution',
            leadId,
            partnerId,
            action,
            ...meta
        });
    }

    // Log database events
    database(action, meta = {}) {
        this.info('Database operation', {
            component: 'database',
            action,
            ...meta
        });
    }

    // Log performance metrics
    performance(operation, durationMs, meta = {}) {
        this.info('Performance metric', {
            component: 'performance',
            operation,
            durationMs,
            ...meta
        });
    }
}

// Express middleware to add request ID and logger
function requestLogger(req, res, next) {
    const requestId = req.headers['x-request-id'] || generateRequestId();
    req.requestId = requestId;
    req.logger = new Logger(requestId);
    
    // Add request ID to response headers
    res.setHeader('X-Request-ID', requestId);
    
    // Log incoming request
    req.logger.info('Incoming request', {
        method: req.method,
        url: req.originalUrl,
        userAgent: req.headers['user-agent'],
        ip: req.ip
    });
    
    next();
}

// Create default logger for non-request contexts
const defaultLogger = new Logger();

module.exports = {
    Logger,
    requestLogger,
    generateRequestId,
    logger: defaultLogger
};