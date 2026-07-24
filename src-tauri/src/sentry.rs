use std::sync::atomic::{AtomicBool, Ordering};

use sentry::protocol::Event;

static CONSENT: AtomicBool = AtomicBool::new(false);

/// Initialise Sentry before the Tauri runtime spawns threads. The guard
/// flushes pending events on drop. No-op when no DSN was baked in at build time.
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN")?;
    let environment = option_env!("SENTRY_ENVIRONMENT");
    let release = option_env!("SENTRY_APP_VERSION").map(|v| format!("sable@{v}"));

    let guard = sentry::init(sentry::ClientOptions {
        dsn: dsn.parse().ok(),
        release: release.map(Into::into),
        environment: environment.map(Into::into),
        send_default_pii: false,
        before_send: Some(std::sync::Arc::new(|event: Event<'static>| {
            if CONSENT.load(Ordering::Relaxed) {
                Some(event)
            } else {
                None
            }
        })),
        ..Default::default()
    });

    Some(guard)
}

#[tauri::command]
pub fn set_native_sentry_enabled(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
}
