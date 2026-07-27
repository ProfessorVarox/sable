// iOS shows a form accessory bar (prev/next arrows + Done) above the keyboard
// for web inputs. WKWebView exposes no API to disable it, so swap the private
// WKContentView's class for a runtime subclass whose inputAccessoryView is nil,
// the same approach as Capacitor's hideFormAccessoryBar.

use std::ffi::CString;
use std::sync::OnceLock;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use tauri::webview::WebviewWindow;

extern "C-unwind" fn input_accessory_view_nil(_this: &AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

// Edge-swipe back, matching Android's system back gesture. wry leaves
// allowsBackForwardNavigationGestures off; react-router entries are
// same-document navigations, which WKWebView tracks in its back-forward list.
pub fn enable_swipe_back_navigation(window: &WebviewWindow<crate::BrowserEngine>) {
    let _ = window.with_webview(|webview| unsafe {
        let webview: *mut AnyObject = webview.inner().cast();
        let _: () = msg_send![&*webview, setAllowsBackForwardNavigationGestures: true];
    });
}

// UIFeedbackGenerator must run on the main thread, where Tauri schedules mobile
// commands.
#[tauri::command]
pub fn haptic_feedback(style: String) {
    unsafe {
        if style == "selection" {
            let Some(cls) = AnyClass::get(c"UISelectionFeedbackGenerator") else {
                return;
            };
            let allocated: Allocated<AnyObject> = msg_send![cls, alloc];
            let generator: Retained<AnyObject> = msg_send![allocated, init];
            let _: () = msg_send![&*generator, prepare];
            let _: () = msg_send![&*generator, selectionChanged];
        } else {
            // UIImpactFeedbackStyle: light = 0, medium = 1, heavy = 2.
            let intensity: isize = match style.as_str() {
                "medium" => 1,
                "heavy" => 2,
                _ => 0,
            };
            let Some(cls) = AnyClass::get(c"UIImpactFeedbackGenerator") else {
                return;
            };
            let allocated: Allocated<AnyObject> = msg_send![cls, alloc];
            let generator: Retained<AnyObject> = msg_send![allocated, initWithStyle: intensity];
            let _: () = msg_send![&*generator, prepare];
            let _: () = msg_send![&*generator, impactOccurred];
        }
    }
}

pub fn hide_form_accessory_bar(window: &WebviewWindow<crate::BrowserEngine>) {
    let _ = window.with_webview(|webview| unsafe {
        let webview: *mut AnyObject = webview.inner().cast();
        let scroll_view: *mut AnyObject = msg_send![&*webview, scrollView];
        let subviews: *mut AnyObject = msg_send![&*scroll_view, subviews];
        let count: usize = msg_send![&*subviews, count];
        for index in 0..count {
            let subview: *mut AnyObject = msg_send![&*subviews, objectAtIndex: index];
            let class = (*subview).class();
            if !class.name().to_bytes().starts_with(b"WKContent") {
                continue;
            }
            let Ok(subclass_name) =
                CString::new(format!("{}_NoAccessoryBar", class.name().to_string_lossy()))
            else {
                continue;
            };
            let subclass = AnyClass::get(&subclass_name).unwrap_or_else(|| {
                let mut builder = ClassBuilder::new(&subclass_name, class)
                    .expect("accessory bar subclass already registered");
                builder.add_method(
                    sel!(inputAccessoryView),
                    input_accessory_view_nil as extern "C-unwind" fn(_, _) -> _,
                );
                builder.register()
            });
            AnyObject::set_class(&*subview, subclass);
        }
    });
}

// WKWebView plays HTMLAudioElement on .playback, ignoring the silent switch.
// AudioServicesPlaySystemSound respects the switch and uses ringer volume.

use objc2_foundation::{NSString, NSURL};

// This library is linked by Cargo before Xcode creates the application bundle,
// so declaring AudioToolbox only in tauri.conf.json is not sufficient.
#[link(name = "AudioToolbox", kind = "framework")]
extern "C" {
    fn AudioServicesCreateSystemSoundID(
        in_file_url: *const objc2::runtime::AnyObject,
        out_sound_id: *mut u32,
    ) -> i32;
    fn AudioServicesPlaySystemSound(sound_id: u32);
}

fn load_system_sound(caf_bytes: &[u8], temp_name: &str) -> Result<u32, String> {
    // AudioServicesCreateSystemSoundID needs a file URL, so write the
    // embedded .caf to the app's temp directory on first use.
    let mut path = std::env::temp_dir();
    path.push(temp_name);
    if !path.exists() {
        std::fs::write(&path, caf_bytes)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    }
    unsafe {
        let path_str = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path_str);
        let mut sound_id: u32 = 0;
        let status = AudioServicesCreateSystemSoundID(Retained::as_ptr(&url).cast(), &mut sound_id);
        if status != 0 || sound_id == 0 {
            return Err(format!(
                "AudioServicesCreateSystemSoundID failed for {} with status {status}",
                path.display()
            ));
        }
        Ok(sound_id)
    }
}

pub(crate) fn play_notification_sound(kind: String) -> Result<(), String> {
    static NOTIFICATION_SOUND: OnceLock<u32> = OnceLock::new();
    static INVITE_SOUND: OnceLock<u32> = OnceLock::new();

    let cache = if kind == "invite" {
        &INVITE_SOUND
    } else {
        &NOTIFICATION_SOUND
    };
    let caf: &[u8] = if kind == "invite" {
        include_bytes!("../resources/invite.caf")
    } else {
        include_bytes!("../resources/notification.caf")
    };
    let name = if kind == "invite" {
        "sable_invite.caf"
    } else {
        "sable_notification.caf"
    };

    // Not get_or_init: a failed load must not be cached as permanent silence.
    let sound_id = match cache.get() {
        Some(id) => *id,
        None => {
            let id = load_system_sound(caf, name)?;
            let _ = cache.set(id);
            id
        }
    };
    unsafe { AudioServicesPlaySystemSound(sound_id) };
    Ok(())
}
