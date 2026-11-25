//! Puts this process in a Windows Job Object that kills every process in it when the last handle closes. Children
//! (and their children) join the job automatically, so a force-closed app (Task Manager, crash) takes its node /
//! ffmpeg / receiver processes with it instead of leaving them holding ports and cameras.
//! Same file in studio-app and player.
use std::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct BasicLimit {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimit {
    basic: BasicLimit,
    io: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn GetCurrentProcess() -> *mut c_void;
}
const EXTENDED_LIMIT_INFORMATION: i32 = 9;
const KILL_ON_JOB_CLOSE: u32 = 0x2000;

/// Call once at start. The job handle is never closed: Windows closes it when this process ends, for any reason.
pub fn kill_children_with_me() -> bool {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return false;
        }
        let mut info = ExtendedLimit::default();
        info.basic.limit_flags = KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, EXTENDED_LIMIT_INFORMATION, &info as *const _ as *const c_void, std::mem::size_of::<ExtendedLimit>() as u32) != 0
            && AssignProcessToJobObject(job, GetCurrentProcess()) != 0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn layout_matches_windows() {
        // sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64 Windows
        assert_eq!(std::mem::size_of::<super::ExtendedLimit>(), 144);
    }
}
