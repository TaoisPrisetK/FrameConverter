use std::path::{Path, PathBuf};
use std::fs;
use std::sync::atomic::{AtomicU8, Ordering};

use image::{ImageFormat, GenericImageView};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use walkdir::WalkDir;
use thiserror::Error;
use once_cell::sync::Lazy;

// Global conversion control state
// 0 = running, 1 = paused, 2 = cancelled
static CONVERT_STATE: Lazy<AtomicU8> = Lazy::new(|| AtomicU8::new(0));

#[cfg(unix)]
fn symlink_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(not(unix))]
fn symlink_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Best-effort fallback on non-unix platforms
    fs::hard_link(src, dst).or_else(|_| fs::copy(src, dst).map(|_| ()))
}

fn make_unique_temp_dir(prefix: &str) -> Result<PathBuf, std::io::Error> {
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let base = std::env::temp_dir().join(format!("frame_converter_{}_{}_{}", prefix, pid, ts));
    fs::create_dir_all(&base)?;
    Ok(base)
}

fn prepare_ffmpeg_sequence_input(frame_paths: &[String], prefix: &str) -> Result<(PathBuf, String), ConverterError> {
    if frame_paths.is_empty() {
        return Err(ConverterError::InvalidFormat("No frames".to_string()));
    }

    let first_ext = Path::new(&frame_paths[0])
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();

    // If mixed extensions, sequence input becomes unreliable; caller should fall back.
    for p in frame_paths.iter().skip(1) {
        let ext = Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != first_ext {
            return Err(ConverterError::InvalidFormat("Mixed input extensions; cannot use sequence input".to_string()));
        }
    }

    let seq_dir = make_unique_temp_dir(prefix)?;
    for (idx, src) in frame_paths.iter().enumerate() {
        let dst = seq_dir.join(format!("frame_{:06}.{}", idx + 1, first_ext));
        let src_path = Path::new(src);
        // Best effort: if symlink fails (rare), fall back to hardlink/copy via symlink_file()
        symlink_file(src_path, &dst)?;
    }

    let pattern = seq_dir.join(format!("frame_%06d.{}", first_ext)).to_string_lossy().to_string();
    Ok((seq_dir, pattern))
}

fn spawn_ffmpeg_with_progress(
    ffmpeg: &str,
    mut args: Vec<String>,
    app: &tauri::AppHandle,
    total: usize,
    format: &str,
) -> Result<(std::process::Child, std::thread::JoinHandle<()>), ConverterError> {
    // Ensure progress is emitted via stdout key=value lines
    args.push("-progress".to_string());
    args.push("pipe:1".to_string());

    let mut child = std::process::Command::new(ffmpeg)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ConverterError::InvalidFormat(format!("Failed to spawn FFmpeg: {}", e)))?;

    let stdout = child.stdout.take();
    let app_clone = app.clone();
    let format_s = format.to_string();

    let reader_thread = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut last_frame: usize = 0;
            for line in reader.lines().flatten() {
                if let Some(v) = line.strip_prefix("frame=") {
                    if let Ok(frame_num) = v.trim().parse::<usize>() {
                        if frame_num != last_frame {
                            last_frame = frame_num;
                            let percent = if frame_num >= total {
                                100.0
                            } else {
                                (frame_num as f64 / total as f64 * 100.0).min(99.5)
                            };
                            app_clone
                                .emit(
                                    "convert-progress",
                                    ConvertProgressEvent {
                                        phase: "Converting with FFmpeg".to_string(),
                                        current: frame_num.min(total),
                                        total,
                                        percent,
                                        format: Some(format_s.clone()),
                                        file: None,
                                    },
                                )
                                .ok();
                        }
                    }
                }
            }
        }
    });

    Ok((child, reader_thread))
}

fn spawn_ffmpeg_control_thread(pid: i32) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut last_state: u8 = 0;
        loop {
            let state = CONVERT_STATE.load(Ordering::SeqCst);
            if state != last_state {
                unsafe {
                    match state {
                        1 => {
                            let _ = libc::kill(pid, libc::SIGSTOP);
                        }
                        0 => {
                            let _ = libc::kill(pid, libc::SIGCONT);
                        }
                        2 => {
                            let _ = libc::kill(pid, libc::SIGKILL);
                        }
                        _ => {}
                    }
                }
                last_state = state;
            }
            if state == 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    })
}

