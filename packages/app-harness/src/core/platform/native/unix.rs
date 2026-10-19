use super::{Configuration, Exit, SpawnError};
use std::io;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};

extern "C" {
    fn setsid() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    #[cfg(target_os = "linux")]
    fn prctl(option: i32, ...) -> i32;
}
pub struct Process { child: Child, pid: u32, exited: bool, tree_closed: bool }
impl Process {
    pub fn pid(&self) -> u32 { self.pid }
    pub fn try_wait(&mut self) -> io::Result<Option<Exit>> {
        let result = self.child.try_wait()?;
        if let Some(status) = result {
            self.exited = true;
            Ok(Some(Exit { code: status.code().map(i64::from), signal: status.signal() }))
        } else { Ok(None) }
    }
    pub fn terminate(&mut self, force: bool) -> io::Result<()> {
        if self.tree_closed { return Ok(()); }
        let result = unsafe { kill(-(self.pid as i32), if force { 9 } else { 15 }) };
        if result == 0 { Ok(()) }
        else if io::Error::last_os_error().raw_os_error() == Some(3) { self.tree_closed = true; Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    pub fn tree_alive(&mut self) -> io::Result<bool> {
        if self.tree_closed { return Ok(false); }
        // Linux adopts orphaned descendants before they can become persistent
        // zombies under an uncooperative container PID 1. Only reap after the
        // initial process status was consumed by std::process::Child.
        if self.exited {
            let mut status = 0;
            while unsafe { waitpid(-(self.pid as i32), &mut status, 1) } > 0 {}
        }
        if unsafe { kill(-(self.pid as i32), 0) } == 0 { return Ok(true); }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(3) { self.tree_closed = true; Ok(false) } else { Err(error) }
    }
}
impl Drop for Process { fn drop(&mut self) { let _ = self.terminate(true); let _ = self.child.wait(); } }
pub fn spawn(config: &Configuration) -> Result<(Process, ChildStdin, ChildStdout, ChildStderr), SpawnError> {
    #[cfg(target_os = "linux")]
    if unsafe { prctl(36, 1usize, 0usize, 0usize, 0usize) } != 0 { return Err(io::Error::last_os_error().into()); }
    let mut command = Command::new(&config.executable);
    command.args(&config.args).current_dir(&config.cwd).env_clear().envs(config.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe { command.pre_exec(|| { if setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) } }); }
    let mut child = command.spawn()?;
    let input = child.stdin.take().expect("piped stdin");
    let output = child.stdout.take().expect("piped stdout");
    let error = child.stderr.take().expect("piped stderr");
    let pid = child.id();
    Ok((Process { child, pid, exited: false, tree_closed: false }, input, output, error))
}
