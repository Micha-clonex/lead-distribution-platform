const express = require('express');
const router = express.Router();
const { requireAuth, comparePassword, updateAdminPassword, getAdminById } = require('../middleware/auth');

// Profile page
router.get('/', requireAuth, async (req, res) => {
    try {
        const admin = await getAdminById(req.session.adminId);
        res.render('admin/profile', {
            title: 'Admin Profile',
            admin: admin,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Profile page error:', error);
        res.redirect('/?error=Failed to load profile');
    }
});

// Change password
router.post('/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Validation
        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/admin/profile?error=All fields are required');
        }
        
        if (newPassword !== confirmPassword) {
            return res.redirect('/admin/profile?error=New passwords do not match');
        }
        
        if (newPassword.length < 8) {
            return res.redirect('/admin/profile?error=Password must be at least 8 characters long');
        }
        
        // Get current admin
        const admin = await getAdminById(req.session.adminId);
        if (!admin) {
            return res.redirect('/admin/login');
        }
        
        // Verify current password
        const isValidPassword = await comparePassword(currentPassword, admin.password);
        if (!isValidPassword) {
            return res.redirect('/admin/profile?error=Current password is incorrect');
        }
        
        // Update password
        await updateAdminPassword(req.session.adminId, newPassword);
        
        console.log(`Admin ${admin.username} changed their password`);
        res.redirect('/admin/profile?success=Password changed successfully');
        
    } catch (error) {
        console.error('Change password error:', error);
        res.redirect('/admin/profile?error=Failed to change password');
    }
});

module.exports = router;