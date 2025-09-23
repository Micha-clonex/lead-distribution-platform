# Partner Integration Guide
## Lead Distribution Platform - Render Deployment

### Overview
The Lead Distribution Platform provides automated lead routing to partners across multiple countries (Germany, Austria, Spain, Canada, Italy, UK, Norway) in forex and recovery niches. Partners integrate via secure webhook URLs with customizable field transformation.

---

## 🚀 How Partner Integration Works

### Lead Flow Process
1. **Lead Ingestion** → Platform receives leads from Facebook ads, landing pages, etc.
2. **Smart Routing** → System selects optimal partner based on:
   - Country matching
   - Niche specialization (forex/recovery)
   - Daily limit availability
   - Premium/raw lead ratios
3. **Transformation** → Lead data formatted to partner requirements
4. **Secure Delivery** → POST request sent to partner's webhook URL

---

## 📋 Adding New Partners

### Required Information
Partners must provide:

**Basic Details:**
- Company name and contact email
- Target country for leads
- Niche focus (forex or recovery)
- Daily lead capacity limit
- Premium lead percentage preference

**Integration Settings:**
- **Webhook URL** (HTTPS required for security)
- **Phone number format** preference
- **Required fields** list
- Any special transformation needs

### Partner Setup Process

1. **Access Admin Dashboard** → Navigate to Partners section
2. **Click "Add Partner"** → Opens integration form
3. **Fill Basic Information:**
   ```
   Partner Name: FX Trading Partners Ltd
   Email: integration@fxpartners.com
   Country: germany
   Niche: forex
   Daily Limit: 50
   Premium Ratio: 70%
   Timezone: Europe/Berlin
   ```

4. **Configure Integration:**
   ```
   Webhook URL: https://fxpartners.com/api/leads
   Phone Format: International (+1234567890)
   Required Fields: name,email,phone,country
   ```

5. **Save Partner** → System validates webhook URL and creates integration

---

## 🔧 Webhook Requirements

### Security Standards
- **HTTPS Only** - No HTTP URLs accepted (prevents data interception)
- **Public Endpoints** - No localhost or private IP addresses
- **Valid SSL** - Certificate must be trusted

### Payload Format
Partners receive lead data via POST request:

```json
{
  "lead_id": "12345",
  "name": "John Smith",
  "email": "john.smith@email.com",
  "phone": "+491234567890",
  "country": "germany",
  "niche": "forex",
  "lead_type": "premium",
  "source": "facebook_ads",
  "timestamp": "2025-09-23T22:55:13.207Z"
}
```

### Phone Number Formats
- **International**: `+491234567890`
- **National**: `491234567890`
- **Local**: `49-123-456-7890`

---

## 🎯 Partner Integration Examples

### Example 1: Basic Forex Partner
```
Name: "German FX Solutions"
Country: germany
Niche: forex
Webhook: https://germanfx.com/webhook/leads
Required Fields: name,email,phone,country
Phone Format: International
```

### Example 2: Recovery Partner with Custom Fields
```
Name: "Recovery Specialists Spain"
Country: spain
Niche: recovery
Webhook: https://recovery-es.com/api/new-lead
Required Fields: name,lastname,email,phone,country,amount_lost,fraud_type
Phone Format: Local
```

---

## 🛠️ Technical Implementation

### Database Schema
Partners are stored with integration configuration:
- `webhook_url` - Secure HTTPS endpoint
- `phone_format` - Format preference
- `required_fields` - JSON array of needed fields
- `field_mapping` - Custom field name mapping
- `default_values` - Static values to include

### Webhook Delivery
- **Retry Logic** - Failed deliveries retry automatically
- **Timeout Handling** - 30-second response timeout
- **Error Logging** - Failed deliveries tracked for monitoring
- **Idempotency** - Duplicate prevention via lead IDs

### Load Balancing
Partners receive leads based on:
1. Current daily lead count (lowest first)
2. Random selection for ties
3. Business hours compliance
4. Premium/raw ratio requirements

---

## 🔐 Security Features

### SSRF Protection
- Webhook URLs validated for security
- Private IP ranges blocked
- Only HTTPS protocol allowed

### Data Privacy
- Secure transmission via HTTPS
- No sensitive data logged
- Partner isolation maintained

---

## 📊 Monitoring & Analytics

### Partner Performance Tracking
- Daily lead distribution counts
- Conversion rate monitoring
- Revenue attribution
- Delivery success rates

### System Health
- Webhook delivery status
- Failed delivery tracking
- Partner response time monitoring
- Load distribution analytics

---

## 🚨 Troubleshooting

### Common Integration Issues

**Webhook URL Invalid:**
- Ensure URL uses HTTPS protocol
- Verify domain is publicly accessible
- Check SSL certificate validity

**Missing Leads:**
- Verify partner daily limits not exceeded
- Check business hours configuration
- Confirm country/niche matching

**Failed Deliveries:**
- Monitor webhook response codes
- Check partner endpoint availability
- Review retry attempt logs

### Support Contacts
For integration issues, partners should provide:
- Webhook URL being used
- Expected lead format
- Error messages received
- Integration timeline requirements

---

## 🔄 Deployment Notes

### Environment Variables
Required for production:
```
DATABASE_URL=postgresql://...
SESSION_SECRET=secure_random_string
POSTMARK_SERVER_TOKEN=email_service_token
POSTMARK_FROM_EMAIL=noreply@yourdomain.com
```

### Migration Commands
```bash
# Deploy schema changes
npm run db:push

# Force migration if needed
npm run db:push --force
```

### Production Checklist
- [ ] Environment variables configured
- [ ] Database migrations applied
- [ ] HTTPS webhook validation enabled
- [ ] Partner notification emails working
- [ ] Analytics tracking operational
- [ ] Backup systems verified

---

*This documentation covers the complete partner integration system for the Lead Distribution Platform deployed on Render. Partners can be added through the admin interface with their webhook URLs and field requirements, enabling automatic lead distribution with smart routing and transformation.*