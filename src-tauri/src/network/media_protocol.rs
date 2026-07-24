use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock, Weak},
    time::Duration,
};

use aes::cipher::{KeyIvInit, StreamCipher};
use aes::Aes256;
use base64::Engine;
use ctr::{Ctr128BE, Ctr64BE};
use sha2::{Digest, Sha256};
use tauri::{
    http::{header, response::Builder as ResponseBuilder, Request, Response, StatusCode, Uri},
    AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder,
};
use tauri_plugin_http::reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    Client, Url,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

pub const MEDIA_URI_SCHEME: &str = "sable-media";

const MEDIA_PATH_PREFIXES: [&str; 2] = ["/_matrix/media/", "/_matrix/client/v1/media/"];
const CACHE_SUBDIR: &str = "sable-media";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONCURRENT_REQUESTS: usize = 4;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RANGE_CHUNK: u64 = 2 * 1024 * 1024;

const TEMP_CACHE_SUBDIR: &str = "sable-media-temp";
const MAX_TEMP_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

type FetchResult = Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode>;

pub struct MediaSessionState {
    inner: RwLock<Option<MediaSession>>,
    encryption: RwLock<HashMap<String, EncryptionParams>>,
    client: OnceLock<Client>,
    semaphore: Semaphore,
    cache_miss_gates: Mutex<HashMap<String, Weak<AsyncMutex<Option<FetchResult>>>>>,
}

impl Default for MediaSessionState {
    fn default() -> Self {
        Self {
            inner: RwLock::new(None),
            encryption: RwLock::new(HashMap::new()),
            client: OnceLock::new(),
            semaphore: Semaphore::new(MAX_CONCURRENT_REQUESTS),
            cache_miss_gates: Mutex::new(HashMap::new()),
        }
    }
}

impl MediaSessionState {
    // Shared across requests so the connection pool and TLS sessions stay warm.
    fn client(&self) -> Client {
        self.client
            .get_or_init(|| {
                // MSC3916: default policy strips Authorization on cross-origin redirects to a signed CDN URL.
                Client::builder()
                    .timeout(REQUEST_TIMEOUT)
                    .connect_timeout(CONNECT_TIMEOUT)
                    .redirect(tauri_plugin_http::reqwest::redirect::Policy::default())
                    .build()
                    .unwrap_or_else(|_| Client::new())
            })
            .clone()
    }

    fn cache_miss_gate(
        &self,
        key: &str,
    ) -> Result<Arc<AsyncMutex<Option<FetchResult>>>, StatusCode> {
        let mut gates = self
            .cache_miss_gates
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(key).and_then(Weak::upgrade) {
            return Ok(gate);
        }

        let gate = Arc::new(AsyncMutex::new(None));
        gates.insert(key.to_owned(), Arc::downgrade(&gate));
        Ok(gate)
    }
}

#[derive(Clone)]
struct MediaSession {
    origin: String,
    token: String,
}

#[derive(Clone)]
struct EncryptionParams {
    key: [u8; 32],
    iv: [u8; 16],
    counter_length: u8,
    expected_sha256: Vec<u8>,
    content_type: String,
}

#[tauri::command]
pub fn set_media_session(
    state: tauri::State<'_, MediaSessionState>,
    base_url: String,
    token: String,
) -> Result<(), String> {
    let origin = Url::parse(&base_url)
        .map_err(|err| err.to_string())?
        .origin()
        .ascii_serialization();

    let mut guard = state
        .inner
        .write()
        .map_err(|_| "media session lock poisoned".to_string())?;
    *guard = Some(MediaSession { origin, token });
    Ok(())
}

#[tauri::command]
pub fn clear_media_session<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, MediaSessionState>,
) {
    if let Ok(mut guard) = state.inner.write() {
        *guard = None;
    }
    if let Ok(dir) = cache_dir(&app) {
        let _ = fs::remove_dir_all(dir);
    }
    if let Ok(temp_dir) = temp_cache_dir(&app) {
        let _ = fs::remove_dir_all(temp_dir);
    }
}