#[tauri::command]
pub fn pause_conversion() {
    let prev = CONVERT_STATE.swap(1, Ordering::SeqCst);
    log::info!("pause_conversion called, prev state: {}", prev);
}

#[tauri::command]
pub fn resume_conversion() {
    let prev = CONVERT_STATE.swap(0, Ordering::SeqCst);
    log::info!("resume_conversion called, prev state: {}", prev);
}

#[tauri::command]
pub fn cancel_conversion() {
    let prev = CONVERT_STATE.swap(2, Ordering::SeqCst);
    log::info!("cancel_conversion called, prev state: {}", prev);
}

fn is_cancelled() -> bool {
    CONVERT_STATE.load(Ordering::SeqCst) == 2
}

fn wait_if_paused() {
    while CONVERT_STATE.load(Ordering::SeqCst) == 1 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn check_state() -> Result<(), ConverterError> {
    wait_if_paused();
    if is_cancelled() {
        return Err(ConverterError::InvalidFormat("Conversion cancelled".to_string()));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ConverterError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("Invalid format: {0}")]
    InvalidFormat(String),
    #[error("API error: {0}")]
    Api(String),
    #[error("WebP error: {0}")]
    WebP(String),
    #[error("APNG error: {0}")]
    APNG(String),
    #[error("GIF error: {0}")]
    Gif(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub input_mode: String,
    pub input_path: String,
    pub input_paths: Option<Vec<String>>,
    pub output_dir: String,
    pub output_name: Option<String>,
    pub fps: f64,
    pub loop_count: u32,
    pub formats: Vec<String>,
    pub api_key: Option<String>,
    pub quality: Option<u8>,
    pub use_local_compression: bool,
    pub compression_quality: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameFileInfo {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub files: Vec<FrameFileInfo>,
    pub total: usize,
    pub all_same_size: bool,
    pub base_size: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertProgressEvent {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
    pub format: Option<String>,
    pub file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub format: String,
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
    pub original_size: Option<u64>,
    pub compressed_size: Option<u64>,
}

fn is_image_file(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        if let Some(ext_str) = ext.to_str() {
            let lower = ext_str.to_lowercase();
            return matches!(lower.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "apng");
        }
    }
    false
}

#[tauri::command]
pub async fn scan_frame_files(
    input_mode: String,
    input_path: String,
    input_paths: Option<Vec<String>>,
) -> Result<ScanResult, String> {
    let mut files = Vec::new();

    if input_mode == "folder" {
        let dir = PathBuf::from(&input_path);
        if !dir.exists() {
            return Err("Directory does not exist".to_string());
        }

        let mut entries: Vec<_> = WalkDir::new(&dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_image_file(e.path()))
            .collect();

        entries.sort_by_key(|e| e.path().to_string_lossy().to_string());

        for entry in entries {
            let path = entry.path();
            // Use image_dimensions() to read only header, much faster than image::open()
            if let Ok((width, height)) = image::image_dimensions(path) {
                let metadata = fs::metadata(path).ok();
                let size = metadata.map(|m| m.len()).unwrap_or(0);

                files.push(FrameFileInfo {
                    path: path.to_string_lossy().to_string(),
                    width,
                    height,
                    size,
                });
            }
        }
    } else {
        let paths = input_paths.unwrap_or_else(|| vec![input_path]);
        for path_str in paths {
            let path = PathBuf::from(&path_str);
            if !path.exists() {
                continue;
            }
            if !is_image_file(&path) {
                continue;
            }

            // Use image_dimensions() to read only header, much faster than image::open()
            if let Ok((width, height)) = image::image_dimensions(&path) {
                let metadata = fs::metadata(&path).ok();
                let size = metadata.map(|m| m.len()).unwrap_or(0);

                files.push(FrameFileInfo {
                    path: path_str,
                    width,
                    height,
                    size,
                });
            }
        }
    }

    let total = files.len();
    let all_same_size = if files.len() <= 1 {
        true
    } else {
        let first = &files[0];
        files.iter().all(|f| f.width == first.width && f.height == first.height)
    };

    let base_size = files.first().map(|f| (f.width, f.height));

    Ok(ScanResult {
        files,
        total,
        all_same_size,
        base_size,
    })
}

// Get FFmpeg path - prioritize bundled version
fn get_ffmpeg_path() -> Option<String> {
    // Try development path first (most reliable in dev mode)
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("ffmpeg");
    if dev_path.exists() {
        // Verify the file is actually executable
        let test_result = std::process::Command::new(&dev_path)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if matches!(test_result, Ok(status) if status.success()) {
        log::info!("Found FFmpeg at dev path: {:?}", dev_path);
        return Some(dev_path.to_string_lossy().to_string());
        } else {
            log::warn!("FFmpeg at dev path exists but is not executable: {:?}", dev_path);
        }
    }
    
    // Try production path
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let resources_path = parent.parent()
                .map(|p| p.join("Resources").join("bin").join("ffmpeg"));
            
            if let Some(path) = resources_path {
                if path.exists() {
                    // Verify the file is actually executable
                    if std::process::Command::new(&path)
                        .arg("-version")
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false)
                    {
                    log::info!("Found FFmpeg at resources path: {:?}", path);
                    return Some(path.to_string_lossy().to_string());
                    } else {
                        log::warn!("FFmpeg at resources path exists but is not executable: {:?}", path);
                    }
                }
            }
        }
    }
    
    // Fallback to system FFmpeg
    let system_paths = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg", 
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ];
    
    for path in system_paths {
        let test_result = std::process::Command::new(path)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if matches!(test_result, Ok(status) if status.success()) {
            log::info!("Found FFmpeg at system path: {}", path);
            return Some(path.to_string());
        }
    }
    
    log::warn!("FFmpeg not found, will use Rust fallback");
    None
}

