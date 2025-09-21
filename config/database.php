<?php

class Database {
    private $host;
    private $dbname;
    private $username;
    private $password;
    private $port;
    private $pdo;
    
    public function __construct() {
        // Use PostgreSQL from Replit environment
        $this->host = $_ENV['PGHOST'] ?? 'localhost';
        $this->dbname = $_ENV['PGDATABASE'] ?? 'leadagency';
        $this->username = $_ENV['PGUSER'] ?? 'postgres';
        $this->password = $_ENV['PGPASSWORD'] ?? '';
        $this->port = $_ENV['PGPORT'] ?? '5432';
    }
    
    public function connect() {
        if ($this->pdo === null) {
            try {
                $dsn = "pgsql:host={$this->host};port={$this->port};dbname={$this->dbname}";
                $this->pdo = new PDO($dsn, $this->username, $this->password, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                ]);
            } catch(PDOException $e) {
                throw new Exception("Connection failed: " . $e->getMessage());
            }
        }
        return $this->pdo;
    }
    
    public function createTables() {
        $sql = "
        -- Partners table
        CREATE TABLE IF NOT EXISTS partners (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            country VARCHAR(50) NOT NULL,
            niche VARCHAR(50) NOT NULL CHECK (niche IN ('forex', 'recovery')),
            webhook_url TEXT NOT NULL,
            daily_limit INTEGER DEFAULT 50,
            premium_ratio DECIMAL(3,2) DEFAULT 0.70,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused')),
            timezone VARCHAR(50) DEFAULT 'UTC',
            business_hours_start TIME DEFAULT '09:00:00',
            business_hours_end TIME DEFAULT '18:00:00',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Leads table
        CREATE TABLE IF NOT EXISTS leads (
            id SERIAL PRIMARY KEY,
            source VARCHAR(100) NOT NULL,
            type VARCHAR(20) NOT NULL CHECK (type IN ('premium', 'raw')),
            niche VARCHAR(50) NOT NULL CHECK (niche IN ('forex', 'recovery')),
            country VARCHAR(50) NOT NULL,
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            email VARCHAR(255),
            phone VARCHAR(50),
            data JSON,
            status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'distributed', 'converted', 'failed')),
            assigned_partner_id INTEGER REFERENCES partners(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            distributed_at TIMESTAMP,
            converted_at TIMESTAMP
        );
        
        -- Webhooks table for tracking deliveries
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES leads(id),
            partner_id INTEGER REFERENCES partners(id),
            webhook_url TEXT NOT NULL,
            payload JSON,
            response_code INTEGER,
            response_body TEXT,
            attempts INTEGER DEFAULT 1,
            status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'retry')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            delivered_at TIMESTAMP
        );
        
        -- Distribution tracking
        CREATE TABLE IF NOT EXISTS distribution_stats (
            id SERIAL PRIMARY KEY,
            partner_id INTEGER REFERENCES partners(id),
            date DATE DEFAULT CURRENT_DATE,
            leads_received INTEGER DEFAULT 0,
            premium_leads INTEGER DEFAULT 0,
            raw_leads INTEGER DEFAULT 0,
            conversions INTEGER DEFAULT 0,
            revenue DECIMAL(10,2) DEFAULT 0.00,
            UNIQUE(partner_id, date)
        );
        
        -- Conversion tracking via postbacks
        CREATE TABLE IF NOT EXISTS conversions (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES leads(id),
            partner_id INTEGER REFERENCES partners(id),
            conversion_value DECIMAL(10,2),
            conversion_data JSON,
            postback_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Webhook sources for inbound leads
        CREATE TABLE IF NOT EXISTS webhook_sources (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            source_type VARCHAR(50) NOT NULL,
            webhook_token VARCHAR(255) UNIQUE NOT NULL,
            is_active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Create indexes for performance
        CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_niche_country ON leads(niche, country);
        CREATE INDEX IF NOT EXISTS idx_partners_country_niche ON partners(country, niche, status);
        CREATE INDEX IF NOT EXISTS idx_distribution_stats_date ON distribution_stats(date);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
        ";
        
        $this->connect()->exec($sql);
        return true;
    }
}
?>