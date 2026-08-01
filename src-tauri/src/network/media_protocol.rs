use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, RwLock, Weak,
    },
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
use tokio::{
    sync::{Mutex as AsyncMutex, Notify, Semaphore},
    time::{timeout_at, Instant},
};

pub const MEDIA_URI_SCHEME: &str = "sable-media";
const MEDIA_SESSION_MARKER: &str = "__sable_media_session";

const MEDIA_PATH_PREFIXES: [&str; 2] = ["/_matrix/media/", "/_matrix/client/v1/media/"];
// How the webview spells this protocol: `sable-media://` on iOS/macOS, and
// `http(s)://sable-media.localhost/` on Windows/Android respectively.
const MEDIA_PROTOCOL_PREFIXES: [&str; 3] = [
    "sable-media://",
    "http://sable-media.localhost/",
    "https://sable-media.localhost/",
];
const CACHE_SUBDIR: &str = "sable-media";
// Inactivity deadline between chunks, so a slow but progressing download is not killed.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONCURRENT_THUMBNAIL_REQUESTS: usize = 4;
const MAX_CONCURRENT_DOWNLOAD_REQUESTS: usize = 6;
// The frontend mounts (and starts requesting media) before it hands us the session, so a request
// may arrive first. `<img>` never retries, so waiting beats answering 503.
const SESSION_WAIT: Duration = Duration::from_secs(5);
const SESSION_REFRESH_WAIT: Duration = Duration::from_millis(2500);
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
// Short: a 4xx stops being true once an unreachable remote server comes back.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_NEGATIVE_CACHE_ENTRIES: usize = 512;

const TEMP_CACHE_SUBDIR: &str = "sable-media-temp";
const MAX_TEMP_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

type FetchResult = Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode>;

pub struct MediaSessionState {
    inner: RwLock<Option<MediaSession>>,
    session_ready: Notify,
    session_ever_set: AtomicBool,
    session_generation: AtomicU64,
    encryption: RwLock<HashMap<String, EncryptionParams>>,
    client: OnceLock<Client>,
    thumbnail_semaphore: Semaphore,
    download_semaphore: Semaphore,
    cache_miss_gates: Mutex<HashMap<String, Weak<AsyncMutex<Option<FetchResult>>>>>,
    negative_cache: Mutex<HashMap<String, (StatusCode, Instant)>>,
}

impl Default for MediaSessionState {
    fn default() -> Self {
        Self {
            inner: RwLock::new(None),
            session_ready: Notify::new(),
            session_ever_set: AtomicBool::new(false),
            session_generation: AtomicU64::new(0),
            encryption: RwLock::new(HashMap::new()),
            client: OnceLock::new(),
            thumbnail_semaphore: Semaphore::new(MAX_CONCURRENT_THUMBNAIL_REQUESTS),
            download_semaphore: Semaphore::new(MAX_CONCURRENT_DOWNLOAD_REQUESTS),
            cache_miss_gates: Mutex::new(HashMap::new()),
            negative_cache: Mutex::new(HashMap::new()),
        }
    }
}

impl MediaSessionState {
    fn session(&self) -> Option<MediaSession> {
        self.inner.read().ok().and_then(|guard| guard.clone())
    }

    /// Waits out the startup window where media is requested before the session arrives. Fails
    /// fast once a session has existed, so requests still in flight after a logout do not hang.
    async fn wait_for_session(&self) -> Option<MediaSession> {
        if let Some(session) = self.session() {
            return Some(session);
        }
        if self.session_ever_set.load(Ordering::Acquire) {
            return None;
        }

        let deadline = Instant::now() + SESSION_WAIT;
        loop {
            let mut notified = std::pin::pin!(self.session_ready.notified());
            // Register before re-checking, otherwise a session arriving in between is missed.
            notified.as_mut().enable();
            if let Some(session) = self.session() {
                return Some(session);
            }
            if timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }

    async fn wait_for_newer_session(&self, previous: &MediaSession) -> Option<MediaSession> {
        self.wait_for_newer_session_with_timeout(previous, SESSION_REFRESH_WAIT)
            .await
    }

    async fn wait_for_newer_session_with_timeout(
        &self,
        previous: &MediaSession,
        wait: Duration,
    ) -> Option<MediaSession> {
        let deadline = Instant::now() + wait;
        loop {
            let mut notified = std::pin::pin!(self.session_ready.notified());
            // Register before re-checking, otherwise a session arriving in between is missed.
            notified.as_mut().enable();
            match self.session() {
                Some(session) if session.generation > previous.generation => {
                    if session.origin != previous.origin || session.scope != previous.scope {
                        return None;
                    }
                    if session.token != previous.token {
                        return Some(session);
                    }
                }
                None if self.session_generation.load(Ordering::Acquire) > previous.generation => {
                    return None;
                }
                _ => {}
            }
            if timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }

    fn set_session(&self, mut session: MediaSession) -> Result<(), String> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| "media session lock poisoned".to_string())?;
        session.generation = self.session_generation.fetch_add(1, Ordering::AcqRel) + 1;
        *guard = Some(session);
        drop(guard);
        self.forget_client_errors();
        self.session_ever_set.store(true, Ordering::Release);
        self.session_ready.notify_waiters();
        Ok(())
    }