// Ultra-fast GIF encoder using FFmpeg with hardware acceleration
fn save_as_gif_streaming(
    frame_paths: &[String],
    output_path: &Path,
    fps: f64,
    loop_count: u32,
    app: &tauri::AppHandle,
) -> Result<(), ConverterError> {
    if frame_paths.is_empty() {
        return Err(ConverterError::InvalidFormat("No frames to encode".to_string()));
    }

    CONVERT_STATE.store(0, Ordering::SeqCst);
    let temp_path = output_path.with_extension("tmp.gif");
    let total = frame_paths.len();

    // Try FFmpeg first (much faster)
    let ffmpeg_path = get_ffmpeg_path();
    if let Some(ffmpeg) = &ffmpeg_path {
        log::info!("Using FFmpeg at: {}", ffmpeg);
        
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Converting with FFmpeg".to_string(),
            current: 0,
            total,
            percent: 0.0,
            format: Some("gif".to_string()),
            file: None,
        }).ok();

        // Build FFmpeg command with optimal settings
        let loop_arg = if loop_count == 0 { "0".to_string() } else { loop_count.to_string() };

        let (seq_dir, pattern) = match prepare_ffmpeg_sequence_input(frame_paths, "gif") {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Sequence input prep failed, falling back to Rust GIF encoder: {}", e);
                return save_as_gif_rust(frame_paths, output_path, fps, loop_count, app);
            }
        };

        let args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-nostats".into(),
            "-loglevel".into(),
            "error".into(),
            "-framerate".into(),
            format!("{}", fps).into(),
            "-start_number".into(),
            "1".into(),
            "-i".into(),
            pattern,
            "-vf".into(),
            format!(
                "fps={},split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
                fps
            ),
            "-loop".into(),
            loop_arg,
            "-threads".into(),
            "0".into(),
            temp_path.to_string_lossy().to_string(),
        ];

        let (mut child, progress_thread) = spawn_ffmpeg_with_progress(ffmpeg, args, app, total, "gif")?;
        let pid = child.id() as i32;
        let ctrl_thread = spawn_ffmpeg_control_thread(pid);

        let output = child.wait_with_output();

        // Stop control thread before joining
        CONVERT_STATE.store(2, Ordering::SeqCst);
        let _ = ctrl_thread.join();
        CONVERT_STATE.store(0, Ordering::SeqCst);

        let _ = fs::remove_dir_all(&seq_dir);

        match output {
            Ok(result) if result.status.success() => {
                let _ = progress_thread.join();
                if temp_path.exists() {
                    app.emit("convert-progress", ConvertProgressEvent {
                        phase: "Completed".to_string(),
                        current: total,
                        total,
                        percent: 100.0,
                        format: Some("gif".to_string()),
                        file: None,
                    }).ok();
                    
                    fs::rename(&temp_path, output_path)?;
                    return Ok(());
                } else {
                    log::error!("FFmpeg succeeded but output file not found");
                }
            }
            Ok(result) => {
                let _ = progress_thread.join();
                log::error!("FFmpeg failed with status: {:?}", result.status);
                if let Ok(stderr) = String::from_utf8(result.stderr) {
                    log::error!("FFmpeg stderr: {}", stderr);
                }
            }
            Err(e) => {
                let _ = progress_thread.join();
                log::error!("FFmpeg execution error: {}", e);
            }
        }
        
        let _ = fs::remove_file(&temp_path);
    } else {
        log::info!("FFmpeg not available, using Rust implementation");
    }

    // Fallback: Use Rust implementation
    save_as_gif_rust(frame_paths, output_path, fps, loop_count, app)
}

