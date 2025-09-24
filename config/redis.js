const Redis = require('redis');
const Queue = require('bull');

let redisClient = null;
let webhookQueue = null;

// Redis connection configuration
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryDelayOnFailover: 1000,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    lazyConnect: true
};

// Initialize Redis client
async function initRedis() {
    try {
        // For development, we'll use a memory-based fallback if Redis isn't available
        if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
            console.log('⚠️ Redis not configured - using memory-based fallback for development');
            return { client: null, queue: null };
        }

        redisClient = Redis.createClient(process.env.REDIS_URL || redisConfig);
        
        redisClient.on('error', (err) => {
            console.error('Redis connection error:', err.message);
        });
        
        redisClient.on('connect', () => {
            console.log('✅ Redis connected successfully');
        });
        
        await redisClient.connect();
        
        // Initialize Bull queue
        webhookQueue = new Queue('webhook delivery', process.env.REDIS_URL || redisConfig);
        
        webhookQueue.on('error', (error) => {
            console.error('Queue error:', error.message);
        });
        
        webhookQueue.on('completed', (job) => {
            console.log(`✅ Webhook job ${job.id} completed successfully`);
        });
        
        webhookQueue.on('failed', (job, err) => {
            console.error(`❌ Webhook job ${job.id} failed:`, err.message);
        });
        
        console.log('✅ Redis queue system initialized');
        return { client: redisClient, queue: webhookQueue };
        
    } catch (error) {
        console.warn('⚠️ Redis initialization failed, using memory fallback:', error.message);
        return { client: null, queue: null };
    }
}

// Graceful shutdown
async function closeRedis() {
    try {
        if (webhookQueue) {
            await webhookQueue.close();
        }
        if (redisClient) {
            await redisClient.quit();
        }
        console.log('✅ Redis connections closed gracefully');
    } catch (error) {
        console.error('Redis shutdown error:', error.message);
    }
}

// Health check for Redis
async function getRedisHealth() {
    try {
        if (!redisClient) {
            return { status: 'disabled', message: 'Redis not configured' };
        }
        
        const start = Date.now();
        await redisClient.ping();
        const latency = Date.now() - start;
        
        return {
            status: 'connected',
            latency_ms: latency,
            memory_usage: await redisClient.memory('usage') || 'unknown'
        };
    } catch (error) {
        return {
            status: 'error',
            message: error.message
        };
    }
}

module.exports = {
    initRedis,
    closeRedis,
    getRedisHealth,
    getClient: () => redisClient,
    getQueue: () => webhookQueue
};