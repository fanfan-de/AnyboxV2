//! Cancel only a standard Windows dialog owned by the named live Electron window.
//! The helper never closes the owner, other applications, or unowned dialogs.
use std::ffi::c_void;

type Hwnd = *mut c_void;

#[link(name = "user32")]
extern "system" {
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize) -> i32;
    fn GetWindow(window: Hwnd, command: u32) -> Hwnd;
    fn GetClassNameW(window: Hwnd, class: *mut u16, maximum: i32) -> i32;
    fn PostMessageW(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> i32;
}

struct Search {
    owner: Hwnd,
    process_id: u32,
    posted: bool,
}

unsafe fn owned_by_process(window: Hwnd, expected: u32) -> bool {
    let mut actual = 0;
    !window.is_null() && GetWindowThreadProcessId(window, &mut actual) != 0 && actual == expected
}

unsafe extern "system" fn visit(window: Hwnd, data: isize) -> i32 {
    let search = &mut *(data as *mut Search);
    // Revalidate the original owner for every candidate. The caller keeps that
    // window alive until the dialog's result settles, preventing handle reuse.
    if !owned_by_process(search.owner, search.process_id) {
        return 0;
    }
    if GetWindow(window, 4 /* GW_OWNER */) != search.owner
        || !owned_by_process(window, search.process_id)
    {
        return 1;
    }
    let mut class = [0u16; 32];
    let length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
    if length != 6 || class[..6] != [35, 51, 50, 55, 55, 48] /* #32770 */ {
        return 1;
    }
    search.posted = PostMessageW(window, 0x0010 /* WM_CLOSE */, 0, 0) != 0;
    // A directory selection has one owned dialog. Never close additional UI.
    if search.posted { 0 } else { 1 }
}

fn decimal<T: std::str::FromStr>(value: &str) -> Option<T> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() == 1 && args[0] == "--version" {
        println!("anybox-dialog-host 1");
        return;
    }
    let inputs = if args.len() == 2 {
        decimal::<usize>(&args[0]).zip(decimal::<u32>(&args[1]))
    } else {
        None
    };
    let posted = inputs.is_some_and(|(owner, process_id)| {
        if owner == 0 || process_id == 0 { return false; }
        let mut search = Search { owner: owner as Hwnd, process_id, posted: false };
        unsafe {
            if !owned_by_process(search.owner, process_id) { return false; }
            EnumWindows(visit, &mut search as *mut Search as isize);
        }
        search.posted
    });
    println!("{}", posted);
}