// Rust fallback GIF encoder
fn save_as_gif_rust(
    frame_paths: &[String],
    output_path: &Path,
    fps: f64,
    loop_count: u32,
    app: &tauri::AppHandle,
) -> Result<(), ConverterError> {
    use gif::{Encoder, Frame, Repeat};

    let temp_path = output_path.with_extension("tmp.gif");
    let total = frame_paths.len();

    let (width, height) = image::image_dimensions(&frame_paths[0])?;
    let width_u16: u16 = width.try_into().map_err(|_| ConverterError::InvalidFormat("Width too large for GIF".to_string()))?;
    let height_u16: u16 = height.try_into().map_err(|_| ConverterError::InvalidFormat("Height too large for GIF".to_string()))?;

    let mut file = fs::File::create(&temp_path)?;
    let mut encoder = Encoder::new(&mut file, width_u16, height_u16, &[])
        .map_err(|e| ConverterError::Gif(format!("Failed to create GIF encoder: {}", e)))?;
    
    if loop_count == 0 {
        encoder.set_repeat(Repeat::Infinite).ok();
    } else {
        encoder.set_repeat(Repeat::Finite(loop_count as u16)).ok();
    }

    let delay = (100.0 / fps) as u16;

    for (idx, path) in frame_paths.iter().enumerate() {
        wait_if_paused();
        if is_cancelled() {
            drop(encoder);
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(ConverterError::InvalidFormat("Conversion cancelled".to_string()));
        }

        let img = image::open(path)?;
        let rgba = img.to_rgba8();
        let mut rgba_vec = rgba.into_raw();
        let mut frame = Frame::from_rgba(width_u16, height_u16, &mut rgba_vec);
        frame.delay = delay;
        encoder.write_frame(&frame)
            .map_err(|e| ConverterError::Gif(format!("Failed to write frame: {}", e)))?;

        let percent = ((idx + 1) as f64 / total as f64) * 100.0;
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Encoding GIF".to_string(),
            current: idx + 1,
            total,
            percent,
            format: Some("gif".to_string()),
            file: None,
        }).ok();
    }

    drop(encoder);
    drop(file);
    fs::rename(&temp_path, output_path)?;
    Ok(())
}

