fn main() {
    println!("cargo:rustc-env=TS_RS_EXPORT_DIR=../src/app/generated/tauri");

    if let Ok(dsn) = std::env::var("VITE_SENTRY_DSN") {
        println!("cargo:rustc-env=SENTRY_DSN={dsn}");
    }
    if let Ok(env) = std::env::var("VITE_SENTRY_ENVIRONMENT") {
        println!("cargo:rustc-env=SENTRY_ENVIRONMENT={env}");
    }
    if let Ok(version) = std::env::var("VITE_APP_VERSION") {
        println!("cargo:rustc-env=SENTRY_APP_VERSION={version}");
    }
    println!("cargo:rerun-if-env-changed=VITE_SENTRY_DSN");
    println!("cargo:rerun-if-env-changed=VITE_SENTRY_ENVIRONMENT");
    println!("cargo:rerun-if-env-changed=VITE_APP_VERSION");

    // Find libcef.so next to the binary (CEF ships it there).
    if std::env::var_os("CARGO_FEATURE_CEF").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
    {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    }

    // The notifications plugin links the Swift runtime via @rpath.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_typegen::BuildSystem::generate_at_build_time()
        .expect("Failed to generate TypeScript bindings");

    // tauri-build fails on permissions from missing plugins, so only glob the
    // updater capability file when the `updater` feature is on.
    #[cfg(feature = "updater")]
    let tauri_attrs =
        tauri_build::Attributes::new().capabilities_path_pattern("./capabilities/**/*.json");
    #[cfg(not(feature = "updater"))]
    let tauri_attrs =
        tauri_build::Attributes::new().capabilities_path_pattern("./capabilities/*.json");

    tauri_build::try_build(tauri_attrs).expect("tauri-build failed");
}
