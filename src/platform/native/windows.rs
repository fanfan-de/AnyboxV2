//! All process and Job handles stay inside this supervisor. Only the three
//! explicitly listed standard handles are inherited by the suspended child.
use super::{Configuration, Exit, SpawnError};
use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};

type Handle = *mut c_void;
#[repr(C)]
struct SecurityAttributes { length: u32, descriptor: *mut c_void, inherit: i32 }
#[repr(C)]
struct StartupInfo {
    cb: u32, reserved: *mut u16, desktop: *mut u16, title: *mut u16,
    x: u32, y: u32, x_size: u32, y_size: u32, x_chars: u32, y_chars: u32,
    fill: u32, flags: u32, show: u16, reserved_size: u16, reserved_bytes: *mut u8,
    input: Handle, output: Handle, error: Handle,
}
#[repr(C)]
struct StartupInfoEx { startup: StartupInfo, attributes: *mut c_void }
#[repr(C)]
struct ProcessInformation { process: Handle, thread: Handle, pid: u32, tid: u32 }
#[repr(C)]
struct BasicLimits {
    process_time: i64, job_time: i64, flags: u32, min_working_set: usize, max_working_set: usize,
    active_limit: u32, affinity: usize, priority: u32, scheduling: u32,
}
#[repr(C)]
struct ExtendedLimits { basic: BasicLimits, io: [u64; 6], process_memory: usize, job_memory: usize, peak_process: usize, peak_job: usize }
#[repr(C)]
struct Accounting { user: i64, kernel: i64, period_user: i64, period_kernel: i64, faults: u32, total: u32, active: u32, terminated: u32 }
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *const SecurityAttributes, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, value: *const c_void, length: u32) -> i32;
    fn QueryInformationJobObject(job: Handle, class: i32, value: *mut c_void, length: u32, returned: *mut u32) -> i32;
    fn TerminateJobObject(job: Handle, code: u32) -> i32;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attributes: *const SecurityAttributes, size: u32) -> i32;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn InitializeProcThreadAttributeList(attributes: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
    fn UpdateProcThreadAttribute(attributes: *mut c_void, flags: u32, attribute: usize, value: *const c_void, size: usize, previous: *mut c_void, returned: *mut usize) -> i32;
    fn DeleteProcThreadAttributeList(attributes: *mut c_void);
    fn CreateProcessW(application: *const u16, command: *mut u16, process_attributes: *const SecurityAttributes,
        thread_attributes: *const SecurityAttributes, inherit: i32, flags: u32, environment: *const c_void,
        cwd: *const u16, startup: *const StartupInfo, info: *mut ProcessInformation) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
}
struct OwnedHandle(Handle);
impl OwnedHandle {
    fn new(handle: Handle) -> io::Result<Self> { if handle.is_null() || handle as isize == -1 { Err(io::Error::last_os_error()) } else { Ok(Self(handle)) } }
    fn into_file(mut self) -> File { let handle = self.0; self.0 = null_mut(); unsafe { File::from_raw_handle(handle) } }
}
impl Drop for OwnedHandle { fn drop(&mut self) { if !self.0.is_null() { unsafe { CloseHandle(self.0); } } } }
struct AttributeList { _bytes: Vec<usize>, pointer: *mut c_void }
impl Drop for AttributeList { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.pointer); } } }
fn check(success: i32) -> io::Result<()> { if success == 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
fn pipe(parent_reads: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SecurityAttributes { length: size_of::<SecurityAttributes>() as u32, descriptor: null_mut(), inherit: 1 };
    let mut read = null_mut(); let mut write = null_mut();
    check(unsafe { CreatePipe(&mut read, &mut write, &attributes, 65_536) })?;
    let read = OwnedHandle::new(read)?; let write = OwnedHandle::new(write)?;
    check(unsafe { SetHandleInformation(if parent_reads { read.0 } else { write.0 }, 1, 0) })?;
    Ok((read, write))
}
// The executable and arguments are passed directly, never through cmd.exe.
// This is the documented CommandLineToArgvW/CRT backslash-and-quote convention.
fn quote(value: &str) -> String {
    let mut output = String::from("\""); let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' { slashes += 1; continue; }
        if ch == '"' { output.extend(std::iter::repeat('\\').take(slashes * 2 + 1)); }
        else { output.extend(std::iter::repeat('\\').take(slashes)); }
        slashes = 0; output.push(ch);
    }
    output.extend(std::iter::repeat('\\').take(slashes * 2)); output.push('"'); output
}
pub struct Process { process: OwnedHandle, job: OwnedHandle, pid: u32, terminated: bool }
impl Process {
    pub fn pid(&self) -> u32 { self.pid }
    pub fn try_wait(&mut self) -> io::Result<Option<Exit>> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            0 => { let mut code = 0; check(unsafe { GetExitCodeProcess(self.process.0, &mut code) })?; Ok(Some(Exit { code: Some(code as i64), signal: None })) },
            258 => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }
    pub fn terminate(&mut self, _force: bool) -> io::Result<()> {
        if self.terminated { return Ok(()); }
        check(unsafe { TerminateJobObject(self.job.0, 1) })?;
        self.terminated = true; Ok(())
    }
    pub fn tree_alive(&mut self) -> io::Result<bool> {
        let mut accounting: Accounting = unsafe { zeroed() };
        check(unsafe { QueryInformationJobObject(self.job.0, 1, &mut accounting as *mut _ as *mut c_void, size_of::<Accounting>() as u32, null_mut()) })?;
        Ok(accounting.active != 0)
    }
}
impl Drop for Process { fn drop(&mut self) { let _ = self.terminate(true); } }
pub fn spawn(config: &Configuration) -> Result<(Process, File, File, File), SpawnError> {
    let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits: ExtendedLimits = unsafe { zeroed() }; limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
    check(unsafe { SetInformationJobObject(job.0, 9, &limits as *const _ as *const c_void, size_of::<ExtendedLimits>() as u32) })?;
    let (input_child, input_parent) = pipe(false)?;
    let (output_parent, output_child) = pipe(true)?;
    let (error_parent, error_child) = pipe(true)?;
    let mut size = 0;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size); }
    if size == 0 { return Err(io::Error::last_os_error().into()); }
    let mut memory = vec![0usize; (size + size_of::<usize>() - 1) / size_of::<usize>()];
    let pointer = memory.as_mut_ptr() as *mut c_void;
    check(unsafe { InitializeProcThreadAttributeList(pointer, 2, 0, &mut size) })?;
    let attributes = AttributeList { _bytes: memory, pointer };
    let handles = [input_child.0, output_child.0, error_child.0];
    check(unsafe { UpdateProcThreadAttribute(attributes.pointer, 0, 0x00020002, handles.as_ptr() as *const c_void, size_of_val(&handles), null_mut(), null_mut()) })?;
    // Windows 10+/Server 2016+: assign the Job as part of process creation.
    // A separate CreateProcess/AssignProcess pair leaves a suspended orphan if
    // this supervisor dies between the two calls. No non-atomic fallback.
    let jobs = [job.0];
    check(unsafe { UpdateProcThreadAttribute(attributes.pointer, 0, 0x0002000d /* PROC_THREAD_ATTRIBUTE_JOB_LIST */,
        jobs.as_ptr() as *const c_void, size_of_val(&jobs), null_mut(), null_mut()) })?;
    let mut startup: StartupInfoEx = unsafe { zeroed() };
    startup.startup.cb = size_of::<StartupInfoEx>() as u32;
    startup.startup.flags = 0x100; // STARTF_USESTDHANDLES
    startup.startup.input = input_child.0; startup.startup.output = output_child.0; startup.startup.error = error_child.0;
    startup.attributes = attributes.pointer;
    let arguments = if config.windows_verbatim_arguments { config.args.join(" ") }
        else { config.args.iter().map(|value| quote(value)).collect::<Vec<_>>().join(" ") };
    let command = format!("{} {}", quote(&config.executable), arguments);
    let mut command = wide(&command); let executable = wide(&config.executable); let cwd = wide(&config.cwd);
    if command.len() > 32_767 { return Err(io::Error::other("command line exceeds platform limit").into()); }
    let mut environment = config.env.clone(); environment.sort_by_key(|(key, _)| key.to_uppercase());
    let mut block = Vec::new();
    for (key, value) in &environment { block.extend(format!("{key}={value}").encode_utf16()); block.push(0); }
    block.push(0); if environment.is_empty() { block.push(0); }
    let mut info: ProcessInformation = unsafe { zeroed() };
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
    check(unsafe { CreateProcessW(executable.as_ptr(), command.as_mut_ptr(), null(), null(), 1, 0x08080404,
        block.as_ptr() as *const c_void, cwd.as_ptr(), &startup.startup, &mut info) })?;
    let process = OwnedHandle::new(info.process)?; let thread = OwnedHandle::new(info.thread)?;
    let mut child = Process { process, job, pid: info.pid, terminated: false };
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let terminated = child.terminate(true).is_ok();
        let exited = unsafe { WaitForSingleObject(child.process.0, 15_000) } == 0;
        return Err(SpawnError { clean: terminated && exited });
    }
    // These inherited child handles must close before output readers can see EOF.
    drop(input_child); drop(output_child); drop(error_child); drop(thread); drop(attributes);
    Ok((child, input_parent.into_file(), output_parent.into_file(), error_parent.into_file()))
}
