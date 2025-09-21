const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// Get all partners
router.get('/', async (req, res) => {
    try {
        const { country, niche, status } = req.query;
        let query = 'SELECT * FROM partners WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (country) {
            query += ` AND country = $${++paramCount}`;
            params.push(country);
        }
        if (niche) {
            query += ` AND niche = $${++paramCount}`;
            params.push(niche);
        }
        if (status) {
            query += ` AND status = $${++paramCount}`;
            params.push(status);
        }

        query += ' ORDER BY created_at DESC';
        
        const result = await pool.query(query, params);
        res.render('partners/index', { 
            partners: result.rows,
            title: 'Partner Management',
            countries: ['germany', 'austria', 'spain', 'canada', 'italy', 'uk', 'norway'],
            niches: ['forex', 'recovery'],
            // Pass current query parameters for filter selection
            currentFilters: {
                country: country || '',
                niche: niche || '',
                status: status || ''
            }
        });
    } catch (error) {
        console.error('Partners fetch error:', error);
        res.status(500).render('error', { error: 'Failed to fetch partners' });
    }
});

// Add new partner
router.post('/', async (req, res) => {
    try {
        const { name, email, country, niche, webhook_url, daily_limit, premium_ratio, timezone } = req.body;
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio ? (parseFloat(premium_ratio) / 100) : 0.70;
        
        await pool.query(`
            INSERT INTO partners (name, email, country, niche, webhook_url, daily_limit, premium_ratio, timezone)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [name, email, country, niche, webhook_url, daily_limit || 50, ratioDecimal, timezone || 'UTC']);
        
        res.redirect('/partners?success=Partner added successfully');
    } catch (error) {
        console.error('Partner creation error:', error);
        res.redirect('/partners?error=Failed to add partner');
    }
});

// Update partner
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, country, niche, webhook_url, daily_limit, premium_ratio, status, timezone } = req.body;
        
        // Validate premium_ratio
        if (premium_ratio !== undefined && premium_ratio !== null && premium_ratio !== '') {
            const ratio = parseFloat(premium_ratio);
            if (isNaN(ratio) || ratio < 0 || ratio > 100) {
                return res.status(400).json({ success: false, error: 'Premium ratio must be between 0 and 100' });
            }
        }
        
        // Validate daily_limit  
        if (daily_limit !== undefined && daily_limit !== null && daily_limit !== '') {
            const limit = parseInt(daily_limit);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ success: false, error: 'Daily limit must be at least 1' });
            }
        }
        
        // Convert percentage input to decimal (70 -> 0.70)
        const ratioDecimal = premium_ratio && premium_ratio !== '' ? (parseFloat(premium_ratio) / 100) : null;
        
        await pool.query(`
            UPDATE partners 
            SET name = $1, email = $2, country = $3, niche = $4, webhook_url = $5, 
                daily_limit = $6, premium_ratio = $7, status = $8, timezone = $9, updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
        `, [name, email, country, niche, webhook_url, daily_limit, ratioDecimal, status, timezone, id]);
        
        res.json({ success: true, message: 'Partner updated successfully' });
    } catch (error) {
        console.error('Partner update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update partner' });
    }
});

// Delete partner
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM partners WHERE id = $1', [id]);
        res.json({ success: true, message: 'Partner deleted successfully' });
    } catch (error) {
        console.error('Partner deletion error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete partner' });
    }
});

module.exports = router;