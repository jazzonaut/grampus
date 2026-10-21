using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Windows 10+: assign the job atomically at CreateProcess, before any tool code runs.
// The non-inherited job handle kills ordinary descendants if this supervisor dies.
public static class GrampusCheck {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedData, In, Out, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static volatile bool stop;
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static uint Active(IntPtr job) {
        Accounting info; Check(QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return info.Active;
    }
    static string ExitReason(IntPtr job, Stopwatch clock, int timeoutMs, int jobDrainMs) {
        // A signalled root handle can precede the job's final accounting update.
        // Observe bounded settlement; never infer zero activity from root exit.
        var drain = Stopwatch.StartNew();
        while (!stop && (timeoutMs == 0 || clock.ElapsedMilliseconds < timeoutMs) && Active(job) != 0 && drain.ElapsedMilliseconds < jobDrainMs) Thread.Sleep(1);
        if (stop) return "interrupted";
        if (timeoutMs > 0 && clock.ElapsedMilliseconds >= timeoutMs) return "timed_out";
        return Active(job) == 0 ? "exited" : "descendants_remaining";
    }
    static IntPtr FileHandle(string path, bool input) {
        var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
        var handle = CreateFileW(path, input ? 0x80000000u : 0x40000000u, 7, ref security, input ? 3u : 2u, 0x80, IntPtr.Zero);
        Check(handle != new IntPtr(-1)); return handle;
    }
    // Windows CRT argument encoding; no shell or command-string interpolation.
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            text.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes); text.Append(ch); slashes = 0;
        }
        text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    static void Emit(string value) { Console.WriteLine(value); Console.Out.Flush(); }

    public static void Run(string file, string[] args, string cwd, int timeoutMs, string stdout, string stderr, string receiptPath, string checkId, string token, int supervisorPid, int jobDrainMs) {
        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        var process = new ProcessInfo(); bool initialized = false, confirmed = false;
        string reason = "failed"; uint exitCode = 1;
        string supervisorStartedAt = null;
        // Measured from tool start; reported so a timeout records how long the tool actually ran.
        Stopwatch clock = null; string elapsed = "null";
        try {
            using (var owner = Process.GetProcessById(supervisorPid))
                supervisorStartedAt = owner.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture);
        } catch { } // An unknown identity keeps the conservative PID-only recovery guard.
        // A broken Windows pipe can throw rather than return EOF. Never let the
        // reader thread terminate the helper before the job is settled and receipted.
        var reader = new Thread(() => { try { Console.ReadLine(); } catch { } finally { stop = true; } });
        reader.IsBackground = true; reader.Start();
        try {
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list, 2, 0, ref size)); initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            input = FileHandle("NUL", true); output = FileHandle(stdout, false); error = FileHandle(stderr, false);
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx(); startup.Startup.Size = Marshal.SizeOf(typeof(StartupEx)); startup.Attributes = list;
            startup.Startup.Flags = 0x100; startup.Startup.In = input; startup.Startup.Out = output; startup.Startup.Error = error;
            var command = new StringBuilder(Quote(file));
            foreach (var arg in args) command.Append(' ').Append(Quote(arg));
            if (stop) { reason = "interrupted"; confirmed = true; return; }
            Check(CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, cwd, ref startup, out process));
            Emit("{\"type\":\"started\",\"pid\":" + process.Pid + "}");
            clock = Stopwatch.StartNew();
            while (true) {
                if (stop) { reason = "interrupted"; break; }
                if (timeoutMs > 0 && clock.ElapsedMilliseconds >= timeoutMs) { reason = "timed_out"; break; }
                if (new FileInfo(stdout).Length + new FileInfo(stderr).Length > 2 * 1024 * 1024) { reason = "output_limit"; break; }
                if (WaitForSingleObject(process.Process, 0) == 0) {
                    Check(GetExitCodeProcess(process.Process, out exitCode));
                    reason = ExitReason(job, clock, timeoutMs, jobDrainMs); break;
                }
                Thread.Sleep(20);
            }
        } catch { reason = "supervisor_error"; }
        finally {
            if (clock != null) elapsed = clock.ElapsedMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
            try {
                if (job != IntPtr.Zero) {
                    if (Active(job) != 0) Check(TerminateJobObject(job, 1));
                    var grace = Stopwatch.StartNew();
                    while (Active(job) != 0 && grace.ElapsedMilliseconds < 5000) Thread.Sleep(20);
                    confirmed = Active(job) == 0;
                } else confirmed = process.Process == IntPtr.Zero;
            } catch { confirmed = false; }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (initialized) DeleteProcThreadAttributeList(list);
            foreach (var memory in new [] { list, jobs, handles }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
            foreach (var handle in new [] { input, output, error, job }) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
            string result = "\"reason\":\"" + reason + "\",\"exitCode\":" + exitCode + ",\"exitConfirmed\":" + (confirmed ? "true" : "false")
                + ",\"elapsedMs\":" + elapsed;
            // Persist before touching the controller pipe: it may already be gone.
            // Names and tokens are controller-generated UUIDs, never tool output.
            if (!String.IsNullOrEmpty(receiptPath)) {
                var receipt = Encoding.UTF8.GetBytes("{\"protocol\":1,\"checkId\":\"" + checkId + "\",\"token\":\"" + token
                    + "\",\"supervisorPid\":" + supervisorPid + ",\"supervisorStartedAt\":"
                    + (supervisorStartedAt == null ? "null" : "\"" + supervisorStartedAt + "\"")
                    + ",\"toolPid\":" + process.Pid + "," + result + "}");
                using (var stream = new FileStream(receiptPath + ".tmp", FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                    stream.Write(receipt, 0, receipt.Length); stream.Flush(true);
                }
                File.Move(receiptPath + ".tmp", receiptPath);
            }
            Emit("{\"type\":\"result\"," + result + "}");
        }
    }
}
