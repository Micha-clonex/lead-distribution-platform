// Email Service - Multiple email provider support with admin dashboard configuration
const axios = require('axios');
const { pool } = require('../config/db');

/**
 * Get active email service configuration from database
 */
async function getEmailConfig() {
    try {
        // Try database first
        const result = await pool.query(`
            SELECT service_name, settings 
            FROM api_settings 
            WHERE service_type = 'email' AND is_active = true 
            ORDER BY updated_at DESC 
            LIMIT 1
        `);
        
        if (result.rows.length > 0) {
            const config = result.rows[0];
            return {
                provider: config.service_name,
                settings: config.settings
            };
        }
        
        // Fallback to environment variables (for backwards compatibility)
        if (process.env.POSTMARK_SERVER_TOKEN && process.env.POSTMARK_FROM_EMAIL) {
            return {
                provider: 'postmark',
                settings: {
                    server_token: process.env.POSTMARK_SERVER_TOKEN,
                    from_email: process.env.POSTMARK_FROM_EMAIL
                }
            };
        }
        
        throw new Error('No email service configured. Please configure an email provider in API Settings.');
        
    } catch (error) {
        console.error('Error getting email config:', error.message);
        throw error;
    }
}

/**
 * Send email using configured provider
 */
async function sendEmail(message) {
    const config = await getEmailConfig();

    try {
        if (config.provider === 'postmark') {
            return await sendPostmarkEmail(message, config.settings);
        } else if (config.provider === 'mailgun') {
            return await sendMailgunEmail(message, config.settings);
        } else if (config.provider === 'sendgrid') {
            return await sendSendGridEmail(message, config.settings);
        } else if (config.provider === 'amazon_ses') {
            return await sendAmazonSESEmail(message, config.settings);
        } else {
            throw new Error(`Unsupported email provider: ${config.provider}`);
        }
    } catch (error) {
        console.error(`${config.provider} email error:`, error.message);
        throw error;
    }
}

/**
 * Send email via Postmark
 */
async function sendPostmarkEmail(message, settings) {
    const response = await axios.post('https://api.postmarkapp.com/email', {
        From: settings.from_email,
        To: message.to,
        Cc: message.cc,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        MessageStream: 'outbound',
        Attachments: message.attachments
    }, {
        headers: {
            'X-Postmark-Server-Token': settings.server_token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    return {
        messageId: response.data.MessageID,
        accepted: [message.to],
        response: response.data
    };
}

/**
 * Send email via Mailgun
 */
async function sendMailgunEmail(message, settings) {
    const formData = new URLSearchParams();
    formData.append('from', settings.from_email);
    formData.append('to', message.to);
    if (message.cc) formData.append('cc', message.cc);
    formData.append('subject', message.subject);
    if (message.text) formData.append('text', message.text);
    if (message.html) formData.append('html', message.html);

    const response = await axios.post(`https://api.mailgun.net/v3/${settings.domain}/messages`, formData, {
        auth: {
            username: 'api',
            password: settings.api_key
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    return {
        messageId: response.data.id,
        accepted: [message.to],
        response: response.data
    };
}

/**
 * Send email via SendGrid  
 */
async function sendSendGridEmail(message, settings) {
    const response = await axios.post('https://api.sendgrid.com/v3/mail/send', {
        personalizations: [{
            to: [{ email: message.to }],
            cc: message.cc ? [{ email: message.cc }] : undefined,
            subject: message.subject
        }],
        from: { email: settings.from_email },
        content: [
            message.text ? { type: 'text/plain', value: message.text } : null,
            message.html ? { type: 'text/html', value: message.html } : null
        ].filter(Boolean)
    }, {
        headers: {
            'Authorization': `Bearer ${settings.api_key}`,
            'Content-Type': 'application/json'
        }
    });

    return {
        messageId: response.headers['x-message-id'] || 'sendgrid-' + Date.now(),
        accepted: [message.to],
        response: response.data
    };
}

/**
 * Send email via Amazon SES
 */
async function sendAmazonSESEmail(message, settings) {
    // Note: This is a simplified implementation. For production, use AWS SDK
    const params = {
        Source: settings.from_email,
        Destination: {
            ToAddresses: [message.to],
            CcAddresses: message.cc ? [message.cc] : undefined
        },
        Message: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
                Text: message.text ? { Data: message.text, Charset: 'UTF-8' } : undefined,
                Html: message.html ? { Data: message.html, Charset: 'UTF-8' } : undefined
            }
        }
    };

    // For production, implement proper AWS SES integration
    throw new Error('Amazon SES integration requires AWS SDK setup. Please use Postmark, Mailgun, or SendGrid for now.');
}

/**
 * Send promotional email after 30-minute delay
 */
async function sendPromotionalEmail(leadEmail, templateContent) {
    try {
        const result = await sendEmail({
            to: leadEmail,
            subject: templateContent.subject,
            html: templateContent.htmlContent,
            text: templateContent.textContent
        });
        
        console.log(`Promotional email sent to ${leadEmail} - Message ID: ${result.messageId}`);
        return result;
    } catch (error) {
        console.error(`Failed to send promotional email to ${leadEmail}:`, error.message);
        throw error;
    }
}

/**
 * Send test email to verify Postmark configuration
 */
async function sendTestEmail(testEmail, subject = "Test Email", content = "This is a test email from your Lead Distribution Platform.") {
    try {
        const result = await sendEmail({
            to: testEmail,
            subject: subject,
            text: content,
            html: `<div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
                     <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
                         <h2 style="margin: 0;">Test Email - Postmark Integration</h2>
                     </div>
                     <div style="background: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                         <p style="color: #333; line-height: 1.6;">${content}</p>
                         <div style="background: #f8f9fa; padding: 15px; border-left: 4px solid #667eea; margin: 15px 0;">
                             <strong style="color: #667eea;">✅ Postmark Integration Working!</strong><br>
                             <span style="color: #666; font-size: 14px;">Your emails will have industry-leading 81.5% inbox delivery rate</span>
                         </div>
                         <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                         <p style="color: #999; font-size: 12px; text-align: center;">
                             Sent via Postmark API • Lead Distribution Platform
                         </p>
                     </div>
                   </div>`
        });
        
        console.log(`Test email sent to ${testEmail} - Message ID: ${result.messageId}`);
        return result;
    } catch (error) {
        console.error(`Failed to send test email to ${testEmail}:`, error.message);
        throw error;
    }
}

module.exports = {
    sendEmail,
    sendPromotionalEmail,
    sendTestEmail
};