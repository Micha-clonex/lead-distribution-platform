const axios = require('axios');
const { getQueue } = require('../config/redis');
const { pool, safeQuery } = require('../config/db');
const { applyAuthentication } = require('./universalAuth');
const { logger } = require('../utils/logger');

// Memory-based fallback for webhook delivery when Redis is not available
const memoryQueue = [];
let isProcessingMemoryQueue = false;

class QueuedWebhookService {
    constructor() {
        this.setupQueueProcessor();
        this.setupMemoryQueueProcessor();
    }

    // Add webhook delivery job to queue (Redis or memory fallback)
    async enqueueWebhook(webhookData) {
        // Validate webhook URL for SSRF protection with DNS resolution
        if (!(await this.validateWebhookUrl(webhookData.webhookUrl))) {
            logger.error('Invalid webhook URL blocked for security', {
                leadId: webhookData.leadId,
                partnerId: webhookData.partnerId,
                url: webhookData.webhookUrl
            });
            throw new Error('Invalid or unsafe webhook URL');
        }

        const queue = getQueue();
        
        // Create deterministic job ID for idempotency
        const jobId = `${webhookData.leadId}:${webhookData.partnerId}`;
        
        if (queue) {
            // Use Redis queue with idempotent job ID
            const job = await queue.add('deliver-webhook', {
                ...webhookData,
                requestId: webhookData.requestId || logger.requestId
            }, {
                jobId: jobId, // Prevents duplicate jobs
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                },
                removeOnComplete: 10,
                removeOnFail: 5
            });
            
            logger.info('Webhook queued successfully', {
                component: 'webhook-queue',
                jobId: job.id,
                leadId: webhookData.leadId,
                partnerId: webhookData.partnerId
            });
            return job.id;
        } else {
            // Use memory fallback with deduplication
            const existingJob = memoryQueue.find(job => job.id === jobId);
            if (existingJob) {
                logger.warn('Duplicate webhook job prevented', {
                    component: 'webhook-queue',
                    jobId: jobId,
                    leadId: webhookData.leadId
                });
                return jobId;
            }
            
            memoryQueue.push({
                id: jobId,
                data: {
                    ...webhookData,
                    requestId: webhookData.requestId || logger.requestId
                },
                attempts: 0,
                createdAt: new Date()
            });
            
            logger.info('Webhook queued in memory', {
                component: 'webhook-queue',
                jobId: jobId,
                leadId: webhookData.leadId
            });
            this.processMemoryQueue(); // Start processing if not already running
            return jobId;
        }
    }

    // Setup Redis queue processor
    setupQueueProcessor() {
        const queue = getQueue();
        if (!queue) return;

        queue.process('deliver-webhook', 3, async (job) => {
            return await this.processWebhookJob(job.data);
        });

        console.log('✅ Redis webhook queue processor started');
    }

    // Setup memory-based queue processor for development
    setupMemoryQueueProcessor() {
        setInterval(() => {
            this.processMemoryQueue();
        }, 2000); // Process every 2 seconds
    }

    // Process memory queue (fallback when Redis not available)
    async processMemoryQueue() {
        if (isProcessingMemoryQueue || memoryQueue.length === 0) return;
        
        isProcessingMemoryQueue = true;
        
        try {
            const job = memoryQueue.shift();
            if (!job) return;

            job.attempts++;
            
            try {
                await this.processWebhookJob(job.data);
                console.log(`✅ Memory queue job ${job.id} completed`);
            } catch (error) {
                console.error(`❌ Memory queue job ${job.id} failed (attempt ${job.attempts}):`, error.message);
                
                // Retry logic
                if (job.attempts < 5) {
                    // Add back to queue with delay
                    setTimeout(() => {
                        memoryQueue.push(job);
                    }, Math.pow(2, job.attempts) * 1000); // Exponential backoff
                } else {
                    console.error(`💀 Memory queue job ${job.id} permanently failed after 5 attempts`);
                    // Log permanent failure
                    await this.logWebhookFailure(job.data, error.message, true);
                }
            }
        } finally {
            isProcessingMemoryQueue = false;
        }
    }

    // SSRF protection - validate webhook URLs with DNS resolution
    async validateWebhookUrl(url) {
        try {
            if (!url || typeof url !== 'string') return false;
            
            const parsedUrl = new URL(url);
            
            // Only allow HTTPS (HTTP allowed for development)
            if (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'https:') {
                return false;
            }
            
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return false;
            }
            
            const hostname = parsedUrl.hostname.toLowerCase();
            
            // Block obvious private hostnames first
            const forbiddenHosts = [
                'localhost', '127.0.0.1', '0.0.0.0', '::1',
                'metadata.google.internal', 'metadata.amazonaws.com'
            ];
            
            for (const forbidden of forbiddenHosts) {
                if (hostname === forbidden || hostname.includes(forbidden)) {
                    return false;
                }
            }
            
            // Resolve DNS and check IPs
            const dns = require('dns');
            const { promisify } = require('util');
            const lookup = promisify(dns.lookup);
            
            try {
                const { address } = await lookup(hostname);
                if (this.isPrivateIP(address)) {
                    logger.warn('Webhook URL resolves to private IP - blocked', {
                        hostname,
                        resolvedIP: address
                    });
                    return false;
                }
            } catch (dnsError) {
                logger.warn('DNS lookup failed for webhook URL', {
                    hostname,
                    error: dnsError.message
                });
                return false;
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }
    
    // Check if IP address is private/internal
    isPrivateIP(ip) {
        // IPv4 private ranges
        const ipv4Private = [
            /^10\./,                     // 10.0.0.0/8
            /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
            /^192\.168\./,               // 192.168.0.0/16
            /^127\./,                    // 127.0.0.0/8 (localhost)
            /^169\.254\./,               // 169.254.0.0/16 (link-local)
            /^0\./                       // 0.0.0.0/8
        ];
        
        // Check IPv4
        for (const pattern of ipv4Private) {
            if (pattern.test(ip)) {
                return true;
            }
        }
        
        // Basic IPv6 private/local checks
        if (ip.startsWith('::1') || ip.startsWith('fc00') || ip.startsWith('fe80')) {
            return true;
        }
        
        return false;
    }

    // Process individual webhook job
    async processWebhookJob(webhookData) {
        const { leadId, partnerId, webhookUrl, payload, authConfig, contentType, requestId } = webhookData;
        
        // Create logger with request context
        const jobLogger = requestId ? new (require('../utils/logger')).Logger(requestId) : logger;
        
        const startTime = Date.now();
        
        try {
            jobLogger.info('Processing webhook delivery', {
                component: 'webhook-delivery',
                leadId,
                partnerId,
                webhookUrl
            });
            
            // Double-check URL validation at processing time with DNS resolution
            if (!(await this.validateWebhookUrl(webhookUrl))) {
                throw new Error('Webhook URL failed security validation');
            }
            
            // Prepare request configuration with redirect prevention
            const requestConfig = {
                method: 'POST',
                url: webhookUrl,
                data: payload,
                headers: {
                    'Content-Type': contentType || 'application/json',
                    'User-Agent': 'Lead-Distribution-Platform/1.0',
                    'Idempotency-Key': `lead-${leadId}-partner-${partnerId}`, // Idempotency protection
                    'X-Event-ID': `${leadId}:${partnerId}:${Date.now()}`
                },
                timeout: 30000, // 30 second timeout
                maxRedirects: 0, // Prevent redirect-based SSRF
                validateStatus: function (status) {
                    return status >= 200 && status < 300; // Accept 2xx status codes
                }
            };

            // Apply authentication if configured
            if (authConfig && authConfig.type !== 'none') {
                requestConfig.headers = applyAuthentication(requestConfig.headers, authConfig);
            }

            const response = await axios(requestConfig);
            const responseTime = Date.now() - startTime;

            // Log successful delivery
            await this.logWebhookDelivery(leadId, partnerId, webhookUrl, payload, response, responseTime, 'success');
            
            jobLogger.info('Webhook delivered successfully', {
                component: 'webhook-delivery',
                leadId,
                partnerId,
                responseTime,
                status: response.status
            });
            
            return { success: true, status: response.status, responseTime };

        } catch (error) {
            const responseTime = Date.now() - startTime;
            
            // Log failed delivery
            await this.logWebhookDelivery(leadId, partnerId, webhookUrl, payload, error.response, responseTime, 'failed', error.message);
            
            jobLogger.error('Webhook delivery failed', {
                component: 'webhook-delivery',
                leadId,
                partnerId,
                error: error.message,
                responseTime
            });
            
            throw error; // Let queue handle retries
        }
    }

    // Log webhook delivery attempt to database
    async logWebhookDelivery(leadId, partnerId, webhookUrl, payload, response, responseTime, status, errorMessage = null) {
        try {
            await safeQuery(`
                INSERT INTO webhook_deliveries 
                (lead_id, partner_id, webhook_url, payload, response_code, response_status, response_body, status, delivered_at, attempts)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
                ON CONFLICT (lead_id, partner_id) 
                DO UPDATE SET
                    response_code = EXCLUDED.response_code,
                    response_status = EXCLUDED.response_status,
                    response_body = EXCLUDED.response_body,
                    status = EXCLUDED.status,
                    delivered_at = EXCLUDED.delivered_at,
                    attempts = webhook_deliveries.attempts + 1
            `, [
                leadId,
                partnerId,
                webhookUrl,
                JSON.stringify(payload),
                response ? response.status : null,
                response ? response.statusText : null,
                response ? JSON.stringify(response.data).substring(0, 1000) : errorMessage,
                status,
                new Date(),
            ]);
        } catch (dbError) {
            console.error('Failed to log webhook delivery:', dbError.message);
        }
    }

    // Log permanent webhook failure
    async logWebhookFailure(webhookData, errorMessage, permanent = false) {
        try {
            await safeQuery(`
                UPDATE webhook_deliveries 
                SET status = $1, response_body = $2, updated_at = NOW()
                WHERE lead_id = $3 AND partner_id = $4
            `, [
                permanent ? 'permanently_failed' : 'failed',
                errorMessage,
                webhookData.leadId,
                webhookData.partnerId
            ]);
        } catch (dbError) {
            console.error('Failed to log webhook failure:', dbError.message);
        }
    }

    // Get queue stats for monitoring
    async getQueueStats() {
        const queue = getQueue();
        
        if (queue) {
            try {
                const waiting = await queue.getWaiting();
                const active = await queue.getActive();
                const completed = await queue.getCompleted();
                const failed = await queue.getFailed();
                
                return {
                    type: 'redis',
                    waiting: waiting.length,
                    active: active.length,
                    completed: completed.length,
                    failed: failed.length
                };
            } catch (error) {
                return { type: 'redis', error: error.message };
            }
        } else {
            return {
                type: 'memory',
                waiting: memoryQueue.length,
                active: isProcessingMemoryQueue ? 1 : 0,
                completed: 'unknown',
                failed: 'unknown'
            };
        }
    }
}

// Export singleton instance
module.exports = new QueuedWebhookService();