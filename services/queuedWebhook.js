const axios = require('axios');
const { getQueue } = require('../config/redis');
const { pool, safeQuery } = require('../config/db');
const { applyAuthentication } = require('./universalAuth');

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
        const queue = getQueue();
        
        if (queue) {
            // Use Redis queue
            const job = await queue.add('deliver-webhook', webhookData, {
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                },
                removeOnComplete: 10,
                removeOnFail: 5
            });
            
            console.log(`📤 Webhook queued (Redis): Job ${job.id} for lead ${webhookData.leadId}`);
            return job.id;
        } else {
            // Use memory fallback
            const jobId = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            memoryQueue.push({
                id: jobId,
                data: webhookData,
                attempts: 0,
                createdAt: new Date()
            });
            
            console.log(`📤 Webhook queued (memory): Job ${jobId} for lead ${webhookData.leadId}`);
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

    // Process individual webhook job
    async processWebhookJob(webhookData) {
        const { leadId, partnerId, webhookUrl, payload, authConfig, contentType } = webhookData;
        
        try {
            console.log(`🔄 Processing webhook for lead ${leadId} to partner ${partnerId}`);
            
            // Prepare request configuration
            const requestConfig = {
                method: 'POST',
                url: webhookUrl,
                data: payload,
                headers: {
                    'Content-Type': contentType || 'application/json',
                    'User-Agent': 'Lead-Distribution-Platform/1.0'
                },
                timeout: 30000, // 30 second timeout
                validateStatus: function (status) {
                    return status >= 200 && status < 300; // Accept 2xx status codes
                }
            };

            // Apply authentication if configured
            if (authConfig && authConfig.type !== 'none') {
                requestConfig.headers = applyAuthentication(requestConfig.headers, authConfig);
            }

            const startTime = Date.now();
            const response = await axios(requestConfig);
            const responseTime = Date.now() - startTime;

            // Log successful delivery
            await this.logWebhookDelivery(leadId, partnerId, webhookUrl, payload, response, responseTime, 'success');
            
            console.log(`✅ Webhook delivered successfully to ${webhookUrl} (${responseTime}ms)`);
            return { success: true, status: response.status, responseTime };

        } catch (error) {
            const responseTime = Date.now() - (webhookData.startTime || Date.now());
            
            // Log failed delivery
            await this.logWebhookDelivery(leadId, partnerId, webhookUrl, payload, error.response, responseTime, 'failed', error.message);
            
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