    fn clear_session(&self) -> Result<(), String> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| "media session lock poisoned".to_string())?;
        *guard = None;
        self.session_generation.fetch_add(1, Ordering::AcqRel);
        drop(guard);
        self.forget_client_errors();
        self.session_ready.notify_waiters();
        Ok(())
    }

    // Shared across requests so the connection pool and TLS sessions stay warm.
    fn client(&self) -> Client {
        self.client
            .get_or_init(|| {
                // MSC3916: default policy strips Authorization on cross-origin redirects to a signed CDN URL.
                Client::builder()
                    .read_timeout(READ_TIMEOUT)
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

    fn recent_client_error(&self, key: &str) -> Option<StatusCode> {
        let mut cache = self.negative_cache.lock().ok()?;
        let (status, seen_at) = *cache.get(key)?;
        if seen_at.elapsed() < NEGATIVE_CACHE_TTL {
            return Some(status);
        }
        cache.remove(key);
        None
    }

    /// 5xx and auth/rate-limit failures stay retryable.
    fn note_client_error(&self, key: &str, status: StatusCode) {
        let media_specific = status.is_client_error()
            && !matches!(
                status,
                StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::REQUEST_TIMEOUT
                    | StatusCode::TOO_MANY_REQUESTS
            );
        if !media_specific {
            return;
        }
        let Ok(mut cache) = self.negative_cache.lock() else {
            return;
        };
        cache.retain(|_, (_, seen_at)| seen_at.elapsed() < NEGATIVE_CACHE_TTL);
        if cache.len() >= MAX_NEGATIVE_CACHE_ENTRIES {
            return;
        }
        cache.insert(key.to_owned(), (status, Instant::now()));
    }

    fn forget_client_errors(&self) {
        if let Ok(mut cache) = self.negative_cache.lock() {
            cache.clear();
        }
    }
}

#[derive(Clone)]
struct MediaSession {
    origin: String,
    token: String,
    // Cache key input. The Matrix user ID, not `token`, which rotates on every OIDC
    // refresh and would orphan the whole on-disk cache.
    scope: String,
    generation: u64,
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
    scope: Option<String>,
) -> Result<(), String> {
    let origin = Url::parse(&base_url)
        .map_err(|err| err.to_string())?
        .origin()
        .ascii_serialization();

    let scope = scope
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| origin.clone());

    state.set_session(MediaSession {
        origin,
        token,
        scope,
        generation: 0,
    })
}

#[tauri::command]
pub fn clear_media_session<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, MediaSessionState>,
) {
    let _ = state.clear_session();
    if let Ok(dir) = cache_dir(&app) {
        let _ = fs::remove_dir_all(dir);
    }
    if let Ok(temp_dir) = temp_cache_dir(&app) {
        let _ = fs::remove_dir_all(temp_dir);
    }
    if let Ok(mut guard) = state.encryption.write() {
        guard.clear();
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
    if MEDIA_PROTOCOL_PREFIXES
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        if let Ok(uri) = Uri::try_from(url) {
            let path = uri.path().trim_start_matches('/');
            let decoded = percent_encoding::percent_decode_str(path)
                .decode_utf8()
                .unwrap_or(std::borrow::Cow::Borrowed(path));
            if let Ok(mut parsed) = Url::parse(&decoded) {
                // A retry fragment is transport metadata, never part of the params key.
                parsed.set_fragment(None);
                return parsed.to_string();
            }
            return decoded.into_owned();
        }
    }
    // Parse bare URLs too, so both sides of the map agree on one canonical form.
    Url::parse(url)
        .map(|mut parsed| {
            parsed.set_fragment(None);
            parsed.to_string()
        })
        .unwrap_or_else(|_| url.to_string())
}

fn media_session_marker(uri: &Uri) -> Result<Option<String>, StatusCode> {
    let Some(query) = uri.query() else {
        return Ok(None);
    };

    let mut marker = None;
    for component in query.split('&') {
        let (raw_key, raw_value) = component.split_once('=').unwrap_or((component, ""));
        let key = percent_encoding::percent_decode_str(raw_key)
            .decode_utf8()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if key == MEDIA_SESSION_MARKER {
            if marker.is_some() {
                return Err(StatusCode::BAD_REQUEST);
            }
            marker = Some(
                percent_encoding::percent_decode_str(raw_value)
                    .decode_utf8()
                    .map_err(|_| StatusCode::BAD_REQUEST)?
                    .into_owned(),
            );
        }
    }

    Ok(marker)
}

fn session_marker_matches(uri: &Uri, scope: &str) -> Result<bool, StatusCode> {
    Ok(media_session_marker(uri)?.is_none_or(|marker| marker == scope))
}

