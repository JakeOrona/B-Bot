# Twitter/X Image Scraper

A TypeScript application using Playwright to authenticate with X/Twitter, navigate to artist profiles, extract image URLs, and download images to local storage.

## Features

- **Page Object Model Design Pattern**: Clean separation of concerns between authentication, navigation, scraping, and downloading
- **Object-Oriented Programming**: Utilizes classes and inheritance for maintainable code
- **Session Management**: Stores and reuses cookies for efficient authentication
- **Robust Error Handling**: Implements retry logic and gracefully handles various edge cases
- **Rate Limiting**: Respects Twitter's rate limits to avoid being blocked
- **Configurable**: Easy configuration through environment variables and config files
- **Progress Logger**: Dual-mode logging system with progress bars for visual feedback
  - Concise mode with real-time progress bars for downloads and uploads
  - Verbose mode with detailed logs for debugging
  - All logs saved to files regardless of display mode

## Project Structure

```
twitter-scraper/
├── src/
│   ├── pageObjects/
│   │   ├── BasePage.ts
│   │   ├── TwitterAuth.ts
│   │   └── TwitterScraper.ts
│   ├── utilities/
│   │   ├── ConfigManager.ts
│   │   ├── ImageDownloader.ts
│   │   └── Logger.ts
│   ├── interfaces/
│   │   └── ScraperTypes.ts
│   ├── tests/
│   │   └── scraper.spec.ts
│   └── index.ts
├── config/
│   ├── artists.txt
│   └── .env
└── downloads/
    └── [artist_folders]/
```

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/twitter-image-scraper.git
   cd twitter-image-scraper
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Install Playwright browsers:
   ```
   npx playwright install chromium
   ```

4. Configure the scraper by editing files in the `config/` directory:
   - `.env`: Set your Twitter credentials and scraper settings
   - `artists.txt`: Add the Twitter usernames you want to scrape

## Usage

### Running the Scraper

```
npm run build   # Compile TypeScript to JavaScript
npm start       # Start the scraper
```

### Development Mode

```
npm run dev     # Run with auto-restart on code changes
```

### Testing

```
npm test        # Run the test script
```

## Configuration

Edit the `.env` file to configure the scraper:

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

# Logging Configuration
LOG_MODE=concise           # 'concise' or 'verbose'
SHOW_PROGRESS_BARS=true    # Whether to show progress bars
LOG_TO_FILE=true           # Whether to save logs to files
```

Add Twitter usernames (one per line) to `config/artists.txt`:

```
artist1
artist2
artist3
```

### Logging Modes

- **Concise Mode** (default): Shows progress bars for downloads and uploads with minimal text output
- **Verbose Mode**: Shows detailed log messages for each action without progress bars

You can test different logging configurations without modifying your `.env` file by using:

```bash
node test-logger.js --verbose   # Test verbose mode
node test-logger.js --concise   # Test concise mode (default)
node test-logger.js --help      # Show all options
```

For more information about the advanced logging system, see [ADVANCED_LOGGING.md](docs/ADVANCED_LOGGING.md)

## How It Works

1. **Authentication**: Logs in to Twitter using provided credentials, handles 2FA if needed
2. **Navigation**: Visits each artist's profile and navigates to their Media tab
3. **Scraping**: Scrolls through the media feed, extracting image URLs and tweet IDs
4. **Downloading**: Downloads images with proper naming convention to artist-specific folders
5. **Error Handling**: Gracefully handles private accounts, suspended accounts, and network issues

## License

ISC

## Disclaimer

This tool is for educational purposes only. Please respect Twitter's Terms of Service and rate limitations when using this scraper. Always ensure you have permission to download and use images from the respective artists.