// Ultra-fast animated WebP encoder using FFmpeg
fn save_as_webp_streaming(
    frame_paths: &[String],
    output_path: &Path,
    fps: f64,
    loop_count: u32,
    app: &tauri::AppHandle,
) -> Result<(), ConverterError> {
    if frame_paths.is_empty() {
        return Err(ConverterError::InvalidFormat("No frames to encode".to_string()));
    }

    CONVERT_STATE.store(0, Ordering::SeqCst);
    let temp_path = output_path.with_extension("tmp.webp");
    let total = frame_paths.len();

    // Use FFmpeg + webpmux approach: FFmpeg converts frames to static WebP, webpmux combines them
    let ffmpeg_path = get_ffmpeg_path();
    let webpmux_path = "/opt/homebrew/bin/webpmux";
    
    if ffmpeg_path.is_some() && Path::new(webpmux_path).exists() {
        log::info!("Using FFmpeg + webpmux for animated WebP");
        
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Converting frames to WebP".to_string(),
            current: 0,
            total,
            percent: 0.0,
            format: Some("webp".to_string()),
            file: None,
        }).ok();

        // Create temp directory for individual WebP frames
        let frames_dir = make_unique_temp_dir("webp_frames")?;
        let delay_ms = (1000.0 / fps) as u32;
        
        // Step 1: Convert each frame to static WebP using FFmpeg
        for (idx, frame_path) in frame_paths.iter().enumerate() {
            wait_if_paused();
            if is_cancelled() {
                let _ = fs::remove_dir_all(&frames_dir);
                return Err(ConverterError::InvalidFormat("Conversion cancelled".to_string()));
            }
            
            let frame_webp = frames_dir.join(format!("frame_{:06}.webp", idx + 1));
            
            let ffmpeg_args = vec![
                "-y".into(),
                "-i".into(),
                frame_path.clone(),
                "-vcodec".into(),
                "libwebp".into(),
                "-pix_fmt".into(),
                "yuva420p".into(),
                "-lossless".into(),
                "0".into(),
                "-quality".into(),
                "80".into(),
                "-compression_level".into(),
                "4".into(),
                frame_webp.to_string_lossy().to_string(),
            ];

            let output = std::process::Command::new(ffmpeg_path.as_ref().unwrap())
                .args(&ffmpeg_args)
                .output();

            match output {
                Ok(result) if result.status.success() => {
                    let percent = ((idx + 1) as f64 / total as f64) * 50.0; // First 50% for frame conversion
                    app.emit("convert-progress", ConvertProgressEvent {
                        phase: "Converting frames to WebP".to_string(),
                        current: idx + 1,
                        total,
                        percent,
                        format: Some("webp".to_string()),
                        file: None,
                    }).ok();
                }
                Ok(result) => {
                    let _ = fs::remove_dir_all(&frames_dir);
                    let stderr = String::from_utf8_lossy(&result.stderr);
                    return Err(ConverterError::InvalidFormat(format!("FFmpeg frame conversion failed: {}", stderr)));
                }
                Err(e) => {
                    let _ = fs::remove_dir_all(&frames_dir);
                    return Err(ConverterError::InvalidFormat(format!("FFmpeg execution error: {}", e)));
                }
            }
        }
        
        // Step 2: Use webpmux to combine frames into animated WebP
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Combining frames with webpmux".to_string(),
            current: total,
            total,
            percent: 60.0,
            format: Some("webp".to_string()),
            file: None,
        }).ok();
        
        // Build webpmux command: -frame file1 +d1 -frame file2 +d2 ... [-loop N] -o OUTPUT
        let mut webpmux_args = Vec::new();
        
        // Add all frames with delays (format: -frame file +delay_ms)
        for idx in 0..total {
            let frame_path = frames_dir.join(format!("frame_{:06}.webp", idx + 1));
            webpmux_args.push("-frame".into());
            webpmux_args.push(frame_path.to_string_lossy().to_string());
            // +di+xi+yi+mi : duration, offsets, dispose (1=background), blend omitted (default)
            webpmux_args.push(format!("+{}+0+0+1", delay_ms));
        }
        
        // Set loop count (0 = infinite loop)
        webpmux_args.push("-loop".into());
        webpmux_args.push(if loop_count == 0 { "0".into() } else { loop_count.to_string() });
        
        // Output file
        webpmux_args.push("-o".into());
        webpmux_args.push(temp_path.to_string_lossy().to_string());
        
        let mux_output = std::process::Command::new(webpmux_path)
            .args(&webpmux_args)
            .output();
        
        let _ = fs::remove_dir_all(&frames_dir);
        
        match mux_output {
            Ok(result) if result.status.success() && temp_path.exists() => {
                        app.emit("convert-progress", ConvertProgressEvent {
                            phase: "Completed".to_string(),
                            current: total,
                            total,
                            percent: 100.0,
                            format: Some("webp".to_string()),
                            file: None,
                        }).ok();
                        
                        fs::rename(&temp_path, output_path)?;
                
                        return Ok(());
                }
                Ok(result) => {
                let stderr = String::from_utf8_lossy(&result.stderr);
                log::error!("webpmux failed: {}", stderr);
                return Err(ConverterError::InvalidFormat(format!("webpmux failed: {}", stderr)));
                }
                Err(e) => {
                log::error!("webpmux execution error: {}", e);
                return Err(ConverterError::InvalidFormat(format!("webpmux execution error: {}", e)));
                }
            }
        } else {
        log::info!("FFmpeg or webpmux not available for WebP, using fallback");
    }

    // Fallback: static WebP (first frame only)
    app.emit("convert-progress", ConvertProgressEvent {
        phase: "Encoding WebP".to_string(),
        current: 1,
        total,
        percent: 50.0,
        format: Some("webp".to_string()),
        file: None,
    }).ok();

    let first_img = image::open(&frame_paths[0])?;
    first_img.save_with_format(&temp_path, ImageFormat::WebP)?;
    fs::rename(&temp_path, output_path)?;
    
    app.emit("convert-progress", ConvertProgressEvent {
        phase: "Completed".to_string(),
        current: total,
        total,
        percent: 100.0,
        format: Some("webp".to_string()),
        file: None,
    }).ok();
    
    Ok(())
}

