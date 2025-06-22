#!/usr/bin/env node
/**
 * Test script to demonstrate the progress logger in different configurations
 * 
 * This script allows testing the progress logger with different settings
 * without having to modify the .env file each time
 * 
 * Usage:
 *   node test-logger.js [--verbose|--concise] [--bars|--no-bars] [--file|--no-file]
 */

const { spawn } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);

// Default settings
let logMode = 'concise';
let showBars = true;
let logToFile = true;

// Process arguments
args.forEach(arg => {
  if (arg === '--verbose') logMode = 'verbose';
  if (arg === '--concise') logMode = 'concise';
  if (arg === '--bars') showBars = true;
  if (arg === '--no-bars') showBars = false;
  if (arg === '--file') logToFile = true;
  if (arg === '--no-file') logToFile = false;
});

// Help text if needed
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node test-logger.js [OPTIONS]

Test the progress logger with different configurations.

Options:
  --verbose       Use verbose logging mode
  --concise       Use concise logging mode (default)
  --bars          Show progress bars (default)
  --no-bars       Hide progress bars
  --file          Log to file (default)
  --no-file       Don't log to file
  --help, -h      Show this help message

Examples:
  node test-logger.js --verbose --no-bars
  node test-logger.js --concise --bars
  `);
  process.exit(0);
}

// Read current .env file
const envPath = path.join(process.cwd(), 'config', '.env');
let envContent;

try {
  envContent = readFileSync(envPath, 'utf8');
} catch (error) {
  console.error(`Error reading .env file: ${error.message}`);
  console.error('Make sure you are running this script from the project root directory');
  process.exit(1);
}

// Create temporary environment variables
const env = { ...process.env };

// Set logging configuration for the test
env.LOG_MODE = logMode;
env.SHOW_PROGRESS_BARS = showBars ? 'true' : 'false';
env.LOG_TO_FILE = logToFile ? 'true' : 'false';

// Show configuration
console.log('\nRunning progress logger test with:');
console.log(`  LOG_MODE = ${logMode}`);
console.log(`  SHOW_PROGRESS_BARS = ${showBars}`);
console.log(`  LOG_TO_FILE = ${logToFile}\n`);

// Run the demo script with these settings
const demo = spawn('npx', ['ts-node', 'src/demo/progressLoggerDemo.ts'], {
  env,
  stdio: 'inherit'
});

demo.on('close', code => {
  if (code !== 0) {
    console.error(`Demo process exited with code ${code}`);
  }
});
