# Render Deployment Guide

## Automated Database Migrations on Git Push

This project is configured for **automatic deployment** to Render with **zero-downtime database migrations**.

## 🚀 How It Works

### 1. **Push to Git = Automatic Deploy**
```bash
git add .
git commit -m "Your changes"
git push origin main
```

### 2. **Render Automatically:**
- ✅ Pulls latest code
- ✅ Runs `npm install`
- ✅ Executes database migrations (`npm run migrate`)
- ✅ Starts the application (`npm start`)
- ✅ **Zero manual SQL commands required!**

## 📁 Project Structure

```
├── scripts/
│   └── migrate-production.js    # Automatic database migrations
├── render.yaml                  # Render deployment configuration
├── package.json                 # Build and deploy scripts
└── server.js                    # Application entry point
```

## ⚙️ Deployment Configuration

### `render.yaml` - Automatic Setup
- **Build Command**: `npm install && npm run migrate`
- **Start Command**: `npm start`
- **Database**: Automatically configured with `DATABASE_URL`
- **Environment**: Production settings applied

### `package.json` - Migration Scripts
```json
{
  "scripts": {
    "migrate": "node scripts/migrate-production.js",
    "build": "npm run migrate",
    "deploy": "npm run migrate && npm start"
  }
}
```

## 🔄 Migration Process

### What Happens on Deploy:
1. **Pull Code**: Latest git changes
2. **Install Dependencies**: `npm install`
3. **Run Migrations**: `npm run migrate`
   - Adds missing database columns
   - Updates schema safely
   - Handles CRM integrations structure
   - Sets up smart transformation fields
4. **Start Application**: Production server launches

### Migration Script Features:
- ✅ **Safe Migrations**: Uses `ADD COLUMN IF NOT EXISTS`
- ✅ **Error Handling**: Fails deployment if migration fails
- ✅ **Verification**: Confirms schema updates
- ✅ **Logging**: Clear deployment status messages

## 🛠️ First-Time Setup on Render

### 1. Connect Repository
- Link your GitHub repository to Render
- Select "Web Service" type
- Choose Node.js environment

### 2. Environment Variables (Auto-configured)
```
NODE_ENV=production
DATABASE_URL=[automatically set by Render]
SESSION_SECRET=[automatically generated]
PORT=10000
```

### 3. Database Setup
- Render creates PostgreSQL database automatically
- Connection string provided via `DATABASE_URL`
- Migrations run automatically on first deploy

## 🎯 Benefits

### **Zero Manual Work**
- No SSH into servers
- No manual SQL commands
- No database management required

### **Safe Deployments**
- Migrations tested before application starts
- Rollback-safe column additions
- Error handling prevents broken deployments

### **Consistent Environments**
- Same migration process for all deployments
- Identical schema across environments
- Automated verification

## 🔧 Manual Migration (Emergency Only)

If you ever need to run migrations manually:

```bash
# In production environment
npm run migrate
```

But this should **never be necessary** with the automated system!

## 📊 What Gets Migrated

### Partner CRM Integrations
- `auth_type` column (fixes "column does not exist" error)
- `auth_config` column (JSON authentication data)

### Partners Table (Smart Transformation)
- `field_mapping` column (custom field mappings)
- `default_values` column (auto-fill missing data)
- `required_fields` column (validation rules)
- `phone_format` column (formatting preferences)

## ✅ Verification

After deployment, verify everything works:
1. Visit your production URL
2. Navigate to "CRM Integrations"
3. Confirm page loads without errors
4. Test partner management features

## 🚨 Troubleshooting

### If deployment fails:
- Check Render build logs for migration errors
- Verify `DATABASE_URL` is set correctly
- Ensure PostgreSQL database is running

### If CRM Integrations still shows errors:
- Deployment succeeded but migration failed
- Check application logs in Render dashboard
- Contact support with specific error messages

---

**🎉 With this setup, your lead distribution platform deploys automatically with every git push!**