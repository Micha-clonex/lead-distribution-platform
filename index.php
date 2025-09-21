<?php
require_once 'vendor/autoload.php';
require_once 'config/database.php';

// Load environment variables
$dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
$dotenv->load();

// Start session
session_start();

// Simple routing
$request = $_SERVER['REQUEST_URI'];
$path = parse_url($request, PHP_URL_PATH);

switch ($path) {
    case '/':
        require 'views/dashboard.php';
        break;
    case '/partners':
        require 'views/partners.php';
        break;
    case '/leads':
        require 'views/leads.php';
        break;
    case '/webhooks':
        require 'views/webhooks.php';
        break;
    case '/analytics':
        require 'views/analytics.php';
        break;
    case '/api/webhook':
        require 'api/webhook.php';
        break;
    case '/api/postback':
        require 'api/postback.php';
        break;
    case '/api/distribute':
        require 'api/distribute.php';
        break;
    default:
        http_response_code(404);
        echo "404 Not Found";
        break;
}
?>