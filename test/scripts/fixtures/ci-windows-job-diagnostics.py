# Observe the copied checkout owner's native Job boundary without waiting.
import json as fixture_job_json


class FixtureWindowsJobDiagnostics:
    def __init__(self, bootstrap_pid, job, deadline):
        self.bootstrap_pid, self.job, self.deadline = bootstrap_pid, job, deadline
        self.handles = {}
        self.initialization_error = None
        try:
            self.setup()
        except Exception as error:
            self.initialization_error = type(error).__name__

    def setup(self):
        self.kernel = c.WinDLL("kernel32", use_last_error=True)

        def bind(name, result, *arguments):
            function = getattr(self.kernel, name)
            function.restype, function.argtypes = result, arguments
            return function

        self.open = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
        self.close = bind("CloseHandle", w.BOOL, w.HANDLE)
        self.wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
        self.times = bind("GetProcessTimes", w.BOOL, w.HANDLE, *([c.POINTER(w.FILETIME)] * 4))
        self.in_job = bind("IsProcessInJob", w.BOOL, w.HANDLE, w.HANDLE, c.POINTER(w.BOOL))
        self.query = bind("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int,
                          c.c_void_p, w.DWORD, c.c_void_p)

        class ProcessIds(c.Structure):
            _fields_ = [("assigned", w.DWORD), ("listed", w.DWORD),
                        ("pids", c.c_size_t * 64)]

        self.process_ids = ProcessIds

    def __enter__(self):
        self.sample("before-bootstrap-stop")
        return self

    def sample(self, stage, active_processes=None):
        event = dict(stage=stage, bootstrapPid=self.bootstrap_pid,
                     monotonicNs=str(time.monotonic_ns()),
                     remainingMs=round((self.deadline - time.monotonic()) * 1000, 3))
        try:
            if self.initialization_error:
                event["initializationError"] = self.initialization_error
                return
            # Capture held-handle signaling before another membership/accounting query.
            waits = {}
            for pid, (handle, _stage) in self.handles.items():
                result = self.wait(handle, 0)
                waits[pid] = (result, str(time.monotonic_ns()),
                              c.get_last_error() if result not in (0, 258) else None)
            members = self.process_ids()
            result = self.query(self.job, 3, c.byref(members), c.sizeof(members), None)
            query_error = c.get_last_error() if not result else None
            event["membership"] = dict(assigned=members.assigned, listed=members.listed,
                                       error=query_error)
            pids = list(members.pids[:min(members.listed, 64)]) if result else []
            event["membership"]["pids"] = pids
            event["membership"]["complete"] = bool(result and members.assigned == members.listed
                                                    and members.listed <= 64)
            event["openErrors"] = []
            for pid in sorted(set([self.bootstrap_pid, *pids])):
                if pid in self.handles:
                    continue
                if len(self.handles) >= 64:
                    event["handleLimit"] = True
                    break
                handle = self.open(0x1000 | 0x100000, False, pid)
                if handle:
                    self.handles[pid] = (handle, stage)
                else:
                    event["openErrors"].append(dict(pid=pid, error=c.get_last_error()))
            if active_processes is None:
                accounting = Accounting()
                if self.query(self.job, 1, c.byref(accounting), c.sizeof(accounting), None):
                    active_processes = accounting.ActiveProcesses
                else:
                    event["accountingError"] = c.get_last_error()
            event["activeProcesses"] = active_processes
            event["processes"] = []
            for pid, (handle, first_seen) in sorted(self.handles.items()):
                observation = dict(pid=pid, firstSeen=first_seen)
                if pid in waits:
                    wait_result, wait_time, wait_error = waits[pid]
                else:
                    wait_result = self.wait(handle, 0)
                    wait_time = str(time.monotonic_ns())
                    wait_error = c.get_last_error() if wait_result not in (0, 258) else None
                observation["waitResult"] = wait_result
                observation["waitMonotonicNs"] = wait_time
                if wait_error is not None:
                    observation["waitError"] = wait_error
                times = [w.FILETIME() for _ in range(4)]
                if self.times(handle, *(c.byref(value) for value in times)):
                    observation["creationTime"] = str(times[0].dwHighDateTime << 32 | times[0].dwLowDateTime)
                    # Windows leaves exit FILETIME undefined until the process exits.
                    observation["exitTime"] = (str(times[1].dwHighDateTime << 32 | times[1].dwLowDateTime)
                                               if wait_result == 0 else None)
                else:
                    observation["timesError"] = c.get_last_error()
                member = w.BOOL()
                if self.in_job(handle, self.job, c.byref(member)):
                    observation["inJob"] = bool(member.value)
                else:
                    observation["membershipError"] = c.get_last_error()
                event["processes"].append(observation)
        except Exception as error:
            # Observational failure must not replace the owner's real outcome.
            event["diagnosticError"] = type(error).__name__
        finally:
            self.emit(event)

    def emit(self, event):
        try:
            print("[fixture-windows-job] " + fixture_job_json.dumps(event, separators=(",", ":")), flush=True)
        except Exception:
            pass  # A failed diagnostic write cannot replace the owner's outcome.

    def __exit__(self, error_type, _error, _traceback):
        try:
            self.sample("drain-error" if error_type else "drain-return")
        finally:
            errors = []
            for pid, (handle, _stage) in self.handles.items():
                try:
                    if not self.close(handle):
                        errors.append(dict(pid=pid, error=c.get_last_error()))
                except Exception as error:
                    errors.append(dict(pid=pid, diagnosticError=type(error).__name__))
            self.handles.clear()
            if errors:
                self.emit(dict(stage="close-errors", bootstrapPid=self.bootstrap_pid, errors=errors))