// Ultra-fast APNG encoder using FFmpeg
fn save_as_apng_streaming(
    frame_paths: &[String],
    output_path: &Path,
    fps: f64,
    loop_count: u32,
    app: &tauri::AppHandle,
) -> Result<(), ConverterError> {
    if frame_paths.is_empty() {
        return Err(ConverterError::InvalidFormat("No frames to encode".to_string()));
    }

    CONVERT_STATE.store(0, Ordering::SeqCst);
    let temp_path = output_path.with_extension("tmp.png");
    let total = frame_paths.len();

    // Try FFmpeg first
    let ffmpeg_path = get_ffmpeg_path();
    if let Some(ffmpeg) = &ffmpeg_path {
        log::info!("Using FFmpeg for APNG at: {}", ffmpeg);
        
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Converting with FFmpeg".to_string(),
            current: 0,
            total,
            percent: 0.0,
            format: Some("apng".to_string()),
            file: None,
        }).ok();

        let loop_arg = if loop_count == 0 { "0".to_string() } else { loop_count.to_string() };

        let (seq_dir, pattern) = match prepare_ffmpeg_sequence_input(frame_paths, "apng") {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Sequence input prep failed, falling back to Rust APNG encoder: {}", e);
                return save_as_apng_rust(frame_paths, output_path, fps, loop_count, app);
            }
        };

        let args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-nostats".into(),
            "-loglevel".into(),
            "error".into(),
            "-framerate".into(),
            format!("{}", fps).into(),
            "-start_number".into(),
            "1".into(),
            "-i".into(),
            pattern.clone(),
            "-plays".into(),
            loop_arg.clone(),
            "-vf".into(),
            "format=rgba,setsar=1".into(),
            "-f".into(),
            "apng".into(),
            "-threads".into(),
            "0".into(),
            temp_path.to_string_lossy().to_string(),
        ];

        let (child, progress_thread) = spawn_ffmpeg_with_progress(ffmpeg, args, app, total, "apng")?;
        let pid = child.id() as i32;
        let ctrl_thread = spawn_ffmpeg_control_thread(pid);

        // Wait for process to finish first (like GIF conversion does)
        let output = child.wait_with_output();

        // Now wait for progress thread to finish
        progress_thread.join().ok();

        // Stop control thread before proceeding
        CONVERT_STATE.store(2, Ordering::SeqCst);
        let _ = ctrl_thread.join();
        CONVERT_STATE.store(0, Ordering::SeqCst);

        let _ = fs::remove_dir_all(&seq_dir);

        // If cancelled, abort and clean up
        if is_cancelled() {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(output_path).ok(); // Ignore error if file doesn't exist
            return Err(ConverterError::InvalidFormat("Conversion cancelled".to_string()));
        }

        match output {
            Ok(result) if result.status.success() => {
                if temp_path.exists() {
                    app.emit("convert-progress", ConvertProgressEvent {
                        phase: "Completed".to_string(),
                        current: total,
                        total,
                        percent: 100.0,
                        format: Some("apng".to_string()),
                        file: None,
                    }).ok();
                    
                    fs::rename(&temp_path, output_path)?;
                    return Ok(());
                } else {
                    log::error!("FFmpeg APNG succeeded but output file not found");
                }
            }
            Ok(result) => {
                log::error!("FFmpeg APNG failed with status: {:?}", result.status);
            }
            Err(e) => {
                log::error!("FFmpeg APNG execution error: {}", e);
            }
        }
        
        let _ = fs::remove_file(&temp_path);
        let _ = fs::remove_file(output_path).ok(); // Ignore error if file doesn't exist
        return Err(ConverterError::APNG("FFmpeg APNG failed".to_string()));
    } else {
        log::info!("FFmpeg not available for APNG, using Rust implementation");
    }

    // Fallback to Rust implementation
    save_as_apng_rust(frame_paths, output_path, fps, loop_count, app)
}