fn should_retry_with_session(failed: &MediaSession, updated: &MediaSession) -> bool {
    updated.generation != failed.generation
        && updated.token != failed.token
        && updated.origin == failed.origin
        && updated.scope == failed.scope
}

/// The app's own webview origins, which vary by platform and scheme.
fn is_webview_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions) && origin.starts_with("http://localhost:"))
}

/// Grants CORS only to our own webview. A request with no `Origin` (an `<img>`
/// load) is not a CORS request and needs no grant.
fn apply_cors_headers(response: &mut Response<Vec<u8>>, request_origin: Option<&str>) {
    let Some(origin) = request_origin.filter(|origin| is_webview_origin(origin)) else {
        return;
    };
    let Ok(value) = header::HeaderValue::from_str(origin) else {
        return;
    };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    // Responses are cached `immutable`, so the cache must key on Origin too.
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
}

pub fn respond<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();
    let header_value = |name: header::HeaderName| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let origin = header_value(header::ORIGIN);
    tauri::async_runtime::spawn(async move {
        let mut response = handle_request(&app, uri)
            .await
            .unwrap_or_else(error_response);
        apply_cors_headers(&mut response, origin.as_deref());
        responder.respond(response);
    });
}

async fn handle_request<R: Runtime>(
    app: &AppHandle<R>,
    uri: Uri,
) -> Result<Response<Vec<u8>>, StatusCode> {
    let target = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_owned();

    let state = app.state::<MediaSessionState>();
    let Some(session) = state.wait_for_session().await else {
        return Ok(session_unavailable_response());
    };

    let mut media_url = Url::parse(&target).map_err(|_| StatusCode::BAD_REQUEST)?;
    // A retry fragment never goes upstream and must not key encryption params, but stays
    // in `target` below so the retry gets a fresh cache identity.
    media_url.set_fragment(None);
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
    if !session_marker_matches(&uri, &session.scope)? {
        return Err(StatusCode::FORBIDDEN);
    }

    let key = cache_key(&session.scope, &target);
    if let Some(status) = state.recent_client_error(&key) {
        return Err(status);
    }
    let dir = cache_dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let temp_dir = temp_cache_dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (content_type, in_memory_body, disk_path) =
        ensure_cached(&state, &session, &key, media_url, dir, temp_dir).await?;

    match in_memory_body {
        Some(body) => {
            let vec_body = Arc::try_unwrap(body).unwrap_or_else(|b| (*b).clone());
            Ok(ok_response(vec_body, &content_type))
        }
        None => Ok(ok_response(read_full(disk_path).await?, &content_type)),
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
        let content_type =
            sniff_and_fix_content_type(body_path.clone(), content_type_path.clone(), content_type)
                .await;
        return Ok((content_type, None, body_path));
    }

    // Fast path 2: Temporary cache hit (sequential range requests for oversized media)
    if let Some(content_type) =
        read_content_type(temp_body_path.clone(), temp_content_type_path.clone()).await
    {
        let content_type = sniff_and_fix_content_type(
            temp_body_path.clone(),
            temp_content_type_path.clone(),
            content_type,
        )
        .await;
        return Ok((content_type, None, temp_body_path));
    }

    let gate = state.cache_miss_gate(key)?;
    let mut gate_guard = gate.lock().await;

    // Double-check persistent cache inside gate lock
    if let Some(content_type) =
        read_content_type(body_path.clone(), content_type_path.clone()).await
    {
        let content_type =
            sniff_and_fix_content_type(body_path.clone(), content_type_path.clone(), content_type)
                .await;
        return Ok((content_type, None, body_path));
    }

    // Double-check temporary cache inside gate lock
    if let Some(content_type) =
        read_content_type(temp_body_path.clone(), temp_content_type_path.clone()).await
    {
        let content_type = sniff_and_fix_content_type(
            temp_body_path.clone(),
            temp_content_type_path.clone(),
            content_type,
        )
        .await;
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
            state.note_client_error(key, *status);
            *gate_guard = Some(Err(*status));
            Err(*status)
        }
    }
}

// Thumbnails queue separately so a few large downloads cannot stall a painting timeline.
async fn acquire_lane<'a>(
    state: &'a MediaSessionState,
    media_url: &Url,
) -> Result<tokio::sync::SemaphorePermit<'a>, StatusCode> {
    let semaphore = if is_thumbnail_request(media_url) {
        &state.thumbnail_semaphore
    } else {
        &state.download_semaphore
    };
    semaphore
        .acquire()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn is_thumbnail_request(media_url: &Url) -> bool {
    media_url.path().contains("/thumbnail/")
}

