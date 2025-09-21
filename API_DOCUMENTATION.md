# Lead Distribution Platform - API Documentation

## Overview
Complete API documentation for external integrations, lead tracking, and CPA optimization.

---

## 🔐 Authentication

### Webhook Token Authentication
All webhook endpoints require a unique token for security:
- **Token Location**: URL parameter or header
- **Token Format**: 64-character hexadecimal string
- **Verification**: Server validates token against active webhook sources

---

## 📥 Inbound Webhooks (Receiving Leads)

### POST `/api/webhook/{token}`
Receive leads from external sources (Facebook, landing pages, etc.)

#### Headers
```
Content-Type: application/json
```

#### URL Parameters
- `token` (required): Webhook authentication token

#### Request Body Examples

**Facebook Lead Ads:**
```json
{
  "first_name": "John",
  "last_name": "Doe", 
  "email": "john.doe@example.com",
  "phone": "+1234567890",
  "country": "germany",
  "niche": "forex",
  "type": "raw"
}
```

**Landing Page:**
```json
{
  "first_name": "Jane",
  "last_name": "Smith",
  "email": "jane.smith@example.com", 
  "phone": "+9876543210",
  "country": "canada",
  "niche": "recovery",
  "type": "premium"
}
```

#### Response
```json
{
  "success": true,
  "lead_id": 123,
  "message": "Lead received and queued for distribution"
}
```

#### Error Responses
- `401`: Invalid webhook token
- `500`: Server processing error

---

## 📊 Conversion Tracking (CPA Optimization)

### POST `/api/conversion/{partnerId}`
Partners report lead conversions for CPA tracking

#### Headers
```
Content-Type: application/json
Authorization: Bearer {partner_api_key} // Optional
```

#### URL Parameters  
- `partnerId` (required): Partner ID from the system

#### Request Body
```json
{
  "lead_id": 123,
  "conversion_type": "deposit", // qualified|demo|deposit|sale
  "conversion_value": 250.00,
  "external_transaction_id": "TXN_ABC123",
  "metadata": {
    "campaign_id": "CAMP_456",
    "utm_source": "google_ads",
    "deposit_amount": 250.00
  }
}
```

#### Conversion Types & Quality Scores
- **qualified**: 25 points - Lead showed interest
- **demo**: 50 points - Completed demo/consultation  
- **deposit**: 75 points - Made initial deposit
- **sale**: 100 points - Completed full conversion

#### Response
```json
{
  "success": true,
  "message": "Conversion recorded successfully",
  "lead_id": 123,
  "conversion_type": "deposit", 
  "total_value": 250.00
}
```

### Legacy Postback: POST `/api/postback/{partner_id}`
Simple conversion tracking (maintained for backwards compatibility)

#### Request Body
```json
{
  "lead_id": 123,
  "status": "converted", 
  "value": 250.00,
  "data": {}
}
```

---

## 🔍 Real-Time Lead Status Tracking

### GET `/api/lead/{leadId}/status`
Get comprehensive lead status and conversion history

#### Response
```json
{
  "success": true,
  "lead": {
    "id": 123,
    "email": "john.doe@example.com",
    "status": "distributed",
    "quality_score": 75,
    "conversion_value": 250.00,
    "converted_at": "2024-12-21T10:30:00Z",
    "partner_name": "TestPartner",
    "status_history": [
      {
        "status": "qualified",
        "timestamp": "2024-12-21T09:00:00Z",
        "value": 0,
        "external_id": null
      },
      {
        "status": "deposit", 
        "timestamp": "2024-12-21T10:30:00Z",
        "value": 250.00,
        "external_id": "TXN_ABC123"
      }
    ],
    "conversions": [
      {
        "id": 1,
        "conversion_type": "deposit",
        "conversion_value": 250.00,
        "external_transaction_id": "TXN_ABC123",
        "created_at": "2024-12-21T10:30:00Z"
      }
    ],
    "conversion_count": 1
  }
}
```

---

## 📈 CPA Analytics API

### GET `/api/analytics/cpa`
Get real-time CPA performance metrics

#### Query Parameters
- `partner_id` (optional): Filter by specific partner
- `date_from` (optional): Start date (YYYY-MM-DD)
- `date_to` (optional): End date (YYYY-MM-DD)

#### Response
```json
{
  "success": true,
  "analytics": [
    {
      "partner_id": 1,
      "partner_name": "TestPartner", 
      "total_leads": 100,
      "conversions": 25,
      "revenue": 6250.00,
      "avg_quality_score": 67.5,
      "high_quality_leads": 18,
      "conversion_rate": 25.00,
      "avg_conversion_value": 250.00
    }
  ],
  "summary": {
    "total_partners": 3,
    "total_leads": 250, 
    "total_conversions": 45,
    "total_revenue": 11250.00,
    "overall_conversion_rate": 18.00
  }
}
```

---

## 🏆 Best Practices

### Security
- ✅ Always use HTTPS endpoints
- ✅ Validate webhook tokens server-side
- ✅ Implement rate limiting on your end
- ✅ Log all webhook events for debugging

### Error Handling  
- ✅ Implement exponential backoff for retries
- ✅ Set reasonable timeout limits (30 seconds)
- ✅ Handle HTTP 4xx/5xx responses appropriately
- ✅ Use idempotent operations where possible

### Data Quality
- ✅ Validate email format and phone numbers
- ✅ Normalize country codes (use lowercase)
- ✅ Set realistic conversion values
- ✅ Include relevant metadata for tracking

---

## 🔄 Integration Flow Example

### Complete CPA Tracking Workflow

1. **Lead Reception**
   ```
   External Source → POST /api/webhook/{token}
   → Lead Created → Auto-distributed to Partner
   ```

2. **Partner Processing**  
   ```
   Partner receives lead → Processes → Converts → Reports back
   ```

3. **Conversion Reporting**
   ```
   Partner → POST /api/conversion/{partnerId}
   → Lead status updated → CPA metrics updated
   ```

4. **Real-time Monitoring**
   ```
   Monitor via GET /api/lead/{id}/status
   → Track CPA performance via GET /api/analytics/cpa
   ```

---

## 📞 Support

### Webhook Testing
Use tools like:
- **Postman**: API testing and webhook simulation
- **ngrok**: Local development tunneling  
- **Webhook.site**: Test webhook delivery

### Common Issues
- **401 Unauthorized**: Check webhook token validity
- **404 Not Found**: Verify partner ID and lead assignment
- **500 Server Error**: Check payload format and required fields

### Rate Limits
- **Inbound Webhooks**: 100 requests/minute per token
- **Conversion Tracking**: 50 requests/minute per partner  
- **Analytics API**: 20 requests/minute

---

*This documentation is maintained for the Lead Distribution Platform CPA tracking system.*