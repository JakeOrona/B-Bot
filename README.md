# Twitter/X Image Scraper

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8.3-blue.svg)
![Playwright](https://img.shields.io/badge/Playwright-1.53.1-green.svg)

A professional-grade Twitter/X image scraper built with TypeScript and Playwright. This tool automates downloading images from multiple Twitter/X profiles with concurrent processing, comprehensive error handling, and optional Google Drive integration.

## 🚀 Features

### Core Capabilities
- **Concurrent Profile Processing**: Process multiple Twitter profiles simultaneously for faster extraction
- **Google Drive Integration**: Automatically upload images to custom folder structures
- **Advanced Logging System**: Dual-mode output with worker context, progress bars, and separate log files
- **Robust Error Handling**: Comprehensive retry logic, rate limiting, and account status detection
- **CLI Operation Modes**: Full mode, scrape-only, upload-only, debug-drive

### Advanced Features
- **Session Management**: Cookie-based authentication with 2FA support
- **Rate Limiting Protection**: Configurable delays to avoid API rate limits
- **Semaphore-Controlled Operations**: Optimal resource utilization for downloads and uploads
- **Automatic Cleanup**: File management policies and duplicate detection
- **Extensive Configuration**: Fine-tune behavior via environment variables
- **Testing Framework**: Comprehensive Playwright test suite

## 🏗️ Project Structure

```
src/
├── pageObjects/          # Page Object Model classes
│   ├── BasePage.ts       # Base page with common browser actions
│   ├── TwitterAuth.ts    # Twitter authentication handling
│   └── TwitterScraper.ts # Core Twitter scraping functionality
├── utilities/            # Utility classes
│   ├── ConfigManager.ts           # Configuration management
│   ├── ConcurrentProfileManager.ts # Concurrent profile processing
│   ├── ExtractionWorker.ts        # Worker for extraction tasks
│   ├── GoogleDriveUploader.ts     # Google Drive integration
│   ├── ImageDownloader.ts         # Image download management
│   ├── ProfileQueue.ts            # Queue for profile processing
│   ├── ProgressLogger.ts          # Enhanced logging with progress bars
│   ├── Logger.ts                  # Basic logging functionality
│   ├── Semaphore.ts               # Concurrent operation limiting
│   ├── FileCleanup.ts             # File management utilities
│   └── ConsoleMutex.ts            # Console output synchronization
├── interfaces/           # TypeScript interfaces
│   ├── ConcurrentTypes.ts  # Types for concurrent processing
│   └── ScraperTypes.ts     # Core scraper type definitions
├── tests/               # Test suites
│   └── scraper.spec.ts  # Playwright tests
├── demo/                # Demonstration code
│   └── progressLoggerDemo.ts  # Demo for progress logger
└── index.ts             # Main entry point
```

## 🖥️ Installation

### Prerequisites
- Node.js (v16+)
- npm (v7+)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/twitter-image-scraper.git
   cd twitter-image-scraper
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install Playwright browsers**
   ```bash
   npx playwright install chromium
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Configure the scraper**
   ```bash
   # The first run will create default config files
   npm start
   ```

## 🛠️ Usage

### Operation Modes

#### Full Process (Scrape + Upload)
```bash
npm start
# or with timeout
npm start -- --timeout 120
```

#### Scrape Only (No Google Drive upload)
```bash
npm run scrape
# or
npm start -- --mode scrape-only
```

#### Upload Only (Upload existing images)
```bash
npm run upload
# or  
npm start -- --mode upload-only
```

#### Debug Google Drive Configuration
```bash
npm run debug-drive
# or
npm start -- --debug-drive
```

#### Display Help
```bash
npm run help
```

## 🧪 Development & Testing

### Development Mode
```bash
npm run dev
```

### Run Tests
```bash
npm test                 # Run all tests
npm run test:ui          # Run tests with UI
npm run test:debug       # Run tests in debug mode
npm run test:headed      # Run tests in headed browser
```

### Progress Logger Demo
```bash
npm run demo:logger
```

## ⚙️ Configuration

Configuration files are automatically created in the `config` directory on first run:

### 1. Twitter Profiles (`config/artists.txt`)
```
# Add Twitter/X artist usernames below (one per line)
# Lines starting with # are comments and will be ignored
artist1
artist2
artist3
```

### 2. Environment Variables (`config/.env`)

```
# Twitter/X Authentication
TWITTER_USERNAME=your_username
TWITTER_PASSWORD=your_password

# Scraper Configuration
HEADLESS=true
DELAY_BETWEEN_SCROLLS=1000
MAX_SCROLLS=10
RATE_LIMIT_DELAY=2000
MAX_RETRIES=3
RETRY_DELAY=5000

# Upload Configuration
UPLOAD_BATCH_SIZE=10
MAX_CONCURRENT_UPLOADS=3

# Logging Configuration
LOG_MODE=concise                # 'concise' | 'verbose'
SHOW_PROGRESS_BARS=true
LOG_TO_FILE=true
SEPARATE_LOG_FILES=true         # Creates separate verbose and concise log files

# Google Drive Configuration
GOOGLE_DRIVE_ENABLED=false
GOOGLE_DRIVE_CREDENTIALS_PATH=config/google-service-account.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_root_folder_id_here

# Concurrent Processing Configuration
ENABLE_CONCURRENT_PROCESSING=true
MAX_CONCURRENT_PROFILES=3
EXTRACTION_TIMEOUT_MS=300000
QUEUE_MAX_SIZE=100
```

### Logging Modes

- **Concise Mode** (default): Shows progress bars for downloads and uploads with minimal text output
- **Verbose Mode**: Shows detailed log messages for each action without progress bars

You can test the logging system without running the full scraper:

```bash
npm run demo:logger   # Demonstrates progress bars and logging features
```

## 🔄 Architecture & Design Patterns

The scraper implements several design patterns for maintainability and extensibility:

- **Page Object Model**: Separates page interactions from business logic
- **Singleton Pattern**: Used for ConfigManager, Logger, and ProgressLogger
- **Factory Pattern**: Dynamic progress bar creation
- **Semaphore Pattern**: Controls concurrent operations
- **Observer Pattern**: Queue event handling

## 🔒 Google Drive Integration

### Setting Up Google Drive

1. **Create a Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project

2. **Enable the Google Drive API**
   - Navigate to "APIs & Services" > "Library"
   - Search for "Google Drive API" and enable it

3. **Create a Service Account**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in the details and create the account

4. **Generate Service Account Key**
   - Click on the created service account
   - Go to "Keys" tab > "Add Key" > "Create New Key"
   - Choose JSON and download
   - Save as `config/google-service-account.json`

5. **Create a Folder in Google Drive**
   - Create a folder in your Google Drive
   - Right-click, select "Share"
   - Add the service account's email with "Editor" permission

6. **Get the Folder ID**
   - Open the folder in your browser
   - The URL will be like: `https://drive.google.com/drive/folders/FOLDER_ID`
   - Copy the `FOLDER_ID` and add it to your `.env` file as `GOOGLE_DRIVE_ROOT_FOLDER_ID`

7. **Enable in Configuration**
   - Set `GOOGLE_DRIVE_ENABLED=true` in your `.env` file

8. **Test Configuration**
   ```bash
   npm run debug-drive
   ```

## 🔍 Troubleshooting

### Authentication Issues
- Ensure your Twitter credentials are correct
- Check if your account has 2FA enabled and handle it during the authentication process
- If login consistently fails, try running in non-headless mode (`HEADLESS=false`) to see what's happening

### Rate Limiting
- Increase `RATE_LIMIT_DELAY` and `DELAY_BETWEEN_SCROLLS` values
- Reduce `MAX_CONCURRENT_PROFILES` to minimize parallel requests

### Google Drive Errors
- Verify the service account has appropriate permissions
- Check that the Root Folder ID is correct
- Run `npm run debug-drive` to test the Google Drive connection

### Private or Suspended Accounts
- The scraper automatically detects and skips private or suspended accounts
- Check the logs for notifications about these accounts

### Infinite Loops or Hanging
- Set a reasonable `--timeout` value to ensure the process exits
- Check the `EXTRACTION_TIMEOUT_MS` setting to prevent individual worker hangs
- The scraper includes multiple safeguards against infinite loops:
  - Idle iteration counters
  - Maximum runtime limits
  - Stall detection
  - Global process timeouts

## 🛡️ Security Considerations

- **Credential Management**: Store credentials securely; never commit `.env` files
- **Rate Limiting**: Respect Twitter's rate limits to avoid account restrictions
- **Google API Permissions**: Use the principle of least privilege for service accounts
- **File Access**: Be aware of file permissions when downloading media

## � Advanced Logging System

The project incorporates a sophisticated logging architecture designed specifically for concurrent operations:

### Features

- **Dual-Mode Output**: Choose between concise (progress bars) or verbose (detailed logs) modes
- **Worker Context Logging**: All logs include worker identification (`[Worker#1:@username]`)
- **Progress Bars**:
  - Scrolling: `███████████░░░░░░░ | Scrolling @user1 | 15/50 | 30% | ETA: 15s`
  - Download: `████████████████░░░ | Download @user2 | 25/30 | 83% | ETA: 5s`
  - Upload: `██████░░░░░░░░░░░░░░░ | Upload @user1 B1 | 6/20 | 30% | ETA: 45s`
- **Dual-File Logging**: Separate log files for concise and verbose information:
  - `logs/scraper-${timestamp}.log`: Detailed debug logs
  - `logs/scraper-${timestamp}-concise.log`: Progress summaries
- **Thread-Safe Console Output**: Uses `ConsoleMutex` to prevent progress bar corruption

See the [Advanced Logging Documentation](docs/ADVANCED_LOGGING.md) for complete details.

## �📝 License

This project is licensed under the ISC License.

## ⚠️ Disclaimer

This tool is for educational purposes only. Please respect Twitter's Terms of Service and rate limitations when using this scraper. Always ensure you have permission to download and use images from the respective artists.

## 🙏 Acknowledgements

- [Playwright](https://playwright.dev/) - Browser automation library
- [cli-progress](https://www.npmjs.com/package/cli-progress) - Progress bar rendering
- [Google Drive API](https://developers.google.com/drive) - Cloud storage integration
