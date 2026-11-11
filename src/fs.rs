#[cfg(target_os = "ios")]
use crate::native::ios;

#[derive(Debug)]
pub enum Error {
    IOError(std::io::Error),
    DownloadFailed,
    AndroidAssetLoadingError,
    /// MainBundle pathForResource returned null
    IOSAssetNoSuchFile,
    /// NSData dataWithContentsOfFile or data.bytes are null
    IOSAssetNoData,
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::IOError(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::IOError(e) => write!(f, "I/O error: {e}"),
            Self::DownloadFailed => write!(f, "Download failed"),
            Self::AndroidAssetLoadingError => write!(f, "[android] Failed to load asset"),
            Self::IOSAssetNoSuchFile => write!(f, "[ios] No such asset file"),
            Self::IOSAssetNoData => write!(f, "[ios] No data in asset file"),
        }
    }
}

impl std::error::Error for Error {}

pub type Response = Result<Vec<u8>, Error>;

/// Check that the asset length fits `android_asset::content_length`.
#[cfg(any(target_os = "android", test))]
pub(crate) fn android_asset_length_in_range(length: i64) -> bool {
    (0..=i32::MAX as i64).contains(&length)
}

/// Accept only a complete read, including an empty asset.
#[cfg(any(target_os = "android", test))]
pub(crate) fn android_asset_read_outcome(length: i64, read: i32) -> Option<usize> {
    if android_asset_length_in_range(length) && i64::from(read) == length {
        Some(length as usize)
    } else {
        None
    }
}

/// Filesystem path on desktops or HTTP URL in WASM
pub fn load_file<F: Fn(Response) + 'static>(path: &str, on_loaded: F) {
    #[cfg(target_arch = "wasm32")]
    wasm::load_file(path, on_loaded);

    #[cfg(target_os = "android")]
    load_file_android(path, on_loaded);

    #[cfg(target_os = "ios")]
    ios::load_file(path, on_loaded);

    #[cfg(not(any(target_arch = "wasm32", target_os = "android", target_os = "ios")))]
    load_file_desktop(path, on_loaded);
}

#[cfg(target_os = "android")]
fn load_file_android<F: Fn(Response)>(path: &str, on_loaded: F) {
    fn load_file_sync(path: &str) -> Response {
        use crate::native;

        let filename = std::ffi::CString::new(path).unwrap();

        let mut data: native::android_asset = unsafe { std::mem::zeroed() };

        unsafe { native::android::load_asset(filename.as_ptr(), &mut data as _) };

        if data.content.is_null() == false {
            let slice =
                unsafe { std::slice::from_raw_parts(data.content, data.content_length as _) };
            let response = slice.iter().map(|c| *c as _).collect::<Vec<_>>();
            unsafe { libc::free(data.content as _) };
            Ok(response)
        } else {
            Err(Error::AndroidAssetLoadingError)
        }
    }

    let response = load_file_sync(path);

    on_loaded(response);
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::Response;
    use crate::native;

    use std::{cell::RefCell, collections::HashMap, thread_local};

    thread_local! {
        #[allow(clippy::type_complexity)]
        static FILES: RefCell<HashMap<u32, Box<dyn Fn(Response)>>> = RefCell::new(HashMap::new());
    }

    #[no_mangle]
    pub extern "C" fn file_loaded(file_id: u32) {
        use super::Error;
        use native::wasm::fs;

        FILES.with(|files| {
            let mut files = files.borrow_mut();
            let callback = files
                .remove(&file_id)
                .unwrap_or_else(|| panic!("Unknown file loaded!"));
            let file_len = unsafe { fs::fs_get_buffer_size(file_id) };
            if file_len == -1 {
                callback(Err(Error::DownloadFailed));
            } else {
                let mut buffer = vec![0; file_len as usize];
                unsafe { fs::fs_take_buffer(file_id, buffer.as_mut_ptr(), file_len as u32) };

                callback(Ok(buffer));
            }
        })
    }

    pub fn load_file<F: Fn(Response) + 'static>(path: &str, on_loaded: F) {
        use native::wasm::fs;
        use std::ffi::CString;

        let url = CString::new(path).unwrap();
        let file_id = unsafe { fs::fs_load_file(url.as_ptr(), url.as_bytes().len() as u32) };
        FILES.with(|files| {
            let mut files = files.borrow_mut();
            files.insert(file_id, Box::new(on_loaded));
        });
    }
}

#[cfg(not(any(target_arch = "wasm32", target_os = "android", target_os = "ios")))]
fn load_file_desktop<F: Fn(Response)>(path: &str, on_loaded: F) {
    fn load_file_sync(path: &str) -> Response {
        use std::fs::File;
        use std::io::Read;

        let mut response = vec![];
        let mut file = File::open(path)?;
        file.read_to_end(&mut response)?;
        Ok(response)
    }

    let response = load_file_sync(path);

    on_loaded(response);
}

#[cfg(test)]
mod android_asset_read_outcome_tests {
    use super::{android_asset_length_in_range, android_asset_read_outcome};

    #[test]
    fn empty_asset_is_a_successful_zero_byte_read() {
        assert_eq!(android_asset_read_outcome(0, 0), Some(0));
    }

    #[test]
    fn full_read_reports_every_requested_byte() {
        assert_eq!(android_asset_read_outcome(128, 128), Some(128));
    }

    #[test]
    fn short_read_is_an_error_not_a_truncated_success() {
        assert_eq!(android_asset_read_outcome(128, 20), None);
    }

    #[test]
    fn failed_read_of_a_non_empty_asset_is_an_error() {
        assert_eq!(android_asset_read_outcome(128, 0), None);
        assert_eq!(android_asset_read_outcome(128, -1), None);
    }

    #[test]
    fn negative_length_is_rejected_before_any_read() {
        assert!(!android_asset_length_in_range(-1));
    }

    #[test]
    fn length_over_c_int_max_is_rejected_before_any_read() {
        assert!(!android_asset_length_in_range(i32::MAX as i64 + 1));
    }

    #[test]
    fn zero_and_max_c_int_lengths_are_in_range() {
        assert!(android_asset_length_in_range(0));
        assert!(android_asset_length_in_range(i32::MAX as i64));
    }
}
