# Process Supervision

Roadrunner registers subprocesses it creates in `.roadrunner/processes.json` in the target project.

Cleanup only signals registered processes after checking PID start-time ticks to reduce PID-reuse risk. Records without verifiable process identity are treated as stale instead of being signaled by PID alone.

Provider, verification, interactive task-restart cancellation, and automatic idle restarts use the same Roadrunner-owned process supervision path. Restarts and timeouts must signal only registered subprocesses or their process groups, never arbitrary editor or agent processes.