// Rust fallback APNG encoder
fn save_as_apng_rust(
    frame_paths: &[String],
    output_path: &Path,
    fps: f64,
    loop_count: u32,
    app: &tauri::AppHandle,
) -> Result<(), ConverterError> {
    use png::Encoder;
    
    let temp_path = output_path.with_extension("tmp.png");
    let total = frame_paths.len();
    let (width, height) = image::image_dimensions(&frame_paths[0])?;
    let delay_num = 1u16;
    let delay_den = fps as u16;

    let file = fs::File::create(&temp_path)?;
    let buf_writer = std::io::BufWriter::new(file);
    
    let mut encoder = Encoder::new(buf_writer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_animated(total as u32, loop_count)
        .map_err(|e| ConverterError::APNG(format!("Failed to set animation: {}", e)))?;
    
    let mut writer = encoder.write_header()
        .map_err(|e| ConverterError::APNG(format!("Failed to write PNG header: {}", e)))?;

    for (idx, path) in frame_paths.iter().enumerate() {
        wait_if_paused();
        if is_cancelled() {
            let _ = fs::remove_file(&temp_path);
            return Err(ConverterError::InvalidFormat("Conversion cancelled".to_string()));
        }

        let img = image::open(path)?;
        let rgba = img.to_rgba8();
        let raw_data = rgba.into_raw();

        writer.set_frame_delay(delay_num, delay_den)
            .map_err(|e| ConverterError::APNG(format!("Failed to set frame delay: {}", e)))?;
        writer.write_image_data(&raw_data)
            .map_err(|e| ConverterError::APNG(format!("Failed to write frame data: {}", e)))?;

        let percent = ((idx + 1) as f64 / total as f64) * 100.0;
        app.emit("convert-progress", ConvertProgressEvent {
            phase: "Encoding APNG".to_string(),
            current: idx + 1,
            total,
            percent,
            format: Some("apng".to_string()),
            file: None,
        }).ok();
    }
    
    writer.finish()
        .map_err(|e| ConverterError::APNG(format!("Failed to finish APNG: {}", e)))?;
    
    fs::rename(&temp_path, output_path)?;
    Ok(())
}

fn compress_locally(
    image_path: &Path,
    _quality: u8,
) -> Result<Vec<u8>, ConverterError> {
    // Read the image
    let img = image::open(image_path)?;
    let (_width, _height) = img.dimensions();
    
    // Determine format from extension
    let ext = image_path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());
    
    match ext.as_deref() {
        Some("png") | Some("apng") => {
            // Re-encode PNG with different quality using image crate
            let img = image::open(image_path)?;
            let _rgba = img.to_rgba8();
            let (_width, _height) = img.dimensions();
            
            // Create a new PNG with quality adjustment
            // Note: PNG is lossless, so we'll just return the original
            // For actual compression, would need to use oxipng command-line tool
            Ok(fs::read(image_path)?)
        }
        Some("webp") => {
            // Re-encode WebP with different quality
            
            // Save to temporary file and read back
            let temp_path = image_path.with_extension("temp.webp");
            img.save_with_format(&temp_path, ImageFormat::WebP)?;
            
            // For WebP, we can't easily change quality after encoding
            // So we'll just return the original file
            // In a full implementation, we'd re-encode with libwebp-sys
            let data = fs::read(image_path)?;
            let _ = fs::remove_file(temp_path); // Clean up temp file
            Ok(data)
        }
        Some("gif") => {
            // For GIF, we can't easily re-encode with different quality
            // Just return the original file
            Ok(fs::read(image_path)?)
        }
        _ => {
            // Unknown format, return original
            Ok(fs::read(image_path)?)
        }
    }
}

async fn compress_with_tinypng(
    api_key: &str,
    image_path: &Path,
) -> Result<Vec<u8>, ConverterError> {
    let client = reqwest::Client::new();
    let file_bytes = fs::read(image_path)?;

    let file_name = image_path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "image".to_string());
    
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(file_bytes).file_name(file_name));

    let response = client
        .post("https://api.tinify.com/shrink")
        .basic_auth(api_key, Some(""))
        .multipart(form)
        .send()
        .await
        .map_err(|e| ConverterError::Api(e.to_string()))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(ConverterError::Api(format!("API error: {}", error_text)));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ConverterError::Api(e.to_string()))?;
    
    let compressed_url = response_json
        .get("output")
        .and_then(|o| o.get("url"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| ConverterError::Api("Invalid API response".to_string()))?;

    let download_response = client
        .get(compressed_url)
        .send()
        .await
        .map_err(|e| ConverterError::Api(e.to_string()))?;

    let compressed_data = download_response
        .bytes()
        .await
        .map_err(|e| ConverterError::Api(e.to_string()))?;

    Ok(compressed_data.to_vec())
}

