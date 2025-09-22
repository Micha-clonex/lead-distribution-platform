// Email Service using Replit Mail integration
// Referenced from blueprint:replitmail integration

/**
 * Send email using Replit Mail service
 */
async function sendEmail(message) {
    const xReplitToken = process.env.REPL_IDENTITY
        ? "repl " + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? "depl " + process.env.WEB_REPL_RENEWAL
        : null;

    if (!xReplitToken) {
        throw new Error(
            "No authentication token found. Please set REPL_IDENTITY or ensure you're running in Replit environment."
        );
    }

    const response = await fetch(
        "https://connectors.replit.com/api/v2/mailer/send",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X_REPLIT_TOKEN": xReplitToken,
            },
            body: JSON.stringify({
                to: message.to,
                cc: message.cc,
                subject: message.subject,
                text: message.text,
                html: message.html,
                attachments: message.attachments,
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to send email");
    }

    return await response.json();
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
        
        console.log(`Promotional email sent to ${leadEmail}:`, result.accepted);
        return result;
    } catch (error) {
        console.error(`Failed to send promotional email to ${leadEmail}:`, error.message);
        throw error;
    }
}

/**
 * Send test email to verify configuration
 */
async function sendTestEmail(testEmail, subject = "Test Email", content = "This is a test email from your Lead Distribution Platform.") {
    try {
        const result = await sendEmail({
            to: testEmail,
            subject: subject,
            text: content,
            html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
                     <h2 style="color: #667eea;">Test Email</h2>
                     <p>${content}</p>
                     <hr style="margin: 20px 0;">
                     <small style="color: #666;">Sent from Lead Distribution Platform</small>
                   </div>`
        });
        
        console.log(`Test email sent to ${testEmail}:`, result.accepted);
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