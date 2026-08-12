use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, RwLock},
    thread,
};

use sha2::{Digest, Sha256};
use tauri::http::{header, Response, StatusCode};

use super::session::MediaSession;

pub(super) struct LoopbackMediaServer {
    origin: String,
    routes: Arc<RwLock<HashMap<String, CachedMedia>>>,
}

#[derive(Clone)]
struct CachedMedia {
    path: PathBuf,
    content_type: String,
}

impl LoopbackMediaServer {
    pub(super) fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let routes = Arc::new(RwLock::new(HashMap::<String, CachedMedia>::new()));
        let server_routes = Arc::clone(&routes);
        thread::Builder::new()
            .name("sable-media-loopback".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let routes = Arc::clone(&server_routes);
                    let _ = thread::Builder::new()
                        .name("sable-media-request".into())
                        .spawn(move || serve(stream, routes));
                }
            })?;

        Ok(Self { origin, routes })
    }

    pub(super) fn clear(&self) {
        if let Ok(mut routes) = self.routes.write() {
            routes.clear();
        }
    }

    pub(super) fn redirect_response(
        &self,
        session: &MediaSession,
        cache_key: &str,
        path: PathBuf,
        content_type: &str,
    ) -> Response<Vec<u8>> {
        let capability = capability(session, cache_key);
        if let Ok(mut routes) = self.routes.write() {
            routes.insert(
                capability.clone(),
                CachedMedia {
                    path,
                    content_type: content_type.to_owned(),
                },
            );
        }
        Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, format!("{}/{}", self.origin, capability))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

fn capability(session: &MediaSession, cache_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session.token.as_bytes());
    hasher.update([0]);
    hasher.update(session.scope.as_bytes());
    hasher.update([0]);
    hasher.update(cache_key.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn serve(mut stream: TcpStream, routes: Arc<RwLock<HashMap<String, CachedMedia>>>) {
    let Ok((method, capability, range)) = parse_request(&stream) else {
        let _ = write_status(&mut stream, 400, "Bad Request", &[]);
        return;
    };
    if method != "GET" && method != "HEAD" {
        let _ = write_status(&mut stream, 405, "Method Not Allowed", &[]);
        return;
    }
    let media = routes
        .read()
        .ok()
        .and_then(|routes| routes.get(&capability).cloned());
    let Some(media) = media else {
        let _ = write_status(&mut stream, 404, "Not Found", &[]);
        return;
    };
    let Ok(mut file) = File::open(media.path) else {
        let _ = write_status(&mut stream, 404, "Not Found", &[]);
        return;
    };
    let Ok(total) = file.metadata().map(|metadata| metadata.len()) else {
        let _ = write_status(&mut stream, 500, "Internal Server Error", &[]);
        return;
    };
    let selection = range.as_deref().and_then(|value| parse_range(value, total));
    if range.is_some() && selection.is_none() {
        let _ = write_status(
            &mut stream,
            416,
            "Range Not Satisfiable",
            &[("Content-Range", format!("bytes */{total}"))],
        );
        return;
    }
    let (start, end, partial) = selection.unwrap_or((0, total.saturating_sub(1), false));
    let length = end.saturating_sub(start) + 1;
    let mut headers = vec![
        ("Content-Type", media.content_type),
        ("Content-Length", length.to_string()),
        ("Accept-Ranges", "bytes".to_owned()),
        (
            "Access-Control-Allow-Origin",
            "https://tauri.localhost".to_owned(),
        ),
        (
            "Cache-Control",
            "private, max-age=31536000, immutable".to_owned(),
        ),
    ];
    if partial {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{total}")));
    }
    if write_status(
        &mut stream,
        if partial { 206 } else { 200 },
        if partial { "Partial Content" } else { "OK" },
        &headers,
    )
    .is_err()
        || method == "HEAD"
    {
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut left = length;
    let mut buffer = [0_u8; 64 * 1024];
    while left > 0 {
        let want = left.min(buffer.len() as u64) as usize;
        let Ok(read) = file.read(&mut buffer[..want]) else {
            return;
        };
        if read == 0 || stream.write_all(&buffer[..read]).is_err() {
            return;
        }
        left -= read as u64;
    }
}

fn parse_request(stream: &TcpStream) -> Result<(String, String, Option<String>), ()> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).map_err(|_| ())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(())?.to_owned();
    let path = parts.next().ok_or(())?;
    if parts.next().is_none() || !path.starts_with('/') || path[1..].contains('/') {
        return Err(());
    }
    let mut range = None;
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).map_err(|_| ())?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line
            .strip_prefix("Range:")
            .or_else(|| line.strip_prefix("range:"))
        {
            range = Some(value.trim().to_owned());
        }
        if line.len() > 8192 {
            return Err(());
        }
    }
    Ok((method, path[1..].to_owned(), range))
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64, bool)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    if start.is_empty() {
        let length = end.parse::<u64>().ok()?.min(total);
        (length > 0).then_some((total - length, total - 1, true))
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() {
            total.checked_sub(1)?
        } else {
            end.parse::<u64>().ok()?.min(total.checked_sub(1)?)
        };
        (start <= end && start < total).then_some((start, end, true))
    }
}

fn write_status(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\n"
    )?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")
}
