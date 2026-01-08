# FrameConverter

A desktop application built with Tauri and React for converting image sequences (PNG, WebP, GIF, APNG) into animated formats (WebP, APNG, GIF).

## Features

- **Multiple Input Modes**: Select multiple files or an entire folder
- **Flexible Output**: Choose output directory and customize file names
- **Animation Settings**: Configure frame rate (fps) and loop count (0 = infinite)
- **Multiple Formats**: Export to WebP, APNG, or GIF (or all three)
- **Compression Options**: 
  - Local compression with quality control (1-100)
  - Optional TinyPNG API integration
- **Auto Naming**: Automatically generates output names with dimensions

## Requirements

- Node.js 18+ and npm
- Rust (latest stable version)
- For building: Platform-specific build tools (Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows)

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd FrameConverter
```

Or simply double-click `runDev.command` to automatically install dependencies and run the app!

2. Install dependencies:
```bash
npm install
```

## Development

Run the app in development mode:

```bash
npm run tauri:dev
```

## Building

Build the app for production:

```bash
npm run tauri:build
```

The built application will be in `src-tauri/target/release/` (or `src-tauri/target/release/bundle/` for installers).

## Usage

1. **Select Input**: Choose between File or Folder mode, then browse to select your image sequence
2. **Set Output**: Choose the output directory where converted files will be saved
3. **Configure Settings**:
   - Frame Rate: Default is 30 fps
   - Loop Count: Default is 0 (infinite loop)
   - Output Formats: Select one or more formats (WebP, APNG, GIF)
4. **Compression Options**:
   - **Local Compression**: Check "Use Local Compression" and set quality (1-100)
     - Higher quality = better image but larger file size
     - Works offline, no API key needed
   - **TinyPNG API** (optional): Enter your API key for cloud-based compression
     - Sign up at [TinyPNG Developer API](https://tinypng.com/developers)
     - Free tier: 500 compressions per month
5. **Convert**: Click the Convert button to start the conversion process

## Quick Start

**macOS**: Double-click `runDev.command` to automatically install dependencies and run the app!

**Manual Setup**:
1. Install dependencies: `npm install`
2. Run in development: `npm run tauri:dev`
3. Build for production: `npm run tauri:build`

## Supported Formats

### Input Formats
- PNG
- JPEG/JPG
- WebP
- GIF
- APNG

### Output Formats
- **GIF**: Full animation support with loop count and frame rate
- **APNG**: Full animation support with loop count and frame rate  
- **WebP**: Full animation support with loop count and frame rate (using libwebp)

### Compression Methods
- **Local Compression**: Uses oxipng for PNG/APNG and re-encoding for WebP
  - Quality setting: 1-100 (higher = better quality, larger file)
  - Works completely offline
- **TinyPNG API**: Cloud-based compression service
  - Requires API key
  - Free tier: 500 compressions/month

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

