// Email Scheduler Service - Handles 30-minute delayed promotional emails
const { pool } = require('../config/db');
const { sendPromotionalEmail } = require('./emailService');
const cron = require('node-cron');

/**
 * Schedule promotional email for a lead (30 minutes after arrival)
 */
async function schedulePromotionalEmail(lead) {
    try {
        // Skip if no email provided
        if (!lead.email) {
            console.log(`Lead ${lead.id} has no email address, skipping promotional email`);
            return false;
        }

        // Get the default promotional template
        const templateResult = await pool.query(`
            SELECT id, name, subject, html_content, text_content 
            FROM email_templates 
            WHERE name = 'promotional_default' AND is_active = true
            LIMIT 1
        `);

        if (templateResult.rows.length === 0) {
            console.error('No active promotional template found');
            return false;
        }

        const template = templateResult.rows[0];

        // Schedule email for 30 minutes from now
        const scheduledTime = new Date(Date.now() + (30 * 60 * 1000)); // 30 minutes

        // Insert into email queue
        const queueResult = await pool.query(`
            INSERT INTO email_queue (lead_id, email_address, template_id, scheduled_at, status)
            VALUES ($1, $2, $3, $4, 'pending')
            ON CONFLICT (lead_id, template_id) DO NOTHING
            RETURNING id
        `, [lead.id, lead.email, template.id, scheduledTime]);

        if (queueResult.rows.length > 0) {
            console.log(`Promotional email scheduled for lead ${lead.id} (${lead.email}) at ${scheduledTime}`);
            return true;
        } else {
            console.log(`Promotional email already scheduled for lead ${lead.id}`);
            return false;
        }

    } catch (error) {
        console.error(`Failed to schedule promotional email for lead ${lead.id}:`, error.message);
        return false;
    }
}

/**
 * Process pending emails in queue (called by cron job)
 */
async function processEmailQueue() {
    try {
        // Get emails ready to be sent
        const pendingEmails = await pool.query(`
            SELECT 
                eq.id as queue_id,
                eq.lead_id,
                eq.email_address,
                eq.attempts,
                et.name as template_name,
                et.subject,
                et.html_content,
                et.text_content,
                l.first_name,
                l.last_name
            FROM email_queue eq
            JOIN email_templates et ON eq.template_id = et.id
            LEFT JOIN leads l ON eq.lead_id = l.id
            WHERE eq.status = 'pending' 
                AND eq.scheduled_at <= NOW()
                AND eq.attempts < 3
            ORDER BY eq.scheduled_at ASC
            LIMIT 50
        `);

        console.log(`Processing ${pendingEmails.rows.length} pending promotional emails`);

        for (const emailData of pendingEmails.rows) {
            await processSingleEmail(emailData);
        }

        return pendingEmails.rows.length;

    } catch (error) {
        console.error('Email queue processing error:', error);
        return 0;
    }
}

/**
 * Process a single email from the queue
 */
async function processSingleEmail(emailData) {
    try {
        // Update attempt count
        await pool.query(`
            UPDATE email_queue 
            SET attempts = attempts + 1, last_attempt_at = NOW()
            WHERE id = $1
        `, [emailData.queue_id]);

        // Personalize email content
        let htmlContent = emailData.html_content;
        let textContent = emailData.text_content;
        
        if (emailData.first_name) {
            htmlContent = htmlContent.replace(/{{first_name}}/g, emailData.first_name);
            textContent = textContent.replace(/{{first_name}}/g, emailData.first_name);
        } else {
            htmlContent = htmlContent.replace(/{{first_name}}/g, 'there');
            textContent = textContent.replace(/{{first_name}}/g, 'there');
        }

        // Send the email
        const result = await sendPromotionalEmail(emailData.email_address, {
            subject: emailData.subject,
            htmlContent: htmlContent,
            textContent: textContent
        });

        // Mark as sent and log the result
        await pool.query(`
            UPDATE email_queue 
            SET status = 'sent'
            WHERE id = $1
        `, [emailData.queue_id]);

        // Log the successful send
        await pool.query(`
            INSERT INTO email_logs (queue_id, email_address, template_name, subject, status, message_id, response_data)
            VALUES ($1, $2, $3, $4, 'sent', $5, $6)
        `, [
            emailData.queue_id,
            emailData.email_address,
            emailData.template_name,
            emailData.subject,
            result.messageId || 'unknown',
            JSON.stringify(result)
        ]);

        console.log(`Promotional email sent successfully to ${emailData.email_address}`);

    } catch (error) {
        console.error(`Failed to send promotional email to ${emailData.email_address}:`, error.message);

        // Mark as failed if max attempts reached
        if (emailData.attempts >= 2) { // Will be 3 after the increment above
            await pool.query(`
                UPDATE email_queue 
                SET status = 'failed', error_message = $2
                WHERE id = $1
            `, [emailData.queue_id, error.message.substring(0, 500)]);

            // Log the failure
            await pool.query(`
                INSERT INTO email_logs (queue_id, email_address, template_name, subject, status, response_data)
                VALUES ($1, $2, $3, $4, 'failed', $5)
            `, [
                emailData.queue_id,
                emailData.email_address,
                emailData.template_name,
                emailData.subject,
                JSON.stringify({ error: error.message })
            ]);
        }
    }
}

/**
 * Get email queue statistics
 */
async function getEmailStats() {
    try {
        const stats = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM email_queue
            GROUP BY status
        `);

        const result = {
            pending: 0,
            sent: 0,
            failed: 0
        };

        stats.rows.forEach(row => {
            result[row.status] = parseInt(row.count);
        });

        return result;
    } catch (error) {
        console.error('Error fetching email stats:', error);
        return { pending: 0, sent: 0, failed: 0 };
    }
}

/**
 * Initialize email processing cron job (runs every 5 minutes)
 */
function initEmailScheduler() {
    // Process email queue every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        console.log('Processing promotional email queue...');
        const processed = await processEmailQueue();
        if (processed > 0) {
            console.log(`Processed ${processed} promotional emails`);
        }
    });

    console.log('Email scheduler initialized - processing every 5 minutes');
}

module.exports = {
    schedulePromotionalEmail,
    processEmailQueue,
    getEmailStats,
    initEmailScheduler
};