#[tauri::command]
pub fn set_media_encryption(
    state: State<MediaSessionState>,
    url: String,
    key: String,
    iv: String,
    sha256: String,
    version: String,
    mime_type: String,
) -> Result<(), String> {
    // Decode key from base64url to [u8; 32]
    let key_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&key)
        .map_err(|e| format!("invalid key base64url: {e}"))?;
    if key_bytes.len() != 32 {
        return Err(format!("key must be 32 bytes, got {}", key_bytes.len()));
    }
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(&key_bytes);

    // Decode IV from unpadded standard base64 to [u8; 16]
    let iv_bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&iv)
        .map_err(|e| format!("invalid iv base64: {e}"))?;
    if iv_bytes.len() != 16 {
        return Err(format!("iv must be 16 bytes, got {}", iv_bytes.len()));
    }
    let mut iv_arr = [0u8; 16];
    iv_arr.copy_from_slice(&iv_bytes);

    // Decode sha256 from unpadded standard base64
    let sha256_bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&sha256)
        .map_err(|e| format!("invalid sha256 base64: {e}"))?;

    let counter_length: u8 = if version == "v1" || version == "v2" {
        64
    } else {
        128
    };

    let params = EncryptionParams {
        key: key_arr,
        iv: iv_arr,
        counter_length,
        expected_sha256: sha256_bytes,
        content_type: mime_type,
    };

    // Strip sable-media:// prefix to match the lookup key in decrypt_if_encrypted.
    let normalized_key = normalize_encryption_key(&url);

    let mut guard = state
        .encryption
        .write()
        .map_err(|_| "encryption lock poisoned".to_string())?;
    guard.insert(normalized_key, params);
    Ok(())
}

fn normalize_encryption_key(url: &str) -> String {
    if url.starts_with("sable-media://") || url.starts_with("http://sable-media.localhost/") {
        if let Ok(uri) = Uri::try_from(url) {
            let path = uri.path().trim_start_matches('/');
            let decoded = percent_encoding::percent_decode_str(path)
                .decode_utf8()
                .unwrap_or(std::borrow::Cow::Borrowed(path));
            if let Ok(parsed) = Url::parse(&decoded) {
                return parsed.to_string();
            }
            return decoded.into_owned();
        }
    }
    url.to_string()
}

pub fn respond<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    tauri::async_runtime::spawn(async move {
        let response = handle_request(&app, uri, range)
            .await
            .unwrap_or_else(error_response);
        responder.respond(response);
    });
}

async fn handle_request<R: Runtime>(
    app: &AppHandle<R>,
    uri: Uri,
    range: Option<String>,
) -> Result<Response<Vec<u8>>, StatusCode> {
    let target = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_owned();

    let session = {
        let state = app.state::<MediaSessionState>();
        let guard = state
            .inner
            .read()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        match guard.clone() {
            Some(s) => s,
            None => {
                return Ok(Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header(header::RETRY_AFTER, "1")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Vec::new())
                    .expect("failed to build 503 media response"));
            }
        }
    };

    let media_url = Url::parse(&target).map_err(|_| StatusCode::BAD_REQUEST)?;
    if media_url.scheme() != "http" && media_url.scheme() != "https" {
        return Err(StatusCode::FORBIDDEN);
    }
    if media_url.origin().ascii_serialization() != session.origin {
        return Err(StatusCode::FORBIDDEN);
    }
    if !MEDIA_PATH_PREFIXES
        .iter()
        .any(|prefix| media_url.path().starts_with(prefix))
    {
        return Err(StatusCode::FORBIDDEN);
    }

    let key = cache_key(&session.token, &target);
    let dir = cache_dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let temp_dir = temp_cache_dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let state = app.state::<MediaSessionState>();

    let (content_type, in_memory_body, disk_path) =
        ensure_cached(&state, &session, &key, media_url, dir, temp_dir).await?;

    match (range, in_memory_body) {
        (Some(range_header), Some(body)) => {
            Ok(serve_range_memory(&body, &content_type, &range_header))
        }
        (Some(range_header), None) => serve_range(disk_path, content_type, range_header).await,
        (None, Some(body)) => {
            let vec_body = Arc::try_unwrap(body).unwrap_or_else(|b| (*b).clone());
            Ok(ok_response(vec_body, &content_type))
        }
        (None, None) => Ok(ok_response(read_full(disk_path).await?, &content_type)),
    }
}