fn has_encryption_params(state: &MediaSessionState, url: &str) -> bool {
    state
        .encryption
        .read()
        .map(|guard| guard.contains_key(url))
        .unwrap_or(false)
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
    let permit = acquire_lane(state, &media_url).await?;

    let mut upstream = state
        .client()
        .get(media_url.clone())
        .header(AUTHORIZATION, format!("Bearer {}", session.token))
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if matches!(
        upstream.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        if let Some(updated) = state.wait_for_newer_session(session).await {
            if should_retry_with_session(session, &updated) {
                upstream = state
                    .client()
                    .get(media_url.clone())
                    .header(AUTHORIZATION, format!("Bearer {}", updated.token))
                    .send()
                    .await
                    .map_err(|_| StatusCode::BAD_GATEWAY)?;
            }
        }
    }

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

    // Encrypted media stays buffered: its SHA-256 only verifies over the whole ciphertext.
    if has_encryption_params(state, media_url.as_str()) {
        let body = upstream
            .bytes()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .to_vec();
        let (body, content_type) =
            decrypt_if_encrypted(state, media_url.as_str(), body, &content_type)?;
        drop(permit);

        return store_buffered_body(
            body,
            content_type,
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
    }

    // Plaintext media streams to disk, so peak memory is one chunk instead of the whole file.
    let staging_path = temp_body_path.with_extension("part");
    match stream_to_staging_file(&mut upstream, temp_dir.clone(), staging_path.clone()).await {
        StreamOutcome::Written(size) => {
            drop(permit);
            let (target_dir, target_body, target_ct, max_bytes) =
                if size <= max_persistent_cache_bytes {
                    (
                        dir,
                        body_path,
                        content_type_path,
                        max_persistent_cache_bytes,
                    )
                } else {
                    (
                        temp_dir,
                        temp_body_path,
                        temp_content_type_path,
                        max_temp_cache_bytes,
                    )
                };

            if promote_staging_file(
                staging_path,
                target_dir,
                target_body.clone(),
                target_ct,
                content_type.clone(),
                max_bytes,
            )
            .await
            {
                Ok((content_type, None, target_body))
            } else {
                Err(StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
        // Cache directory unusable (read-only, full): serve from memory instead of failing.
        StreamOutcome::Unstorable => {
            let body = upstream
                .bytes()
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?
                .to_vec();
            drop(permit);
            Ok((content_type, Some(Arc::new(body)), temp_body_path))
        }
        StreamOutcome::Failed => Err(StatusCode::BAD_GATEWAY),
    }
}

enum StreamOutcome {
    Written(u64),
    /// The staging file could not be created; nothing was read from the body yet.
    Unstorable,
    Failed,
}

async fn stream_to_staging_file(
    upstream: &mut tauri_plugin_http::reqwest::Response,
    temp_dir: PathBuf,
    staging_path: PathBuf,
) -> StreamOutcome {
    if tokio::fs::create_dir_all(&temp_dir).await.is_err() {
        return StreamOutcome::Unstorable;
    }
    let Ok(file) = tokio::fs::File::create(&staging_path).await else {
        return StreamOutcome::Unstorable;
    };

    let mut file = tokio::io::BufWriter::new(file);
    let mut written: u64 = 0;

    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) => {
                if tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                    .await
                    .is_err()
                {
                    break;
                }
                written += chunk.len() as u64;
            }
            Ok(None) => {
                if tokio::io::AsyncWriteExt::flush(&mut file).await.is_ok() {
                    return StreamOutcome::Written(written);
                }
                break;
            }
            Err(_) => break,
        }
    }

    let _ = tokio::fs::remove_file(&staging_path).await;
    StreamOutcome::Failed
}

// Move a completed staging file into its cache directory and record its content type.
async fn promote_staging_file(
    staging_path: PathBuf,
    target_dir: PathBuf,
    target_body: PathBuf,
    target_content_type: PathBuf,
    content_type: String,
    max_bytes: u64,
) -> bool {
    tokio::task::spawn_blocking(move || {
        if fs::create_dir_all(&target_dir).is_err() {
            let _ = fs::remove_file(&staging_path);
            return false;
        }
        if fs::rename(&staging_path, &target_body).is_err() {
            let _ = fs::remove_file(&staging_path);
            return false;
        }
        if fs::write(&target_content_type, &content_type).is_err() {
            let _ = fs::remove_file(&target_body);
            return false;
        }
        evict_directory_if_needed(&target_dir, max_bytes);
        target_body.is_file()
    })
    .await
    .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
async fn store_buffered_body(
    body: Vec<u8>,
    content_type: String,
    dir: PathBuf,
    temp_dir: PathBuf,
    body_path: PathBuf,
    content_type_path: PathBuf,
    temp_body_path: PathBuf,
    temp_content_type_path: PathBuf,
    max_persistent_cache_bytes: u64,
    max_temp_cache_bytes: u64,
) -> Result<(String, Option<Arc<Vec<u8>>>, PathBuf), StatusCode> {
    if body.len() as u64 > max_temp_cache_bytes {
        return Ok((content_type, Some(Arc::new(body)), temp_body_path));
    }

    if body.len() as u64 <= max_persistent_cache_bytes {
        write_cache(
            dir,
            body_path.clone(),
            content_type_path,
            body,
            content_type.clone(),
            max_persistent_cache_bytes,
        )
        .await;
        Ok((content_type, None, body_path))
    } else {
        let shared = Arc::new(body);
        let written = write_cache(
            temp_dir,
            temp_body_path.clone(),
            temp_content_type_path,
            shared.as_ref().clone(),
            content_type.clone(),
            max_temp_cache_bytes,
        )
        .await;

        if written {
            Ok((content_type, None, temp_body_path))
        } else {
            // Storage write failed or evicted; serve from memory fallback
            Ok((content_type, Some(shared), temp_body_path))
        }
    }
}

/// Sniff the image MIME type from magic bytes of decrypted content.
/// Restricted to an image allowlist and never returns SVG (which can carry scripts).
/// Used as a fallback when the registered content type is missing or octet-stream.
fn sniff_image_content_type(bytes: &[u8]) -> Option<&'static str> {
    const ALLOWED: [&str; 5] = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
    ];
    infer::get(bytes)
        .filter(|kind| ALLOWED.contains(&kind.mime_type()))
        .map(|kind| kind.mime_type())
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

    // Kept for the session: if this file is evicted, the refetch must still decrypt rather
    // than serve ciphertext. `clear_media_session` drops them.
    let final_content_type =
        if params.content_type.is_empty() || params.content_type == "application/octet-stream" {
            sniff_image_content_type(&plaintext)
                .map(|s| s.to_owned())
                .unwrap_or(params.content_type)
        } else {
            params.content_type
        };
    Ok((plaintext, final_content_type))
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

/// On a cache hit where the stored content type is octet-stream, re-sniff the
/// body file's magic bytes and rewrite the .ct file if a real image type is found.
async fn sniff_and_fix_content_type(
    body_path: PathBuf,
    content_type_path: PathBuf,
    stored_ct: String,
) -> String {
    if stored_ct != "application/octet-stream" {
        return stored_ct;
    }
    let ct_for_closure = stored_ct.clone();
    tokio::task::spawn_blocking(move || {
        let mut file = match fs::File::open(&body_path) {
            Ok(f) => f,
            Err(_) => return ct_for_closure,
        };
        let mut buf = [0u8; 64];
        let n = file.read(&mut buf).unwrap_or(0);
        if let Some(sniffed) = sniff_image_content_type(&buf[..n]) {
            let _ = fs::write(&content_type_path, sniffed);
            return sniffed.to_owned();
        }
        ct_for_closure
    })
    .await
    .unwrap_or(stored_ct)
}

async fn read_full(body_path: PathBuf) -> Result<Vec<u8>, StatusCode> {
    tokio::task::spawn_blocking(move || fs::read(&body_path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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

// Shared response headers. Media is content-addressed and the URL is session-scoped, so
// it is safe to let the webview cache it as immutable.
fn media_response_builder(status: StatusCode, content_type: &str) -> ResponseBuilder {
    let cache_control = if content_type == "application/octet-stream" {
        "no-store"
    } else {
        "private, max-age=31536000, immutable"
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache_control)
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

fn session_unavailable_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::RETRY_AFTER, "1")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("failed to build 503 media response")
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
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
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        sync::{atomic::AtomicU64, mpsc, Arc},
        thread,
        time::Duration,
    };

    use tauri::http::{header, StatusCode, Uri};

    use super::{
        cache_key, ok_response, session_marker_matches, should_retry_with_session, MediaSession,
        MediaSessionState, Url,
    };

    static TEST_CACHE_ID: AtomicU64 = AtomicU64::new(0);

    fn test_session(origin: &str, token: &str, scope: &str, generation: u64) -> MediaSession {
        MediaSession {
            origin: origin.to_owned(),
            token: token.to_owned(),
            scope: scope.to_owned(),
            generation,
        }
    }

    fn start_upstream(
        statuses: Vec<(u16, &'static str)>,
    ) -> (Url, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (auth_sender, auth_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, body) in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = stream.read(&mut chunk) else {
                        break;
                    };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                }
                let authorization = String::from_utf8_lossy(&request)
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Authorization: ")
                            .or_else(|| line.strip_prefix("authorization: "))
                    })
                    .unwrap_or_default()
                    .to_owned();
                auth_sender.send(authorization).unwrap();
                let reason = match status {
                    200 => "OK",
                    403 => "Forbidden",
                    _ => "Unauthorized",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (
            Url::parse(&format!(
                "http://{address}/_matrix/client/v1/media/download/matrix.org/id"
            ))
            .unwrap(),
            auth_receiver,
            server,
        )
    }

    async fn fetch_test(
        state: &MediaSessionState,
        session: MediaSession,
        media_url: Url,
    ) -> Result<(String, Option<Arc<Vec<u8>>>, std::path::PathBuf), StatusCode> {
        let root = std::env::temp_dir().join(format!(
            "sable-media-test-{}-{}",
            std::process::id(),
            TEST_CACHE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let temp = root.join("temp");
        let key = cache_key(&session.scope, media_url.as_str());
        let result = super::ensure_cached_with_limits(
            state,
            &session,
            &key,
            media_url,
            root.clone(),
            temp,
            1024 * 1024,
            1024 * 1024,
        )
        .await;
        fs::remove_dir_all(root).ok();
        result
    }

    async fn receive_auth(receiver: &mpsc::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(auth) = receiver.try_recv() {
                    return auth;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }

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

    #[tokio::test]
    async fn waits_for_a_session_that_arrives_late() {
        // Mirrors startup: media is requested before the frontend hands over the session.
        let state = Arc::new(MediaSessionState::default());
        let writer = Arc::clone(&state);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            writer
                .set_session(super::MediaSession {
                    origin: "https://matrix.example.org".into(),
                    token: "token".into(),
                    scope: "@a:example.org".into(),
                    generation: 0,
                })
                .unwrap();
        });

        let session =
            tokio::time::timeout(std::time::Duration::from_secs(2), state.wait_for_session())
                .await
                .expect("wait_for_session hung");
        assert_eq!(session.map(|s| s.scope), Some("@a:example.org".to_string()));
    }

    #[tokio::test]
    async fn retries_once_after_a_same_scope_token_update() {
        let (media_url, auth_receiver, server) = start_upstream(vec![(401, ""), (200, "data")]);
        let state = Arc::new(MediaSessionState::default());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "old-token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        let failed_session = state.session().unwrap();
        let fetch_state = Arc::clone(&state);
        let fetch_url = media_url.clone();
        let fetch =
            tokio::spawn(async move { fetch_test(&fetch_state, failed_session, fetch_url).await });

        assert_eq!(receive_auth(&auth_receiver).await, "Bearer old-token");
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "new-token",
                "@a:example.org",
                0,
            ))
            .unwrap();

        assert!(fetch.await.unwrap().is_ok());
        assert_eq!(receive_auth(&auth_receiver).await, "Bearer new-token");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn retries_once_after_same_token_then_changed_token_updates() {
        let (media_url, auth_receiver, server) = start_upstream(vec![(401, ""), (200, "data")]);
        let state = Arc::new(MediaSessionState::default());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "same-token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        let failed_session = state.session().unwrap();
        let fetch_state = Arc::clone(&state);
        let fetch_url = media_url.clone();
        let fetch =
            tokio::spawn(async move { fetch_test(&fetch_state, failed_session, fetch_url).await });

        assert_eq!(receive_auth(&auth_receiver).await, "Bearer same-token");
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "same-token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(auth_receiver.try_recv().is_err());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "changed-token",
                "@a:example.org",
                0,
            ))
            .unwrap();

        assert!(fetch.await.unwrap().is_ok());
        assert_eq!(receive_auth(&auth_receiver).await, "Bearer changed-token");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn times_out_without_a_session_update() {
        let state = MediaSessionState::default();
        let session = test_session("https://matrix.example.org", "token", "@a:example.org", 1);
        assert!(state
            .wait_for_newer_session_with_timeout(&session, Duration::from_millis(20))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_failed_retry_does_not_loop() {
        let (media_url, auth_receiver, server) = start_upstream(vec![(401, ""), (403, "")]);
        let state = Arc::new(MediaSessionState::default());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "old-token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        let failed_session = state.session().unwrap();
        let fetch_state = Arc::clone(&state);
        let fetch_url = media_url.clone();
        let fetch =
            tokio::spawn(async move { fetch_test(&fetch_state, failed_session, fetch_url).await });

        assert_eq!(receive_auth(&auth_receiver).await, "Bearer old-token");
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "new-token",
                "@a:example.org",
                0,
            ))
            .unwrap();

        assert_eq!(fetch.await.unwrap().unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(receive_auth(&auth_receiver).await, "Bearer new-token");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn clear_while_waiting_terminates_without_a_retry() {
        let (media_url, auth_receiver, server) = start_upstream(vec![(401, "")]);
        let state = Arc::new(MediaSessionState::default());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        let failed_session = state.session().unwrap();
        let fetch_state = Arc::clone(&state);
        let fetch_url = media_url.clone();
        let fetch =
            tokio::spawn(async move { fetch_test(&fetch_state, failed_session, fetch_url).await });

        assert_eq!(receive_auth(&auth_receiver).await, "Bearer token");
        state.clear_session().unwrap();

        assert_eq!(fetch.await.unwrap().unwrap_err(), StatusCode::UNAUTHORIZED);
        assert!(auth_receiver.try_recv().is_err());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn origin_or_scope_switch_while_waiting_terminates_without_a_retry() {
        for (origin, scope) in [
            ("https://other.example.org", "@a:example.org"),
            ("https://matrix.example.org", "@b:example.org"),
        ] {
            let state = Arc::new(MediaSessionState::default());
            state
                .set_session(test_session(
                    "https://matrix.example.org",
                    "old-token",
                    "@a:example.org",
                    0,
                ))
                .unwrap();
            let previous = state.session().unwrap();
            let waiter_state = Arc::clone(&state);
            let waiter = tokio::spawn(async move {
                waiter_state
                    .wait_for_newer_session_with_timeout(&previous, Duration::from_secs(1))
                    .await
            });

            state
                .set_session(test_session(origin, "new-token", scope, 0))
                .unwrap();

            assert!(tokio::time::timeout(Duration::from_millis(100), waiter)
                .await
                .unwrap()
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn concurrent_cache_misses_share_the_initial_attempt_and_retry() {
        let (media_url, auth_receiver, server) = start_upstream(vec![(401, ""), (200, "data")]);
        let state = Arc::new(MediaSessionState::default());
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "old-token",
                "@a:example.org",
                0,
            ))
            .unwrap();
        let failed_session = state.session().unwrap();
        let first_state = Arc::clone(&state);
        let first_url = media_url.clone();
        let first =
            tokio::spawn(async move { fetch_test(&first_state, failed_session, first_url).await });
        let second_state = Arc::clone(&state);
        let second_session = state.session().unwrap();
        let second_url = media_url.clone();
        let second =
            tokio::spawn(
                async move { fetch_test(&second_state, second_session, second_url).await },
            );

        assert_eq!(receive_auth(&auth_receiver).await, "Bearer old-token");
        state
            .set_session(test_session(
                media_url.origin().ascii_serialization().as_str(),
                "new-token",
                "@a:example.org",
                0,
            ))
            .unwrap();

        let first_result = first.await.unwrap();
        let second_result = second.await.unwrap();
        assert!(first_result.is_ok(), "first result: {first_result:?}");
        assert!(second_result.is_ok(), "second result: {second_result:?}");
        assert_eq!(receive_auth(&auth_receiver).await, "Bearer new-token");
        assert!(auth_receiver.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn mismatched_account_or_origin_never_qualifies_for_retry() {
        let failed = test_session("https://matrix.example.org", "old", "@a:example.org", 1);
        assert!(!should_retry_with_session(
            &failed,
            &test_session("https://matrix.example.org", "new", "@b:example.org", 2)
        ));
        assert!(!should_retry_with_session(
            &failed,
            &test_session("https://other.example.org", "new", "@a:example.org", 2)
        ));
    }

    #[test]
    fn session_marker_is_an_equality_guard_and_validates_decoding() {
        let matching: Uri =
            "https://sable-media.localhost/media?__sable_media_session=%40a%3Aexample.org"
                .parse()
                .unwrap();
        let mismatched: Uri =
            "https://sable-media.localhost/media?__sable_media_session=%40b%3Aexample.org"
                .parse()
                .unwrap();
        let malformed: Uri = "https://sable-media.localhost/media?__sable_media_session=%FF"
            .parse()
            .unwrap();
        let markerless: Uri = "https://sable-media.localhost/media".parse().unwrap();

        assert!(session_marker_matches(&matching, "@a:example.org").unwrap());
        assert!(!session_marker_matches(&mismatched, "@a:example.org").unwrap());
        assert_eq!(
            session_marker_matches(&malformed, "@a:example.org"),
            Err(StatusCode::BAD_REQUEST)
        );
        assert!(session_marker_matches(&markerless, "@a:example.org").unwrap());
    }

    #[tokio::test]
    async fn does_not_wait_once_a_session_has_been_cleared() {
        // After logout there is nothing to wait for, so in-flight requests must not hang.
        let state = MediaSessionState::default();
        state
            .session_ever_set
            .store(true, std::sync::atomic::Ordering::Release);

        let waited = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            state.wait_for_session(),
        )
        .await
        .expect("wait_for_session should fail fast after a clear");
        assert!(waited.is_none());
    }

    #[test]
    fn client_errors_are_remembered_but_server_errors_are_not() {
        let state = MediaSessionState::default();

        state.note_client_error("cannot-thumbnail", StatusCode::BAD_REQUEST);
        assert_eq!(
            state.recent_client_error("cannot-thumbnail"),
            Some(StatusCode::BAD_REQUEST)
        );

        state.note_client_error("server-down", StatusCode::BAD_GATEWAY);
        assert_eq!(state.recent_client_error("server-down"), None);
    }

    #[test]
    fn auth_and_rate_limit_failures_stay_retryable() {
        let state = MediaSessionState::default();
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            state.note_client_error("key", status);
            assert_eq!(
                state.recent_client_error("key"),
                None,
                "{status} must not be cached"
            );
        }
    }

    #[test]
    fn a_new_session_forgets_remembered_failures() {
        let state = MediaSessionState::default();
        state.note_client_error("key", StatusCode::NOT_FOUND);
        state.forget_client_errors();
        assert_eq!(state.recent_client_error("key"), None);
    }

    #[test]
    fn negative_cache_is_bounded() {
        let state = MediaSessionState::default();
        for index in 0..(super::MAX_NEGATIVE_CACHE_ENTRIES + 50) {
            state.note_client_error(&format!("key-{index}"), StatusCode::NOT_FOUND);
        }
        assert_eq!(
            state.negative_cache.lock().unwrap().len(),
            super::MAX_NEGATIVE_CACHE_ENTRIES
        );
    }

    #[test]
    fn cache_key_is_stable_and_hex() {
        let url = "https://matrix.example.org/_matrix/client/v1/media/download/x/y";
        let key = cache_key("@a:example.org", url);
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, cache_key("@a:example.org", url));
    }

    #[test]
    fn cache_key_is_scoped_per_account() {
        let url = "https://matrix.example.org/_matrix/client/v1/media/download/x/y";
        assert_ne!(
            cache_key("@a:example.org", url),
            cache_key("@b:example.org", url)
        );
    }

    #[test]
    fn thumbnail_requests_use_their_own_lane() {
        let thumbnail = super::Url::parse(
            "https://matrix.example.org/_matrix/client/v1/media/thumbnail/x/y?width=96",
        )
        .unwrap();
        let download =
            super::Url::parse("https://matrix.example.org/_matrix/client/v1/media/download/x/y")
                .unwrap();
        assert!(super::is_thumbnail_request(&thumbnail));
        assert!(!super::is_thumbnail_request(&download));
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
    fn normalize_encryption_key_strips_android_prefix() {
        // Android serves the protocol over https, which used to fall through to the bare-URL
        // branch: the params were then keyed by the sable-media URL, never matched at fetch
        // time, and encrypted media was served as ciphertext.
        let input = "https://sable-media.localhost/https%3A%2F%2Fmatrix.example.org%2F_matrix%2Fclient%2Fv1%2Fmedia%2Fdownload%2Fmatrix.org%2Fabc123%3Fallow_redirect%3Dtrue?__sable_media_cache=3&__sable_media_session=%40a%3Aexample.org";
        let result = super::normalize_encryption_key(input);
        assert_eq!(
            result,
            "https://matrix.example.org/_matrix/client/v1/media/download/matrix.org/abc123?allow_redirect=true"
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

    #[test]
    fn sniff_detects_png() {
        let png_header = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(
            super::sniff_image_content_type(&png_header),
            Some("image/png")
        );
    }

    #[test]
    fn sniff_rejects_unknown() {
        assert_eq!(super::sniff_image_content_type(&[0x00, 0x01, 0x02]), None);
    }

    #[test]
    fn sniff_does_not_detect_svg() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'>";
        assert_eq!(super::sniff_image_content_type(svg), None);
    }

    #[test]
    fn octet_stream_response_is_not_cached_immutable() {
        let response = super::media_response_builder(StatusCode::OK, "application/octet-stream")
            .body(Vec::<u8>::new())
            .unwrap();
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[test]
    fn cors_is_granted_only_to_the_apps_own_webview_origins() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            let mut response = ok_response(vec![0_u8; 4], "image/png");
            super::apply_cors_headers(&mut response, Some(origin));
            assert_eq!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .unwrap(),
                origin,
                "{origin} should be granted CORS"
            );
            assert_eq!(response.headers().get(header::VARY).unwrap(), "Origin");
        }
    }

    #[test]
    fn cors_is_denied_to_foreign_origins() {
        for origin in [
            "https://evil.example.org",
            "https://tauri.localhost.evil.example.org",
            "null",
        ] {
            let mut response = ok_response(vec![0_u8; 4], "image/png");
            super::apply_cors_headers(&mut response, Some(origin));
            assert!(
                !response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                "{origin} must not be granted CORS"
            );
        }
    }

    #[test]
    fn requests_without_an_origin_get_no_cors_header() {
        let mut response = ok_response(vec![0_u8; 4], "image/png");
        super::apply_cors_headers(&mut response, None);
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[test]
    fn retry_fragment_never_keys_encryption_params() {
        let bare = "https://matrix.example.org/_matrix/client/v1/media/download/matrix.org/abc123";
        for input in [
            format!("{bare}#retry=1"),
            format!(
                "https://sable-media.localhost/{}?__sable_media_session=%40a%3Aexample.org",
                percent_encoding::utf8_percent_encode(
                    &format!("{bare}#retry=1"),
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
        ] {
            assert_eq!(super::normalize_encryption_key(&input), bare);
        }
    }

    #[test]
    fn retry_fragment_gives_a_distinct_cache_identity() {
        let base = "https://matrix.example.org/_matrix/client/v1/media/download/matrix.org/abc123";
        let original = cache_key("@a:example.org", base);
        assert_ne!(
            original,
            cache_key("@a:example.org", &format!("{base}#retry=1"))
        );
        assert_ne!(
            original,
            cache_key("@a:example.org", &format!("{base}#retry=2"))
        );
        assert_eq!(
            cache_key("@a:example.org", &format!("{base}#retry=1")),
            cache_key("@a:example.org", &format!("{base}#retry=1"))
        );
    }

    #[test]
    fn error_responses_are_no_store() {
        for response in [
            super::error_response(StatusCode::UNAUTHORIZED),
            super::error_response(StatusCode::FORBIDDEN),
            super::session_unavailable_response(),
        ] {
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store"
            );
        }
    }

    #[test]
    fn image_response_is_cached_immutable() {
        let response = super::media_response_builder(StatusCode::OK, "image/png")
            .body(Vec::<u8>::new())
            .unwrap();
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, max-age=31536000, immutable"
        );
    }
}
