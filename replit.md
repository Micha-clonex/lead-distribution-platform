# Overview

The Lead Distribution Platform is a multi-country lead management system designed for distributing leads between partners in the forex and recovery niches. The platform serves as a central hub that receives leads from various sources (Facebook, landing pages, etc.) and intelligently distributes them to active partners based on country, niche, daily limits, and premium/raw lead ratios.

The system features a web-based admin dashboard for managing partners, monitoring lead distribution, tracking performance analytics, and managing webhook integrations. It includes automated webhook delivery with retry mechanisms, session-based authentication, and comprehensive analytics reporting.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Backend Architecture
- **Node.js/Express**: Core server framework with EJS templating for server-side rendering
- **PostgreSQL**: Primary database for storing partners, leads, webhook deliveries, and analytics
- **Session Management**: PostgreSQL-backed sessions using express-session and connect-pg-simple
- **Authentication**: bcrypt-based password hashing with session-based admin authentication

## Lead Distribution Logic
- **Intelligent Routing**: Leads are distributed based on partner country, niche (forex/recovery), daily limits, and premium/raw ratios
- **Transaction Safety**: Database transactions ensure consistent lead assignment without race conditions
- **Load Balancing**: Partners receive leads in order of current daily load, with random tiebreaking

## Webhook System
- **Inbound Webhooks**: Token-based API endpoints for receiving leads from external sources (Facebook, landing pages)
- **Outbound Webhooks**: Reliable delivery system with retry mechanisms and idempotency protection
- **Delivery Tracking**: Comprehensive logging of webhook attempts, responses, and failures

## Analytics and Monitoring
- **Real-time Stats**: Partner performance tracking with conversion rates and revenue metrics
- **Daily Aggregation**: Distribution statistics collected daily for reporting and analytics
- **Performance Dashboards**: Web-based interface for monitoring partner performance and system health

## Data Models
- **Partners**: Multi-country partners with configurable daily limits, premium ratios, and business hours
- **Leads**: Structured lead data with type classification (premium/raw) and distribution tracking
- **Webhook Sources**: Configurable inbound webhook endpoints with token-based authentication
- **Distribution Stats**: Daily aggregated metrics for partner performance analysis

## Scheduled Tasks
- **Webhook Retry**: Automated retry system using node-cron for failed webhook deliveries
- **Analytics Processing**: Daily aggregation of distribution statistics and performance metrics

# External Dependencies

## Core Runtime
- **Node.js**: JavaScript runtime environment (v18+)
- **PostgreSQL**: Primary database for all persistent data storage

## HTTP and API Integration
- **Axios**: HTTP client for outbound webhook delivery and external API calls
- **Guzzle HTTP**: PHP HTTP client (legacy component, may be unused)

## Security and Authentication
- **bcryptjs**: Password hashing for admin user authentication
- **jsonwebtoken**: JWT token generation (currently used for webhook tokens)
- **express-session**: Session management middleware

## Background Processing
- **node-cron**: Task scheduler for webhook retries and daily analytics processing
- **connect-pg-simple**: PostgreSQL session store integration

## Development Tools
- **dotenv**: Environment variable management
- **multer**: File upload middleware (configured but may be unused)
- **cors**: Cross-origin request handling for API endpoints

## Email Integration
- **PHPMailer**: Email sending capabilities (PHP component, may be legacy)

The platform is designed to handle high-volume lead processing with robust error handling, transaction safety, and comprehensive monitoring capabilities.