// Ensure the body + content type are on disk (persistent or temporary), fetching from the homeserver on a miss.
async fn ensure_cached(
    state: &MediaSessionState,
    session: &MediaSession,
    key: &str,
    media_url: Url,
    dir: PathBuf,
    temp_dir: PathBuf,
) -> Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode> {
    ensure_cached_with_limits(
        state,
        session,
        key,
        media_url,
        dir,
        temp_dir,
        MAX_CACHE_BYTES,
        MAX_TEMP_CACHE_BYTES,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn ensure_cached_with_limits(
    state: &MediaSessionState,
    session: &MediaSession,
    key: &str,
    media_url: Url,
    dir: PathBuf,
    temp_dir: PathBuf,
    max_persistent_cache_bytes: u64,
    max_temp_cache_bytes: u64,
) -> Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode> {
    let body_path = dir.join(key);
    let content_type_path = dir.join(format!("{key}.ct"));
    let temp_body_path = temp_dir.join(key);
    let temp_content_type_path = temp_dir.join(format!("{key}.ct"));

    // Fast path 1: Persistent cache hit
    if let Some(content_type) =
        read_content_type(body_path.clone(), content_type_path.clone()).await
    {
        return Ok((content_type, None, body_path));
    }

    // Fast path 2: Temporary cache hit (sequential range requests for oversized media)
    if let Some(content_type) =
        read_content_type(temp_body_path.clone(), temp_content_type_path.clone()).await
    {
        return Ok((content_type, None, temp_body_path));
    }

    let gate = state.cache_miss_gate(key)?;
    let mut gate_guard = gate.lock().await;

    // Double-check persistent cache inside gate lock
    if let Some(content_type) =
        read_content_type(body_path.clone(), content_type_path.clone()).await
    {
        return Ok((content_type, None, body_path));
    }

    // Double-check temporary cache inside gate lock
    if let Some(content_type) =
        read_content_type(temp_body_path.clone(), temp_content_type_path.clone()).await
    {
        return Ok((content_type, None, temp_body_path));
    }

    // Double-check in-flight results
    if let Some(res) = &*gate_guard {
        return match res {
            Ok((content_type, body_opt, path)) => {
                Ok((content_type.clone(), body_opt.clone(), path.clone()))
            }
            Err(status) => Err(*status),
        };
    }

    let fetch_res = fetch_and_cache(
        state,
        session,
        media_url,
        dir,
        temp_dir,
        body_path,
        content_type_path,
        temp_body_path,
        temp_content_type_path,
        max_persistent_cache_bytes,
        max_temp_cache_bytes,
    )
    .await;

    match &fetch_res {
        Ok((content_type, body_opt, path)) => {
            *gate_guard = Some(Ok((content_type.clone(), body_opt.clone(), path.clone())));
            fetch_res
        }
        Err(status) => {
            *gate_guard = Some(Err(*status));
            Err(*status)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_and_cache(
    state: &MediaSessionState,
    session: &MediaSession,
    media_url: Url,
    dir: PathBuf,
    temp_dir: PathBuf,
    body_path: PathBuf,
    content_type_path: PathBuf,
    temp_body_path: PathBuf,
    temp_content_type_path: PathBuf,
    max_persistent_cache_bytes: u64,
    max_temp_cache_bytes: u64,
) -> Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode> {
    let _permit = state
        .semaphore
        .acquire()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let upstream = state
        .client()
        .get(media_url.clone())
        .header(AUTHORIZATION, format!("Bearer {}", session.token))
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !upstream.status().is_success() {
        return Err(
            StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
        );
    }

    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();

    let body = upstream
        .bytes()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .to_vec();

    // Check for encryption params and decrypt if present
    let (body, content_type) =
        match decrypt_if_encrypted(state, media_url.as_str(), body, &content_type) {
            Ok((decrypted_body, decrypted_ct)) => (decrypted_body, decrypted_ct),
            Err(status) => return Err(status),
        };

    if body.len() as u64 > max_temp_cache_bytes {
        return Ok((content_type, Some(Arc::new(body)), temp_body_path));
    }

    if body.len() as u64 <= max_persistent_cache_bytes {
        write_cache(
            dir.clone(),
            body_path.clone(),
            content_type_path,
            body,
            content_type.clone(),
            max_persistent_cache_bytes,
        )
        .await;
        Ok((content_type, None, body_path))
    } else {
        // Oversized media: write to temporary session cache for sequential range requests
        let written = write_cache(
            temp_dir.clone(),
            temp_body_path.clone(),
            temp_content_type_path,
            body.clone(),
            content_type.clone(),
            max_temp_cache_bytes,
        )
        .await;

        if written {
            Ok((content_type, None, temp_body_path))
        } else {
            // Storage write failed or evicted; serve from memory fallback
            Ok((content_type, Some(Arc::new(body)), temp_body_path))
        }
    }
}

/// Decrypt the body if encryption params exist for this URL.
fn decrypt_if_encrypted(
    state: &MediaSessionState,
    url: &str,
    ciphertext: Vec<u8>,
    upstream_content_type: &str,
) -> Result<(Vec<u8>, String), StatusCode> {
    let encryption = {
        let guard = state
            .encryption
            .read()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        guard.get(url).cloned()
    };

    let Some(params) = encryption else {
        // No encryption params: pass through unchanged
        return Ok((ciphertext, upstream_content_type.to_owned()));
    };

    // Verify SHA-256 of ciphertext
    let mut hasher = Sha256::new();
    hasher.update(&ciphertext);
    let actual_sha256 = hasher.finalize().to_vec();
    if actual_sha256 != params.expected_sha256 {
        let _ = state.encryption.write().map(|mut guard| guard.remove(url));
        return Err(StatusCode::BAD_GATEWAY);
    }

    // Decrypt in-place using AES-CTR
    let mut plaintext = ciphertext;
    match params.counter_length {
        64 => {
            let mut cipher = Ctr64BE::<Aes256>::new((&params.key).into(), (&params.iv).into());
            cipher.apply_keystream(&mut plaintext);
        }
        128 => {
            let mut cipher = Ctr128BE::<Aes256>::new((&params.key).into(), (&params.iv).into());
            cipher.apply_keystream(&mut plaintext);
        }
        _ => return Err(StatusCode::BAD_REQUEST),
    }

    // Remove encryption params — decrypted content is now cached on disk
    let _ = state.encryption.write().map(|mut guard| guard.remove(url));

    Ok((plaintext, params.content_type))
}

async fn write_cache(
    dir: PathBuf,
    body_path: PathBuf,
    content_type_path: PathBuf,
    body: Vec<u8>,
    content_type: String,
    max_bytes: u64,
) -> bool {
    tokio::task::spawn_blocking(move || {
        if fs::create_dir_all(&dir).is_ok() {
            let res_body = fs::write(&body_path, &body);
            let res_ct = fs::write(&content_type_path, &content_type);
            evict_directory_if_needed(&dir, max_bytes);
            res_body.is_ok() && res_ct.is_ok() && body_path.is_file()
        } else {
            false
        }
    })
    .await
    .unwrap_or(false)
}

#[allow(dead_code)]
fn fits_in_cache(len: u64) -> bool {
    len <= MAX_CACHE_BYTES
}

// Only a hit when the body file is also present, so a stray `.ct` counts as a miss.
async fn read_content_type(body_path: PathBuf, content_type_path: PathBuf) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        if !body_path.is_file() {
            return None;
        }
        fs::read_to_string(&content_type_path).ok()
    })
    .await
    .unwrap_or(None)
}

async fn read_full(body_path: PathBuf) -> Result<Vec<u8>, StatusCode> {
    tokio::task::spawn_blocking(move || fs::read(&body_path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn serve_range(
    body_path: PathBuf,
    content_type: String,
    range_header: String,
) -> Result<Response<Vec<u8>>, StatusCode> {
    tokio::task::spawn_blocking(move || {
        let mut file = fs::File::open(&body_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let total = file
            .metadata()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .len();

        let Some((start, end)) = parse_range(&range_header, total) else {
            return Ok(range_not_satisfiable(total));
        };

        let end = end.min(start + MAX_RANGE_CHUNK - 1);
        let length = end - start + 1;

        let mut buf = vec![0_u8; length as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.read_exact(&mut buf)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        Ok(partial_response(buf, &content_type, start, end, total))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

// Serve a Range request from an in-memory body. Mirrors serve_range but slices
// the buffer instead of seeking.
fn serve_range_memory(body: &[u8], content_type: &str, range_header: &str) -> Response<Vec<u8>> {
    let total = body.len() as u64;
    let Some((start, end)) = parse_range(range_header, total) else {
        return range_not_satisfiable(total);
    };
    let end = end.min(start + MAX_RANGE_CHUNK - 1);
    let buf = body[start as usize..=(end as usize)].to_vec();
    partial_response(buf, content_type, start, end, total)
}

// First byte range of a `Range: bytes=...` header as inclusive (start, end); None → 416.
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }

    let spec = header.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split(',').next()?.trim().split_once('-')?;

    let (start, end) = if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start: u64 = start_str.parse().ok()?;
        let end = if end_str.is_empty() {
            total - 1
        } else {
            end_str.parse::<u64>().ok()?.min(total - 1)
        };
        (start, end)
    };

    if start > end || start >= total {
        return None;
    }
    Some((start, end))
}

// Trim oldest-first when the cache exceeds its byte budget.
fn evict_directory_if_needed(dir: &Path, max_bytes: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            Some((path, meta.len(), modified))
        })
        .collect();

    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= max_bytes {
        return;
    }

    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in files {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

// Shared 200/206 headers. Media is content-addressed and the URL is session-scoped, so
// it is safe to let the webview cache it as immutable and to advertise Range support.
fn media_response_builder(status: StatusCode, content_type: &str) -> ResponseBuilder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'; script-src 'none'; object-src 'none'",
        )
}

fn ok_response(body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    let content_length = body.len();
    media_response_builder(StatusCode::OK, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .body(body)
        .expect("failed to build media response")
}

fn partial_response(
    body: Vec<u8>,
    content_type: &str,
    start: u64,
    end: u64,
    total: u64,
) -> Response<Vec<u8>> {
    let content_length = body.len();
    media_response_builder(StatusCode::PARTIAL_CONTENT, content_type)
        .header(header::CONTENT_LENGTH, content_length)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
        .body(body)
        .expect("failed to build partial media response")
}

fn range_not_satisfiable(total: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .body(Vec::new())
        .expect("failed to build range error response")
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("failed to build media error response")
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(CACHE_SUBDIR))
        .map_err(|err| err.to_string())
}

fn temp_cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(TEMP_CACHE_SUBDIR))
        .map_err(|err| err.to_string())
}

fn cache_key(session_token: &str, url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session_token.as_bytes());
    hasher.update([0]);
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tauri::http::{header, StatusCode};

    use super::{
        cache_key, fits_in_cache, ok_response, parse_range, partial_response, serve_range_memory,
        MediaSessionState,
    };

    #[test]
    fn cache_miss_gates_are_reused_and_expired_entries_are_cleaned() {
        let state = MediaSessionState::default();
        let first = state.cache_miss_gate("first").unwrap();
        let same = state.cache_miss_gate("first").unwrap();
        let different = state.cache_miss_gate("different").unwrap();

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &different));

        drop(first);
        drop(same);
        let _third = state.cache_miss_gate("third").unwrap();
        let gates = state.cache_miss_gates.lock().unwrap();
        assert!(!gates.contains_key("first"));
        assert!(gates.contains_key("different"));
        assert!(gates.contains_key("third"));
    }

    #[test]
    fn cache_key_is_stable_and_hex() {
        let url = "https://matrix.example.org/_matrix/client/v1/media/download/x/y";
        let key = cache_key("account-a-token", url);
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, cache_key("account-a-token", url));
    }

    #[test]
    fn cache_key_is_scoped_to_the_session() {
        let url = "https://matrix.example.org/_matrix/client/v1/media/download/x/y";
        assert_ne!(
            cache_key("account-a-token", url),
            cache_key("account-b-token", url)
        );
    }

    #[test]
    fn ok_response_has_content_length_and_cache_headers() {
        let response = ok_response(vec![0_u8; 42], "image/png");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            "42"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, max-age=31536000, immutable"
        );
        assert_eq!(
            response.headers().get(header::ACCEPT_RANGES).unwrap(),
            "bytes"
        );
    }

    #[test]
    fn parse_range_handles_the_common_forms() {
        assert_eq!(parse_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        // End past the file is clamped to the last byte.
        assert_eq!(parse_range("bytes=990-5000", 1000), Some((990, 999)));
        // Suffix range: the last N bytes.
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
    }

    #[test]
    fn parse_range_rejects_unsatisfiable_and_malformed() {
        assert_eq!(parse_range("bytes=1000-1001", 1000), None);
        assert_eq!(parse_range("bytes=500-400", 1000), None);
        assert_eq!(parse_range("bytes=abc-def", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-0", 0), None);
    }

    #[test]
    fn partial_response_reports_the_served_range() {
        let response = partial_response(vec![0_u8; 100], "video/mp4", 0, 99, 5000);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(header::CONTENT_LENGTH).unwrap(),
            "100"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-99/5000"
        );
        assert_eq!(
            response.headers().get(header::ACCEPT_RANGES).unwrap(),
            "bytes"
        );
    }

    #[test]
    fn oversized_media_is_not_cacheable() {
        assert!(fits_in_cache(0));
        assert!(fits_in_cache(super::MAX_CACHE_BYTES));
        assert!(!fits_in_cache(super::MAX_CACHE_BYTES + 1));
    }

    #[test]
    fn serve_range_memory_slices_the_in_memory_body() {
        let body: Vec<u8> = (0..200u8).collect();
        let response = serve_range_memory(&body, "application/octet-stream", "bytes=10-19");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &body[10..=19]);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 10-19/200"
        );
    }

    #[test]
    fn serve_range_memory_caps_at_max_range_chunk() {
        let body = vec![7_u8; (super::MAX_RANGE_CHUNK * 2) as usize];
        let response = serve_range_memory(&body, "application/octet-stream", "bytes=0-");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len() as u64, super::MAX_RANGE_CHUNK);
        let total = super::MAX_RANGE_CHUNK * 2;
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            &format!("bytes 0-{}/{total}", super::MAX_RANGE_CHUNK - 1)
        );
    }

    #[test]
    fn serve_range_memory_rejects_unsatisfiable_range() {
        let response = serve_range_memory(&[], "application/octet-stream", "bytes=0-0");
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn normalize_encryption_key_strips_sable_media_prefix() {
        let input = "sable-media://localhost/https%3A%2F%2Fmatrix.example.org%2F_matrix%2Fclient%2Fv1%2Fmedia%2Fdownload%2Fmatrix.org%2Fabc123";
        let result = super::normalize_encryption_key(input);
        assert_eq!(
            result,
            "https://matrix.example.org/_matrix/client/v1/media/download/matrix.org/abc123"
        );
    }

    #[test]
    fn normalize_encryption_key_strips_windows_prefix() {
        let input = "http://sable-media.localhost/https%3A%2F%2Fmatrix.example.org%2F_matrix%2Fclient%2Fv1%2Fmedia%2Fthumbnail%2Fmatrix.org%2Fxyz%3Fwidth%3D96%26height%3D96";
        let result = super::normalize_encryption_key(input);
        assert_eq!(
            result,
            "https://matrix.example.org/_matrix/client/v1/media/thumbnail/matrix.org/xyz?width=96&height=96"
        );
    }

    #[test]
    fn normalize_encryption_key_passes_through_bare_url() {
        let input = "https://matrix.example.org/_matrix/client/v1/media/download/matrix.org/abc123";
        let result = super::normalize_encryption_key(input);
        assert_eq!(result, input);
    }
}
