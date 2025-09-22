const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { getEmailStats } = require('../services/emailScheduler');
const { sendTestEmail } = require('../services/emailService');

const router = express.Router();

// Apply authentication to all email template routes
router.use(requireAuth);

// Email Templates Management Page
router.get('/', async (req, res) => {
    try {
        const templates = await pool.query(`
            SELECT id, name, subject, is_active, created_at, updated_at 
            FROM email_templates 
            ORDER BY created_at DESC
        `);
        
        const emailStats = await getEmailStats();
        
        res.render('admin/email-templates', { 
            title: 'Email Template Management',
            templates: templates.rows,
            emailStats
        });
    } catch (error) {
        console.error('Email templates page error:', error);
        res.status(500).render('error', { error: 'Failed to load email templates' });
    }
});

// Get single template (API)
router.get('/api/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const template = await pool.query(`
            SELECT * FROM email_templates WHERE id = $1
        `, [id]);
        
        if (template.rows.length === 0) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        res.json(template.rows[0]);
    } catch (error) {
        console.error('Get template error:', error);
        res.status(500).json({ error: 'Failed to fetch template' });
    }
});

// Create new template
router.post('/api', async (req, res) => {
    try {
        const { name, subject, html_content, text_content, is_active } = req.body;
        
        if (!name || !subject || !html_content || !text_content) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        const result = await pool.query(`
            INSERT INTO email_templates (name, subject, html_content, text_content, is_active)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [name, subject, html_content, text_content, is_active !== false]);
        
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('Create template error:', error);
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ error: 'Template name already exists' });
        } else {
            res.status(500).json({ error: 'Failed to create template' });
        }
    }
});

// Update template
router.put('/api/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, subject, html_content, text_content, is_active } = req.body;
        
        if (!name || !subject || !html_content || !text_content) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        const result = await pool.query(`
            UPDATE email_templates 
            SET name = $1, subject = $2, html_content = $3, text_content = $4, is_active = $5, updated_at = NOW()
            WHERE id = $6
        `, [name, subject, html_content, text_content, is_active !== false, id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update template error:', error);
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ error: 'Template name already exists' });
        } else {
            res.status(500).json({ error: 'Failed to update template' });
        }
    }
});

// Delete template
router.delete('/api/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if template is being used in queue
        const queueCheck = await pool.query(`
            SELECT COUNT(*) as count FROM email_queue WHERE template_id = $1 AND status = 'pending'
        `, [id]);
        
        if (parseInt(queueCheck.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Cannot delete template - it has pending emails in queue' 
            });
        }
        
        const result = await pool.query(`
            DELETE FROM email_templates WHERE id = $1
        `, [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// Send test email
router.post('/api/:id/test', async (req, res) => {
    try {
        const { id } = req.params;
        const { test_email } = req.body;
        
        if (!test_email) {
            return res.status(400).json({ error: 'Test email address is required' });
        }
        
        // Get template
        const template = await pool.query(`
            SELECT * FROM email_templates WHERE id = $1
        `, [id]);
        
        if (template.rows.length === 0) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        const templateData = template.rows[0];
        
        // Personalize with test data
        let htmlContent = templateData.html_content.replace(/{{first_name}}/g, 'John');
        let textContent = templateData.text_content.replace(/{{first_name}}/g, 'John');
        
        // Send test email
        await sendTestEmail(
            test_email, 
            `[TEST] ${templateData.subject}`,
            textContent
        );
        
        res.json({ success: true, message: 'Test email sent successfully' });
    } catch (error) {
        console.error('Test email error:', error);
        res.status(500).json({ error: 'Failed to send test email: ' + error.message });
    }
});

// Email queue status
router.get('/api/queue/stats', async (req, res) => {
    try {
        const stats = await getEmailStats();
        
        // Get recent email activity
        const recentActivity = await pool.query(`
            SELECT 
                el.email_address,
                el.subject,
                el.status,
                el.sent_at,
                et.name as template_name
            FROM email_logs el
            LEFT JOIN email_queue eq ON el.queue_id = eq.id
            LEFT JOIN email_templates et ON eq.template_id = et.id
            ORDER BY el.sent_at DESC
            LIMIT 10
        `);
        
        res.json({
            ...stats,
            recent_activity: recentActivity.rows
        });
    } catch (error) {
        console.error('Email stats error:', error);
        res.status(500).json({ error: 'Failed to fetch email statistics' });
    }
});

module.exports = router;