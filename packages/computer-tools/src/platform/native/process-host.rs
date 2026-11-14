//! Protocol v1: tag:u8 + length:u32le + bytes. The owner alone owns the control
//! pipe. EOF cancels the command tree even when a command never reads its stdin.
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

const MAX_FRAME: usize = 1_048_576;
pub struct Configuration {
    executable: String,
    cwd: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    grace: Duration,
    #[cfg_attr(unix, allow(dead_code))]
    windows_verbatim_arguments: bool,
}
#[derive(Clone, Copy)]
pub struct Exit { code: Option<i64>, signal: Option<i32> }
pub struct SpawnError { clean: bool }
impl From<io::Error> for SpawnError { fn from(_: io::Error) -> Self { Self { clean: true } } }
enum Event { Input(Vec<u8>), CloseInput, Stop, OwnerClosed, Invalid, OutputClosed(bool) }
type Output = Arc<Mutex<io::Stdout>>;
fn emit(output: &Output, tag: u8, bytes: &[u8]) -> io::Result<()> {
    let mut writer = output.lock().map_err(|_| io::Error::other("output unavailable"))?;
    writer.write_all(&[tag])?;
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
fn read_frame(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 5];
    match input.read(&mut header[..1])? { 0 => return Ok(None), _ => {} }
    input.read_exact(&mut header[1..])?;
    let length = u32::from_le_bytes(header[1..5].try_into().unwrap()) as usize;
    if length > MAX_FRAME { return Err(io::Error::other("oversize control frame")); }
    let mut bytes = vec![0; length]; input.read_exact(&mut bytes)?;
    Ok(Some((header[0], bytes)))
}
fn configuration(bytes: &[u8]) -> io::Result<Configuration> {
    struct Parser<'a> { bytes: &'a [u8] }
    impl Parser<'_> {
        fn integer(&mut self) -> io::Result<u32> {
            if self.bytes.len() < 4 { return Err(io::Error::other("invalid configuration")); }
            let value = u32::from_le_bytes(self.bytes[..4].try_into().unwrap());
            self.bytes = &self.bytes[4..]; Ok(value)
        }
        fn string(&mut self) -> io::Result<String> {
            let length = self.integer()? as usize;
            if length > self.bytes.len() || self.bytes[..length].contains(&0) { return Err(io::Error::other("invalid configuration")); }
            let value = String::from_utf8(self.bytes[..length].to_vec()).map_err(io::Error::other)?;
            self.bytes = &self.bytes[length..]; Ok(value)
        }
    }
    let mut parser = Parser { bytes };
    let grace = parser.integer()?;
    if grace > 60_000 { return Err(io::Error::other("invalid grace")); }
    let executable = parser.string()?; let cwd = parser.string()?;
    let count = parser.integer()?;
    if count > 16_384 { return Err(io::Error::other("too many arguments")); }
    let mut args = Vec::new(); for _ in 0..count { args.push(parser.string()?); }
    let count = parser.integer()?;
    if count > 16_384 { return Err(io::Error::other("too many environment variables")); }
    let mut env = Vec::new();
    for _ in 0..count {
        let key = parser.string()?; let value = parser.string()?;
        if key.is_empty() || key.contains('=') { return Err(io::Error::other("invalid environment")); }
        env.push((key, value));
    }
    let windows_verbatim_arguments = if parser.bytes.is_empty() { false } else {
        match parser.integer()? { 0 => false, 1 => true, _ => return Err(io::Error::other("invalid argument mode")) }
    };
    if !parser.bytes.is_empty() || executable.is_empty() || cwd.is_empty() { return Err(io::Error::other("invalid configuration")); }
    Ok(Configuration { executable, cwd, args, env, grace: Duration::from_millis(grace as u64), windows_verbatim_arguments })
}
fn pump(mut reader: impl Read + Send + 'static, output: Output, tag: u8, events: mpsc::Sender<Event>) {
    thread::spawn(move || {
        let mut buffer = [0u8; 16_384];
        let result = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break true,
                Ok(length) => if emit(&output, tag, &buffer[..length]).is_err() { break false; },
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break false,
            }
        };
        let _ = events.send(Event::OutputClosed(result));
    });
}
fn run(output: &Output) -> io::Result<()> {
    let config = {
        let input = io::stdin();
        let (tag, bytes) = read_frame(&mut input.lock())?.ok_or_else(|| io::Error::other("owner disconnected"))?;
        if tag != b'S' { return Err(io::Error::other("missing configuration")); }
        configuration(&bytes)?
    };
    let (mut child, input, stdout, stderr) = match platform::spawn(&config) {
        Ok(value) => value,
        Err(error) if error.clean => {
            emit(output, b'N', &[])?;
            emit(output, b'D', &[])?;
            return Ok(());
        },
        Err(_) => return Err(io::Error::other("failed process creation could not be cleaned")),
    };
    // Before this response the process already belongs to its isolated tree.
    emit(output, b'P', &child.pid().to_le_bytes())?;
    let (events, receive) = mpsc::channel();
    pump(stdout, output.clone(), b'O', events.clone());
    pump(stderr, output.clone(), b'E', events.clone());
    // A bounded input queue prevents an unread command stdin from blocking the
    // control reader, cancellation, owner death or actual-exit observation.
    let (input_send, input_receive) = mpsc::sync_channel::<Vec<u8>>(8);
    let input_done = thread::spawn(move || {
        let mut input = input;
        while let Ok(bytes) = input_receive.recv() { if input.write_all(&bytes).is_err() { break; } }
    });
    let mut input_send = Some(input_send);
    let control_events = events.clone();
    thread::spawn(move || {
        let input = io::stdin(); let mut reader = input.lock();
        loop {
            let event = match read_frame(&mut reader) {
                Ok(Some((b'I', bytes))) => Event::Input(bytes),
                Ok(Some((b'C', bytes))) if bytes.is_empty() => Event::CloseInput,
                Ok(Some((b'T', bytes))) if bytes.is_empty() => Event::Stop,
                Ok(None) => { let _ = control_events.send(Event::OwnerClosed); break; }
                _ => { let _ = control_events.send(Event::Invalid); break; }
            };
            if control_events.send(event).is_err() { break; }
        }
    });
    drop(events);
    let mut exit = None;
    let mut stopping: Option<Instant> = None;
    let mut stop_sent = false;
    let mut forced = false;
    let mut output_closed = 0;
    let mut failed = false;
    let mut owner_closed = false;
    loop {
        match receive.recv_timeout(Duration::from_millis(10)) {
            Ok(Event::Input(bytes)) => if let Some(input) = &input_send {
                if input.try_send(bytes).is_err() { failed = true; stopping.get_or_insert_with(Instant::now); }
            },
            Ok(Event::CloseInput) => { input_send.take(); },
            Ok(Event::Stop) => { stopping.get_or_insert_with(Instant::now); },
            Ok(Event::OwnerClosed) => { owner_closed = true; stopping.get_or_insert_with(Instant::now); },
            Ok(Event::Invalid) => { failed = true; stopping.get_or_insert_with(Instant::now); },
            Ok(Event::OutputClosed(success)) => {
                output_closed += 1;
                if !success { failed = true; stopping.get_or_insert_with(Instant::now); }
            },
            Err(mpsc::RecvTimeoutError::Disconnected) => { owner_closed = true; stopping.get_or_insert_with(Instant::now); },
            Err(mpsc::RecvTimeoutError::Timeout) => {},
        }
        if exit.is_none() {
            if let Some(status) = child.try_wait()? {
                exit = Some(status);
                let mut bytes = Vec::with_capacity(12);
                bytes.extend_from_slice(&status.code.unwrap_or(i64::MIN).to_le_bytes());
                bytes.extend_from_slice(&status.signal.unwrap_or(0).to_le_bytes());
                if !owner_closed && emit(output, b'X', &bytes).is_err() { owner_closed = true; }
                // A shell may exit while redirected children remain. They are
                // never promoted to independent background work.
                stopping.get_or_insert_with(Instant::now);
            }
        }
        if let Some(started) = stopping {
            input_send.take();
            if !stop_sent { child.terminate(false)?; stop_sent = true; }
            if !forced && started.elapsed() >= config.grace { child.terminate(true)?; forced = true; }
            if started.elapsed() > config.grace + Duration::from_secs(15) {
                child.terminate(true)?;
                return Err(io::Error::other("process tree exit could not be confirmed"));
            }
        }
        if exit.is_some() && !child.tree_alive()? && output_closed == 2 { break; }
    }
    input_send.take();
    if input_done.join().is_err() { failed = true; }
    if failed { return Err(io::Error::other("process resource cleanup failed")); }
    if !owner_closed { emit(output, b'D', &[])?; }
    Ok(())
}
fn main() {
    let output = Arc::new(Mutex::new(io::stdout()));
    let result = run(&output);
    if result.is_err() { let _ = emit(&output, b'F', b"process-runtime-failed"); }
    // The control thread may be waiting on the live owner's pipe. It holds no
    // child resources; process exit releases that observation after tree join.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}