#[tauri::command]
pub async fn convert_sequence_frames(
    app: tauri::AppHandle,
    request: ConvertRequest,
) -> Result<Vec<ConvertResult>, String> {
    let scan_result = scan_frame_files(
        request.input_mode.clone(),
        request.input_path.clone(),
        request.input_paths.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    if scan_result.files.is_empty() {
        return Err("No image files found".to_string());
    }

    let frame_paths: Vec<String> = scan_result.files.iter().map(|f| f.path.clone()).collect();
    
    // Get dimensions from first frame without loading all frames
    let first_img = image::open(&frame_paths[0]).map_err(|e| e.to_string())?;
    let (width, height) = first_img.dimensions();
    drop(first_img); // Free memory immediately

    let output_dir = PathBuf::from(&request.output_dir);
    if !output_dir.exists() {
        fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    }

    let base_name = request.output_name.unwrap_or_else(|| {
        let input_name = if request.input_mode == "folder" {
            let path_buf = PathBuf::from(&request.input_path);
            path_buf.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "output".to_string())
        } else {
            let path_buf = PathBuf::from(&frame_paths[0]);
            path_buf.file_stem()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "output".to_string())
        };
        format!("{}_{}x{}", input_name, width, height)
    });

    let mut results = Vec::new();
    for format in request.formats.iter() {
        let ext = match format.as_str() {
            "webp" => "webp",
            "apng" => "png",  // APNG uses .png extension for better compatibility
            "gif" => "gif",
            _ => continue,
        };

        let output_path = output_dir.join(format!("{}.{}", base_name, ext));

        app.emit("convert-progress", ConvertProgressEvent {
            phase: format!("Starting {} conversion", format.to_uppercase()),
            current: 0,
            total: 0,
            percent: 0.0,
            format: Some(format.clone()),
            file: Some(output_path.to_string_lossy().to_string()),
        })
        .ok();

        // Use streaming encoding for GIF to avoid loading all frames into memory
        let convert_result = match format.as_str() {
            "gif" => save_as_gif_streaming(&frame_paths, &output_path, request.fps, request.loop_count, &app),
            "apng" => save_as_apng_streaming(&frame_paths, &output_path, request.fps, request.loop_count, &app),
            "webp" => save_as_webp_streaming(&frame_paths, &output_path, request.fps, request.loop_count, &app),
            _ => Err(ConverterError::InvalidFormat(format.clone())),
        };

        match convert_result {
            Ok(_) => {
                let original_size = fs::metadata(&output_path)
                    .ok()
                    .map(|m| m.len());

                let mut compressed_size = original_size;
                let mut error = None;

                // Apply compression if requested
                if request.use_local_compression || request.api_key.is_some() {
                    if let Some(ref api_key) = request.api_key {
                        // Use TinyPNG API
                        match compress_with_tinypng(api_key, &output_path).await {
                            Ok(compressed_data) => {
                                let compressed_path = output_path.with_extension(format!("compressed.{}", ext));
                                if let Err(e) = fs::write(&compressed_path, compressed_data) {
                                    error = Some(e.to_string());
                                } else {
                                    compressed_size = fs::metadata(&compressed_path)
                                        .ok()
                                        .map(|m| m.len());
                                }
                            }
                            Err(e) => {
                                error = Some(e.to_string());
                            }
                        }
                    } else if request.use_local_compression {
                        // Use local compression
                        match compress_locally(&output_path, request.compression_quality) {
                            Ok(compressed_data) => {
                                let compressed_path = output_path.with_extension(format!("compressed.{}", ext));
                                if let Err(e) = fs::write(&compressed_path, compressed_data) {
                                    error = Some(e.to_string());
                                } else {
                                    compressed_size = fs::metadata(&compressed_path)
                                        .ok()
                                        .map(|m| m.len());
                                }
                            }
                            Err(e) => {
                                error = Some(e.to_string());
                            }
                        }
                    }
                }

                results.push(ConvertResult {
                    format: format.clone(),
                    path: output_path.to_string_lossy().to_string(),
                    success: true,
                    error,
                    original_size,
                    compressed_size,
                });
            }
            Err(e) => {
                results.push(ConvertResult {
                    format: format.clone(),
                    path: output_path.to_string_lossy().to_string(),
                    success: false,
                    error: Some(e.to_string()),
                    original_size: None,
                    compressed_size: None,
                });
            }
        }
    }

    Ok(results)
}

