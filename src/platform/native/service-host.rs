//! Minimal Windows SCM adapter. Role code and cleanup stay inside the Node process.
#![cfg(windows)]
use std::{ffi::c_void, fs::OpenOptions, io::{BufRead, BufReader, Write}, os::windows::{ffi::OsStrExt, process::CommandExt}, process::{Command, Stdio}, ptr::null_mut, sync::{atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering}, OnceLock}, thread, time::Duration};
type Handle = *mut c_void;
#[repr(C)] struct Status { kind:u32, state:u32, accepted:u32, win32_exit:u32, specific_exit:u32, checkpoint:u32, wait_hint:u32 }
#[repr(C)] struct Table { name:*mut u16, main:Option<unsafe extern "system" fn(u32,*mut *mut u16)> }
#[repr(C)] struct BasicLimits { process_time:i64, job_time:i64, flags:u32, min_working:usize, max_working:usize, active_limit:u32, affinity:usize, priority:u32, scheduling:u32 }
#[repr(C)] struct IoCounters { read_ops:u64, write_ops:u64, other_ops:u64, read_bytes:u64, write_bytes:u64, other_bytes:u64 }
#[repr(C)] struct ExtendedLimits { basic:BasicLimits, io:IoCounters, process_memory:usize, job_memory:usize, peak_process:usize, peak_job:usize }
#[link(name="advapi32")] unsafe extern "system" {
  fn StartServiceCtrlDispatcherW(table:*const Table)->i32;
  fn RegisterServiceCtrlHandlerExW(name:*const u16, handler:Option<unsafe extern "system" fn(u32,u32,Handle,Handle)->u32>, context:Handle)->Handle;
  fn SetServiceStatus(handle:Handle,status:*const Status)->i32;
}
#[link(name="kernel32")] unsafe extern "system" {
  fn CreateJobObjectW(attributes:Handle,name:*const u16)->Handle;
  fn SetInformationJobObject(job:Handle,class:i32,info:*const c_void,size:u32)->i32;
  fn AssignProcessToJobObject(job:Handle,process:Handle)->i32;
  fn GetCurrentProcess()->Handle;
  fn GetLastError()->u32;
}
static CONFIG:OnceLock<Vec<String>>=OnceLock::new();
static STOP:AtomicBool=AtomicBool::new(false);
static READY:AtomicBool=AtomicBool::new(false);
static STATUS:AtomicUsize=AtomicUsize::new(0);
static CHECKPOINT:AtomicU32=AtomicU32::new(1);
fn wide(value:&str)->Vec<u16>{ std::ffi::OsStr::new(value).encode_wide().chain(Some(0)).collect() }
fn status(state:u32,error:u32){
 let handle=STATUS.load(Ordering::SeqCst) as Handle;
 if !handle.is_null(){let status=Status{kind:0x10,state,accepted:if state==4 { 1|4 } else {0},win32_exit:error,specific_exit:0,checkpoint:if state==2||state==3 {CHECKPOINT.fetch_add(1,Ordering::SeqCst)}else{0},wait_hint:if state==2||state==3 {5000}else{0}}; unsafe{SetServiceStatus(handle,&status);}}
}
unsafe extern "system" fn control(code:u32,_event:u32,_data:Handle,_context:Handle)->u32{
 if code==1||code==5 {STOP.store(true,Ordering::SeqCst);status(3,0);} 0
}
unsafe extern "system" fn service_main(_argc:u32,_argv:*mut *mut u16){
 let args=CONFIG.get().unwrap();
 let name=wide(&args[0]);
 let handle=unsafe{RegisterServiceCtrlHandlerExW(name.as_ptr(),Some(control),null_mut())};
 if handle.is_null(){return} STATUS.store(handle as usize,Ordering::SeqCst);status(2,0);
 // The host joins a private job before spawning Node. Children are owned from
 // their first instruction; closing the final handle on a host crash kills them.
 // Independent Computer services have their own SCM host/job, not this job.
 let job=unsafe{CreateJobObjectW(null_mut(),std::ptr::null())};
 let mut limits:ExtendedLimits=unsafe{std::mem::zeroed()}; limits.basic.flags=0x2000;
 if job.is_null()||unsafe{SetInformationJobObject(job,9,&limits as *const _ as *const c_void,std::mem::size_of::<ExtendedLimits>() as u32)}==0||unsafe{AssignProcessToJobObject(job,GetCurrentProcess())}==0 {status(1,unsafe{GetLastError()});return}
 let log_path=std::path::Path::new(&args[3]).with_file_name("service.log");
 let log=match OpenOptions::new().create(true).append(true).open(log_path){Ok(file)=>file,Err(_)=>{status(1,5);return}};
 let error_log=match log.try_clone(){Ok(file)=>file,Err(_)=>{status(1,5);return}};
 let mut child=match Command::new(&args[1]).args([&args[2],&args[3],"--stdio-control"]).creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(error_log).spawn(){Ok(child)=>child,Err(_)=>{status(1,2);return}};
 let output=child.stdout.take().unwrap();
 let reader=thread::spawn(move||{let mut log=log;for line in BufReader::new(output).lines(){match line{Ok(line)=>{if line=="ANYBOX_SERVICE_READY"{READY.store(true,Ordering::SeqCst)}else{let _=writeln!(log,"{}",line);}},Err(_)=>break}}});
 let mut stop_sent=false; let mut running=false; let mut tick=0u32;
 loop {
   if STOP.load(Ordering::SeqCst)&&!stop_sent {stop_sent=true;status(3,0);if let Some(mut input)=child.stdin.take(){let _=input.write_all(b"{\"type\":\"stop\"}\n");}}
   if !stop_sent&&!running&&READY.load(Ordering::SeqCst){running=true;status(4,0);}
   match child.try_wait(){Ok(Some(exit))=>{let _=reader.join();status(1,if exit.success(){0}else{1067});break},Err(_)=>{status(1,1067);break},Ok(None)=>{}}
   tick+=1;if tick%10==0 {if stop_sent{status(3,0)}else if !running{status(2,0)}}
   thread::sleep(Duration::from_millis(100));
 }
 // Do not CloseHandle(job) while reporting STOPPED: the service host belongs
 // to that job too. Process teardown closes it after the SCM callback returns.
}
fn main(){
 let args:Vec<String>=std::env::args().skip(1).collect();
 if args.len()==1&&args[0]=="--version"{println!("anybox-service-host 1");return}
 if args.len()!=4{eprintln!("Usage: anybox-service-host <service-name> <node> <runner> <configuration>");std::process::exit(2)}
 let mut name=wide(&args[0]);CONFIG.set(args).unwrap();
 let table=[Table{name:name.as_mut_ptr(),main:Some(service_main)},Table{name:null_mut(),main:None}];
 if unsafe{StartServiceCtrlDispatcherW(table.as_ptr())}==0 {eprintln!("SCM connection failed: {}",unsafe{GetLastError()});std::process::exit(1)}
}
